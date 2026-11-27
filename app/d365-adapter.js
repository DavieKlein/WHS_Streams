// D365 F&O connection: OAuth2 client credentials (Entra ID) + read-only OData via the GET-only client.
// Secrets stay in this process: never returned to the browser, never logged.
const { createReadOnlyClient } = require("./lib/readonly-http");
const credentialStore = require("./windows-credential-store");

const CREDENTIAL_TARGET = "StroomViewer:D365";
const ENV_LABELS = ["DEV", "TEST", "ACC", "PROD"];

let connection = null;      // { environmentUrl, tenantId, clientId, clientSecret, label, source }
let restoreTried = false;
let cachedToken = null;
let metadata = null;        // { fetchedAt, entitySets: Map(name -> {entityType, properties[]}) }
let client = createReadOnlyClient();

function httpError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }

function cleanUrl(url) {
  const u = String(url || "").trim().replace(/\/+$/, "").replace(/\/data$/i, "");
  let parsed;
  try { parsed = new URL(u); } catch { throw httpError("Environment URL is geen geldige URL.", 400); }
  if (parsed.protocol !== "https:") throw httpError("Environment URL moet met https:// beginnen.", 400);
  return parsed.origin;
}

function validate(input) {
  const c = {
    environmentUrl: cleanUrl(input.environmentUrl),
    tenantId: String(input.tenantId || "").trim(),
    clientId: String(input.clientId || "").trim(),
    clientSecret: String(input.clientSecret || ""),
    label: ENV_LABELS.includes(String(input.label || "").toUpperCase()) ? String(input.label).toUpperCase() : "ACC"
  };
  if (!/^[0-9a-f-]{36}$/i.test(c.tenantId) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.tenantId)) throw httpError("Tenant ID moet een GUID of domeinnaam zijn.", 400);
  if (!/^[0-9a-f-]{36}$/i.test(c.clientId)) throw httpError("Client ID moet een GUID zijn.", 400);
  if (!c.clientSecret) throw httpError("Client secret ontbreekt.", 400);
  return c;
}

/** Startup: env var JSON, separate env vars (.env) or the DM Quality Tool's variable. */
function initFromEnv() {
  const json = process.env.STROOM_D365_CONNECTION || process.env.DM_QUALITY_D365_CONNECTION;
  const varName = process.env.STROOM_D365_CONNECTION ? "STROOM_D365_CONNECTION" : "DM_QUALITY_D365_CONNECTION";
  try {
    if (json) {
      connection = { ...validate(JSON.parse(json)), source: "env" };
      if (process.env.STROOM_D365_ENV_LABEL) connection.label = validate({ ...connection, label: process.env.STROOM_D365_ENV_LABEL }).label;
      console.log(`D365: connection from ${varName} (${connection.environmentUrl}).`);
    } else if (process.env.STROOM_D365_ENVIRONMENT_URL) {
      connection = { ...validate({
        environmentUrl: process.env.STROOM_D365_ENVIRONMENT_URL, tenantId: process.env.STROOM_D365_TENANT_ID,
        clientId: process.env.STROOM_D365_CLIENT_ID, clientSecret: process.env.STROOM_D365_CLIENT_SECRET,
        label: process.env.STROOM_D365_ENV_LABEL
      }), source: "env" };
      console.log(`D365: connection from .env/STROOM_D365_* (${connection.environmentUrl}).`);
    }
  } catch (error) {
    console.error(`D365: connection in environment variables is invalid: ${error.message}`);
  }
  if (connection) restoreTried = true; // env wins, Credential Manager is never read
}

async function restoreRemembered() {
  if (restoreTried) return;
  restoreTried = true;
  if (!credentialStore.supported) return;
  try {
    const raw = await credentialStore.readCredential(CREDENTIAL_TARGET);
    if (raw) connection = { ...validate(JSON.parse(raw)), source: "credential-manager" };
  } catch (error) {
    console.error(`D365: could not read Credential Manager: ${error.message}`);
  }
}

async function getAccessToken(c = connection) {
  if (!c) throw httpError("Geen D365-verbinding ingesteld.", 409);
  if (c === connection && cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret, scope: `${c.environmentUrl}/.default` })
  }).catch((e) => { throw httpError(`Entra ID niet bereikbaar: ${e.message}`, 502); });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(`D365-authenticatie mislukt: ${payload.error_description || payload.error || response.statusText}`, 401);
  const token = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in || 3600) * 1000 };
  if (c === connection) cachedToken = token;
  return token.value;
}

