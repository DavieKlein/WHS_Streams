/* Shared map rendering for Tekenen, Stromen and the export.
 * Everything is drawn in screen pixels from world (grid) coordinates with t = { scale, tx, ty },
 * so stroke widths, arrowheads and text stay crisp at every zoom level and the export can
 * reuse the same code with fixed colours. */
const MapView = (() => {
  function colours() {
    return {
      text: cssToken("--text"), muted: cssToken("--muted"), line: cssToken("--line"), bg: cssToken("--bg"), panel: cssToken("--panel"),
      accent: cssToken("--accent"), accentSoft: cssToken("--accent-soft"), accentText: cssToken("--accent-text"),
      warnSoft: cssToken("--warn-soft"), warnText: cssToken("--warn-text"), warnLine: cssToken("--warn-line"),
      error: cssToken("--error"), errorSoft: cssToken("--error-soft"), good: cssToken("--good"), font: cssToken("--font")
    };
  }

  // ---------- view (pan / zoom) ----------
  function create(svg, onChange) {
    const view = { svg, scale: 8, tx: 20, ty: 20, onChange, fitted: false };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(view, e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    return view;
  }
  function zoomAt(view, factor, sx, sy) {
    const next = Math.min(80, Math.max(1.5, view.scale * factor));
    const f = next / view.scale;
    view.tx = sx - (sx - view.tx) * f;
    view.ty = sy - (sy - view.ty) * f;
    view.scale = next;
    view.onChange && view.onChange();
  }
  function zoomCentre(view, factor) {
    const r = view.svg.getBoundingClientRect();
    zoomAt(view, factor, r.width / 2, r.height / 2);
  }
  function fit(view, grid) {
    const r = view.svg.getBoundingClientRect();
    if (!r.width || !grid) return;
    const pad = 24;
    view.scale = Math.max(1.5, Math.min((r.width - 2 * pad) / grid.width, (r.height - 2 * pad) / grid.height));
    view.tx = (r.width - grid.width * view.scale) / 2;
    view.ty = (r.height - grid.height * view.scale) / 2;
    view.fitted = true;
    view.onChange && view.onChange();
  }
  function toWorld(view, clientX, clientY) {
    const r = view.svg.getBoundingClientRect();
    return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
  }
  /** Drag on background pans the view. Returns a handler for pointerdown. */
  function startPan(view, e) {
    const sx = e.clientX, sy = e.clientY, tx = view.tx, ty = view.ty;
    view.svg.classList.add("panning");
    const move = (ev) => { view.tx = tx + ev.clientX - sx; view.ty = ty + ev.clientY - sy; view.onChange && view.onChange(); };
    const up = () => { view.svg.classList.remove("panning"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------- pieces ----------
  const r1 = (v) => Math.round(v * 10) / 10;
  const sx = (t, x) => x * t.scale + t.tx;
  const sy = (t, y) => y * t.scale + t.ty;

  function gridSvg(grid, t, c) {
    const out = [];
    const step = t.scale >= 10 ? 1 : t.scale >= 4 ? 5 : 10;
    for (let x = 0; x <= grid.width; x += step) {
      const major = x % 10 === 0;
      out.push(`<line x1="${r1(sx(t, x))}" y1="${r1(sy(t, 0))}" x2="${r1(sx(t, x))}" y2="${r1(sy(t, grid.height))}" stroke="${major ? c.line : "#EDEDED"}" stroke-width="1"/>`);
    }
    for (let y = 0; y <= grid.height; y += step) {
      const major = y % 10 === 0;
      out.push(`<line x1="${r1(sx(t, 0))}" y1="${r1(sy(t, y))}" x2="${r1(sx(t, grid.width))}" y2="${r1(sy(t, y))}" stroke="${major ? c.line : "#EDEDED"}" stroke-width="1"/>`);
    }
    out.push(`<rect x="${r1(sx(t, 0))}" y="${r1(sy(t, 0))}" width="${r1(grid.width * t.scale)}" height="${r1(grid.height * t.scale)}" fill="none" stroke="${c.muted}" stroke-width="1"/>`);
    return out.join("");
  }

  const ORDER = { zone: 0, aisle: 1, location: 2, point: 3 };
  const ROLE_LABEL = Object.fromEntries(Core.POINT_ROLES.map((r) => [r.id, r.label]));

  /**
   * opts: { selectedId, dimIds:Set, highlightIds:Set, problemRefs:Set(zone refs), handles:bool, interactive:bool }
   */
  function shapesSvg(layout, t, c, opts = {}) {
    const shapes = (layout.shapes || []).slice().sort((a, b) => (ORDER[a.type] - ORDER[b.type]) || (b.w * b.h - a.w * a.h));
    const out = [];
    for (const s of shapes) {
      const x = sx(t, s.x), y = sy(t, s.y), w = s.w * t.scale, h = s.h * t.scale;
      const linked = !!s.ref;
      const problem = opts.problemRefs && s.type === "zone" && opts.problemRefs.has(String(s.ref).toLowerCase());
      let fill = c.panel, stroke = c.muted, sw = 1, dash = "", rx = 0;
      if (s.type === "zone") { fill = c.accentSoft; stroke = c.accentText; sw = 1.5; rx = 3; }
      if (s.type === "aisle") { fill = c.panel; stroke = c.accentText; }
      if (s.type === "point") { fill = c.panel; stroke = c.text; sw = 1.5; rx = 4; }
      if (!linked) { fill = c.warnSoft; stroke = c.warnText; dash = "4 3"; }
      if (problem) { fill = c.errorSoft; stroke = c.error; dash = "6 3"; sw = 1.5; }
      const opacity = opts.dimIds && opts.dimIds.has(s.id) ? 0.35 : 1;
      const hl = opts.highlightIds && opts.highlightIds.has(s.id);
      out.push(`<g data-shape="${escapeHtml(s.id)}" opacity="${opacity}" ${opts.interactive ? 'style="cursor:pointer"' : ""}>`);
      out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx}" fill="${fill}" stroke="${hl ? c.accent : stroke}" stroke-width="${hl ? 3 : sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
      // Labels: zone top-left, others centred when they fit.
      const label = s.label || s.ref || "";
      const sub = s.type === "point" ? (ROLE_LABEL[s.role] || "Vast punt") + (s.ref && s.ref !== label ? ` · ${s.ref}` : "")
        : (s.ref && s.label && s.ref !== s.label ? s.ref : "");
      if (s.type === "zone") {
        if (w > 36 && h > 18) out.push(`<text x="${r1(x + 6)}" y="${r1(y + 15)}" font-size="12" font-weight="700" fill="${c.text}">${escapeHtml(label || "(niet gekoppeld)")}</text>`);
        if (sub && w > 60 && h > 32) out.push(`<text x="${r1(x + 6)}" y="${r1(y + 28)}" font-size="11" fill="${c.muted}">${escapeHtml(sub)}</text>`);
        if (problem && w > 80 && h > 46) out.push(`<text x="${r1(x + 6)}" y="${r1(y + (sub ? 41 : 28))}" font-size="11" font-weight="700" fill="${c.error}">Geen directive-actie</text>`);
      } else {
        const fits = w > label.length * 6 + 4 && h > 13;
        const vertical = !fits && h > label.length * 6 + 4 && w > 13;
        if (fits) out.push(`<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 + (sub && h > 30 ? -2 : 4))}" font-size="11" font-weight="600" text-anchor="middle" fill="${c.text}">${escapeHtml(label || "?")}</text>`);
        else if (vertical) out.push(`<text transform="translate(${r1(x + w / 2 + 4)} ${r1(y + h / 2)}) rotate(-90)" font-size="11" font-weight="600" text-anchor="middle" fill="${c.text}">${escapeHtml(label || "?")}</text>`);
        if (sub && fits && h > 30 && w > sub.length * 5.5) out.push(`<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 12)}" font-size="10" text-anchor="middle" fill="${c.muted}">${escapeHtml(sub)}</text>`);
      }
      out.push("</g>");
    }
    if (opts.handles && opts.selectedId) {
      const s = shapes.find((x) => x.id === opts.selectedId);
      if (s) {
        const x = sx(t, s.x), y = sy(t, s.y), w = s.w * t.scale, h = s.h * t.scale;
        out.push(`<rect x="${r1(x - 2)}" y="${r1(y - 2)}" width="${r1(w + 4)}" height="${r1(h + 4)}" fill="none" stroke="${c.accent}" stroke-width="2" pointer-events="none"/>`);
        for (const [hx, hy, name] of [[x, y, "nw"], [x + w, y, "ne"], [x, y + h, "sw"], [x + w, y + h, "se"]]) {
          out.push(`<rect data-handle="${name}" x="${r1(hx - 5)}" y="${r1(hy - 5)}" width="10" height="10" fill="${c.panel}" stroke="${c.accentText}" stroke-width="1.5" style="cursor:${name === "nw" || name === "se" ? "nwse" : "nesw"}-resize"/>`);
        }
      }
    }
    return out.join("");
  }

  // ---------- arrows ----------
  function boundaryPoint(rect, from, pad) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = from.x - cx, dy = from.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const tt = Math.min(dx ? (rect.w / 2) / Math.abs(dx) : Infinity, dy ? (rect.h / 2) / Math.abs(dy) : Infinity);
    const len = Math.hypot(dx, dy);
    const k = Math.min(1, tt) + pad / len;
    return { x: cx + dx * k, y: cy + dy * k };
  }
  function quad(p0, c, p2, u) {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, d = u * u;
    return { x: a * p0.x + b * c.x + d * p2.x, y: a * p0.y + b * c.y + d * p2.y };
  }

  /** Builds arrow geometry (screen px) for the visible flows. */
  function arrowGeometry(flows, layout, t) {
    const byId = new Map((layout.shapes || []).map((s) => [s.id, s]));
    const screenRect = (s) => ({ x: sx(t, s.x), y: sy(t, s.y), w: s.w * t.scale, h: s.h * t.scale });
    const list = [];
    for (const f of flows) {
      const choices = new Set(f.edges.map((e) => e.choice)).size;
      f.edges.forEach((e, i) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (a && b) list.push({ flow: f, edge: e, edgeIndex: i, a, b, multi: choices > 1 });
      });
    }
    const groups = new Map();
    for (const item of list) {
      const key = [item.a.id, item.b.id].sort().join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const items of groups.values()) {
      items.forEach((item, i) => {
        const ra = screenRect(item.a), rb = screenRect(item.b);
        const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
        // Normal from the sorted pair so A->B and B->A bend to different sides consistently.
        const [p, q] = item.a.id < item.b.id ? [ca, cb] : [cb, ca];
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
        const off = 16 + (i - (items.length - 1) / 2) * 20;
        const ctrl = { x: (ca.x + cb.x) / 2 + n.x * off, y: (ca.y + cb.y) / 2 + n.y * off };
        const p0 = boundaryPoint(ra, ctrl, 2), p2 = boundaryPoint(rb, ctrl, 3);
        item.d = `M${r1(p0.x)},${r1(p0.y)} Q${r1(ctrl.x)},${r1(ctrl.y)} ${r1(p2.x)},${r1(p2.y)}`;
        item.labelAt = quad(p0, ctrl, p2, 0.62);
        item.width = Math.min(8, 1.8 + (item.edge.weight - 1) * 1.4);
      });
    }
    return list;
  }

  function markerDefs(c) {
    return "<defs>" + Object.keys(FLOW_STYLE).map((cat) =>
      `<marker id="arrow-${cat}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${flowColour(cat)}"/></marker>`
    ).join("") + "</defs>";
  }

  /** opts: { selectedFlowId, interactive } */
  function arrowsSvg(flows, layout, t, c, opts = {}) {
    const geo = arrowGeometry(flows, layout, t);
    const out = [];
    for (const g of geo) {
      const f = g.flow, cat = f.category, style = FLOW_STYLE[cat] || FLOW_STYLE.overig;
      const dim = opts.selectedFlowId && opts.selectedFlowId !== f.id ? 0.2 : 1;
      out.push(`<g data-flow="${escapeHtml(f.id)}" data-edge="${g.edgeIndex}" opacity="${dim}" ${opts.interactive ? 'style="cursor:pointer"' : ""}>`);
      if (opts.interactive) out.push(`<path d="${g.d}" fill="none" stroke="transparent" stroke-width="14"/>`);
      out.push(`<path d="${g.d}" fill="none" stroke="${flowColour(cat)}" stroke-width="${r1(g.width)}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""} stroke-linecap="round" marker-end="url(#arrow-${cat})"/>`);
      const text = (g.multi ? String(g.edge.choice) : "") + (f.status === "conflict" ? "!" : "");
      if (text) {
        const bad = f.status === "conflict";
        out.push(`<circle cx="${r1(g.labelAt.x)}" cy="${r1(g.labelAt.y)}" r="${text.length > 1 ? 10 : 8}" fill="${c.panel}" stroke="${bad ? c.error : flowColour(cat)}" stroke-width="1.5"/>`);
        out.push(`<text x="${r1(g.labelAt.x)}" y="${r1(g.labelAt.y + 4)}" font-size="11" font-weight="700" text-anchor="middle" fill="${bad ? c.error : c.text}">${escapeHtml(text)}</text>`);
      }
      out.push("</g>");
    }
    return out.join("");
  }

  return { create, zoomAt, zoomCentre, fit, toWorld, startPan, colours, gridSvg, shapesSvg, arrowsSvg, markerDefs, arrowGeometry };
})();
