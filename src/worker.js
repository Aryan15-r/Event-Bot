import {
  ensureTranscriptTables,
  checkDurableRateLimit,
  compareSnowflakes,
  fetchDiscordMessages,
  fetchDiscordChannel,
  normalizeDiscordMessage,
  saveMessagesToDb,
  createTranscriptRecord,
  getTranscriptById,
  getTranscriptMessages,
  listRecentTranscripts,
  runScheduledTranscriptPoll,
  renderTranscriptHtml,
  renderTranscriptsListHtml,
  formatCanonicalTranscriptTxt,
  formatCanonicalTranscriptJson,
  formatAiTranscriptContext,
  createVerifiedBackup,
  getTranscriptBackup,
  safePruneWithBackup,
  resolveTranscriptMessages
} from './transcripts.js';

import sentinelWorker from './sentinel/index.js';

/* ================== CONSTANTS ================== */

const TARGET_CHANNEL_ID = "1429189285076140073";
const ROLE_ID = "1429175738564874413"; // without @& 


//const TARGET_CHANNEL_ID = "1467100891986395268";
// const ROLE_ID = "1466499162144116898"; // without @& // Test


const PREDEFINED_LINK =
  "https://www.roblox.com/games/81437844756243/Galactic-Empire";

const PREDEFINED_INFO =
  "STS at FOB | PTS is inactive | Be mature.";

const TRAINING_TYPES = [
  "ct",
  "gt",
  "combat training (ct)",
  "general training (gt)",
  "defence training (dt)",
  "carida training",
  "carida gt",
  "carida general training",
  "carida combat training",
  "carida defence training",
  "carida ct",
  "training"
];


function isTrainingEvent(type) {
  return TRAINING_TYPES.includes(type.toLowerCase().trim());
}


/* ================== HELPERS ================== */

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" }
  });
}

async function verifyDiscord(req, env, body) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;

  const key = Uint8Array.from(
    env.DISCORD_PUBLIC_KEY.match(/.{2}/g).map(b => parseInt(b, 16))
  );
  const signature = Uint8Array.from(
    sig.match(/.{2}/g).map(b => parseInt(b, 16))
  );
  const data = new TextEncoder().encode(ts + body);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("Ed25519", cryptoKey, signature, data);
}



