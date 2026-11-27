/* Tab "Stromen": arrows from source area to target area per work template, with filters, details, legend and export. */
const FlowsTab = (() => {
  let view, svg;

  function init() {
    svg = document.getElementById("flowMap");
    view = MapView.create(svg, () => renderMap());
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-flow]") || e.target.closest("[data-shape]")) return;
      MapView.startPan(view, e);
    });
    svg.addEventListener("click", (e) => {
      const fl = e.target.closest("[data-flow]");
      if (fl) { select({ kind: "flow", flowId: fl.dataset.flow, edge: Number(fl.dataset.edge) }); return; }
      const sh = e.target.closest("[data-shape]");
      if (sh) select({ kind: "area", shapeId: sh.dataset.shape });
    });
    const panel = document.getElementById("tab-flows");
    panel.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.zoom === "fit") MapView.fit(view, state.layout.grid); else MapView.zoomCentre(view, b.dataset.zoom === "in" ? 1.25 : 0.8);
    }));
    document.getElementById("filterTypes").addEventListener("change", (e) => {
      const cat = e.target.dataset.cat; if (!cat) return;
      if (e.target.checked) state.flows.hiddenCategories.delete(cat); else state.flows.hiddenCategories.add(cat);
      render();
    });
    document.getElementById("filterTemplate").addEventListener("change", (e) => { state.flows.template = e.target.value; render(); });
    document.getElementById("filterDirective").addEventListener("change", (e) => { state.flows.directive = e.target.value; render(); });
    document.getElementById("filterProblemsOnly").addEventListener("change", (e) => { state.flows.problemsOnly = e.target.checked; render(); });
    document.getElementById("flowList").addEventListener("click", (e) => {
      const li = e.target.closest("[data-flow-id]");
      if (li) select({ kind: "flow", flowId: li.dataset.flowId, edge: null });
    });
    document.getElementById("flowDetail").addEventListener("click", (e) => {
      const b = e.target.closest("[data-clear]");
      if (b) select(null);
    });
    document.getElementById("exportSvg").addEventListener("click", () => exportImage("svg"));
    document.getElementById("exportPng").addEventListener("click", () => exportImage("png"));
    window.addEventListener("resize", () => { if (state.tab === "flows" && state.layout) MapView.fit(view, state.layout.grid); });
  }

  function onShow() { if (state.layout && !view.fitted) MapView.fit(view, state.layout.grid); render(); }
  function fitNow() { if (state.layout && state.tab === "flows") MapView.fit(view, state.layout.grid); else if (view) view.fitted = false; }

  function select(sel) { state.flows.selected = sel; render(); }

  function visibleFlows() {
    if (!state.flowResult) return [];
    const f = state.flows;
    return state.flowResult.flows.filter((x) =>
      !f.hiddenCategories.has(x.category) &&
      (!f.template || x.templateKey === f.template) &&
      (!f.directive || x.sources.some((s) => s.directiveKey === f.directive)) &&
      (!f.problemsOnly || x.status !== "complete"));
  }

  function render() {
    if (!svg) return;
    renderFilters();
    renderMap();
    renderList();
    renderLegend();
    renderDetail();
  }

  function renderFilters() {
    if (!state.model) return;
    const cats = Array.from(new Set(state.model.templates.map((t) => Core.categoryOf(t.workOrderType).id)));
    const typesByCat = {};
    for (const t of state.model.templates) (typesByCat[Core.categoryOf(t.workOrderType).id] ||= new Set()).add(t.workOrderType);
    document.getElementById("filterTypes").innerHTML = cats.map((cat) => {
      const c = Core.CATEGORIES.find((x) => x.id === cat);
      return `<label class="checkbox-row legend-row"><input type="checkbox" data-cat="${cat}" ${state.flows.hiddenCategories.has(cat) ? "" : "checked"}>
        ${lineSample(cat)} ${escapeHtml(c.label)} <span class="hint">(${escapeHtml(Array.from(typesByCat[cat]).join(", "))})</span></label>`;
    }).join("") || `<span class="hint">Geen work templates in de data.</span>`;
    const wh = state.warehouse.toLowerCase();
    const tSel = document.getElementById("filterTemplate");
    tSel.innerHTML = `<option value="">Alle templates</option>` + state.model.templates
      .filter((t) => !t.warehouse || t.warehouse.toLowerCase() === wh)
      .map((t) => `<option value="${escapeHtml(t.key)}" ${t.key === state.flows.template ? "selected" : ""}>${escapeHtml(t.id)} (${escapeHtml(t.workOrderType)})${t.valid ? "" : " · niet geldig"}</option>`).join("");
    const dSel = document.getElementById("filterDirective");
    dSel.innerHTML = `<option value="">Alle directives</option>` + state.model.directives
      .filter((d) => d.warehouse.toLowerCase() === wh)
      .map((d) => `<option value="${escapeHtml(d.key)}" ${d.key === state.flows.directive ? "selected" : ""}>${escapeHtml(d.code)} · ${escapeHtml(d.workType)}</option>`).join("");
  }

  function lineSample(cat, w = 34) {
    const st = FLOW_STYLE[cat] || FLOW_STYLE.overig;
    return `<svg width="${w}" height="12" aria-hidden="true"><line x1="1" y1="6" x2="${w - 7}" y2="6" stroke="${flowColour(cat)}" stroke-width="2.5"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/><path d="M${w - 9},1 L${w - 1},6 L${w - 9},11 z" fill="${flowColour(cat)}"/></svg>`;
  }

  function problemRefs() {
    return new Set((state.checks ? state.checks.zonesWithoutAction : []).map((z) => z.zone.toLowerCase()));
  }

  function renderMap() {
    if (!state.layout || !state.flowResult) { svg.innerHTML = ""; return; }
    const t = { scale: view.scale, tx: view.tx, ty: view.ty };
    const c = MapView.colours();
    const flows = visibleFlows();
    const sel = state.flows.selected;
    let highlight = new Set();
    if (sel && sel.kind === "flow") {
      const f = state.flowResult.flows.find((x) => x.id === sel.flowId);
      if (f) highlight = new Set(f.fromAreas.concat(f.toAreas));
    } else if (sel && sel.kind === "area") highlight = new Set([sel.shapeId]);
    const parts = [MapView.markerDefs(c)];
    const u = state.draw.underlay, g = state.layout.grid;
    if (u) parts.push(`<image href="${u.src}" x="${t.tx}" y="${t.ty}" width="${g.width * t.scale}" height="${g.height * t.scale}" preserveAspectRatio="xMinYMin meet" opacity="${u.opacity * 0.6}" pointer-events="none"/>`);
    parts.push(`<rect x="${t.tx}" y="${t.ty}" width="${g.width * t.scale}" height="${g.height * t.scale}" fill="none" stroke="${c.line}"/>`);
    parts.push(MapView.shapesSvg(state.layout, t, c, { interactive: true, highlightIds: highlight, problemRefs: problemRefs() }));
    parts.push(MapView.arrowsSvg(flows, state.layout, t, c, { interactive: true, selectedFlowId: sel && sel.kind === "flow" ? sel.flowId : null }));
    svg.innerHTML = parts.join("");
    document.querySelector("#tab-flows [data-zoom-label]").textContent = Math.round(t.scale * 10) + "%";
  }

  function renderList() {
    const el = document.getElementById("flowList");
    if (!state.flowResult) { el.innerHTML = ""; return; }
    const flows = visibleFlows();
    const sel = state.flows.selected;
    el.innerHTML = flows.length ? flows.map((f) => {
      const drawn = f.edges.length ? "" : ` <span class="hint">· niet te tekenen</span>`;
      return `<li class="clickable ${sel && sel.flowId === f.id ? "selected" : ""}" data-flow-id="${escapeHtml(f.id)}">
        <span>${lineSample(f.category, 26)} ${escapeHtml(f.templateId)}${f.pair > 1 || hasMorePairs(f) ? ` · stap ${f.pair}` : ""}${drawn}</span>${statusTag(f.status)}</li>`;
    }).join("") : `<li><span class="hint">Geen stromen binnen deze filters.</span></li>`;
  }
  function hasMorePairs(f) { return state.flowResult.flows.some((x) => x.templateKey === f.templateKey && x.pair > 1); }

  function renderLegend() {
    const present = Array.from(new Set((state.flowResult ? state.flowResult.flows : []).map((f) => f.category)));
    const el = document.getElementById("legend");
    el.innerHTML = present.map((cat) => `<div class="legend-row">${lineSample(cat, 46)} ${escapeHtml(Core.CATEGORIES.find((c) => c.id === cat).label)}</div>`).join("") + `
      <div class="legend-row"><svg width="46" height="14" aria-hidden="true"><line x1="1" y1="4" x2="40" y2="4" stroke="${cssToken("--muted")}" stroke-width="1.8"/><line x1="1" y1="11" x2="40" y2="11" stroke="${cssToken("--muted")}" stroke-width="5"/></svg> Dikte = aantal directive-acties dat de stroom voedt</div>
      <div class="legend-row"><svg width="46" height="20" aria-hidden="true"><circle cx="23" cy="10" r="8" fill="#fff" stroke="${cssToken("--muted")}" stroke-width="1.5"/><text x="23" y="14" font-size="11" font-weight="700" text-anchor="middle" fill="${cssToken("--text")}">2</text></svg> Volgorde: 1e keus, 2e keus … (directive-volgorde, dan regel, dan actie)</div>
      <div class="legend-row"><svg width="46" height="20" aria-hidden="true"><circle cx="23" cy="10" r="8" fill="#fff" stroke="${cssToken("--error")}" stroke-width="1.5"/><text x="23" y="14" font-size="11" font-weight="700" text-anchor="middle" fill="${cssToken("--error")}">!</text></svg> Conflict: overlappende directives</div>
      <div class="legend-row"><svg width="46" height="16" aria-hidden="true"><rect x="2" y="2" width="42" height="12" fill="${cssToken("--error-soft")}" stroke="${cssToken("--error")}" stroke-dasharray="6 3"/></svg> Zone zonder enkele directive-actie</div>
      <div class="legend-row"><svg width="46" height="16" aria-hidden="true"><rect x="2" y="2" width="42" height="12" fill="${cssToken("--warn-soft")}" stroke="${cssToken("--warn-text")}" stroke-dasharray="4 3"/></svg> Vlak nog niet gekoppeld</div>
      <p class="hint">Strategieën als Consolidate of Empty location hangen af van de voorraad: de viewer toont de toegestane ruimte, niet de locatie die D365 uiteindelijk kiest.</p>`;
  }

  // ---------- details ----------
  function rangesHtml(ranges, known) {
    if (!known) return `<span class="status-tag incomplete">Onbekend</span>`;
    if (!ranges.length) return `<span class="hint">Geen restricties</span>`;
    return ranges.map((r) => `<span class="mono">${escapeHtml(r.table)}.${escapeHtml(r.field)} = ${escapeHtml(r.value)}</span>`).join("<br>");
  }
  function areaName(id) {
    const s = state.layout.shapes.find((x) => x.id === id);
    return s ? (s.label || s.ref || s.id) : id;
  }

  function renderDetail() {
    const el = document.getElementById("flowDetail");
    const sel = state.flows.selected;
    if (!sel || !state.flowResult) { el.innerHTML = `<p class="hint">Klik op een pijl of een vlak.</p>`; return; }
    if (sel.kind === "area") return renderAreaDetail(el, sel.shapeId);
    const f = state.flowResult.flows.find((x) => x.id === sel.flowId);
    if (!f) { el.innerHTML = `<p class="hint">Deze stroom bestaat niet meer.</p>`; return; }
    const tpl = state.model.templates.find((t) => t.key === f.templateKey);
    const edge = sel.edge !== null && sel.edge !== undefined ? f.edges[sel.edge] : null;
    const dirByKey = new Map(state.model.directives.map((d) => [d.key, d]));
    const shown = edge ? f.sources.filter((s) => s.side === "Pick" || f.to.find((a) => a.shape.id === edge.to && a.options.some((o) => o.rank === s.rank && o.directive.key === s.directiveKey))) : f.sources;
    el.innerHTML = `
      <div class="btn-row" style="justify-content:space-between"><b>${escapeHtml(f.templateId)}</b> ${statusTag(f.status)}</div>
      <dl class="kv">
        <dt>Work order type</dt><dd>${escapeHtml(f.workOrderType)}</dd>
        <dt>Template</dt><dd>${escapeHtml(f.templateId)} (volgorde ${tpl ? tpl.sequence : "?"})</dd>
        <dt>Regels</dt><dd>Pick ${f.pickLine ?? "—"} → Put ${f.putLine ?? "—"}${f.pair > 1 ? ` (stap ${f.pair})` : ""}</dd>
        <dt>Van</dt><dd>${f.fromAreas.map((a) => escapeHtml(areaName(a))).join(", ") || "—"}</dd>
        <dt>Naar</dt><dd>${f.to.map((a) => `${f.to.length > 1 ? a.choice + ". " : ""}${escapeHtml(areaName(a.shape.id))}`).join("<br>") || "—"}</dd>
        ${edge ? `<dt>Deze pijl</dt><dd>${escapeHtml(areaName(edge.from))} → ${escapeHtml(areaName(edge.to))}${new Set(f.edges.map((e) => e.choice)).size > 1 ? ` · ${edge.choice}e keus` : ""}</dd>` : ""}
        <dt>Template-query</dt><dd>${tpl ? rangesHtml(tpl.ranges, tpl.rangesKnown) : "—"}</dd>
      </dl>
      ${f.notes.length ? f.notes.map((n) => `<div class="message ${/onbekend|Geen|niet-ondersteund|Niet-ondersteunde|vindt geen/i.test(n) ? "warn" : ""}">${escapeHtml(n)}</div>`).join("") : ""}
      <h3>Directive, regel en actie</h3>
      ${shown.length ? `<div class="table-wrap"><table class="simple-table">
        <thead><tr><th>#</th><th>Kant</th><th>Directive</th><th>Regel</th><th>Actie</th><th>Strategie</th></tr></thead>
        <tbody>${shown.map((s) => `<tr><td>${s.rank}</td><td>${s.side}</td><td>${escapeHtml(s.directive)}</td><td>${s.line ?? "—"}</td><td>${escapeHtml(s.actionName || "—")}</td><td>${escapeHtml(s.strategy || "—")}</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="hint">Geen directive: zie de toelichting hierboven.</p>`}
      <h3>Query-ranges</h3>
      ${Array.from(new Set(shown.map((s) => s.directiveKey))).map((k) => {
        const d = dirByKey.get(k);
        const acts = shown.filter((s) => s.directiveKey === k && s.action !== null);
        return `<div class="field"><b>${escapeHtml(d.code)}</b> <span class="hint">${escapeHtml(d.name)} · volgorde ${d.sequence}${d.directiveCode ? ` · code ${escapeHtml(d.directiveCode)}` : ""}</span>
          <div>Header: ${rangesHtml(d.ranges, d.rangesKnown)}</div>
          ${acts.map((s) => { const a = findAction(d, s); return a ? `<div>Actie ${escapeHtml(a.name)}: ${rangesHtml(a.ranges, a.rangesKnown)}</div>` : ""; }).join("")}
        </div>`;
      }).join("") || `<p class="hint">—</p>`}
      <button class="btn-link" data-clear>Selectie opheffen</button>`;
  }
  function findAction(d, s) {
    const line = d.lines.find((l) => l.sequence === s.line);
    return line && line.actions.find((a) => a.sequence === s.action);
  }

  function renderAreaDetail(el, shapeId) {
    const shape = state.layout.shapes.find((s) => s.id === shapeId);
    if (!shape) { el.innerHTML = ""; return; }
    const info = Core.describeArea(shape, state.model, state.flowResult, state.layout);
    const noAction = shape.type === "zone" && problemRefs().has(String(shape.ref).toLowerCase());
    el.innerHTML = `
      <b>${escapeHtml(shape.label || shape.ref || shape.id)}</b>
      <dl class="kv"><dt>Type</dt><dd>${escapeHtml({ zone: "Zone", aisle: "Gang", location: "Locatie", point: "Vast punt" }[shape.type])}</dd>
        <dt>Koppeling</dt><dd>${escapeHtml(shape.ref || "niet gekoppeld")}</dd><dt>Locaties</dt><dd>${info.locations.length}</dd></dl>
      ${noAction ? `<div class="message error">Geen enkele directive-actie zoekt in deze zone.</div>` : ""}
      <h3>Directives die hierin zoeken</h3>
      ${info.actions.length ? `<div class="table-wrap"><table class="simple-table"><thead><tr><th>Directive</th><th>Type</th><th>Actie</th><th>Loc.</th></tr></thead>
        <tbody>${info.actions.map((a) => `<tr><td>${escapeHtml(a.directive)}</td><td>${escapeHtml(a.workType)}</td><td>${escapeHtml(a.action)} <span class="hint">(r${a.line})</span></td><td>${a.locations}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="hint">Geen.</p>`}
      <h3>Templates die hier langs komen</h3>
      ${info.flows.length ? `<ul class="list">${info.flows.map((f) => `<li class="clickable" data-flow-id="${escapeHtml(f.id)}"><span>${escapeHtml(f.templateId)} · ${f.fromAreas.includes(shapeId) ? "bron" : "doel"}</span>${statusTag(f.status)}</li>`).join("")}</ul>` : `<p class="hint">Geen.</p>`}
      <button class="btn-link" data-clear>Selectie opheffen</button>`;
    el.querySelectorAll("[data-flow-id]").forEach((li) => li.addEventListener("click", () => select({ kind: "flow", flowId: li.dataset.flowId, edge: null })));
  }

  // ---------- export ----------
  function buildExportSvg() {
    const g = state.layout.grid;
    const c = MapView.colours();
    const scale = Math.max(6, Math.min(14, 1400 / g.width));
    const pad = 24, head = 54;
    const t = { scale, tx: pad, ty: head };
    const flows = visibleFlows();
    const cats = Array.from(new Set(flows.map((f) => f.category)));
    const mapW = g.width * scale, mapH = g.height * scale;
    const legendY = head + mapH + 24;
    const width = Math.max(mapW + pad * 2, 520), height = legendY + cats.length * 20 + 60;
    const font = c.font.replace(/"/g, "'");
    const legend = cats.map((cat, i) => {
      const st = FLOW_STYLE[cat] || FLOW_STYLE.overig, y = legendY + i * 20;
      return `<line x1="${pad}" y1="${y}" x2="${pad + 40}" y2="${y}" stroke="${flowColour(cat)}" stroke-width="2.5"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""} marker-end="url(#arrow-${cat})"/>` +
        `<text x="${pad + 52}" y="${y + 4}" font-size="12" fill="${c.text}">${escapeHtml(Core.CATEGORIES.find((x) => x.id === cat).label)}</text>`;
    }).join("");
    const filters = [state.flows.template && state.model.templates.find((x) => x.key === state.flows.template)?.id,
      state.flows.directive && state.model.directives.find((x) => x.key === state.flows.directive)?.code].filter(Boolean);
    const env = state.d365.mode === "live" ? `${state.d365.label} · ${new URL(state.d365.environmentUrl).hostname}` : "Voorbeelddata";
    const notes = `Dikte = aantal directive-acties · cijfer = volgorde van keuze · ! = conflict · toegestane ruimte, niet de gekozen locatie`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${font}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      ${MapView.markerDefs(c)}
      <text x="${pad}" y="26" font-size="17" font-weight="700" fill="${c.text}">Magazijnstromen ${escapeHtml(state.warehouse)}</text>
      <text x="${pad}" y="44" font-size="12" fill="${c.muted}">${escapeHtml(env)} · ${escapeHtml(fmtDateTime(new Date().toISOString()))}${filters.length ? " · filter: " + escapeHtml(filters.join(", ")) : ""}</text>
      <rect x="${pad}" y="${head}" width="${mapW}" height="${mapH}" fill="none" stroke="${c.line}"/>
      ${MapView.shapesSvg(state.layout, t, c, { problemRefs: problemRefs() })}
      ${MapView.arrowsSvg(flows, state.layout, t, c, {})}
      ${legend}
      <text x="${pad}" y="${legendY + cats.length * 20 + 14}" font-size="11" fill="${c.muted}">${escapeHtml(notes)}</text>
    </svg>`;
  }

  function exportImage(kind) {
    if (!state.layout || !state.flowResult) return;
    const svgText = buildExportSvg();
    const name = `stromen-${state.warehouse}-${new Date().toISOString().slice(0, 10)}`;
    if (kind === "svg") { downloadBlob(new Blob([svgText], { type: "image/svg+xml" }), name + ".svg"); return; }
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const k = 2; // sharp in a document or slide
      canvas.width = img.width * k; canvas.height = img.height * k;
      const ctx = canvas.getContext("2d");
      ctx.scale(k, k); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => downloadBlob(blob, name + ".png"), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); message("globalMessage", "PNG-export mislukt: de SVG kon niet als afbeelding geladen worden.", "error"); };
    img.src = url;
  }

  return { init, render, onShow, fitNow, buildExportSvg };
})();
