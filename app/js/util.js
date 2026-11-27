/* Small shared helpers. */
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
  let response;
  try { response = await fetch(path, init); }
  catch { throw new Error("De lokale server reageert niet. Draait 'node app/server.js' nog?"); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

function message(target, text, kind) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (!el) return;
  el.innerHTML = text ? `<div class="message ${kind || ""}">${escapeHtml(text)}</div>` : "";
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusTag(status) {
  const label = { complete: "Compleet", incomplete: "Onvolledig", conflict: "Conflict" }[status] || status;
  return `<span class="status-tag ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Reads design tokens from CSS so the SVG export uses the same colours as the screen. */
function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Category line styles: meaning never by colour alone. */
const FLOW_STYLE = {
  inkoop: { dash: "", token: "--flow-inkoop" },
  verkoop: { dash: "10 5", token: "--flow-verkoop" },
  aanvulling: { dash: "3 4", token: "--flow-aanvulling" },
  productie: { dash: "12 4 3 4", token: "--flow-productie" },
  transfer: { dash: "6 3", token: "--flow-transfer" },
  overig: { dash: "2 3", token: "--flow-overig" }
};
function flowColour(category) { return cssToken((FLOW_STYLE[category] || FLOW_STYLE.overig).token); }
