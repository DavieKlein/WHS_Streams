/* App bootstrap: loads status, dataset and layout; tab switching; header pills. */
const App = (() => {
  const TABS = { draw: DrawTab, flows: FlowsTab, checks: ChecksTab, connect: ConnectTab };

  async function init() {
    const logo = document.getElementById("brandLogo");
    const fallback = () => { logo.hidden = true; document.getElementById("brandWordmark").hidden = false; };
    logo.addEventListener("error", fallback);
    if (logo.complete && !logo.naturalWidth) fallback();

    document.getElementById("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (b) showTab(b.dataset.tab);
    });
    document.querySelectorAll(".wh-select").forEach((sel) => sel.addEventListener("change", (e) => changeWarehouse(e.target.value)));
    window.addEventListener("beforeunload", (e) => { if (state.layoutDirty) { e.preventDefault(); e.returnValue = ""; } });
    DrawTab.init(); FlowsTab.init(); ChecksTab.init(); ConnectTab.init();

    try {
      const [d365, settings] = await Promise.all([api("/api/d365/status"), api("/api/settings")]);
      state.d365 = d365; state.settings = settings;
    } catch (error) { message("globalMessage", error.message, "error"); }
    await loadData();
    ConnectTab.load();
  }

  async function loadData() {
    try {
      state.dataset = await api("/api/dataset");
      state.model = Core.normalize(state.dataset.flat);
      const whs = state.model.warehouses;
      const wanted = state.settings.warehouse && whs.find((w) => w.toLowerCase() === state.settings.warehouse.toLowerCase());
      state.warehouse = wanted || (whs.includes(state.warehouse) ? state.warehouse : whs[0] || state.settings.warehouse || "");
      if (state.dataset.empty) message("globalMessage", state.dataset.message, "warn");
      else if (state.dataset.errors && state.dataset.errors.length) message("globalMessage", `Laatste verversing had ${state.dataset.errors.length} fout(en): ${state.dataset.errors.map((e) => e.label).join(", ")}. Zie Koppeling.`, "warn");
      else message("globalMessage", "");
      renderWarehouseSelects();
      await loadLayout();
    } catch (error) {
      message("globalMessage", `Data laden mislukt: ${error.message}`, "error");
    }
    renderHeader();
  }

  async function loadLayout() {
    if (!state.warehouse) { state.layout = null; recompute(); renderAll(); return; }
    try {
      const r = await api(`/api/layouts/${encodeURIComponent(state.warehouse)}`);
      state.layout = r.layout; state.layoutSource = r.source; state.layoutDirty = false;
      state.draw.undo = []; state.draw.redo = []; state.draw.selectedId = null;
      state.flows.selected = null; state.flows.template = ""; state.flows.directive = "";
      if (r.source === "example") state.layoutDirty = true; // offer to save it as this warehouse's layout
    } catch (error) {
      message("globalMessage", `Layout van ${state.warehouse} laden mislukt: ${error.message}`, "error");
    }
    recompute();
    DrawTab.fitNow(); FlowsTab.fitNow();
    renderAll();
  }

  async function changeWarehouse(wh) {
    if (wh === state.warehouse) return;
    if (state.layoutDirty && state.layoutSource !== "example" && !confirm("Niet-opgeslagen wijzigingen aan de layout gaan verloren. Doorgaan?")) { renderWarehouseSelects(); return; }
    state.warehouse = wh;
    renderWarehouseSelects();
    await loadLayout();
  }

  function renderWarehouseSelects() {
    const whs = state.model ? state.model.warehouses : [];
    document.querySelectorAll(".wh-select").forEach((sel) => {
      sel.innerHTML = whs.length ? whs.map((w) => `<option ${w === state.warehouse ? "selected" : ""}>${escapeHtml(w)}</option>`).join("") : `<option value="">Geen warehouses in de data</option>`;
    });
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    for (const id of Object.keys(TABS)) document.getElementById(`tab-${id}`).hidden = id !== tab;
    if (tab === "draw") DrawTab.onShow();
    else if (tab === "flows") FlowsTab.onShow();
    else TABS[tab].render();
  }

  function renderAll() {
    if (state.tab === "draw") DrawTab.render(); else if (state.tab === "flows") FlowsTab.render(); else TABS[state.tab].render();
    renderHeader();
  }

  function renderHeader() {
    const env = document.getElementById("envPill");
    const d = state.d365;
    if (d.mode === "live") {
      env.textContent = `Verbonden: ${d.label}`;
      env.className = `status-pill ${d.label === "PROD" ? "prod" : "connected"}`;
      env.title = d.environmentUrl;
    } else { env.textContent = "Niet verbonden"; env.className = "status-pill"; env.title = ""; }
    const data = document.getElementById("dataPill");
    const ds = state.dataset;
    if (!ds) { data.textContent = "—"; data.className = "status-pill"; }
    else if (ds.mode === "sample") { data.textContent = "Voorbeelddata"; data.className = "status-pill offline"; data.title = "Fictief magazijn uit sample-data/"; }
    else if (ds.empty) { data.textContent = "Live: nog niet opgehaald"; data.className = "status-pill offline"; }
    else { data.textContent = `Live data · ${fmtDateTime(ds.fetchedAt)}`; data.className = "status-pill connected"; data.title = "Cache in data/cache/"; }
    const n = ChecksTab.problemCount();
    const badge = document.getElementById("checksCount");
    badge.hidden = !n; badge.textContent = n;
  }

  return { init, loadData, loadLayout, showTab, renderHeader };
})();

App.init();
