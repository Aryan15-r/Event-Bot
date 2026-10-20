/* ================== CONSTANTS ================== */




const TARGET_CHANNEL_ID = "1429189285076140073";
const ROLE_ID = "1429175738564874413"; // without @& 
/*
const TARGET_CHANNEL_ID = "1467100891986395268";
const ROLE_ID = "1466499162144116898"; // without @& // Test
*/

const PREDEFINED_LINK =
  "https://www.roblox.com/games/81437844756243/Galactic-Empire";

const PREDEFINED_INFO =
  "STS at FOB | PTS is inactive | Be mature.";

const TRAINING_TYPES = [
  "ct",
  "gt",
  "combat training",
  "general training"
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

  const link = isTraining
    ? data.private_server_link
    : PREDEFINED_LINK;

  const info = isTraining
    ? "STS at pads | PTS is active | Be mature."
    : PREDEFINED_INFO;

  const content =
`- **Event type:** ${data.event_type}
- **Hosted by:** ${data.hostMention}
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

  await env.DB.prepare(`
    INSERT INTO events
    (user_id,event_type,host_name,starts_at,status,message_id,channel_id,guild_id)
    VALUES (?,?,?,?, 'Scheduled', ?,?,?)
  `).bind(
    data.user_id,
    data.event_type,
    data.host_name,
    data.starts_at,
    msg.id,
    TARGET_CHANNEL_ID,
    data.guild_id
  ).run();
}


/* ================== WORKER ================== */

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);

    /* ================== WEBSITE ================== */
    if (req.method === "GET") {

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

/* Chart */
.chart {
  display:flex;
  gap:12px;
  align-items:flex-end;
  height:120px;
  margin:24px 0;
}

.bar {
  flex:1;
  background:#333;
  height:calc(var(--v) * 12px);
  border-radius:6px 6px 0 0;
}

.bar.concluded { background: #4ade80 }
.bar.cancelled { background: #f87171 }
.bar.scheduled { background: #9ca3af }

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

<div class="chart">
  <div class="bar scheduled" style="--v:${stats.scheduled}"></div>
  <div class="bar cancelled" style="--v:${stats.cancelled}"></div>
  <div class="bar concluded" style="--v:${stats.concluded}"></div>
</div>


  <div class="controls">
    <span></span>
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


      return new Response("Not Found", { status: 404 });
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
    private_server_link: body.private_server_link,
    notes: "Hosted from Roblox",
    guild_id: body.guild_id
  });

  return new Response("Event Created");
}

if (url.pathname === "/roblox/event-status" && req.method === "POST") {

  const body = await req.json();

  if (body.key !== env.ROBLOX_SECRET_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ev = await env.DB.prepare(`
    SELECT * FROM events
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind("roblox_" + body.playerId).first();

  if (!ev) {
    return new Response("No event found", { status: 404 });
  }

  const hostMention = `**${body.playerName} (Roblox)**`;

  const newContent =
    body.status === "Cancelled"
      ? `[Cancelled ${ev.event_type}]\n-# (Host: ${hostMention})`
      : `[${ev.event_type}${body.number ? " " + body.number : ""}]\n-# (Host: ${hostMention})`;

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



/* ================== DISCORD ================== */

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

  /* ------------------ /event ------------------ */
  if (name === "event") {
  const opts = Object.fromEntries(
    (interaction.data.options || []).map(o => [o.name, o.value])
  );

  const ADMIN_ROLE_ID = [
  "1429188081050980498", // HiCOM
  "1461724470300512508"  // [PW] STaff
];
  const isEdit = opts.edit === true;
  const isTraining = isTrainingEvent(opts.event_type);

  let existingEvent = null;

  const msg_id = opts.msg_id ?? null;
const canOverride = interaction.member.roles?.some(r =>
  ADMIN_ROLE_ID.includes(r)
);

if (msg_id && !canOverride) {
  return json({
    type: 4,
    data: { content: "🚫 msg_id is ADMIN-only.", flags: 64 }
  });
}

if (isEdit) {
  existingEvent = msg_id && canOverride
    ? await env.DB.prepare(`
        SELECT * FROM events
        WHERE message_id=?
      `).bind(msg_id).first()
    : await env.DB.prepare(`
        SELECT * FROM events
        WHERE user_id=?
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(interaction.member.user.id).first();

  if (!existingEvent) {
    return json({
      type: 4,
      data: {
        content: "❌ No event found to edit.",
        flags: 64
      }
    });
  }


if (!canOverride && existingEvent.user_id !== interaction.member.user.id) {
  return json({
    type: 4,
    data: {
      content: "🚫 You can only edit your own latest event.",
      flags: 64
    }
  });
}

}
   

    const hostUser = interaction.member.user;
    const hostName = hostUser.global_name || hostUser.username;
    const hostMention = `<@${hostUser.id}>`;


    const link =
  isTraining
    ? (opts.private_server_link !== undefined
        ? opts.private_server_link
        : existingEvent?.private_server_link)
    : PREDEFINED_LINK;


if (isTraining && !link) {
  return json({
    type: 4,
    data: {
      content:
        "⚠️ **This training event requires a private server link.**\n" +
        "Please re-run the command and fill in the `private_server_link` option.\n" +
        "-# Sorry for inconvenience... 😔🙏🙇‍♂️",
      flags: 64
    }
  });
}


    const info = isTraining
      ? "STS at pads | PTS is active | Be mature."
      : PREDEFINED_INFO;

    const content =
`- **Event type:** ${opts.event_type}
- **Hosted by:** ${hostMention}
- **Starts at:** ${opts.starts_at}
- **Status:** Scheduled
- **Link:** ${link}
- **Information:** ${info}
- **Note:** ${opts.notes || "N/A"}

<@&${ROLE_ID}>`;

    ctx.waitUntil((async () => {
  if (isEdit) {
    // ✏️ EDIT EXISTING MESSAGE
    await fetch(
      `https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/${existingEvent.message_id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ content })
      }
    );

    await env.DB.prepare(`
      UPDATE events
      SET event_type=?, starts_at=?
      WHERE id=?
    `).bind(
      opts.event_type,
      opts.starts_at,
      existingEvent.id
    ).run();

    await env.DB.prepare(`
      INSERT INTO audit_logs
      (action, actor_id, actor_name, target_id, snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      "EDIT_EVENT",
      interaction.member.user.id,
      interaction.member.user.username,
      existingEvent.id,
      JSON.stringify({ after: opts })
    ).run();

  } else {
    // 🆕 CREATE NEW EVENT
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

    await env.DB.prepare(`
      INSERT INTO events
      (user_id,event_type,host_name,starts_at,status,message_id,channel_id,guild_id)
      VALUES (?,?,?,?, 'Scheduled', ?,?,?)
    `).bind(
      interaction.member.user.id,
      opts.event_type,
      hostName,
      opts.starts_at,
      msg.id,
      TARGET_CHANNEL_ID,
      interaction.guild_id
    ).run();
  }
})());


    return json({
      type: 4,
      data: { content: "✅ Event posted", flags: 64 }
    });
  }

  /* ------------------ /event-status ------------------ */
/* ------------------ /event-status ------------------ */
if (name === "event-status") {
  const opts = Object.fromEntries(
    (interaction.data.options || []).map(o => [o.name, o.value])
  );

  const userId = interaction.member.user.id;
  const eventNumber = opts.number ?? "";

  const ADMIN_ROLE_ID = [
    "1429188081050980498", // HiCOM
    "1461724470300512508"  // [PW] Staff
  ];

  const canOverride =
    Array.isArray(interaction.member.roles) &&
    interaction.member.roles.some(r => ADMIN_ROLE_ID.includes(r));

  const isEdit = opts.edit === true;

  /* ---------- msg_id handling ---------- */
  const msg_id = opts.msg_id ?? null;

  if (msg_id && !canOverride) {
    return json({
      type: 4,
      data: { content: "🚫 msg_id is ADMIN-only.", flags: 64 }
    });
  }

  /* ---------- FETCH EVENT ---------- */
  const ev = msg_id && canOverride
    ? await env.DB.prepare(`
        SELECT * FROM events
        WHERE message_id=?
      `).bind(msg_id).first()
    : await env.DB.prepare(`
        SELECT * FROM events
        WHERE user_id=?
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(userId).first();

  if (!ev) {
    return json({
      type: 4,
      data: { content: "❌ Event not found.", flags: 64 }
    });
  }

  if (!canOverride && ev.user_id !== userId) {
    return json({
      type: 4,
      data: {
        content: "🚫 You can only edit your own latest event status.",
        flags: 64
      }
    });
  }

  /* ---------- STATUS RULES ---------- */
  if (opts.status === "Concluded" && !opts.number) {
    return json({
      type: 4,
      data: {
        content: "❌ Concluded events require a number (e.g. CT 3).",
        flags: 64
      }
    });
  }

  if (ev.status !== "Scheduled" && !isEdit) {
    return json({
      type: 4,
      data: {
        content:
          "❌ You cannot edit the status of an event that is not Scheduled.\n" +
          "Use edit mode to override.",
        flags: 64
      }
    });
  }

  /* ---------- BUILD MESSAGE ---------- */
  const hostMention = `<@${ev.user_id}>`;

  const newContent =
    opts.status === "Cancelled"
      ? `[Cancelled ${ev.event_type}]\n-# (Host: ${hostMention})`
      : `[${ev.event_type}${eventNumber ? " " + eventNumber : ""}]\n-# (Host: ${hostMention})`;

  /* ---------- IMMEDIATE RESPONSE ---------- */
  const response = json({
    type: 4,
    data: { content: "🔄 Status updated", flags: 64 }
  });

  /* ---------- BACKGROUND WORK ---------- */
  ctx.waitUntil((async () => {
    try {
      await env.DB.prepare(
        "UPDATE events SET status=? WHERE id=?"
      ).bind(opts.status, ev.id).run();

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

      await env.DB.prepare(`
        INSERT INTO audit_logs
        (action, actor_id, actor_name, target_id, snapshot)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        "EVENT_STATUS_UPDATE",
        userId,
        interaction.member.user.username,
        ev.id,
        JSON.stringify({
          before: ev.status,
          after: opts.status,
          msg_id: ev.message_id
        })
      ).run();

    } catch (err) {
      console.error("🔥 event-status failed:", err);
    }
  })());

  return response;
}





  /* ---- UNKNOWN SLASH COMMAND ---- */
  return json({
    type: 4,
    data: { content: "Unknown command", flags: 64 }
  });
}
    return json({ type: 4, data: { content: "Unknown command" }});
} 
   catch (err) {
      console.error("🔥 WORKER CRASH:", err);
      return new Response(
        "Internal Error (1101). Check logs.",
        { status: 500 })};
}
};
