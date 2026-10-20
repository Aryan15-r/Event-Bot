import fs from 'node:fs';
import path from 'node:path';

// Load token from process.env or .dev.vars if available
let token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID || "1466474283235545143";
const guildId = process.env.GUILD_ID || "1429172254981492798";

if (!token) {
  try {
    const devVarsPath = path.resolve('.dev.vars');
    if (fs.existsSync(devVarsPath)) {
      const content = fs.readFileSync(devVarsPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [k, ...v] = trimmed.split('=');
          if (k.trim() === 'DISCORD_BOT_TOKEN') {
            token = v.join('=').trim();
          }
        }
      }
    }
  } catch {}
}

if (!token) {
  console.error("❌ Error: DISCORD_BOT_TOKEN environment variable is required.");
  console.error("Set it in .dev.vars or pass via environment variable: $env:DISCORD_BOT_TOKEN='your_token'");
  process.exit(1);
}

const commandsUrl = new URL('./commands.json', import.meta.url);
const commands = JSON.parse(fs.readFileSync(commandsUrl, 'utf8'));

async function register() {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    }
  );

  if (response.ok) {
    console.log('✅ Commands registered successfully!');
  } else {
    console.error('❌ Error registering commands:', await response.text());
  }
}

register();