function status() {
  if (!connection) return { mode: "sample", credentialManager: credentialStore.supported };
  return {
    mode: "live", environmentUrl: connection.environmentUrl, tenantId: connection.tenantId, clientId: connection.clientId,
    label: connection.label, source: connection.source, credentialManager: credentialStore.supported,
    metadataFetchedAt: metadata ? metadata.fetchedAt : null
  };
}

async function connect(input) {
  const c = validate(input);
  await getAccessToken(c); // fail on Connect, not later
  connection = { ...c, source: "manual" };
  cachedToken = null; metadata = null; restoreTried = true;
  let remembered = false, rememberError = null;
  if (input.remember) {
    try {
      const { source, ...toStore } = connection;
      await credentialStore.writeCredential(CREDENTIAL_TARGET, JSON.stringify(toStore));
      remembered = true;
    } catch (error) { rememberError = error.message; }
  }
  return { ...status(), remembered, rememberError };
}

function disconnect() {
  // Forgets the in-memory connection only; a remembered credential stays in Windows Credential Manager.
  connection = null; cachedToken = null; metadata = null;
  return status();
}

async function odataGet(pathOrUrl, accept) {
  if (!connection) throw httpError("Geen D365-verbinding ingesteld.", 409);
  const url = /^https:\/\//i.test(pathOrUrl) ? pathOrUrl : `${connection.environmentUrl}/data/${pathOrUrl}`;
  if (!url.startsWith(connection.environmentUrl + "/")) throw httpError("URL hoort niet bij de ingestelde omgeving.", 400);
  const token = await getAccessToken();
  const response = await client.get(url, { token, accept, headers: { Prefer: "odata.maxpagesize=5000", "OData-Version": "4.0" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 300);
    try { const j = JSON.parse(body); detail = (j.error && (j.error.message || (j.error.innererror && j.error.innererror.message))) || detail; } catch {}
    throw httpError(`D365 gaf ${response.status} ${response.statusText} op ${url.replace(connection.environmentUrl, "")}: ${detail}`, response.status === 401 || response.status === 403 ? response.status : 502);
  }
  return response;
}

async function testConnection() {
  const started = Date.now();
  const response = await odataGet("", "application/json");
  const body = await response.json().catch(() => ({}));
  return { ok: true, ms: Date.now() - started, entitySets: Array.isArray(body.value) ? body.value.length : null };
}

/** $metadata is tens of MB: fetched once per process and parsed with a light regex scan. */
async function getMetadata(force) {
  if (metadata && !force) return metadata;
  const response = await odataGet("$metadata", "application/xml");
  const xml = await response.text();
  const types = new Map();
  const typeRe = /<EntityType\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  let m;
  while ((m = typeRe.exec(xml))) {
    const props = [];
    const propRe = /<Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
    let p;
    while ((p = propRe.exec(m[2]))) props.push({ name: p[1], type: p[2].replace(/^Microsoft\.Dynamics\.DataEntities\./, "") });
    types.set(m[1], props);
  }
  const entitySets = new Map();
  const setRe = /<EntitySet\s+Name="([^"]+)"\s+EntityType="([^"]+)"/g;
  while ((m = setRe.exec(xml))) {
    const typeName = m[2].split(".").pop();
    entitySets.set(m[1], { entityType: typeName, properties: types.get(typeName) || [] });
  }
  metadata = { fetchedAt: new Date().toISOString(), entitySets, sizeMb: Math.round(xml.length / 1e5) / 10 };
  return metadata;
}

async function searchMetadata(query) {
  const md = await getMetadata();
  const q = String(query || "").toLowerCase().trim();
  if (q.length < 2) throw httpError("Zoekterm moet minstens 2 tekens zijn.", 400);
  const hits = [];
  for (const [name, info] of md.entitySets) {
    if (name.toLowerCase().includes(q) || info.entityType.toLowerCase().includes(q) || info.properties.some((p) => p.name.toLowerCase().includes(q))) {
      hits.push({ entitySet: name, entityType: info.entityType, properties: info.properties.map((p) => p.name) });
    }
    if (hits.length >= 40) break;
  }
  return { fetchedAt: md.fetchedAt, total: md.entitySets.size, hits };
}

function fieldsOf(spec) { return String(spec || "").split("+").map((f) => f.trim()).filter(Boolean); }

async function checkEntities(config) {
  const md = await getMetadata();
  const result = {};
  for (const [id, src] of Object.entries(config.sources)) {
    if (!src.entitySet) { result[id] = { status: "not-configured", missing: [] }; continue; }
    const set = md.entitySets.get(src.entitySet);
    if (!set) { result[id] = { status: "missing-entity", missing: [src.entitySet] }; continue; }
    const names = new Set(set.properties.map((p) => p.name));
    const wanted = Object.values(src.fields).flatMap(fieldsOf).concat([src.legalEntityField, src.warehouseField].filter(Boolean));
    const missing = Array.from(new Set(wanted.filter((f) => !names.has(f))));
    result[id] = { status: missing.length ? "missing-fields" : "ok", missing };
  }
  return { fetchedAt: md.fetchedAt, result };
}

/**
 * Finds, per source, the entity set in $metadata whose properties contain all 'match' fields
 * (field names from the CDM schema of the standard entities). Ties: fewest extra properties.
 */
async function autoDetect(config) {
  const md = await getMetadata();
  const result = {};
  for (const [id, src] of Object.entries(config.sources)) {
    const match = src.match || [];
    if (!match.length) { result[id] = { status: "skipped", candidates: [] }; continue; }
    const hint = String(src.cdmEntity || "").replace(/^(WHS|WMS)/, "").replace(/Entity$/, "").toLowerCase();
    const candidates = [];
    for (const [name, info] of md.entitySets) {
      const names = new Set(info.properties.map((p) => p.name));
      if (match.every((f) => names.has(f))) {
        const nameHit = hint && (name.toLowerCase().includes(hint) || info.entityType.toLowerCase().includes(hint)) ? 0 : 1;
        candidates.push({ entitySet: name, entityType: info.entityType, extra: info.properties.length - match.length, nameHit });
      }
    }
    candidates.sort((a, b) => a.nameHit - b.nameHit || a.extra - b.extra || a.entitySet.localeCompare(b.entitySet));
    result[id] = { status: candidates.length ? "found" : "not-found", chosen: candidates[0] ? candidates[0].entitySet : "", candidates: candidates.slice(0, 5).map((c) => c.entitySet) };
  }
  return { fetchedAt: md.fetchedAt, result };
}

const SAFE_CODE = /^[A-Za-z0-9_-]{1,20}$/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fetches one source with $select / $filter and paging; maps rows to the internal flat model. */
async function fetchSource(src, scope, maxPages = 200) {
  const select = Array.from(new Set(Object.values(src.fields).flatMap(fieldsOf)));
  if (!SAFE_FIELD.test(src.entitySet) || select.some((f) => !SAFE_FIELD.test(f))) throw httpError(`Ongeldige entiteit- of veldnaam in de mapping van ${src.label}.`, 400);
  const filters = [];
  if (src.legalEntityField && scope.legalEntity) {
    if (!SAFE_CODE.test(scope.legalEntity)) throw httpError("Ongeldige legal entity-code.", 400);
    filters.push(`${src.legalEntityField} eq '${scope.legalEntity}'`);
  }
  if (src.warehouseField && scope.warehouse) {
    if (!SAFE_CODE.test(scope.warehouse)) throw httpError("Ongeldige warehouse-code.", 400);
    filters.push(`${src.warehouseField} eq '${scope.warehouse}'`);
  }
  const params = new URLSearchParams({ $select: select.join(",") });
  if (filters.length) params.set("$filter", filters.join(" and "));
  params.set("cross-company", "true");
  let next = `${src.entitySet}?${params.toString()}`;
  const rows = [];
  let pages = 0;
  while (next) {
    if (++pages > maxPages) throw httpError(`${src.label}: meer dan ${maxPages} pagina's, ophalen gestopt.`, 502);
    const body = await (await odataGet(next, "application/json")).json();
    for (const r of body.value || []) {
      const out = {};
      for (const [k, spec] of Object.entries(src.fields)) out[k] = fieldsOf(spec).map((f) => (r[f] === null || r[f] === undefined ? "" : r[f])).join("|");
      rows.push(out);
    }
    next = body["@odata.nextLink"] || null;
  }
  return rows;
}

function _setClientForTests(c) { client = c; }

module.exports = {
  initFromEnv, restoreRemembered, status, connect, disconnect, testConnection, searchMetadata, checkEntities, autoDetect, fetchSource,
  getAccessToken, ENV_LABELS, _setClientForTests, _setConnectionForTests: (c) => { connection = c; metadata = null; cachedToken = c ? { value: "test", expiresAt: Date.now() + 3600e3 } : null; }
};
