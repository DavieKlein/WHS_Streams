/* Tab "Koppeling": D365 F&O connection, scope, entity mapping, $metadata check and query ranges. */
const ConnectTab = (() => {
  const SOURCE_LABEL = { env: "Omgevingsvariabele / .env", "credential-manager": "Windows Credential Manager", manual: "Ingevuld in deze sessie" };

  function init() {
    document.getElementById("connForm").addEventListener("submit", connect);
    document.getElementById("connStatus").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      if (b.dataset.action === "test") return testConnection(b);
      if (b.dataset.action === "disconnect") {
        if (!confirm("Verbinding in het geheugen van de server vergeten? Een onthouden verbinding blijft in Windows Credential Manager staan.")) return;
        state.d365 = await api("/api/d365/connection", { method: "DELETE" }).catch((err) => { message("connMessage", err.message, "error"); return state.d365; });
        render(); App.renderHeader();
      }
    });
    document.getElementById("saveScope").addEventListener("click", saveScope);
    document.getElementById("refreshData").addEventListener("click", refreshData);
    document.getElementById("checkEntities").addEventListener("click", checkEntities);
    document.getElementById("autoDetect").addEventListener("click", autoDetect);
    document.getElementById("saveEntities").addEventListener("click", saveEntities);
    document.getElementById("resetEntities").addEventListener("click", resetEntities);
    document.getElementById("mdSearch").addEventListener("click", searchMetadata);
    document.getElementById("mdQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchMetadata(); } });
    document.getElementById("mdResults").addEventListener("click", (e) => {
      const b = e.target.closest("[data-use]");
      if (!b) return;
      const target = b.parentElement.querySelector("select").value;
      if (!target) return;
      const input = document.querySelector(`#entitiesTable [data-src="${target}"][data-key="entitySet"]`);
      if (input) { input.value = b.dataset.use; input.closest("details").open = true; message("entitiesMessage", `${b.dataset.use} ingevuld bij ${state.entities.config.sources[target].label}. Vergeet niet op te slaan.`); }
    });
    document.getElementById("rangesFile").addEventListener("change", uploadRanges);
    document.getElementById("rangesTemplate").addEventListener("click", () =>
      downloadBlob(new Blob(["bron,recId,tabel,veld,waarde\ndirective,5637144576,InventItemGroupItem,ItemGroupId,KOEL\naction,5637144578,WMSLocation,zoneId,KOEL\n"], { type: "text/csv" }), "query-ranges-sjabloon.csv"));
  }

  async function load() {
    try {
      const [entities, ranges, samples] = await Promise.all([api("/api/entities"), api("/api/query-ranges"), api("/api/data/query-samples")]);
      state.entities = entities;
      state.rangesStatus = ranges;
      state.querySamples = samples;
    } catch (error) { message("entitiesMessage", `Mapping laden mislukt: ${error.message}`, "error"); }
    render();
  }

  function render() {
    renderStatus();
    const s = state.settings;
    document.getElementById("dataMode").value = s.dataMode;
    document.getElementById("scopeLe").value = s.legalEntity || "";
    document.getElementById("scopeWh").value = s.warehouse || "";
    document.getElementById("refreshData").disabled = state.d365.mode !== "live";
    renderEntities();
    renderRanges();
  }

  function renderStatus() {
    const d = state.d365;
    const el = document.getElementById("connStatus");
    if (d.mode !== "live") {
      el.innerHTML = `<div class="message warn">Niet verbonden. De app draait op de fictieve voorbeelddata.</div>
        <p class="hint">Verbinden kan op drie manieren (in deze volgorde): <span class="mono">STROOM_D365_*</span> in <span class="mono">.env</span>
        (of <span class="mono">DM_QUALITY_D365_CONNECTION</span> van de DM Quality Tool), een onthouden verbinding in Windows Credential Manager, of het formulier hieronder.</p>`;
      document.getElementById("connFormPanel").open = true;
      return;
    }
    el.innerHTML = `
      <dl class="kv">
        <dt>Omgeving</dt><dd><span class="status-pill ${d.label === "PROD" ? "prod" : "connected"}">${escapeHtml(d.label)}</span></dd>
        <dt>URL</dt><dd class="mono">${escapeHtml(d.environmentUrl)}</dd>
        <dt>Tenant ID</dt><dd class="mono">${escapeHtml(d.tenantId)}</dd>
        <dt>Client ID</dt><dd class="mono">${escapeHtml(d.clientId)}</dd>
        <dt>Bron</dt><dd>${escapeHtml(SOURCE_LABEL[d.source] || d.source)}</dd>
        <dt>Client secret</dt><dd>Ingesteld (alleen in het Node-proces)</dd>
        <dt>$metadata</dt><dd>${d.metadataFetchedAt ? "Gelezen " + escapeHtml(fmtDateTime(d.metadataFetchedAt)) : "Nog niet gelezen"}</dd>
      </dl>
      ${d.label === "PROD" ? `<div class="message error">Let op: dit is een productieomgeving. De tool leest alleen (GET), maar haal grote volumes bij voorkeur buiten kantoortijd op.</div>` : ""}
      <div class="btn-row">
        <button class="btn-quiet btn-small" data-action="test">Test verbinding</button>
        ${d.source !== "env" ? `<button class="btn-quiet btn-small btn-danger" data-action="disconnect">Verbinding vergeten</button>` : ""}
      </div>
      <div id="testMessage"></div>`;
    const form = document.getElementById("connForm");
    form.environmentUrl.value = d.environmentUrl; form.tenantId.value = d.tenantId; form.clientId.value = d.clientId; form.label.value = d.label;
  }

  async function connect(e) {
    e.preventDefault();
    const f = e.target;
    const btn = document.getElementById("connectBtn");
    btn.disabled = true; btn.innerHTML = `Verbinden<span class="spinner"></span>`;
    message("connMessage", "");
    try {
      const result = await api("/api/d365/connection", { method: "POST", body: {
        environmentUrl: f.environmentUrl.value, tenantId: f.tenantId.value, clientId: f.clientId.value,
        clientSecret: f.clientSecret.value, label: f.label.value, remember: f.remember.checked } });
      f.clientSecret.value = "";
      state.d365 = result;
      message("connMessage", `Verbonden met ${result.environmentUrl} (${result.label}). Token aangevraagd.` +
        (f.remember.checked ? (result.remembered ? " Onthouden in Windows Credential Manager." : ` Onthouden lukte niet: ${result.rememberError}`) : ""), result.rememberError ? "warn" : "good");
      render(); App.renderHeader();
    } catch (error) {
      message("connMessage", `Verbinden mislukt: ${error.message}`, "error");
    } finally {
      btn.disabled = false; btn.textContent = "Verbinden";
    }
  }

  async function testConnection(btn) {
    btn.disabled = true; btn.innerHTML = `Test verbinding<span class="spinner"></span>`;
    try {
      const r = await api("/api/d365/test");
      message("testMessage", `OData bereikbaar in ${r.ms} ms${r.entitySets !== null ? `, ${r.entitySets} entity sets` : ""}.`, "good");
    } catch (error) { message("testMessage", `Test mislukt: ${error.message}`, "error"); }
    finally { btn.disabled = false; btn.textContent = "Test verbinding"; }
  }

  async function saveScope() {
    try {
      const before = state.settings.dataMode;
      state.settings = await api("/api/settings", { method: "POST", body: {
        dataMode: document.getElementById("dataMode").value,
        legalEntity: document.getElementById("scopeLe").value, warehouse: document.getElementById("scopeWh").value } });
      message("scopeMessage", "Scope opgeslagen.", "good");
      if (before !== state.settings.dataMode || state.settings.dataMode === "live") await App.loadData();
    } catch (error) { message("scopeMessage", `Opslaan mislukt: ${error.message}`, "error"); }
  }

  async function refreshData() {
    const btn = document.getElementById("refreshData");
    btn.disabled = true; btn.innerHTML = `Ververs data<span class="spinner"></span>`;
    message("scopeMessage", "Bezig met ophalen uit D365. Dit kan bij grote magazijnen even duren…");
    try {
      await saveScopeSilently();
      const meta = await api("/api/data/refresh", { method: "POST" });
      const rows = Object.entries(meta.results).map(([id, r]) => {
        const label = (state.entities.config.sources[id] || {}).label || id;
        const res = r.skipped ? '<span class="status-tag none">Niet ingesteld</span>' : r.error ? `<span class="status-tag errors">Fout</span> ${escapeHtml(r.error)}` : `${r.rows} rijen`;
        return `<tr><td>${escapeHtml(label)}</td><td>${res}</td></tr>`;
      });
      document.getElementById("refreshResult").innerHTML = `<div class="table-wrap"><table class="simple-table"><thead><tr><th>Bron</th><th>Resultaat</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
      message("scopeMessage", meta.errors.length ? `Opgehaald met ${meta.errors.length} fout(en). Controleer de mapping.` : `Alles opgehaald (${fmtDateTime(meta.fetchedAt)}).`, meta.errors.length ? "warn" : "good");
      if (state.settings.dataMode !== "live") {
        state.settings = await api("/api/settings", { method: "POST", body: { dataMode: "live" } });
        document.getElementById("dataMode").value = "live";
      }
      await App.loadData();
      state.querySamples = await api("/api/data/query-samples");
      renderRanges();
    } catch (error) {
      message("scopeMessage", `Ophalen mislukt: ${error.message}`, "error");
    } finally {
      btn.disabled = state.d365.mode !== "live"; btn.textContent = "Ververs data";
    }
  }
  async function saveScopeSilently() {
    state.settings = await api("/api/settings", { method: "POST", body: {
      legalEntity: document.getElementById("scopeLe").value, warehouse: document.getElementById("scopeWh").value } });
  }

  // ---------- entity mapping ----------
  function renderEntities() {
    const el = document.getElementById("entitiesTable");
    if (!state.entities) { el.innerHTML = ""; return; }
    const check = state.entityCheck ? state.entityCheck.result : {};
    const tag = (id) => {
      const r = check[id];
      if (!r) return '<span class="status-tag none">Niet gecontroleerd</span>';
      if (r.status === "ok") return '<span class="status-tag ready">Gevonden</span>';
      if (r.status === "not-configured") return '<span class="status-tag none">Niet ingesteld</span>';
      if (r.status === "missing-entity") return '<span class="status-tag errors">Entiteit onbekend</span>';
      return `<span class="status-tag outdated">${r.missing.length} veld(en) onbekend</span>`;
    };
    el.innerHTML = Object.entries(state.entities.config.sources).map(([id, src]) => {
      const missing = new Set((check[id] && check[id].missing) || []);
      const inp = (key, value, field) => {
        const bad = String(value || "").split("+").some((p) => missing.has(p.trim()));
        return `<input type="text" class="mono ${bad ? "invalid" : ""}" data-src="${id}" data-key="${key}" ${field ? `data-field="${field}"` : ""} value="${escapeHtml(value || "")}">`;
      };
      return `<details class="panel" style="margin-bottom:8px"><summary>${escapeHtml(src.label)} · <span class="mono">${escapeHtml(src.entitySet || "nog niet herkend")}</span> ${tag(id)}</summary>
        <div class="panel-body">
          ${src.cdmEntity ? `<p class="hint">Standaard entiteit: <span class="mono">${escapeHtml(src.cdmEntity)}</span>${state.autoDetect && state.autoDetect.result[id] && state.autoDetect.result[id].candidates.length > 1 ? ` · andere kandidaten: <span class="mono">${state.autoDetect.result[id].candidates.slice(1).map(escapeHtml).join(", ")}</span>` : ""}</p>` : ""}
          <div class="grid-2">
            <label class="field">Entity set${inp("entitySet", src.entitySet)}</label>
            <label class="field">Filterveld legal entity${inp("legalEntityField", src.legalEntityField)}</label>
            <label class="field">Filterveld warehouse${inp("warehouseField", src.warehouseField)}</label>
          </div>
          <div class="grid-2">${Object.entries(src.fields).map(([k, v]) => `<label class="field">${escapeHtml(k)}${inp("field", v, k)}</label>`).join("")}</div>
        </div></details>`;
    }).join("") + (state.entities.customised ? `<p class="hint">Klantspecifieke mapping actief (data/entities.json).</p>` : `<p class="hint">Standaardmapping uit config/entities.json (nog niet geverifieerd).</p>`);
  }

  function collectEntities() {
    const cfg = JSON.parse(JSON.stringify(state.entities.config));
    document.querySelectorAll("#entitiesTable input[data-src]").forEach((i) => {
      const src = cfg.sources[i.dataset.src];
      if (i.dataset.key === "field") src.fields[i.dataset.field] = i.value.trim();
      else src[i.dataset.key] = i.value.trim();
    });
    return cfg;
  }

  async function saveEntities() {
    try {
      state.entities = await api("/api/entities", { method: "POST", body: collectEntities() });
      message("entitiesMessage", "Mapping opgeslagen in data/entities.json.", "good");
      renderEntities();
    } catch (error) { message("entitiesMessage", `Opslaan mislukt: ${error.message}`, "error"); }
  }
  async function resetEntities() {
    if (!confirm("De klantspecifieke mapping verwijderen en terug naar de standaard?")) return;
    try { state.entities = await api("/api/entities", { method: "DELETE" }); state.entityCheck = null; renderEntities(); message("entitiesMessage", "Standaardmapping hersteld."); }
    catch (error) { message("entitiesMessage", error.message, "error"); }
  }
  async function checkEntities() {
    const btn = document.getElementById("checkEntities");
    btn.disabled = true; btn.innerHTML = `Controleer tegen $metadata<span class="spinner"></span>`;
    message("entitiesMessage", "$metadata ophalen (kan tientallen MB zijn; daarna in het geheugen van de server)…");
    try {
      await api("/api/entities", { method: "POST", body: collectEntities() });
      state.entities = await api("/api/entities");
      state.entityCheck = await api("/api/d365/metadata/check");
      const bad = Object.values(state.entityCheck.result).filter((r) => r.status === "missing-entity" || r.status === "missing-fields").length;
      message("entitiesMessage", bad ? `${bad} bron(nen) met onbekende entiteit of velden: rood gemarkeerd. Zoek de juiste namen hieronder op.` : "Alle ingestelde entiteiten en velden bestaan in $metadata.", bad ? "warn" : "good");
      state.d365 = await api("/api/d365/status");
      renderStatus(); renderEntities();
    } catch (error) { message("entitiesMessage", `Controle mislukt: ${error.message}`, "error"); }
    finally { btn.disabled = false; btn.textContent = "Controleer tegen $metadata"; }
  }
  async function autoDetect() {
    const btn = document.getElementById("autoDetect");
    btn.disabled = true; btn.innerHTML = `Automatisch herkennen<span class="spinner"></span>`;
    message("entitiesMessage", "$metadata ophalen en doorzoeken (kan tientallen MB zijn; daarna in het geheugen van de server)…");
    try {
      const r = await api("/api/d365/metadata/autodetect");
      state.autoDetect = r;
      const cfg = collectEntities();
      const found = [], missing = [];
      for (const [id, res] of Object.entries(r.result)) {
        if (res.status === "found") { cfg.sources[id].entitySet = res.chosen; found.push(`${cfg.sources[id].label}: ${res.chosen}`); }
        else if (res.status === "not-found") missing.push(cfg.sources[id].label);
      }
      state.entities = await api("/api/entities", { method: "POST", body: cfg });
      state.entityCheck = await api("/api/d365/metadata/check");
      state.d365 = await api("/api/d365/status");
      message("entitiesMessage", `${found.length} entiteit(en) herkend en opgeslagen.` + (missing.length ? ` Niet gevonden in OData: ${missing.join(", ")}. Mogelijk staat die entiteit niet open voor OData (IsPublic); zoek een alternatief hieronder of gebruik de terugvalroute.` : ""), missing.length ? "warn" : "good");
      renderStatus(); renderEntities();
    } catch (error) { message("entitiesMessage", `Automatisch herkennen mislukt: ${error.message}`, "error"); }
    finally { btn.disabled = false; btn.textContent = "Automatisch herkennen"; }
  }

  async function searchMetadata() {
    const q = document.getElementById("mdQuery").value;
    const el = document.getElementById("mdResults");
    el.innerHTML = `<p class="hint">Zoeken<span class="spinner"></span></p>`;
    try {
      const r = await api(`/api/d365/metadata/search?q=${encodeURIComponent(q)}`);
      const opts = Object.entries(state.entities.config.sources).map(([id, s]) => `<option value="${id}">${escapeHtml(s.label)}</option>`).join("");
      el.innerHTML = r.hits.length ? `<div class="table-wrap scroll-table"><table class="simple-table"><thead><tr><th>Entity set</th><th>Velden</th><th></th></tr></thead><tbody>
        ${r.hits.map((h) => `<tr><td class="mono">${escapeHtml(h.entitySet)}</td><td class="mono" style="font-size:11px">${escapeHtml(h.properties.slice(0, 30).join(", "))}${h.properties.length > 30 ? ` … (+${h.properties.length - 30})` : ""}</td>
          <td><select class="btn-small"><option value="">Gebruik voor…</option>${opts}</select> <button class="btn-quiet btn-small" data-use="${escapeHtml(h.entitySet)}">OK</button></td></tr>`).join("")}
        </tbody></table></div><p class="hint">${r.hits.length} van ${r.total} entity sets${r.hits.length >= 40 ? " (eerste 40)" : ""}.</p>` : `<p class="hint">Niets gevonden voor "${escapeHtml(q)}".</p>`;
    } catch (error) { el.innerHTML = ""; message("mdResults", `Zoeken mislukt: ${error.message}`, "error"); }
  }

  // ---------- query ranges ----------
  function renderQuerySamples() {
    const el = document.getElementById("querySamples");
    const q = state.querySamples;
    if (!q || q.mode !== "live") { el.innerHTML = `<p class="hint">Na "Ververs data" zie je hier hoeveel queries uit de entiteiten gelezen konden worden.</p>`; return; }
    const label = { directives: "Directive-headers", directiveActions: "Directive-acties", templates: "Work templates" };
    const rows = Object.entries(q.sources).map(([id, s]) => `<tr><td>${label[id]}</td><td>${s.rows}</td><td>${s.parsed}</td><td>${s.empty}</td><td>${s.unknown ? `<span class="status-tag outdated">${s.unknown}</span>` : 0}</td></tr>`);
    const samples = Object.entries(q.sources).flatMap(([id, s]) => s.samples.filter((x) => x.status === "unknown").map((x) => ({ id, ...x })));
    el.innerHTML = `<div class="table-wrap"><table class="simple-table"><thead><tr><th>Bron</th><th>Rijen</th><th>Gelezen</th><th>Leeg</th><th>Onbekend formaat</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` +
      (samples.length ? `<div class="message warn">Een deel van de queries heeft een formaat dat de tool nog niet kan lezen. Hieronder een voorbeeld (alleen lokaal); geef dit door aan Claude Code om de lezer uit te breiden.</div>` +
        samples.slice(0, 2).map((x) => `<details class="panel"><summary>Voorbeeld ${escapeHtml(label[x.id])}</summary><div class="panel-body"><pre class="mono" style="white-space:pre-wrap;word-break:break-all;margin:0">${escapeHtml(x.text)}</pre></div></details>`).join("") : "");
  }

  function renderRanges() {
    renderQuerySamples();
    const s = state.rangesStatus;
    const ds = state.dataset;
    const el = document.getElementById("rangesStatus");
    const active = ds ? `Actieve bron: <b>${escapeHtml(ds.rangesSource || "geen")}</b>.` : "";
    if (!s || !s.present) { el.innerHTML = `<p class="hint">${active} Nog geen CSV geüpload voor live data.</p>`; return; }
    el.innerHTML = `<p class="hint">${active} CSV: ${s.rows} regels, geüpload ${escapeHtml(fmtDateTime(s.savedAt))}.</p>` +
      (s.errors.length ? `<div class="message warn">${s.errors.map(escapeHtml).join("<br>")}</div>` : "");
  }
  async function uploadRanges(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const csv = await file.text();
      const parsed = Core.parseQueryRangesCsv(csv);
      if (!parsed.rows.length) throw new Error(parsed.errors[0] || "Geen geldige regels.");
      state.rangesStatus = await api("/api/query-ranges", { method: "POST", body: { csv } });
      message("rangesMessage", `${file.name}: ${parsed.rows.length} regels opgeslagen in data/query-ranges.csv` + (parsed.errors.length ? `, ${parsed.errors.length} regel(s) overgeslagen.` : "."), parsed.errors.length ? "warn" : "good");
      if (state.settings.dataMode === "live") await App.loadData();
      renderRanges();
    } catch (error) { message("rangesMessage", `${file.name}: ${error.message}`, "error"); }
    finally { e.target.value = ""; }
  }

  return { init, load, render };
})();
