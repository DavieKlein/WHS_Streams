// Minimal .env reader (no dependency). Values already in process.env win.
const fs = require("fs");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) { process.env[m[1]] = value; loaded.push(m[1]); }
  }
  return loaded; // names only, never values
}

module.exports = { loadEnvFile };
