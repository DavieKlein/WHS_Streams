/* Tab "Tekenen": draw the floor plan as rectangles and link each to a zone, aisle, location or fixed point. */
const DrawTab = (() => {
  let view, svg;
  let drag = null;        // { mode: "move"|"resize"|"create", ... }
  let preview = null;     // rect being drawn (world units)
  let cursor = null;

  const TYPE_LABEL = { zone: "Zone", aisle: "Gang / stelling", location: "Locatie", point: "Vast punt" };

  function init() {
    svg = document.getElementById("drawMap");
    view = MapView.create(svg, () => render({ detail: false }));
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", (e) => { cursor = MapView.toWorld(view, e.clientX, e.clientY); renderFoot(); });
    svg.addEventListener("pointerleave", () => { cursor = null; renderFoot(); });

    const panel = document.getElementById("tab-draw");
    panel.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
    panel.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.zoom === "fit") MapView.fit(view, state.layout.grid); else MapView.zoomCentre(view, b.dataset.zoom === "in" ? 1.25 : 0.8);
    }));
    document.getElementById("newType").addEventListener("change", (e) => { state.draw.newType = e.target.value; state.draw.pendingRef = null; });
    document.getElementById("undoBtn").addEventListener("click", undo);
    document.getElementById("redoBtn").addEventListener("click", redo);
    document.getElementById("saveLayout").addEventListener("click", saveLayout);
    document.getElementById("reloadLayout").addEventListener("click", () => {
      if (state.layoutDirty && !confirm("Niet-opgeslagen wijzigingen gaan verloren. Doorgaan?")) return;
      App.loadLayout();
    });
    document.getElementById("snapStep").addEventListener("change", (e) => { state.draw.snap = Number(e.target.value); });
    for (const [id, key] of [["gridMeters", "cellMeters"], ["gridW", "width"], ["gridH", "height"]]) {
      document.getElementById(id).addEventListener("change", (e) => {
        const v = Number(e.target.value);
        if (!(v > 0)) { e.target.classList.add("invalid"); return; }
        e.target.classList.remove("invalid");
        mutate(() => { state.layout.grid[key] = v; });
      });
    }
    document.getElementById("underlayFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { state.draw.underlay = { src: reader.result, opacity: Number(document.getElementById("underlayOpacity").value) }; render({ detail: false }); };
      reader.onerror = () => message("layoutMessage", `Onderlegger ${file.name} kon niet gelezen worden.`, "error");
      reader.readAsDataURL(file);
    });
    document.getElementById("underlayOpacity").addEventListener("input", (e) => {
      if (state.draw.underlay) { state.draw.underlay.opacity = Number(e.target.value); render({ detail: false }); }
    });
    document.getElementById("underlayClear").addEventListener("click", () => { state.draw.underlay = null; document.getElementById("underlayFile").value = ""; render({ detail: false }); });
    document.getElementById("unplacedList").addEventListener("click", (e) => {
      const li = e.target.closest("[data-zone]");
      if (!li) return;
      state.draw.pendingRef = { type: "zone", ref: li.dataset.zone };
      state.draw.newType = "zone";
      document.getElementById("newType").value = "zone";
      setTool("rect");
      message("layoutMessage", `Sleep nu een rechthoek voor zone ${li.dataset.zone}; hij wordt meteen gekoppeld.`);
    });
    document.getElementById("shapeDetail").addEventListener("change", onDetailChange);
    document.getElementById("shapeDetail").addEventListener("click", onDetailClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", () => { if (state.tab === "draw" && state.layout) MapView.fit(view, state.layout.grid); });
  }

  function onShow() { if (state.layout && !view.fitted) MapView.fit(view, state.layout.grid); render(); }
  function fitNow() { if (state.layout && state.tab === "draw") MapView.fit(view, state.layout.grid); else if (view) view.fitted = false; }

  // ---------- undo / mutate ----------
  function snapshot() { return JSON.stringify({ grid: state.layout.grid, shapes: state.layout.shapes }); }
  function restore(json) { const s = JSON.parse(json); state.layout.grid = s.grid; state.layout.shapes = s.shapes; }
  function pushUndo() {
    state.draw.undo.push(snapshot());
    if (state.draw.undo.length > 200) state.draw.undo.shift();
    state.draw.redo = [];
  }
  function mutate(fn, { undoable = true } = {}) {
    if (undoable) pushUndo();
    fn();
    state.layoutDirty = true;
    recompute();
    render();
    App.renderHeader();
  }
  function undo() {
    if (!state.draw.undo.length) return;
    state.draw.redo.push(snapshot());
    restore(state.draw.undo.pop());
    if (!state.layout.shapes.some((s) => s.id === state.draw.selectedId)) state.draw.selectedId = null;
    state.layoutDirty = true; recompute(); render();
  }
  function redo() {
    if (!state.draw.redo.length) return;
    state.draw.undo.push(snapshot());
    restore(state.draw.redo.pop());
    state.layoutDirty = true; recompute(); render();
  }
  function newId() {
    let max = 0;
    for (const s of state.layout.shapes) { const n = Number(String(s.id).replace(/^\D+/, "")); if (n > max) max = n; }
    return "s" + (max + 1);
  }
  const selected = () => state.layout && state.layout.shapes.find((s) => s.id === state.draw.selectedId);
  const snapV = (v) => Math.round(v / state.draw.snap) * state.draw.snap;

  function setTool(tool) {
    state.draw.tool = tool;
    document.querySelectorAll("#tab-draw [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    svg.classList.toggle("tool-rect", tool === "rect");
  }

  // ---------- pointer ----------
  function onPointerDown(e) {
    if (!state.layout || e.button === 2) return;
    const p = MapView.toWorld(view, e.clientX, e.clientY);
    const handle = e.target.closest("[data-handle]");
    const shapeEl = e.target.closest("[data-shape]");
    if (e.button === 1) { e.preventDefault(); MapView.startPan(view, e); return; }

    if (handle && selected()) {
      drag = { mode: "resize", corner: handle.dataset.handle, orig: { ...selected() }, start: p, undoPushed: false };
    } else if (state.draw.tool === "rect") {
      drag = { mode: "create", start: { x: snapV(p.x), y: snapV(p.y) } };
      preview = { x: drag.start.x, y: drag.start.y, w: 0, h: 0 };
    } else if (shapeEl) {
      const id = shapeEl.dataset.shape;
      if (state.draw.selectedId !== id) { state.draw.selectedId = id; render(); }
      drag = { mode: "move", orig: { ...selected() }, start: p, undoPushed: false };
    } else {
      if (state.draw.selectedId) { state.draw.selectedId = null; render(); }
      MapView.startPan(view, e);
      return;
    }
    svg.setPointerCapture(e.pointerId);
    const move = (ev) => onDrag(ev);
    const up = (ev) => { svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); onDragEnd(ev); };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  }

  function onDrag(e) {
    if (!drag) return;
    const p = MapView.toWorld(view, e.clientX, e.clientY);
    if (drag.mode === "create") {
      const x = snapV(p.x), y = snapV(p.y);
      preview = { x: Math.min(x, drag.start.x), y: Math.min(y, drag.start.y), w: Math.abs(x - drag.start.x), h: Math.abs(y - drag.start.y) };
      render({ detail: false, side: false });
      return;
    }
    const s = selected();
    if (!s) return;
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.undoPushed && (Math.abs(dx) * view.scale > 2 || Math.abs(dy) * view.scale > 2)) {
      const cur = JSON.parse(snapshot());
      cur.shapes = cur.shapes.map((x) => (x.id === drag.orig.id ? drag.orig : x));
      state.draw.undo.push(JSON.stringify(cur)); state.draw.redo = [];
      drag.undoPushed = true;
    }
    if (!drag.undoPushed) return;
    const o = drag.orig, min = state.draw.snap;
    if (drag.mode === "move") { s.x = snapV(o.x + dx); s.y = snapV(o.y + dy); }
    else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (drag.corner.includes("w")) x0 = Math.min(snapV(p.x), x1 - min); else x1 = Math.max(snapV(p.x), x0 + min);
      if (drag.corner.includes("n")) y0 = Math.min(snapV(p.y), y1 - min); else y1 = Math.max(snapV(p.y), y0 + min);
      Object.assign(s, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    render({ detail: false, side: false });
  }

  function onDragEnd() {
    if (drag && drag.mode === "create") {
      const r = preview;
      preview = null;
      if (r && r.w >= state.draw.snap && r.h >= state.draw.snap) {
        const pending = state.draw.pendingRef;
        const type = pending ? pending.type : state.draw.newType;
        mutate(() => {
          const shape = { id: newId(), type, ref: pending ? pending.ref : "", label: pending ? pending.ref : "", x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0 };
          if (type === "point") shape.role = "receipt";
          state.layout.shapes.push(shape);
          state.draw.selectedId = shape.id;
        });
        if (pending) { state.draw.pendingRef = null; message("layoutMessage", ""); setTool("select"); }
      } else render();
    } else if (drag && drag.undoPushed) {
      state.layoutDirty = true; recompute(); render(); App.renderHeader();
    }
    drag = null;
  }

  function onKey(e) {
    if (state.tab !== "draw" || !state.layout) return;
    if (e.target.closest("input, select, textarea")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); saveLayout(); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "v" || e.key === "Escape") { setTool("select"); state.draw.pendingRef = null; return; }
    if (e.key === "n") { setTool("rect"); return; }
    const s = selected();
    if (!s) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "r") rotate();
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = state.draw.snap;
      mutate(() => {
        if (e.key === "ArrowLeft") s.x -= d; if (e.key === "ArrowRight") s.x += d;
        if (e.key === "ArrowUp") s.y -= d; if (e.key === "ArrowDown") s.y += d;
      });
    }
  }

  // ---------- shape actions ----------
  function duplicate() {
    const s = selected(); if (!s) return;
    mutate(() => {
      const copy = { ...s, id: newId(), x: s.x + s.w, ref: "", label: s.type === "aisle" ? "" : s.label };
      state.layout.shapes.push(copy);
      state.draw.selectedId = copy.id;
    });
  }
  function rotate() {
    const s = selected(); if (!s) return;
    mutate(() => {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const w = s.h, h = s.w;
      s.x = snapV(cx - w / 2); s.y = snapV(cy - h / 2); s.w = w; s.h = h;
      s.rotation = ((s.rotation || 0) + 90) % 360;
    });
  }
  function remove() {
    const s = selected(); if (!s) return;
    mutate(() => { state.layout.shapes = state.layout.shapes.filter((x) => x.id !== s.id); state.draw.selectedId = null; });
  }
  function distribute() {
    const s = selected(); if (!s || s.type !== "zone" || !s.ref) return;
    let n = 0;
    const base = newId(), start = Number(base.slice(1));
    const strips = Core.distributeAisles(s, state.model, state.warehouse, () => "s" + (start + n++));
    if (!strips.length) { message("layoutMessage", `Zone ${s.ref} heeft in de data geen locaties met een gang (aisle).`, "error"); return; }
    const existing = new Set(state.layout.shapes.filter((x) => x.type === "aisle").map((x) => String(x.ref).toLowerCase()));
    const fresh = strips.filter((x) => !existing.has(x.ref.toLowerCase()));
    if (!fresh.length) { message("layoutMessage", `Alle gangen van zone ${s.ref} zijn al getekend.`); return; }
    mutate(() => { state.layout.shapes.push(...fresh); });
    message("layoutMessage", `${fresh.length} gang(en) van zone ${s.ref} als stroken verdeeld` + (fresh.length < strips.length ? ` (${strips.length - fresh.length} al getekend, overgeslagen).` : ". Schuif ze daarna recht."), "good");
  }

  // ---------- reference values from the live data ----------
  function refOptions(type) {
    const wh = state.warehouse.toLowerCase();
    const locs = state.model ? state.model.locations.filter((l) => l.warehouse.toLowerCase() === wh) : [];
    if (type === "zone") return Array.from(new Set(locs.map((l) => l.zoneId).filter(Boolean))).sort();
    if (type === "aisle") return Array.from(new Set(locs.map((l) => l.aisleId).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return locs.map((l) => l.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  function locationsForShape(s) {
    if (!state.model || !s.ref) return [];
    const ref = s.ref.toLowerCase(), wh = state.warehouse.toLowerCase();
    return state.model.locations.filter((l) => l.warehouse.toLowerCase() === wh &&
      (s.type === "zone" ? l.zoneId.toLowerCase() === ref : s.type === "aisle" ? l.aisleId.toLowerCase() === ref : l.id.toLowerCase() === ref));
  }

  function onDetailChange(e) {
    const s = selected(); if (!s) return;
    const f = e.target.dataset.field;
    if (!f) return;
    let v = e.target.value;
    if (f === "ref") {
      v = v.trim();
      const opts = refOptions(s.type);
      const match = opts.find((o) => o.toLowerCase() === v.toLowerCase());
      if (v && !match) {
        e.target.classList.add("invalid");
        message("refMessage", `"${v}" bestaat niet als ${TYPE_LABEL[s.type].toLowerCase()} in warehouse ${state.warehouse}. Kies een waarde uit de lijst.`, "error");
        return;
      }
      v = match || "";
      mutate(() => { if (!s.label || s.label === s.ref) s.label = v; s.ref = v; });
      return;
    }
    if (["x", "y", "w", "h"].includes(f)) {
      const n = Number(v);
      if (!Number.isFinite(n) || ((f === "w" || f === "h") && n <= 0)) { e.target.classList.add("invalid"); return; }
      mutate(() => { s[f] = n; });
      return;
    }
    if (f === "type") {
      mutate(() => { s.type = v; s.ref = ""; if (v === "point") s.role = s.role || "receipt"; else delete s.role; });
      return;
    }
    mutate(() => { s[f] = v; });
  }
  function onDetailClick(e) {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    ({ duplicate, rotate, remove, distribute })[b.dataset.action]();
  }

  // ---------- render ----------
  function render(opts = {}) {
    if (!svg) return;
    if (!state.layout) { svg.innerHTML = ""; return; }
    const t = { scale: view.scale, tx: view.tx, ty: view.ty };
    const c = MapView.colours();
    const parts = [];
    const u = state.draw.underlay, g = state.layout.grid;
    if (u) parts.push(`<image href="${u.src}" x="${t.tx}" y="${t.ty}" width="${g.width * t.scale}" height="${g.height * t.scale}" preserveAspectRatio="xMinYMin meet" opacity="${u.opacity}" pointer-events="none"/>`);
    parts.push(MapView.gridSvg(g, t, c));
    parts.push(MapView.shapesSvg(state.layout, t, c, { selectedId: state.draw.selectedId, handles: true, interactive: state.draw.tool === "select" }));
    if (preview) parts.push(`<rect x="${preview.x * t.scale + t.tx}" y="${preview.y * t.scale + t.ty}" width="${preview.w * t.scale}" height="${preview.h * t.scale}" fill="${c.accentSoft}" fill-opacity="0.6" stroke="${c.accent}" stroke-width="2" stroke-dasharray="5 3"/>`);
    svg.innerHTML = parts.join("");
    document.querySelector("#tab-draw [data-zoom-label]").textContent = Math.round(t.scale * 10) + "%";
    document.getElementById("undoBtn").disabled = !state.draw.undo.length;
    document.getElementById("redoBtn").disabled = !state.draw.redo.length;
    renderFoot();
    if (opts.side !== false) renderSide();
    if (opts.detail !== false) renderDetail();
  }

  function renderFoot() {
    const el = document.getElementById("drawFoot");
    if (!state.layout) { el.textContent = ""; return; }
    const g = state.layout.grid;
    el.textContent = `1 vak = ${String(g.cellMeters).replace(".", ",")} m · raster ${g.width} × ${g.height} · ${state.layout.shapes.length} vlakken` +
      (cursor ? ` · x ${Math.floor(cursor.x)}, y ${Math.floor(cursor.y)}` : "") + (state.layoutDirty ? " · niet opgeslagen" : "");
  }

  function renderSide() {
    const g = state.layout.grid;
    document.getElementById("gridMeters").value = g.cellMeters;
    document.getElementById("gridW").value = g.width;
    document.getElementById("gridH").value = g.height;
    const src = { saved: "Opgeslagen layout", example: "Voorbeeld-layout (nog niet opgeslagen voor dit warehouse)", new: "Nieuwe, lege layout" }[state.layoutSource] || "";
    document.getElementById("layoutSource").textContent = src + (state.layoutDirty ? " · niet-opgeslagen wijzigingen" : "");
    const checks = state.checks;
    const list = document.getElementById("unplacedList");
    const total = checks ? checks.unplaced.length : 0;
    const badge = document.getElementById("unplacedTotal");
    badge.textContent = total;
    badge.classList.toggle("zero", total === 0);
    if (!checks) { list.innerHTML = ""; return; }
    const rows = Object.entries(checks.unplacedByZone).sort((a, b) => b[1] - a[1]);
    list.innerHTML = rows.length ? rows.map(([zone, n]) => {
      const drawable = zone !== "(geen zone)";
      return `<li ${drawable ? `class="clickable" data-zone="${escapeHtml(zone)}" title="Klik om deze zone te tekenen"` : 'title="Locaties zonder zone kun je alleen als losse locatie tekenen"'}>
        <span>${escapeHtml(zone)}</span><span class="count-badge">${n}</span></li>`;
    }).join("") : `<li><span class="hint">Alle locaties van ${escapeHtml(state.warehouse)} vallen in een getekend vlak.</span></li>`;
  }

  function renderDetail() {
    const el = document.getElementById("shapeDetail");
    const s = selected();
    if (!s) {
      el.innerHTML = `<p class="hint">Klik op een vlak om het te bewerken.</p>
        <p class="hint"><b>Sneltoetsen</b><br>N rechthoek · V selecteren · Delete verwijderen · R draaien 90° · Ctrl+D dupliceren · pijltjes verschuiven · Ctrl+Z / Ctrl+Y · Ctrl+S opslaan</p>`;
      return;
    }
    const opts = refOptions(s.type);
    const locs = locationsForShape(s);
    const warnings = (state.checks ? state.checks.aisleWarnings : []).filter((w) => w.shape === s.id);
    const dupes = s.ref ? state.layout.shapes.filter((x) => x.id !== s.id && x.type === s.type && String(x.ref).toLowerCase() === s.ref.toLowerCase()) : [];
    el.innerHTML = `
      <label class="field">Type
        <select data-field="type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === s.type ? "selected" : ""}>${v}</option>`).join("")}</select>
      </label>
      ${s.type === "point" ? `<label class="field">Rol
        <select data-field="role">${Core.POINT_ROLES.map((r) => `<option value="${r.id}" ${r.id === s.role ? "selected" : ""}>${r.label}</option>`).join("")}</select></label>` : ""}
      <label class="field">Gekoppeld aan ${escapeHtml(TYPE_LABEL[s.type].toLowerCase())} (uit de data)
        <input type="search" data-field="ref" list="refOptions" value="${escapeHtml(s.ref)}" placeholder="Zoek ${opts.length} waarden…">
        <datalist id="refOptions">${opts.slice(0, 5000).map((o) => `<option value="${escapeHtml(o)}">`).join("")}</datalist>
      </label>
      <div id="refMessage"></div>
      ${s.ref ? `<p class="hint">${locs.length} locatie(s) in de data.</p>` : `<div class="message warn">Nog niet gekoppeld: dit vlak telt niet mee in de stromen.</div>`}
      ${dupes.length ? `<div class="message warn">${escapeHtml(s.ref)} is ook gekoppeld aan vlak ${dupes.map((d) => escapeHtml(d.id)).join(", ")}.</div>` : ""}
      ${warnings.map((w) => `<div class="message warn">${escapeHtml(w.message)}</div>`).join("")}
      <label class="field">Label<input type="text" data-field="label" value="${escapeHtml(s.label || "")}"></label>
      <div class="grid-4">
        <label class="field">x<input type="number" step="${state.draw.snap}" data-field="x" value="${s.x}"></label>
        <label class="field">y<input type="number" step="${state.draw.snap}" data-field="y" value="${s.y}"></label>
        <label class="field">b<input type="number" step="${state.draw.snap}" data-field="w" value="${s.w}"></label>
        <label class="field">h<input type="number" step="${state.draw.snap}" data-field="h" value="${s.h}"></label>
      </div>
      ${s.type === "zone" ? `<button class="btn-quiet btn-small" data-action="distribute" ${s.ref ? "" : "disabled"}>Gangen automatisch verdelen</button>` : ""}
      <div class="btn-row">
        <button class="btn-quiet btn-small" data-action="duplicate">Dupliceren</button>
        <button class="btn-quiet btn-small" data-action="rotate">Draai 90°</button>
        <button class="btn-quiet btn-small btn-danger" data-action="remove">Verwijderen</button>
      </div>`;
  }

  async function saveLayout() {
    if (!state.layout) return;
    try {
      const saved = await api(`/api/layouts/${encodeURIComponent(state.warehouse)}`, { method: "POST", body: state.layout });
      state.layout = saved.layout; state.layoutSource = saved.source; state.layoutDirty = false;
      message("layoutMessage", `Layout van ${state.warehouse} opgeslagen (${fmtDateTime(saved.layout.savedAt)}).`, "good");
      render();
    } catch (error) {
      message("layoutMessage", `Opslaan van de layout van ${state.warehouse} mislukt: ${error.message}`, "error");
    }
  }

  return { init, render, onShow, fitNow, setTool };
})();