async function createEvent(env, data) {
  const isTraining = isTrainingEvent(data.event_type);
  const link = isTraining ? data.private_server_link : PREDEFINED_LINK;
  const info = isTraining ? "STS at pads | PTS is active | Be mature." : PREDEFINED_INFO;

  // New Mentions Logic for Roblox-initiated events
  const coHostMention = data.co_host ? `<@${data.co_host}>` : "N/A";
  const supervisorMention = data.supervisor ? `<@${data.supervisor}>` : "N/A";

  const content =
`- **Event type:** ${data.event_type}
- **Hosted by:** ${data.hostMention}
- **Co-Host:** ${coHostMention}
- **Supervisor:** ${supervisorMention}
- **Starts at:** ${data.starts_at}
- **Status:** Scheduled
- **Link:** ${link}
- **Information:** ${info}
- **Note:** ${data.notes || "N/A"}

<@&${ROLE_ID}>`;

  const res = await fetch(
    `https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { roles: [ROLE_ID] }
      })
    }
  );

  const msg = await res.json();

  if (!msg.id) {
    console.error("Discord failed:", msg);
    throw new Error("Discord message failed");
  }

  // Update this section inside function createEvent(env, data)
await env.DB.prepare(`
    INSERT INTO events
    (user_id, event_type, host_name, starts_at, status, message_id, channel_id, guild_id, co_host_id, supervisor_id, link)
    VALUES (?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?, ?, ?)
  `).bind(
    data.user_id,
    data.event_type,
    data.host_name,
    data.starts_at,
    msg.id,
    TARGET_CHANNEL_ID,
    data.guild_id,
    data.co_host || null,
    data.supervisor || null,
    link
  ).run();
}

/* ================== WORKER ================== */

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);

      const sentinelDb = env.TRANSCRIPTS_DB || env.DB;
      const sentinelEnv = {
        ...env,
        DB: sentinelDb,
        DASHBOARD_PASSPHRASE: (env.DASHBOARD_PASSPHRASE || 'MB_Vs6DfhE3_sXh').trim(),
        READ_KEY: (env.READ_KEY || 'sentinel_digest_read_key_a83f9e2b4c107d65').trim(),
        REPLY_ADMIN_KEY: (env.REPLY_ADMIN_KEY || env.ADMIN_KEY || 'sentinel_reply_admin_91b72e5c3a4f8012').trim(),
        RESEND_API_KEY: (env.RESEND_API_KEY || '').trim(),
        ALERT_FROM_EMAIL: (env.ALERT_FROM_EMAIL || 'Sentinel <onboarding@resend.dev>').trim(),
        ENABLE_REPLIES: env.ENABLE_REPLIES ?? 'true',
        TIME_ZONE: env.TIME_ZONE || 'Asia/Kolkata',
        DIGEST_MAX_DAYS: env.DIGEST_MAX_DAYS || '14',
        APP_BASE_URL: env.APP_BASE_URL || 'https://discord-event-bot.tgia.workers.dev'
      };

    /* ================== EVENT BOT & TRANSCRIPT ROUTES ================== */

      /* ---- OAuth callback ---- */
      if (url.pathname === "/oauth/callback") {
        const code = url.searchParams.get("code");
        if (!code) return new Response("No code", { status: 400 });

        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:
            `client_id=${env.DISCORD_CLIENT_ID}` +
            `&client_secret=${env.DISCORD_CLIENT_SECRET}` +
            `&grant_type=authorization_code` +
            `&code=${code}` +
            `&redirect_uri=${encodeURIComponent(env.OAUTH_REDIRECT)}`
        });

        if (!tokenRes.ok) return new Response("OAuth failed", { status: 401 });

        ctx.waitUntil(
          env.DB.prepare(`
            INSERT INTO audit_logs (action, actor_id, actor_name)
            VALUES (?, ?, ?)
          `).bind(
            "LOGIN",
            "oauth",
            "OAuth User"
          ).run()
        );
        
        return new Response(null, {
          status: 302,
          headers: {
            "Set-Cookie": "auth=1; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax",
            "Location": "/logs"
          }
        });

      }

      /* ---- Logs page ---- */
      if (url.pathname === "/logs") {
  const cookie = req.headers.get("Cookie") || "";
  if (!cookie.includes("auth=1")) {
    const redirect =
      "https://discord.com/oauth2/authorize" +
      `?client_id=${env.DISCORD_CLIENT_ID}` +
      "&response_type=code" +
      "&scope=identify" +
      `&redirect_uri=${encodeURIComponent(env.OAUTH_REDIRECT)}`;
    return Response.redirect(redirect, 302);
  }

  const { results } = await env.DB.prepare(
    "SELECT * FROM events ORDER BY created_at DESC"
  ).all();

  const audits = await env.DB.prepare(
  "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50"
).all();

  const deleted = await env.DB.prepare(
  "SELECT * FROM deleted_events ORDER BY deleted_at DESC"
).all();


  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) total,
      SUM(status='Scheduled') scheduled,
      SUM(status='Cancelled') cancelled,
      SUM(status='Concluded') concluded
    FROM events
  `).first();

  const sched = Number(stats?.scheduled || 0);
  const canc = Number(stats?.cancelled || 0);
  const conc = Number(stats?.concluded || 0);
  const total = Number(stats?.total || 0);
  const maxVal = Math.max(sched, canc, conc, 1);
  const schedPct = Math.max(sched > 0 ? 8 : 2, Math.round((sched / maxVal) * 100));
  const cancPct = Math.max(canc > 0 ? 8 : 2, Math.round((canc / maxVal) * 100));
  const concPct = Math.max(conc > 0 ? 8 : 2, Math.round((conc / maxVal) * 100));

  const rows = results.map(e => `
  <tr data-status="${e.status}">
    <td>${e.event_type}</td>
    <td>${e.host_name}</td>
    <td>${e.starts_at}</td>
    <td class="time" data-ts="${e.created_at}"></td>
    <td class="status ${e.status}">${e.status}</td>
    <td>
      <a href="https://discord.com/channels/${e.guild_id}/${e.channel_id}/${e.message_id}"
         target="_blank">🔗</a>
    </td>
    <td>
      <button onclick="deleteOne(${e.id})">🗑</button>
    </td>
  </tr>
`).join("");

  return new Response(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Event Logs</title>
<style>
body {
  margin:0;
  background:
    linear-gradient(#222 1px, transparent 1px),
    linear-gradient(90deg,#222 1px,transparent 1px);
  background-size:40px 40px;
  background-color:#0f0f0f;
  color:#e5e5e5;
  font-family:system-ui;
}

.container {
  max-width:1200px;
  margin:40px auto;
  padding:20px;
  background:#111;
  border:1px solid #333;
  border-radius:4px;
  box-shadow:0 0 12px rgb(94, 94, 94);
}

h2 { text-align:center; letter-spacing:2px }

.stats {
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
  margin-bottom:20px;
}

.card {
  border-radius: 2px;
}

.card.blue {
  background:#161616;
  border:1px solid #333;
  padding:14px;
  text-align:center;
  color: #71dbf8;
}

.card.green {
  background:#161616;
  border:1px solid #333;
  padding:14px;
  text-align:center;
  color: #45ff76;
}

.card.red {
  background:#161616;
  border:1px solid #333;
  padding:14px;
  text-align:center;
  color: #ff5b5b;
}

.card.grey {
  background:#161616;
  border:1px solid #333;
  padding:14px;
  text-align:center;
  color: #9ca3af;
}

table {
  width:100%;
  border-collapse:collapse;
}

th, td {
  padding:12px;
  border-bottom:1px solid #333;
  text-align:left;
}

th { color:#aaa }

tr:hover { background:#1b1b1b }

.status.Concluded { color: #4ade80 }
.status.Cancelled { color: #f87171 }
.status.Scheduled { color: #9ca3af }

.time {
  font-family: monospace;
}

button {
  background:#1a1a1a;
  color:#fff;
  border:1px solid #444;
  padding:6px 10px;
  cursor:pointer;
}

button:hover { background:#333 }

a {
  text-decoration:none;
  color:#f87171;
}

.controls {
  display:flex;
  justify-content:space-between;
  margin-bottom:12px;
}

.card.clickable {
  cursor: pointer;
  transition: transform .15s ease, box-shadow .15s ease;
}

.card.clickable:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 12px rgba(248,113,113,.25);
}

/* Chart Box & Responsive Proportional Bars */
.chart-box {
  background: #141414;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  padding: 16px 20px 14px;
  margin: 24px 0;
  box-sizing: border-box;
}

.chart-header {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #888;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
}

.chart {
  display: flex;
  gap: 20px;
  align-items: flex-end;
  height: 120px;
  padding-bottom: 4px;
  border-bottom: 1px solid #333;
  box-sizing: border-box;
}

.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

.bar-val {
  font-size: 13px;
  font-weight: 700;
  font-family: monospace;
  color: #e5e5e5;
}

.bar {
  width: 100%;
  height: var(--pct, 4%);
  min-height: 4px;
  max-height: 100%;
  border-radius: 4px 4px 0 0;
  transition: height 0.3s ease;
}

.bar.scheduled { background: linear-gradient(180deg, #9ca3af, #4b5563); }
.bar.cancelled { background: linear-gradient(180deg, #f87171, #b91c1c); }
.bar.concluded { background: linear-gradient(180deg, #4ade80, #15803d); }

.bar-lbl {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #888;
  margin-top: 6px;
}

.audit.DELETE_EVENT td { color:#f87171 }
.audit.DELETE_ALL_EVENTS td { color:#fb7185 }
.audit.LOGIN td { color:#60a5fa }

details summary {
  cursor:pointer;
  color:#9ca3af;
}

pre {
  background:#0b0b0b;
  padding:10px;
  border:1px solid #333;
  margin-top:6px;
  max-width:600px;
  overflow:auto;
}

</style>
</head>

<body>
<div class="container">
  <h2>📜 EVENT LOGS</h2>

  <div class="stats">
  <div class="card clickable blue" data-filter="all">
    Total<br><b id="totalCount">${stats.total}</b>
  </div>
  <div class="card clickable grey" data-filter="Scheduled">
    Scheduled<br><b>${stats.scheduled}</b>
  </div>
  <div class="card clickable red" data-filter="Cancelled">
    Cancelled<br><b>${stats.cancelled}</b>
  </div>
  <div class="card clickable green" data-filter="Concluded">
    Concluded<br><b>${stats.concluded}</b>
  </div>
</div>

<div class="chart-box">
  <div class="chart-header">
    <span>Event Status Distribution</span>
    <span>Total: ${total}</span>
  </div>
  <div class="chart">
    <div class="bar-col">
      <span class="bar-val">${sched}</span>
      <div class="bar scheduled" style="--pct:${schedPct}%;"></div>
      <span class="bar-lbl">Scheduled</span>
    </div>
    <div class="bar-col">
      <span class="bar-val">${canc}</span>
      <div class="bar cancelled" style="--pct:${cancPct}%;"></div>
      <span class="bar-lbl">Cancelled</span>
    </div>
    <div class="bar-col">
      <span class="bar-val">${conc}</span>
      <div class="bar concluded" style="--pct:${concPct}%;"></div>
      <span class="bar-lbl">Concluded</span>
    </div>
  </div>
</div>


  <div class="controls">
    <span>
      <a href="/" style="background:#1f2937; color:#f1f5f9; padding:6px 14px; text-decoration:none; border:1px solid #374151; border-radius:3px; font-weight:600; font-size:13px; display:inline-block; margin-right:8px;">🏠 Sentinel Dashboard</a>
      <a href="/transcripts" style="background:#5865f2; color:#fff; padding:6px 14px; text-decoration:none; border-radius:3px; font-weight:600; font-size:13px; display:inline-block;">📑 View Channel Transcripts</a>
    </span>
    <button onclick="deleteAll()">🔥 Delete ALL</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Type</th>
        <th>Host</th>
        <th>Starts</th>
        <th>Created</th>
        <th>Status</th>
        <th>Msg</th>
        <th>Del</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<div class="container" style="margin-top:40px;">
    <h2>🔍 AUDIT LOGS</h2>
<table>
  <thead>
  <tr>
    <th>Time</th>
    <th>Action</th>
    <th>Actor</th>
    <th>Target</th>
    <th>Details</th>
  </tr>
</thead>

  <tbody>
    ${audits.results.map(a => `
  <tr class="audit ${a.action}">
    <td class="time" data-ts="${a.created_at}"></td>
    <td><b>${a.action}</b></td>
    <td>${a.actor_name}</td>
    <td>${a.target_id ?? "-"}</td>
    <td>
      ${
        a.snapshot
          ? `<details>
              <summary>📦 snapshot</summary>
              <pre>${JSON.stringify(JSON.parse(a.snapshot), null, 2)}</pre>
            </details>`
          : "-"
      }
    </td>
  </tr>
`).join("")}

  </tbody>
</table>
</div>
<div class="container" style="margin-top:40px;">
  <h2>♻️ DELETED EVENTS (UNDO)</h2>

  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Event</th>
        <th>Deleted At</th>
        <th>Undo</th>
      </tr>
    </thead>
    <tbody>
      ${deleted.results.map(d => {
        const ev = JSON.parse(d.data);
        return `
          <tr>
            <td>${ev.id}</td>
            <td>${ev.event_type} — ${ev.host_name}</td>
            <td>${d.deleted_at}</td>
            <td>
              <button onclick="undoDelete(${ev.id})">♻️ Undo</button>
            </td>
          </tr>
        `;
      }).join("")}
    </tbody>
  </table>
</div>


<script>
document.querySelectorAll(".time").forEach(t=>{
  t.textContent = new Date(t.dataset.ts + "Z").toLocaleString();
});

async function deleteOne(id){
  const pass = prompt("Admin password:");
  if(!pass) return;

  const res = await fetch("/logs/delete", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ id, password: pass })
  });

  if(!res.ok){
    alert("Wrong password or error");
    return;
  }
  location.reload();
}

async function deleteAll(){
  const pass = prompt("DELETE ALL LOGS — password:");
  if(!pass) return;

  const res = await fetch("/logs/delete-all", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ password: pass })
  });

  if(!res.ok){
    alert("Wrong password or error");
    return;
  }
  location.reload();
}

async function undoDelete(id) {
  const pass = prompt("Admin password to restore event:");
  if (!pass) return;

  const res = await fetch("/logs/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, password: pass })
  });

  if (!res.ok) {
    alert("Restore failed");
    return;
  }

  alert("Event restored!");
  location.reload();
}


const rows = [...document.querySelectorAll("tbody tr")];

document.querySelectorAll(".card.clickable").forEach(card => {
  card.onclick = () => {
    const filter = card.dataset.filter;

    rows.forEach(r => {
      if (filter === "all") {
        r.style.display = "";
      } else {
        r.style.display =
          r.dataset.status === filter ? "" : "none";
      }
    });
  };
});

</script>
</body>
</html>`, {
    headers: { "Content-Type": "text/html" }
  });
}

      /* ---- Transcripts list page ---- */
      if (url.pathname === "/transcripts" || url.pathname === "/transcripts/") {
        try {
          const db = env.TRANSCRIPTS_DB || env.DB;
          await ensureTranscriptTables(db);
          const list = await listRecentTranscripts(db, 50);
          return new Response(renderTranscriptsListHtml(list, url.origin), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        } catch (err) {
          console.error('[Transcripts] Error rendering transcripts list:', err);
          return new Response(`<!DOCTYPE html><html><head><title>Discord Transcripts</title><style>body{background:#0a0d14;color:#f0f6fc;font-family:system-ui,-apple-system,sans-serif;padding:40px;text-align:center;}a{color:#58a6ff;}</style></head><body><h1>Discord Transcripts</h1><p>Initializing database or no transcripts recorded yet.</p><p><small style="color:#8b949e;">${(err && err.message) || 'Error initializing'}</small></p><p><a href="/">Return to Dashboard</a></p></body></html>`, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
      }

      /* ---- Single Transcript viewer page ---- */
      if (url.pathname.startsWith("/transcripts/")) {
        const transcriptId = url.pathname.replace("/transcripts/", "").trim();
        if (!transcriptId) {
          return new Response("Missing transcript ID", { status: 400 });
        }
        const db = env.TRANSCRIPTS_DB || env.DB;
        await ensureTranscriptTables(db);
        const transcript = await getTranscriptById(db, transcriptId);
        if (!transcript) {
          return new Response("Transcript Not Found", { status: 404 });
        }
        const messages = await resolveTranscriptMessages(db, env, transcript);
        return new Response(renderTranscriptHtml(transcript, messages, url.origin), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      /* ---- Transcripts List API ---- */
      if (url.pathname === "/api/transcripts" || url.pathname === "/api/transcripts/") {
        const db = env.TRANSCRIPTS_DB || env.DB;
        await ensureTranscriptTables(db);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));
        const channelId = url.searchParams.get("channel_id");
        const guildId = url.searchParams.get("guild_id");
        let list = await listRecentTranscripts(db, limit);
        if (channelId) {
          list = list.filter(t => t.channel_id === channelId);
        }
        if (guildId) {
          list = list.filter(t => t.guild_id === guildId);
        }
        return json({ ok: true, transcripts: list });
      }

      /* ---- Transcripts Backups Audit List API ---- */
      if (url.pathname === "/api/transcripts/backups") {
        const db = env.TRANSCRIPTS_DB || env.DB;
        await ensureTranscriptTables(db);
        const { results } = await db.prepare(
          "SELECT id, transcript_id, guild_id, channel_id, channel_name, guild_name, status, message_count, checksum, backup_size, error_message, github_commit_sha, created_at, verified_at FROM transcript_backups ORDER BY created_at DESC LIMIT 50"
        ).all().catch(() => ({ results: [] }));
        return json({ ok: true, backups: results || [] });
      }

      /* ---- Transcript Download API (backup.txt or JSON) ---- */
      if (url.pathname.startsWith("/api/transcripts/") && url.pathname.endsWith("/download")) {
        const transcriptId = url.pathname.replace("/api/transcripts/", "").replace("/download", "").trim();
        const db = env.TRANSCRIPTS_DB || env.DB;
        await ensureTranscriptTables(db);
        const backup = await getTranscriptBackup(db, transcriptId);
        if (!backup) {
          return new Response("Backup not found for transcript", { status: 404 });
        }

        const format = (url.searchParams.get("format") || "txt").toLowerCase();
        if (format === "json") {
          return new Response(backup.content_json, {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="backup-${transcriptId}.json"`,
              "X-Transcript-Checksum": backup.checksum || "",
              "X-Backup-Status": backup.status || "BACKUP_VERIFIED"
            }
          });
        }

        return new Response(backup.content_txt, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="backup-${transcriptId}.txt"`,
            "X-Transcript-Checksum": backup.checksum || "",
            "X-Backup-Status": backup.status || "BACKUP_VERIFIED"
          }
        });
      }

      /* ---- Single Transcript API (JSON or AI Context) ---- */
      if (url.pathname.startsWith("/api/transcripts/")) {
        const transcriptId = url.pathname.replace("/api/transcripts/", "").trim();
        const db = env.TRANSCRIPTS_DB || env.DB;
        await ensureTranscriptTables(db);
        const transcript = await getTranscriptById(db, transcriptId);
        if (!transcript) {
          return json({ ok: false, error: "Transcript Not Found" }, { status: 404 });
        }
        const messages = await resolveTranscriptMessages(db, env, transcript);

        // Token-efficient AI Context format
        if (url.searchParams.get("format") === "ai") {
          const aiContext = formatAiTranscriptContext(transcript, messages);
          return new Response(aiContext, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Transcript-ID": transcript.id,
              "X-Backup-Status": transcript.backup_status || "BACKUP_VERIFIED"
            }
          });
        }

        return json({ ok: true, transcript, messages });
      }

    /* ================== DELETE APIs ================== */

    if (url.pathname === "/logs/delete" && req.method === "POST") {
  const { id, password } = await req.json();

  if (password !== env.LOGS_ADMIN_PASSWORD) {
    return new Response("Forbidden", { status: 403 });
  }

      const ev = await env.DB.prepare(
      "SELECT * FROM events WHERE id=?"
    ).bind(id).first();
    
    if (!ev) return new Response("Not found", { status: 404 });
    
    await env.DB.prepare(`
  INSERT INTO audit_logs
  (action, actor_id, actor_name, target_id, snapshot)
  VALUES (?, ?, ?, ?, ?)
`).bind(
  "🗑️ DELETE_EVENT",
  "admin",
  "Logs Admin",
  ev.id,
  JSON.stringify({
    event_type: ev.event_type,
    host: ev.host_name,
    starts_at: ev.starts_at,
    status: ev.status,
    message_id: ev.message_id
  })
).run();

    
    await env.DB.prepare(`
      INSERT INTO audit_logs (action, actor_id, actor_name, target_id, snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      "DELETE_EVENT",
      "admin",
      "Logs Admin",
      ev.id,
      JSON.stringify(ev)
    ).run();
    
    await env.DB.prepare(
      "DELETE FROM events WHERE id=?"
    ).bind(id).run();
    

  return new Response("OK");
}

if (url.pathname === "/logs/delete-all" && req.method === "POST") {
  const { password } = await req.json();

  if (password !== env.AUDITS_ADMIN_PASSWORD) {
    return new Response("Forbidden", { status: 403 });
  }

  await env.DB.prepare(`
  INSERT INTO audit_logs
  (action, actor_id, actor_name)
  VALUES (?, ?, ?)
`).bind(
  "DELETE_ALL_EVENTS",
  "logs-admin",
  "Logs Panel Admin"
).run();

await env.DB.prepare("DELETE FROM events").run();
return new Response("OK");

}

if (url.pathname === "/logs/export" && req.method === "GET") {
  const pass = url.searchParams.get("password");
  if (pass !== env.LOGS_ADMIN_PASSWORD) {
    return new Response("Forbidden", { status: 403 });
  }

  const { results } = await env.DB.prepare(
    "SELECT * FROM audit_logs ORDER BY created_at DESC"
  ).all();

  const csv =
    "time,action,actor,target\n" +
    results.map(r =>
      `"${r.created_at}","${r.action}","${r.actor_name}","${r.target_id ?? ""}"`
    ).join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=audit_logs.csv"
    }
  });
}


if (url.pathname === "/logs/undo" && req.method === "POST") {
  const { id, password } = await req.json();

  if (password !== env.LOGS_ADMIN_PASSWORD) {
    return new Response("Forbidden", { status: 403 });
  }

  const row = await env.DB.prepare(
    "SELECT * FROM deleted_events WHERE id=?"
  ).bind(id).first();

  if (!row) {
    return new Response("Nothing to restore", { status: 404 });
  }

  const ev = JSON.parse(row.data);

  await env.DB.prepare(`
    INSERT INTO events
    (id,user_id,event_type,host_name,starts_at,status,message_id,channel_id,guild_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    ev.id,
    ev.user_id,
    ev.event_type,
    ev.host_name,
    ev.starts_at,
    ev.status,
    ev.message_id,
    ev.channel_id,
    ev.guild_id,
    ev.created_at
  ).run();

  await env.DB.prepare(
    "DELETE FROM deleted_events WHERE id=?"
  ).bind(id).run();

  await env.DB.prepare(`
    INSERT INTO audit_logs (action, actor_id, actor_name, target_id)
    VALUES (?, ?, ?, ?)
  `).bind(
    "UNDO_DELETE",
    "admin",
    "Logs Admin",
    id
  ).run();

  return new Response("Restored");
}
if (url.pathname === "/roblox/event" && req.method === "POST") {

  const ua = req.headers.get("User-Agent") || "";
  if (!ua.includes("Roblox")) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await req.json();

  if (body.key !== env.ROBLOX_SECRET_KEY) {
    return new Response("Unauthorized", { status: 401 });
}

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - body.ts) > 30) {
    return new Response("Expired request", { status: 401 });
  }


 await createEvent(env, {
    user_id: "roblox_" + body.playerId,
    host_name: body.playerName,
    hostMention: `**${body.playerName} (Roblox)**`,
    event_type: body.event_type,
    starts_at: body.starts_at,
    co_host: body.co_host, // Passed from Roblox
    supervisor: body.supervisor, // Passed from Roblox
    private_server_link: body.private_server_link,
    notes: body.note || "Hosted from Roblox",
    guild_id: body.guild_id
  });

  return new Response("Event Created");
}

if (url.pathname === "/roblox/event-status" && req.method === "POST") {
  // ... (Secret check)
  const body = await req.json();

  if (body.key !== env.ROBLOX_SECRET_KEY) {
    return new Response("Unauthorized", { status: 401 });
}

  const allowed = ["Cancelled", "Concluded"];
  if (!allowed.includes(body.status)) {
    return new Response("Invalid Status Choice", { status: 400 });
  }

  // Validate status choice
  if (body.status !== "Cancelled" && body.status !== "Concluded") {
    return new Response("Invalid Status", { status: 400 });
  }

  const ev = await env.DB.prepare(`SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC LIMIT 1`)
    .bind("roblox_" + body.playerId).first();

  if (!ev) return new Response("No event found", { status: 404 });

  // Rebuild footer mentions using DB data
  let footerMentions = `(Host: ${ev.user_id.startsWith("roblox_") ? ev.host_name : `<@${ev.user_id}>`})`;
  if (ev.co_host_id) footerMentions += ` (Co-Host: <@${ev.co_host_id}>)`;
  if (ev.supervisor_id) footerMentions += ` (Supervisor: <@${ev.supervisor_id}>)`;

  const newContent = body.status === "Cancelled"
    ? `[Cancelled ${ev.event_type}]\n-# ${footerMentions}`
    : `[${ev.event_type}${body.number ? " " + body.number : ""}]\n-# ${footerMentions}`;

  // ... (PATCH Discord and UPDATE DB)

  await fetch(
    `https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/${ev.message_id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: newContent })
    }
  );

  await env.DB.prepare(
    "UPDATE events SET status=? WHERE id=?"
  ).bind(body.status, ev.id).run();

  return new Response("Status updated");
}



/* ================== DISCORD INTERACTIONS ================== */

if (req.method === "POST" && req.headers.get("X-Signature-Ed25519")) {
  const body = await req.text();

  if (!(await verifyDiscord(req, env, body))) {
    return new Response("Invalid signature", { status: 401 });
  }

let interaction;
try {
  interaction = JSON.parse(body);
} catch {
  return new Response("Bad Request", { status: 400 });
}

/* ---- PING ---- */
if (interaction.type === 1) {
  return json({ type: 1 });
}

/* ================== SLASH COMMANDS ================== */

if (interaction.type === 2) {
const name = interaction.data.name;
const userId = interaction.member.user.id;
const opts = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
  /* ------------------ /web ------------------ */
if (name === "web") {
  if(opts.choices === "Website"){
    return json({
      type: 12, // Activity Modal
      data: {
        content: "### 🌐 Palladium Works Website\nClick below to launch the official website activity.",
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Launch Website",
                url: "/Website"
              }
            ]
          }
        ]
      }
    });
  }
  if (opts.choices === "Portal") {
    const PW = ["1461724470300512508"]; // Palladium Staff role ID
    const canAccess = interaction.member.roles?.some(r => PW.includes(r));
    if (!canAccess) {
      return json({ type: 4, data: { content: "🚫 You can't access the portal.", flags: 64 } });
    }
    return json({
      type: 12, // Activity Modal
      data: {
        content: "### 🌐 Palladium Works Portal\nAuthorized Personals only.",
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Launch Portal",
                url: "/Portal"
              }
            ]
          }
        ]
      }
    });
  }
}

if (name === "link") {
  return json({
    type: 4, // Activity Modal
    data: {
      content: "### 🌐 Palladium Works Portal\nClick below to launch the official website activity.",
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Launch Website",
              url: "https://palladiumworks.org"
            }
          ]
        }
      ]
    }
  });
}




  /* ------------------ /event ------------------ */
  /* ------------------ /event ------------------ */
if (name === "event") {
  const opts = Object.fromEntries(
    (interaction.data.options || []).map(o => [o.name, o.value])
  );

  const ADMIN_ROLE_ID = ["1429188081050980498", "1461724470300512508"];
  const isEdit = opts.edit === true;
  const isTraining = isTrainingEvent(opts.event_type);

  let existingEvent = null;
  const msg_id = opts.msg_id ?? null;
  const canOverride = interaction.member.roles?.some(r => ADMIN_ROLE_ID.includes(r));

  if (msg_id && !canOverride) {
    return json({ type: 4, data: { content: "🚫 msg_id is ADMIN-only.", flags: 64 } });
  }

  if (isEdit) {
    existingEvent = msg_id && canOverride
      ? await env.DB.prepare(`SELECT * FROM events WHERE message_id=?`).bind(msg_id).first()
      : await env.DB.prepare(`SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).bind(interaction.member.user.id).first();

    if (!existingEvent) {
      return json({ type: 4, data: { content: "❌ No event found to edit.", flags: 64 } });
    }
    if (!canOverride && existingEvent.user_id !== interaction.member.user.id) {
      return json({ type: 4, data: { content: "🚫 You can only edit your own latest event.", flags: 64 } });
    }
  }

  const hostUser = interaction.member.user;
  const hostName = hostUser.global_name || hostUser.username;
  const hostMention = `<@${hostUser.id}>`;
  
  // New Mentions Logic
  const coHostMention = opts.co_host ? `<@${opts.co_host}>` : "N/A";
  const supervisorMention = opts.supervisor ? `<@${opts.supervisor}>` : "N/A";

  const link = isTraining
    ? (opts.private_server_link !== undefined ? opts.private_server_link : existingEvent?.link)
    : PREDEFINED_LINK;

  if (isTraining && !link) {
    return json({
      type: 4,
      data: { content: "⚠️ **This training event requires a private server link.**", flags: 64 }
    });
  }

  const info = isTraining ? "STS at pads | PTS is active | Be mature." : PREDEFINED_INFO;

  const content =
`- **Event type:** ${opts.event_type}
- **Hosted by:** ${hostMention}
- **Co-Host:** ${coHostMention}
- **Supervisor:** ${supervisorMention}
- **Starts at:** ${opts.starts_at}
- **Status:** Scheduled
- **Link:** ${link}
- **Information:** ${info}
- **Note:** ${opts.notes || "N/A"}

<@&${ROLE_ID}>`;

  ctx.waitUntil((async () => {
    if (isEdit) {
      await fetch(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/${existingEvent.message_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });

      await env.DB.prepare(`UPDATE events SET event_type=?, starts_at=?, co_host_id=?, supervisor_id=? WHERE id=?`)
        .bind(opts.event_type, opts.starts_at, opts.co_host || null, opts.supervisor || null, existingEvent.id).run();
    } else {
      const res = await fetch(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { roles: [ROLE_ID] } })
      });
      const msg = await res.json();

      await env.DB.prepare(`
        INSERT INTO events (user_id, event_type, host_name, starts_at, status, message_id, channel_id, guild_id, co_host_id, supervisor_id, link)
        VALUES (?,?,?,?,'Scheduled',?,?,?,?,?,?)
      `).bind(interaction.member.user.id, opts.event_type, hostName, opts.starts_at, msg.id, TARGET_CHANNEL_ID, interaction.guild_id, opts.co_host || null, opts.supervisor || null, link).run();
    }
  })());

  return json({ type: 4, data: { content: "✅ Event posted", flags: 64 } });
}

  /* ------------------ /event-status ------------------ */
/* ------------------ /event-status ------------------ */
/* ------------------ /event-status ------------------ */
if (name === "event-status") {
  const opts = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
  const userId = interaction.member.user.id;
  const eventNumber = opts.number ?? "";
  const ADMIN_ROLE_ID = ["1429188081050980498", "1461724470300512508"];

  const canOverride = interaction.member.roles?.some(r => ADMIN_ROLE_ID.includes(r));
  const isEdit = opts.edit === true;
  const msg_id = opts.msg_id ?? null;

  if (msg_id && !canOverride) {
    return json({ type: 4, data: { content: "🚫 msg_id is ADMIN-only.", flags: 64 } });
  }

  const ev = msg_id && canOverride
    ? await env.DB.prepare(`SELECT * FROM events WHERE message_id=?`).bind(msg_id).first()
    : await env.DB.prepare(`SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).bind(userId).first();

  if (!ev) {
    return json({ type: 4, data: { content: "❌ Event not found.", flags: 64 } });
  }

  if (!canOverride && ev.user_id !== userId) {
    return json({ type: 4, data: { content: "🚫 You can only edit your own latest event status.", flags: 64 } });
  }

  if (opts.status === "Concluded" && !opts.number) {
    return json({ type: 4, data: { content: "❌ Concluded events require a number.", flags: 64 } });
  }

  // Build mentions for the status update
  let footerMentions = `(Host: <@${ev.user_id}>)`;
  if (ev.co_host_id) footerMentions += ` (Co-Host: <@${ev.co_host_id}>)`;
  if (ev.supervisor_id) footerMentions += ` (Supervisor: <@${ev.supervisor_id}>)`;

  const newContent = opts.status === "Cancelled"
    ? `[Cancelled ${ev.event_type}]\n-# ${footerMentions}`
    : `[${ev.event_type}${eventNumber ? " " + eventNumber : ""}]\n-# ${footerMentions}`;

  ctx.waitUntil((async () => {
    try {
      await env.DB.prepare("UPDATE events SET status=? WHERE id=?").bind(opts.status, ev.id).run();

      await fetch(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/${ev.message_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent })
      });

      await env.DB.prepare(`INSERT INTO audit_logs (action, actor_id, actor_name, target_id, snapshot) VALUES (?, ?, ?, ?, ?)`)
        .bind("EVENT_STATUS_UPDATE", userId, interaction.member.user.username, ev.id, JSON.stringify({ before: ev.status, after: opts.status })).run();
    } catch (err) {
      console.error("🔥 event-status failed:", err);
    }
  })());

  return json({ type: 4, data: { content: "🔄 Status updated", flags: 64 } });
}

  /* ------------------ /transcript ------------------ */
  if (name === "transcript") {
    const db = env.TRANSCRIPTS_DB || env.DB;
    await ensureTranscriptTables(db);

    // 1. Durable Rate Limiting Check (max 2 requests per 60s per user, 30s lockout)
    const rateKey = `transcript:${userId}`;
    const rateCheck = await checkDurableRateLimit(db, rateKey, 2, 60, 30);
    if (!rateCheck.allowed) {
      return json({
        type: 4,
        data: {
          content: `⏳ **Rate limit reached!** Please wait ${rateCheck.retryAfterSec || 30}s before generating another transcript.`,
          flags: 64
        }
      });
    }

    const channelId = opts.channel || interaction.channel_id || TARGET_CHANNEL_ID;
    const requestedLimit = Math.min(100, Math.max(10, parseInt(opts.limit) || 50));
    const baseUrl = env.APP_BASE_URL || url.origin;

    // 2. Defer interaction response immediately (ephemeral)
    ctx.waitUntil((async () => {
      try {
        const channelInfo = await fetchDiscordChannel(env.DISCORD_BOT_TOKEN, channelId);
        const channelName = channelInfo?.name || 'transcript-channel';

        const rawMessages = await fetchDiscordMessages(env.DISCORD_BOT_TOKEN, channelId, { limit: requestedLimit });
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
          await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_CLIENT_ID}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `⚠️ No messages found to transcribe in <#${channelId}>.`
            })
          });
          return;
        }

        const sorted = [...rawMessages].sort((a, b) => compareSnowflakes(a.id, b.id));
        const normalized = sorted.map(m => normalizeDiscordMessage(m, interaction.guild_id, channelId));

        await saveMessagesToDb(db, normalized);

        const transcriptId = await createTranscriptRecord(db, {
          channel_id: channelId,
          channel_name: channelName,
          guild_id: interaction.guild_id,
          message_count: sorted.length,
          start_message_id: sorted[0].id,
          end_message_id: sorted[sorted.length - 1].id,
          generated_by_id: userId,
          generated_by_name: interaction.member?.user?.username || 'User'
        });

        // Immediately generate verified backup & optional GitHub push
        const backupResult = await createVerifiedBackup(db, {
          id: transcriptId,
          transcript_id: transcriptId,
          channel_id: channelId,
          channel_name: channelName,
          guild_id: interaction.guild_id,
          message_count: sorted.length
        }, normalized, env).catch(err => {
          console.error('[Transcript] Error creating initial verified backup:', err);
          return null;
        });

        const transcriptUrl = `${baseUrl}/transcripts/${transcriptId}`;
        const downloadTxtUrl = `${baseUrl}/api/transcripts/${transcriptId}/download?format=txt`;

        await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_CLIENT_ID}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `📄 **Transcript Generated Successfully!**\n- **Channel:** <#${channelId}> (\`#${channelName}\`)\n- **Messages Collected:** ${sorted.length}\n- **Requested By:** <@${userId}>\n- **Backup:** ${backupResult?.status === 'BACKUP_VERIFIED' ? '🛡️ Verified & Preserved' : '⏱️ Active (48h retention)'}\n\n🔗 **View Transcript:** ${transcriptUrl}\n📥 **Download backup.txt:** ${downloadTxtUrl}`
          })
        });

        await db.prepare(`
          INSERT INTO audit_logs (action, actor_id, actor_name, target_id, snapshot)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          'GENERATE_TRANSCRIPT',
          userId,
          interaction.member?.user?.username || 'User',
          channelId,
          JSON.stringify({ transcriptId, channelName, count: sorted.length })
        ).run().catch(() => {});
      } catch (err) {
        console.error('🔥 /transcript error:', err);
        await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_CLIENT_ID}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ **Failed to generate transcript:** ${err.message}`
          })
        }).catch(() => {});
      }
    })());

    return json({
      type: 5,
      data: { flags: 64 }
    });
  }

 /* ---- UNKNOWN SLASH COMMAND ---- */
      return json({
        type: 4,
        data: { content: "Unknown command", flags: 64 }
      });
    }

     return json({ type: 4, data: { content: "Invalid Interaction Type" } });
    }

    /* ================== FULL SENTINEL WEBSITE ================== */
    // Delegates /, /login, /overview, /servers, /channels, /messages, /messaging,
    // /formatter, /settings, /health-view, /styles.css, /app.js, /api/*, /health, /digest, /reply
    return await sentinelWorker.fetch(req, sentinelEnv, ctx);

    } catch (err) {
      console.error("🔥 WORKER CRASH:", err);
      return new Response(
        "Internal Error (1101). Check logs.",
        { status: 500 }
      );
    }
  },

  /**
   * Cloudflare Workers Scheduled Cron Trigger (Runs every 5 minutes)
   * Runs Sentinel channel polling & Event Bot transcripts polling
   */
  async scheduled(event, env, ctx) {
    const sentinelDb = env.TRANSCRIPTS_DB || env.DB;
    const sentinelEnv = {
      ...env,
      DB: sentinelDb,
      DASHBOARD_PASSPHRASE: (env.DASHBOARD_PASSPHRASE || 'MB_Vs6DfhE3_sXh').trim(),
      READ_KEY: (env.READ_KEY || 'sentinel_digest_read_key_a83f9e2b4c107d65').trim(),
      REPLY_ADMIN_KEY: (env.REPLY_ADMIN_KEY || env.ADMIN_KEY || 'sentinel_reply_admin_91b72e5c3a4f8012').trim(),
      RESEND_API_KEY: (env.RESEND_API_KEY || '').trim(),
      ALERT_FROM_EMAIL: (env.ALERT_FROM_EMAIL || 'Sentinel <onboarding@resend.dev>').trim(),
      ENABLE_REPLIES: env.ENABLE_REPLIES ?? 'true',
      TIME_ZONE: env.TIME_ZONE || 'Asia/Kolkata',
      DIGEST_MAX_DAYS: env.DIGEST_MAX_DAYS || '14',
      APP_BASE_URL: env.APP_BASE_URL || 'https://discord-event-bot.tgia.workers.dev'
    };

    ctx.waitUntil(Promise.all([
      sentinelWorker.scheduled(event, sentinelEnv, ctx),
      runScheduledTranscriptPoll(sentinelDb, env)
    ]));
  }
}
