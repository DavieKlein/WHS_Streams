// Local files: settings, entity mapping, cache, query ranges and layouts.
// Everything customer-specific lives in /data (git-ignored). /sample-data is the fictional demo warehouse.
const fs = require("fs");
const path = require("path");
const Core = require("./js/core");
const d365 = require("./d365-adapter");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.STROOM_DATA_DIR ? path.resolve(process.env.STROOM_DATA_DIR) : path.join(ROOT, "data");
const SAMPLE = path.join(ROOT, "sample-data");
const SOURCES = ["locations", "zones", "profiles", "workClasses", "directives", "directiveLines", "directiveActions", "templates", "templateLines"];

function httpError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }

// ---------- settings ----------
const settingsFile = () => path.join(DATA, "settings.json");
function getSettings() {
  return { dataMode: "sample", legalEntity: "", warehouse: "", ...readJson(settingsFile(), {}) };
}
function saveSettings(input) {
  const s = getSettings();
  if (input.dataMode !== undefined) {
    if (!["sample", "live"].includes(input.dataMode)) throw httpError("dataMode moet sample of live zijn.", 400);
    s.dataMode = input.dataMode;
  }
  for (const k of ["legalEntity", "warehouse"]) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).trim();
    if (v && !/^[A-Za-z0-9_-]{1,20}$/.test(v)) throw httpError(`Ongeldige waarde voor ${k}.`, 400);
    s[k] = v;
  }
  writeJson(settingsFile(), s);
  return s;
}

// ---------- entity mapping ----------
function getEntities() {
  const base = readJson(path.join(ROOT, "config", "entities.json"), { sources: {} });
  const custom = readJson(path.join(DATA, "entities.json"), null);
  return { config: custom || base, customised: !!custom };
}
function saveEntities(input) {
  if (!input || typeof input.sources !== "object") throw httpError("Mapping moet een object 'sources' bevatten.", 400);
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const [id, src] of Object.entries(input.sources)) {
    if (src.entitySet && !ident.test(src.entitySet)) throw httpError(`Ongeldige entity set bij ${id}.`, 400);
    for (const f of Object.values(src.fields || {})) for (const part of String(f).split("+").filter(Boolean)) {
      if (!ident.test(part.trim())) throw httpError(`Ongeldige veldnaam "${part}" bij ${id}.`, 400);
    }
  }
  writeJson(path.join(DATA, "entities.json"), input);
  return getEntities();
}
function resetEntities() {
  try { fs.unlinkSync(path.join(DATA, "entities.json")); } catch {}
  return getEntities();
}

// ---------- query ranges ----------
const rangesFile = () => path.join(DATA, "query-ranges.csv");
function queryRangesStatus() {
  if (!fs.existsSync(rangesFile())) return { present: false };
  const parsed = Core.parseQueryRangesCsv(fs.readFileSync(rangesFile(), "utf8"));
  return { present: true, rows: parsed.rows.length, errors: parsed.errors.slice(0, 20), savedAt: fs.statSync(rangesFile()).mtime.toISOString() };
}
function saveQueryRanges(csv) {
  const parsed = Core.parseQueryRangesCsv(String(csv || ""));
  if (!parsed.rows.length) throw httpError(parsed.errors[0] || "Geen geldige regels gevonden.", 400);
  ensureDir(DATA);
  fs.writeFileSync(rangesFile(), String(csv));
  return { ...queryRangesStatus(), errors: parsed.errors.slice(0, 20) };
}

// ---------- dataset ----------
function cacheDir(settings) {
  const st = d365.status();
  const env = st.mode === "live" ? new URL(st.environmentUrl).hostname : "geen-omgeving";
  return path.join(DATA, "cache", env, `${settings.legalEntity || "alle"}_${settings.warehouse || "alle"}`);
}

function sampleDataset() {
  const flat = {};
  for (const s of SOURCES) flat[s] = readJson(path.join(SAMPLE, "wh01", `${s}.json`), []);
  flat.queryRanges = Core.parseQueryRangesCsv(fs.readFileSync(path.join(SAMPLE, "wh01", "query-ranges.csv"), "utf8")).rows;
  return { mode: "sample", fetchedAt: null, rangesSource: "sample-data/wh01/query-ranges.csv", flat, counts: counts(flat) };
}

function counts(flat) {
  const c = {};
  for (const [k, v] of Object.entries(flat)) c[k] = Array.isArray(v) ? v.length : 0;
  return c;
}

function getDataset() {
  const settings = getSettings();
  if (settings.dataMode !== "live") return sampleDataset();
  const dir = cacheDir(settings);
  const meta = readJson(path.join(dir, "_meta.json"), null);
  if (!meta) return { mode: "live", fetchedAt: null, empty: true, flat: emptyFlat(), counts: {}, message: "Nog geen live data opgehaald. Gebruik 'Ververs data' op het tabblad Koppeling." };
  const flat = {};
  for (const s of SOURCES) flat[s] = readJson(path.join(dir, `${s}.json`), []);
  let rangesSource = "geen";
  flat.queryRanges = [];
  const fromEntity = readJson(path.join(dir, "queryRanges.json"), null);
  if (fromEntity && fromEntity.length) { flat.queryRanges = fromEntity.map((r) => ({ ...r, source: String(r.source).toLowerCase() })); rangesSource = "X++-export (OData)"; }
  else if (fs.existsSync(rangesFile())) { flat.queryRanges = Core.parseQueryRangesCsv(fs.readFileSync(rangesFile(), "utf8")).rows; rangesSource = "data/query-ranges.csv"; }
  return { mode: "live", fetchedAt: meta.fetchedAt, environment: meta.environment, scope: meta.scope, rangesSource, flat, counts: counts(flat), errors: meta.errors || [] };
}
function emptyFlat() { const f = { queryRanges: [] }; for (const s of SOURCES) f[s] = []; return f; }

async function refreshLive() {
  const settings = getSettings();
  const st = d365.status();
  if (st.mode !== "live") throw httpError("Eerst verbinden met D365 (tabblad Koppeling).", 409);
  if (!settings.legalEntity) throw httpError("Vul eerst de legal entity in.", 400);
  const { config } = getEntities();
  const dir = cacheDir(settings);
  ensureDir(dir);
  const results = {}, errors = [];
  for (const [id, src] of Object.entries(config.sources)) {
    if (!src.entitySet) { results[id] = { skipped: true }; continue; }
    try {
      const rows = await d365.fetchSource(src, settings);
      writeJson(path.join(dir, `${id}.json`), rows);
      results[id] = { rows: rows.length };
    } catch (error) {
      errors.push({ source: id, label: src.label, message: error.message });
      results[id] = { error: error.message };
    }
  }
  const meta = { fetchedAt: new Date().toISOString(), environment: st.environmentUrl, label: st.label, scope: settings, results, errors };
  writeJson(path.join(dir, "_meta.json"), meta);
  return meta;
}

/** Query texts from the standard entities in the cache: parse status + a few samples (to extend the parser). */
function querySamples() {
  const ds = getDataset();
  const out = {};
  for (const id of ["directives", "directiveActions", "templates"]) {
    const rows = (ds.flat[id] || []).filter((r) => r.query !== undefined);
    const stats = { rows: rows.length, parsed: 0, empty: 0, unknown: 0 };
    const samples = [];
    for (const r of rows) {
      const q = Core.parseQueryText(r.query);
      stats[q.status]++;
      if (r.query && samples.length < 2 && (q.status === "unknown" || samples.length === 0)) samples.push({ status: q.status, text: String(r.query).slice(0, 1500) });
    }
    out[id] = { ...stats, samples };
  }
  return { mode: ds.mode, fetchedAt: ds.fetchedAt, sources: out };
}

// ---------- layouts ----------
const SAFE_WH = /^[A-Za-z0-9_-]{1,20}$/;
function getLayout(warehouse) {
  if (!SAFE_WH.test(warehouse)) throw httpError("Ongeldige warehouse-code.", 400);
  const saved = readJson(path.join(DATA, "layouts", `${warehouse}.json`), null);
  if (saved) return { source: "saved", layout: saved };
  const example = getSettings().dataMode === "sample" ? readJson(path.join(SAMPLE, "layouts", `${warehouse}.json`), null) : null;
  if (example) return { source: "example", layout: example };
  return { source: "new", layout: { warehouse, grid: { cellMeters: 1, width: 120, height: 80 }, shapes: [] } };
}
function saveLayout(warehouse, layout) {
  if (!SAFE_WH.test(warehouse)) throw httpError("Ongeldige warehouse-code.", 400);
  if (!layout || !Array.isArray(layout.shapes) || !layout.grid) throw httpError("Layout mist 'grid' of 'shapes'.", 400);
  const types = new Set(["zone", "aisle", "location", "point"]);
  const shapes = layout.shapes.map((s) => {
    if (!types.has(s.type)) throw httpError(`Onbekend vlaktype "${s.type}".`, 400);
    const n = (v) => { const x = Number(v); if (!Number.isFinite(x)) throw httpError("Coördinaten moeten getallen zijn.", 400); return x; };
    return { id: String(s.id), type: s.type, ref: String(s.ref || ""), role: s.role ? String(s.role) : undefined, label: String(s.label || ""),
      x: n(s.x), y: n(s.y), w: n(s.w), h: n(s.h), rotation: n(s.rotation || 0) };
  });
  const clean = { warehouse, grid: { cellMeters: Number(layout.grid.cellMeters) || 1, width: Number(layout.grid.width) || 120, height: Number(layout.grid.height) || 80 }, shapes, savedAt: new Date().toISOString() };
  writeJson(path.join(DATA, "layouts", `${warehouse}.json`), clean);
  return { source: "saved", layout: clean };
}

module.exports = { querySamples, getSettings, saveSettings, getEntities, saveEntities, resetEntities, queryRangesStatus, saveQueryRanges, getDataset, refreshLive, getLayout, saveLayout, DATA };
