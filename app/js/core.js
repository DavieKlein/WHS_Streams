/* Core pipeline: normalise -> resolve -> build flows -> place -> checks.
 * Pure functions, no DOM. Loaded as a classic <script> in the browser (window.Core)
 * and with require() in Node (tests). Every unsolvable case is reported, never dropped.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- small helpers ----------
  const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
  const num = (v, fallback) => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const lc = (v) => str(v).toLowerCase();
  const eqi = (a, b) => lc(a) === lc(b);

  // ---------- work order types ----------
  // Category drives colour + line style. Matches both labels ("Sales orders") and enum symbols ("Sales").
  const CATEGORIES = [
    { id: "inkoop", label: "Inkoop", test: /purch|inkoop/ },
    { id: "verkoop", label: "Verkoop", test: /sales|verkoop/ },
    { id: "aanvulling", label: "Aanvulling", test: /replen|aanvul/ },
    { id: "productie", label: "Productie", test: /prod|raw ?mat|finished ?goods|co-?product|kanban|batch ?order/ },
    { id: "transfer", label: "Transfer", test: /transfer/ },
    { id: "overig", label: "Overig", test: /.*/ }
  ];
  function categoryOf(workOrderType) {
    const t = lc(workOrderType);
    return CATEGORIES.find((c) => c.test.test(t)) || CATEGORIES[CATEGORIES.length - 1];
  }
  function normWorkType(v) {
    const t = lc(v);
    if (t === "pick") return "Pick";
    if (t === "put") return "Put";
    return str(v);
  }

  // Pick lines that have no location directive in D365 take their stock from a fixed point.
  // TODO(assumption, see docs/assumptions.md A3): receipt flows pick from the receipt dock,
  // finished goods put-away picks from the production output point.
  const PICK_FALLBACK = [
    { test: /purch|transfer ?receipt|return/, role: "receipt", note: "Geen Pick-directive: voorraad staat op de ontvangstlocatie (aanname A3)." },
    { test: /finished ?goods|co-?product|prodput/, role: "production-output", note: "Geen Pick-directive: voorraad komt van productie-output (aanname A3)." }
  ];

  const POINT_ROLES = [
    { id: "receipt", label: "Ontvangstdock" },
    { id: "baydoor", label: "Expeditiedeur" },
    { id: "staging", label: "Staging" },
    { id: "production-input", label: "Productie-input" },
    { id: "production-output", label: "Productie-output" }
  ];

  // ---------- query ranges ----------
  // Tables whose ranges restrict WHERE stock may go (applied to locations).
  const LOCATION_FIELDS = {
    wmslocation: { wmslocationid: "id", locationid: "id", zoneid: "zoneId", locprofileid: "profileId", aisleid: "aisleId",
      rack: "rack", level: "level", position: "position", inventlocationid: "warehouse" },
    whszone: { zoneid: "zoneId", zonegroupid: "zoneGroup" },
    whslocationprofile: { locprofileid: "profileId", locationtype: "locationType", lpcontrolled: "lpControlled" }
  };
  // Tables whose ranges restrict WHICH stock/orders a directive applies to (shown as conditions).
  const CONDITION_TABLES = new Set(["inventtable", "inventitemgroupitem", "whsinventtable", "inventdim", "inventtablemodule",
    "ecoresproduct", "salestable", "salesline", "purchtable", "purchline", "whsloadtable", "whsloadline", "whsworktable",
    "whsworkline", "inventtransferline", "inventtransfertable", "prodtable", "whsworkclasstable"]);

  // D365 range syntax subset: "A,B" (or), "!A" (not), "A..B" (between), "*" wildcard, '""' empty.
  function termMatcher(term) {
    const t = term.trim();
    if (t === '""' || t === "''") return (v) => str(v) === "";
    if (t.startsWith("!")) { const inner = termMatcher(t.slice(1)); return (v) => !inner(v); }
    const between = t.match(/^(.*)\.\.(.*)$/);
    if (between) {
      const lo = lc(between[1]), hi = lc(between[2]);
      return (v) => { const x = lc(v); return (!lo || x >= lo) && (!hi || x <= hi); };
    }
    if (t.includes("*") || t.includes("?")) {
      const re = new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
      return (v) => re.test(str(v));
    }
    return (v) => eqi(v, t);
  }
  function valueMatcher(value) {
    const terms = str(value).split(",").filter((t) => t.trim() !== "");
    if (!terms.length) return () => true;
    const ms = terms.map(termMatcher);
    return (v) => ms.some((m) => m(v));
  }

  /** Splits ranges into location filters, conditions and unsupported ranges. */
  function classifyRanges(ranges) {
    const location = [], conditions = [], unsupported = [];
    for (const r of ranges || []) {
      const table = lc(r.table), field = lc(r.field);
      if (!table) continue; // "checked, no restrictions" marker row
      if (LOCATION_FIELDS[table] && LOCATION_FIELDS[table][field]) location.push({ ...r, prop: LOCATION_FIELDS[table][field], kind: table });
      else if (CONDITION_TABLES.has(table)) conditions.push(r);
      else unsupported.push(r);
    }
    return { location, conditions, unsupported };
  }

  /** Same field -> OR, different fields -> AND (D365 query semantics). */
  function locationFilter(locRanges, model) {
    const groups = new Map();
    for (const r of locRanges) {
      const key = r.kind + "|" + r.prop;
      if (!groups.has(key)) groups.set(key, { kind: r.kind, prop: r.prop, matchers: [] });
      groups.get(key).matchers.push(valueMatcher(r.value));
    }
    const zoneById = model.zoneById, profileById = model.profileById;
    return (loc) => {
      for (const g of groups.values()) {
        let value;
        if (g.kind === "wmslocation") value = loc[g.prop];
        else if (g.kind === "whszone") value = g.prop === "zoneId" ? loc.zoneId : (zoneById.get(loc.zoneId) || {})[g.prop];
        else value = g.prop === "profileId" ? loc.profileId : (profileById.get(loc.profileId) || {})[g.prop];
        if (!g.matchers.some((m) => m(value))) return false;
      }
      return true;
    };
  }

  function canonicalRanges(ranges) {
    return (ranges || []).filter((r) => str(r.table))
      .map((r) => [lc(r.table), lc(r.field), lc(r.value)].join("="))
      .sort().join("&");
  }

  const truthy = (v) => v === true || ["yes", "true", "1", "ja"].includes(lc(v));

  /**
   * Best-effort reader for the query text in DirectiveQuery / ActionQuery / TemplateQuery of the standard
   * V2 data entities. TODO(assumption A9): the exact format is not documented; we read XML with
   * DataSource/Range elements (attributes or child elements Table/Name, Field, Value). Anything else is
   * reported as "unknown" (never silently treated as "no restrictions"); see Koppeling → query samples.
   */
  function parseQueryText(text) {
    const raw = str(text);
    if (!raw) return { status: "empty", ranges: [] };
    if (!raw.startsWith("<")) return { status: "unknown", ranges: [] };
    const valueOf = (attrs, body, names) => {
      for (const n of names) {
        const a = attrs.match(new RegExp("\\b" + n + "\\s*=\\s*\"([^\"]*)\"", "i"));
        if (a) return decodeXml(a[1]);
        const c = (body || "").match(new RegExp("<" + n + ">([\\s\\S]*?)</" + n + ">", "i"));
        if (c) return decodeXml(c[1].trim());
      }
      return "";
    };
    const ranges = [];
    const dsRe = /<(\w*DataSource\w*)\b([^>]*?)(\/?)>/gi;
    const blocks = [];
    let m;
    while ((m = dsRe.exec(raw))) blocks.push({ attrs: m[2], start: m.index, end: raw.length });
    blocks.forEach((b, i) => { if (blocks[i + 1]) b.end = blocks[i + 1].start; });
    for (const b of blocks) {
      const chunk = raw.slice(b.start, b.end);
      const headEnd = chunk.search(/<\w*Range/i);
      const head = headEnd > 0 ? chunk.slice(0, headEnd) : chunk;
      const table = valueOf(b.attrs, head, ["Table", "TableName", "Name"]);
      const rRe = /<(\w*Range)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
      let r;
      while ((r = rRe.exec(chunk))) {
        if (/Ranges$/i.test(r[1])) continue;
        const field = valueOf(r[2], r[3], ["Field", "FieldName", "Name"]);
        const value = valueOf(r[2], r[3], ["Value", "RangeValue"]);
        if (table && field && value) ranges.push({ table, field, value });
      }
    }
    if (ranges.length) return { status: "parsed", ranges };
    // XML without any element that looks like a range: a query without restrictions.
    if (!/<\w*Range\b/i.test(raw) || /<\w*Ranges\s*\/>/i.test(raw) && !/<\w*Range\b(?!s)/i.test(raw)) return { status: "empty", ranges: [] };
    return { status: "unknown", ranges: [] };
  }
  function decodeXml(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }

  // ---------- 1+2. normalise ----------
  /**
   * flat: { locations, zones, profiles, workClasses, directives, directiveLines, directiveActions,
   *         templates, templateLines, queryRanges }  (see docs/data-model.md)
   */
  function normalize(flat) {
    flat = flat || {};
    const issues = [];
    const rangeIndex = new Map();
    for (const r of flat.queryRanges || []) {
      const key = lc(r.source) + "|" + str(r.key);
      if (!rangeIndex.has(key)) rangeIndex.set(key, []);
      if (str(r.table)) rangeIndex.get(key).push({ table: str(r.table), field: str(r.field), value: str(r.value) });
    }
    // Precedence: explicit rows (X++ export / CSV) > the query text field of the standard entity > unknown.
    const queryStats = { parsed: 0, empty: 0, unknown: 0, explicit: 0 };
    const rangesFor = (source, key, queryText, altKeys) => {
      let k = source + "|" + str(key);
      // TODO(assumption A10): CSV rows may also use the readable key (directive id, "directive/line/action", template id).
      if (!rangeIndex.has(k) && altKeys) for (const a of altKeys) if (rangeIndex.has(source + "|" + str(a))) { k = source + "|" + str(a); break; }
      if (rangeIndex.has(k)) { queryStats.explicit++; return { known: true, ranges: rangeIndex.get(k), origin: "export" }; }
      if (queryText === undefined || queryText === null) return { known: false, ranges: [], origin: "none" };
      const q = parseQueryText(queryText);
      queryStats[q.status]++;
      if (q.status === "unknown") return { known: false, ranges: [], origin: "query-unknown-format" };
      return { known: true, ranges: q.ranges, origin: "entity-query" };
    };

    const zones = (flat.zones || []).map((z) => ({ id: str(z.id), zoneGroup: str(z.zoneGroup), name: str(z.name) }));
    const profiles = (flat.profiles || []).map((p) => ({ id: str(p.id), locationType: str(p.locationType), lpControlled: p.lpControlled }));
    const locations = (flat.locations || []).map((l) => ({
      id: str(l.id), warehouse: str(l.warehouse), zoneId: str(l.zoneId), profileId: str(l.profileId),
      aisleId: str(l.aisleId), rack: str(l.rack), level: str(l.level), position: str(l.position),
      // Default locations from the warehouse setup (WMSWarehouseLocationEntity IsDefault* flags).
      defaultRoles: [["receipt", l.isDefaultReceipt], ["production-input", l.isDefaultProductionInput],
        ["production-output", l.isDefaultProductionOutput], ["baydoor", l.isDefaultIssue]].filter(([, v]) => truthy(v)).map(([r]) => r)
    }));
    for (const l of locations) if (!l.zoneId) issues.push({ type: "location-no-zone", ref: l.id, message: `Locatie ${l.id} heeft geen zone.` });

    const directives = (flat.directives || []).map((d) => {
      const r = rangesFor("directive", d.key, d.query, [d.code]);
      return {
        key: str(d.key), code: str(d.code), name: str(d.name), workOrderType: str(d.workOrderType),
        workType: normWorkType(d.workType), site: str(d.site), warehouse: str(d.warehouse),
        sequence: num(d.sequence, 0), directiveCode: str(d.directiveCode), multipleSku: str(d.multipleSku),
        restrictByUnit: str(d.restrictByUnit), ranges: r.ranges, rangesKnown: r.known, rangesOrigin: r.origin, lines: []
      };
    });
    const dirByKey = new Map(directives.map((d) => [d.key, d]));
    const lineByKey = new Map();
    for (const l of flat.directiveLines || []) {
      const d = dirByKey.get(str(l.directiveKey));
      const line = { key: str(l.key), sequence: num(l.sequence, 0), fromQty: num(l.fromQty), toQty: num(l.toQty),
        unit: str(l.unit), locateQty: str(l.locateQty), actions: [], directive: d ? d.key : "" };
      if (!d) { issues.push({ type: "orphan-line", ref: line.key, message: `Directive-regel ${line.key} hoort bij onbekende directive ${str(l.directiveKey)}.` }); continue; }
      d.lines.push(line);
      lineByKey.set(line.key, line);
    }
    for (const a of flat.directiveActions || []) {
      const line = lineByKey.get(str(a.lineKey));
      if (!line) { issues.push({ type: "orphan-action", ref: str(a.key), message: `Directive-actie ${str(a.name) || str(a.key)} hoort bij onbekende regel ${str(a.lineKey)}.` }); continue; }
      const dOfLine = dirByKey.get(line.directive);
      const r = rangesFor("action", a.key, a.query, [`${dOfLine.code}/${line.sequence}/${num(a.sequence, 0)}`]);
      line.actions.push({ key: str(a.key), sequence: num(a.sequence, 0), name: str(a.name), strategy: str(a.strategy),
        allowSplit: a.allowSplit, ranges: r.ranges, rangesKnown: r.known, rangesOrigin: r.origin });
    }
    for (const d of directives) {
      d.lines.sort((a, b) => a.sequence - b.sequence);
      for (const l of d.lines) l.actions.sort((a, b) => a.sequence - b.sequence);
    }
    directives.sort((a, b) => lc(a.workOrderType).localeCompare(lc(b.workOrderType)) || a.sequence - b.sequence);

    const templates = (flat.templates || []).map((t) => {
      const r = rangesFor("template", t.key, t.query, [t.id]);
      return { key: str(t.key), id: str(t.id), workOrderType: str(t.workOrderType), sequence: num(t.sequence, 0),
        workPool: str(t.workPool), valid: t.valid !== false && lc(t.valid) !== "no" && lc(t.valid) !== "false",
        warehouse: str(t.warehouse), ranges: r.ranges, rangesKnown: r.known, rangesOrigin: r.origin, lines: [] };
    });
    const tplByKey = new Map(templates.map((t) => [t.key, t]));
    for (const l of flat.templateLines || []) {
      const t = tplByKey.get(str(l.templateKey));
      if (!t) { issues.push({ type: "orphan-template-line", ref: str(l.templateKey), message: `Template-regel hoort bij onbekend template ${str(l.templateKey)}.` }); continue; }
      t.lines.push({ lineNo: num(l.lineNo, 0), workType: normWorkType(l.workType), workClass: str(l.workClass), directiveCode: str(l.directiveCode) });
    }
    for (const t of templates) t.lines.sort((a, b) => a.lineNo - b.lineNo);
    templates.sort((a, b) => lc(a.workOrderType).localeCompare(lc(b.workOrderType)) || a.sequence - b.sequence);

    const warehouses = Array.from(new Set(locations.map((l) => l.warehouse).concat(directives.map((d) => d.warehouse)).filter(Boolean))).sort();

    return {
      warehouses, zones, profiles, locations, directives, templates,
      workClasses: (flat.workClasses || []).map((w) => ({ id: str(w.id), workOrderType: str(w.workOrderType) })),
      queryStats,
      zoneById: new Map(zones.map((z) => [z.id, z])),
      profileById: new Map(profiles.map((p) => [p.id, p])),
      issues
    };
  }

  // ---------- 3. resolve ----------
  /** Which locations does one directive action allow? */
  function resolveAction(directive, action, model) {
    const header = classifyRanges(directive.ranges);
    const own = classifyRanges(action.ranges);
    const result = {
      locations: [], conditions: header.conditions.concat(own.conditions),
      unsupported: header.unsupported.concat(own.unsupported), status: "complete", reasons: [], scope: "restricted"
    };
    if (!directive.rangesKnown) { result.status = "incomplete"; result.reasons.push(`Directive ${directive.code}: query-ranges ${directive.rangesOrigin === "query-unknown-format" ? "in onbekend formaat" : "onbekend"}.`); }
    if (!action.rangesKnown) { result.status = "incomplete"; result.reasons.push(`Actie "${action.name}": query-ranges ${action.rangesOrigin === "query-unknown-format" ? "in onbekend formaat" : "onbekend"}.`); return result; }
    if (result.unsupported.length) {
      result.status = "incomplete";
      result.reasons.push("Niet-ondersteunde range(s): " + result.unsupported.map((r) => `${r.table}.${r.field} = ${r.value}`).join("; "));
    }
    const locRanges = header.location.concat(own.location);
    if (!locRanges.length) result.scope = "all";
    const filter = locationFilter(locRanges, model);
    result.locations = model.locations.filter((l) => eqi(l.warehouse, directive.warehouse) && filter(l));
    if (!result.locations.length) { result.status = "incomplete"; result.reasons.push(`Actie "${action.name}" vindt geen enkele locatie.`); }
    if (result.conditions.length) result.reasons.push(`${directive.code}: alleen voor ` + result.conditions.map((r) => `${r.table}.${r.field} = ${r.value}`).join("; "));
    return result;
  }

  /** Directives that a template line can use, in D365 evaluation order. */
  function directivesForLine(template, line, model, warehouse) {
    return model.directives.filter((d) =>
      eqi(d.warehouse, warehouse) && eqi(d.workOrderType, template.workOrderType) && d.workType === line.workType &&
      // TODO(assumption A2): a line without directive code only uses directives without directive code.
      eqi(d.directiveCode, line.directiveCode)
    ).sort((a, b) => a.sequence - b.sequence);
  }

  /** Conflicts: same warehouse, order type, work type, directive code and identical header restrictions. */
  function findConflicts(model) {
    const groups = new Map();
    for (const d of model.directives) {
      if (!d.rangesKnown) continue;
      const key = [lc(d.warehouse), lc(d.workOrderType), d.workType, lc(d.directiveCode), canonicalRanges(d.ranges)].join("#");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const conflicts = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.sequence - b.sequence);
      conflicts.push({
        directives: list.map((d) => d.key), winner: list[0].key,
        message: `${list.map((d) => d.code).join(", ")}: zelfde work order type (${list[0].workOrderType}), work type (${list[0].workType}) en restricties. ` +
          `Alleen ${list[0].code} (volgorde ${list[0].sequence}) wordt ooit gebruikt.`
      });
    }
    return conflicts;
  }

  // ---------- 5. place (layout) ----------
  function shapeIndex(layout) {
    const shapes = (layout && layout.shapes) || [];
    const idx = { byLocation: new Map(), byAisle: new Map(), byZone: new Map(), byRole: new Map(), shapes };
    for (const s of shapes) {
      const ref = str(s.ref);
      if ((s.type === "location" || s.type === "point") && ref) idx.byLocation.set(lc(ref), s);
      if (s.type === "aisle" && ref) idx.byAisle.set(lc(ref), s);
      if (s.type === "zone" && ref) idx.byZone.set(lc(ref), s);
      if (s.type === "point" && s.role) { if (!idx.byRole.has(s.role)) idx.byRole.set(s.role, []); idx.byRole.get(s.role).push(s); }
    }
    return idx;
  }
  /** Most specific drawn shape for a location: location/point > aisle > zone. */
  function shapeForLocation(loc, idx) {
    return idx.byLocation.get(lc(loc.id)) || (loc.aisleId && idx.byAisle.get(lc(loc.aisleId))) || (loc.zoneId && idx.byZone.get(lc(loc.zoneId))) || null;
  }
  /** Maps a set of locations to shapes; a fully covered, drawn zone collapses into the zone shape. */
  function placeLocations(locations, model, idx, warehouse) {
    const shapes = new Map(), unplaced = [];
    const byZone = new Map();
    for (const l of locations) { const z = l.zoneId || ""; if (!byZone.has(z)) byZone.set(z, []); byZone.get(z).push(l); }
    for (const [zoneId, locs] of byZone) {
      const zoneShape = zoneId && idx.byZone.get(lc(zoneId));
      const zoneTotal = model.locations.filter((l) => eqi(l.zoneId, zoneId) && eqi(l.warehouse, warehouse)).length;
      const pointsInSet = locs.filter((l) => { const s = idx.byLocation.get(lc(l.id)); return s && s.type === "point"; });
      if (zoneShape && locs.length === zoneTotal && pointsInSet.length === 0) { shapes.set(zoneShape.id, zoneShape); continue; }
      for (const l of locs) {
        const s = shapeForLocation(l, idx);
        if (s) shapes.set(s.id, s); else unplaced.push(l);
      }
    }
    return { shapes: Array.from(shapes.values()), unplaced };
  }

  // ---------- 4. flows ----------
  /** Resolves one template line into ranked options (directive -> line -> action). */
  function resolveLine(template, line, model, warehouse) {
    const dirs = directivesForLine(template, line, model, warehouse);
    const options = [];
    let rank = 0;
    dirs.forEach((d, di) => {
      if (!d.lines.length) options.push({ rank: ++rank, directive: d, dirRank: di + 1, line: null, action: null,
        resolved: { locations: [], conditions: [], unsupported: [], status: "incomplete", reasons: [`Directive ${d.code} heeft geen regels.`] } });
      for (const l of d.lines) {
        if (!l.actions.length) options.push({ rank: ++rank, directive: d, dirRank: di + 1, line: l, action: null,
          resolved: { locations: [], conditions: [], unsupported: [], status: "incomplete", reasons: [`Directive ${d.code} regel ${l.sequence} heeft geen acties.`] } });
        for (const a of l.actions) options.push({ rank: ++rank, directive: d, dirRank: di + 1, line: l, action: a, resolved: resolveAction(d, a, model) });
      }
    });
    return options;
  }

  function buildFlows(model, layout, opts) {
    opts = opts || {};
    const warehouse = opts.warehouse || (layout && layout.warehouse) || model.warehouses[0];
    const idx = shapeIndex(layout);
    const conflicts = findConflicts(model);
    const conflictKeys = new Set(conflicts.flatMap((c) => c.directives));
    const flows = [];

    for (const t of model.templates) {
      if (t.warehouse && !eqi(t.warehouse, warehouse)) continue;
      if (!t.valid) continue;
      let pendingPick = null, prevPut = null, pairNo = 0;
      for (const line of t.lines) {
        if (line.workType === "Pick") {
          pendingPick = { line, options: resolveLine(t, line, model, warehouse) };
        } else if (line.workType === "Put") {
          const put = { line, options: resolveLine(t, line, model, warehouse) };
          const pick = pendingPick || { line: null, options: [] };
          pendingPick = null;
          pairNo++;
          flows.push(makeFlow(t, pairNo, pick, put, prevPut, model, idx, warehouse, conflictKeys));
          prevPut = flows[flows.length - 1];
        }
      }
      if (pendingPick) {
        flows.push({ id: `${t.key}#open`, warehouse, workOrderType: t.workOrderType, category: categoryOf(t.workOrderType).id,
          templateId: t.id, templateKey: t.key, pair: pairNo + 1, pickLine: pendingPick.line.lineNo, putLine: null,
          from: [], to: [], fromAreas: [], toAreas: [], sources: [], status: "incomplete",
          notes: [`Template ${t.id}: Pick-regel ${pendingPick.line.lineNo} wordt niet gevolgd door een Put-regel.`], edges: [], unplaced: [] });
      }
    }
    return { warehouse, flows, conflicts };
  }

  function makeFlow(t, pairNo, pick, put, prevPut, model, idx, warehouse, conflictKeys) {
    const notes = [];
    let status = "complete";
    const sources = [];
    const unplaced = new Map();
    const addUnplaced = (list) => list.forEach((l) => unplaced.set(l.id, l));

    // ---- source side
    let from = []; // [{shape, rank, options:[...]}]
    if (pick.options.length) {
      const areaMap = new Map();
      for (const o of pick.options) {
        sources.push(sourceRef(o, "Pick"));
        if (o.resolved.status !== "complete") status = "incomplete";
        o.resolved.reasons.forEach((r) => notes.push(r));
        const placed = placeLocations(o.resolved.locations, model, idx, warehouse);
        addUnplaced(placed.unplaced);
        for (const s of placed.shapes) {
          if (!areaMap.has(s.id)) areaMap.set(s.id, { shape: s, rank: o.rank, options: [] });
          areaMap.get(s.id).options.push(o);
        }
      }
      from = Array.from(areaMap.values());
    } else if (prevPut && prevPut.to.length) {
      from = prevPut.to.map((a) => ({ shape: a.shape, rank: 1, options: [], chained: true }));
      notes.push(`Pick vanaf de plek van de vorige Put-regel (template ${t.id}).`);
    } else {
      const rule = PICK_FALLBACK.find((r) => r.test.test(lc(t.workOrderType)));
      let pts = rule ? idx.byRole.get(rule.role) || [] : [];
      if (rule) {
        // Prefer the warehouse's own default location (IsDefault* flag) when it is drawn.
        const defaults = model.locations.filter((l) => eqi(l.warehouse, warehouse) && l.defaultRoles.includes(rule.role));
        const placed = placeLocations(defaults, model, idx, warehouse).shapes;
        if (placed.length) pts = placed;
      }
      if (rule && pts.length) { from = pts.map((s) => ({ shape: s, rank: 1, options: [], fallback: true })); notes.push(rule.note); }
      else if (rule) { status = "incomplete"; notes.push(rule.note + " Er is nog geen vast punt met deze rol getekend."); }
      else { status = "incomplete"; notes.push(`Geen Pick-directive gevonden voor ${t.workOrderType}` + (pick.line ? ` (regel ${pick.line.lineNo}).` : ".")); }
    }

    // ---- target side
    let to = [];
    if (put.options.length) {
      const areaMap = new Map();
      for (const o of put.options) {
        sources.push(sourceRef(o, "Put"));
        if (o.resolved.status !== "complete") status = "incomplete";
        o.resolved.reasons.forEach((r) => notes.push(r));
        const placed = placeLocations(o.resolved.locations, model, idx, warehouse);
        addUnplaced(placed.unplaced);
        for (const s of placed.shapes) {
          if (!areaMap.has(s.id)) areaMap.set(s.id, { shape: s, rank: o.rank, options: [] });
          const a = areaMap.get(s.id);
          a.options.push(o);
          a.rank = Math.min(a.rank, o.rank);
        }
      }
      to = Array.from(areaMap.values()).sort((a, b) => a.rank - b.rank);
    } else {
      status = "incomplete";
      notes.push(`Geen Put-directive gevonden voor ${t.workOrderType}, regel ${put.line.lineNo}` + (put.line.directiveCode ? ` (directive code ${put.line.directiveCode}).` : "."));
    }

    if (unplaced.size) notes.push(`${unplaced.size} toegestane locatie(s) nog niet getekend.`);
    if (!from.length || !to.length) status = "incomplete";
    const usesConflict = sources.some((s) => conflictKeys.has(s.directiveKey));
    if (usesConflict) { status = "conflict"; notes.push("Gebruikt een directive die overlapt met een andere directive (zie Controles)."); }

    // Edges: one per from-area x to-area. Weight = number of directive actions feeding it.
    const edges = [];
    for (const f of from) for (const tA of to) {
      if (f.shape.id === tA.shape.id) continue;
      const weight = Math.max(1, (f.options.length || 0) + tA.options.length);
      edges.push({ from: f.shape.id, to: tA.shape.id, rank: tA.rank, weight, actions: tA.options.length + f.options.length });
    }
    // Rank labels are 1..n in order of the distinct target ranks.
    const ranks = Array.from(new Set(to.map((a) => a.rank))).sort((a, b) => a - b);
    for (const e of edges) e.choice = ranks.indexOf(e.rank) + 1;
    for (const a of to) a.choice = ranks.indexOf(a.rank) + 1;

    return {
      id: `${t.key}#${pairNo}`, warehouse, workOrderType: t.workOrderType, category: categoryOf(t.workOrderType).id,
      templateId: t.id, templateKey: t.key, pair: pairNo, pickLine: pick.line ? pick.line.lineNo : null, putLine: put.line.lineNo,
      from, to, fromAreas: from.map((a) => a.shape.id), toAreas: to.map((a) => a.shape.id),
      sources, status, notes: Array.from(new Set(notes)), edges, unplaced: Array.from(unplaced.values())
    };
  }

  function sourceRef(o, side) {
    return {
      side, directive: o.directive.code, directiveKey: o.directive.key, line: o.line ? o.line.sequence : null,
      action: o.action ? o.action.sequence : null, actionName: o.action ? o.action.name : "", strategy: o.action ? o.action.strategy : "",
      rank: o.rank, status: o.resolved.status
    };
  }

  // ---------- checks ----------
  function rectOf(s) { return { x: s.x, y: s.y, w: s.w, h: s.h }; }
  function contains(outer, inner) {
    const a = rectOf(outer), b = rectOf(inner);
    return b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 && b.x + b.w <= a.x + a.w + 1e-6 && b.y + b.h <= a.y + a.h + 1e-6;
  }

  function runChecks(model, layout, flowResult) {
    const warehouse = flowResult.warehouse;
    const idx = shapeIndex(layout);
    const locs = model.locations.filter((l) => eqi(l.warehouse, warehouse));

    // Zones reached by any directive action of this warehouse (not only via templates).
    const reachedZones = new Map();
    const unresolvedActions = [];
    for (const d of model.directives.filter((x) => eqi(x.warehouse, warehouse))) {
      if (!d.rangesKnown) unresolvedActions.push({ directive: d.code, action: "", reason: "Query-ranges van de directive zijn onbekend." });
      for (const l of d.lines) for (const a of l.actions) {
        const r = resolveAction(d, a, model);
        if (!a.rangesKnown) unresolvedActions.push({ directive: d.code, action: a.name, reason: "Query-ranges van de actie zijn onbekend." });
        else if (r.unsupported.length) unresolvedActions.push({ directive: d.code, action: a.name, reason: r.reasons.find((x) => x.startsWith("Niet-ondersteunde")) || "Niet-ondersteunde range." });
        else if (!r.locations.length) unresolvedActions.push({ directive: d.code, action: a.name, reason: "Vindt geen enkele locatie." });
        for (const loc of r.locations) {
          if (!reachedZones.has(loc.zoneId)) reachedZones.set(loc.zoneId, new Set());
          reachedZones.get(loc.zoneId).add(d.code);
        }
      }
    }
    const zoneIds = Array.from(new Set(model.zones.map((z) => z.id).filter((z) => locs.some((l) => l.zoneId === z))));
    const zonesWithoutAction = zoneIds.filter((z) => !reachedZones.has(z)).map((z) => ({
      zone: z, locations: locs.filter((l) => l.zoneId === z).length, drawn: idx.byZone.has(lc(z))
    }));

    const unplaced = locs.filter((l) => !shapeForLocation(l, idx));
    const unplacedByZone = {};
    for (const l of unplaced) unplacedByZone[l.zoneId || "(geen zone)"] = (unplacedByZone[l.zoneId || "(geen zone)"] || 0) + 1;

    const linesWithoutDirective = [];
    for (const f of flowResult.flows) for (const n of f.notes) if (/^Geen (Pick|Put)-directive gevonden/.test(n)) linesWithoutDirective.push({ template: f.templateId, message: n });

    // Aisle shapes must lie within the zone shape of their locations.
    const aisleWarnings = [];
    for (const s of idx.shapes.filter((x) => x.type === "aisle" && x.ref)) {
      const zonesOfAisle = Array.from(new Set(locs.filter((l) => eqi(l.aisleId, s.ref)).map((l) => l.zoneId).filter(Boolean)));
      for (const z of zonesOfAisle) {
        const zs = idx.byZone.get(lc(z));
        if (zs && !contains(zs, s)) aisleWarnings.push({ shape: s.id, aisle: s.ref, zone: z, message: `Gang ${s.ref} ligt (deels) buiten zonevlak ${z}.` });
      }
    }

    return {
      zonesWithoutAction, conflicts: flowResult.conflicts, unplaced, unplacedByZone,
      unresolvedActions, linesWithoutDirective, aisleWarnings,
      locationsWithoutZone: locs.filter((l) => !l.zoneId),
      issues: model.issues
    };
  }

  /** What a zone/area click shows: directive actions searching it and templates passing by. */
  function describeArea(shape, model, flowResult, layout) {
    const idx = shapeIndex(layout);
    const warehouse = flowResult.warehouse;
    const inShape = (l) => {
      const s = shapeForLocation(l, idx);
      if (!s) return false;
      if (s.id === shape.id) return true;
      return shape.type === "zone" && eqi(l.zoneId, shape.ref);
    };
    const actions = [];
    for (const d of model.directives.filter((x) => eqi(x.warehouse, warehouse))) for (const l of d.lines) for (const a of l.actions) {
      const r = resolveAction(d, a, model);
      const n = r.locations.filter(inShape).length;
      if (n) actions.push({ directive: d.code, workOrderType: d.workOrderType, workType: d.workType, line: l.sequence, action: a.name, locations: n });
    }
    const flows = flowResult.flows.filter((f) => f.fromAreas.includes(shape.id) || f.toAreas.includes(shape.id));
    const locations = model.locations.filter((l) => eqi(l.warehouse, warehouse) && inShape(l));
    return { actions, flows, locations };
  }

  /** Evenly split a zone shape into aisle strips, sorted by aisle id. */
  function distributeAisles(zoneShape, model, warehouse, newId) {
    const aisles = Array.from(new Set(model.locations
      .filter((l) => eqi(l.warehouse, warehouse) && eqi(l.zoneId, zoneShape.ref) && l.aisleId).map((l) => l.aisleId)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!aisles.length) return [];
    const vertical = zoneShape.w >= zoneShape.h; // strips side by side along the long side
    const total = vertical ? zoneShape.w : zoneShape.h;
    const step = total / aisles.length;
    return aisles.map((a, i) => {
      const start = Math.round(i * step * 100) / 100;
      const end = Math.round((i + 1) * step * 100) / 100;
      return vertical
        ? { id: newId(), type: "aisle", ref: a, label: a, x: zoneShape.x + start, y: zoneShape.y, w: end - start, h: zoneShape.h, rotation: 0 }
        : { id: newId(), type: "aisle", ref: a, label: a, x: zoneShape.x, y: zoneShape.y + start, w: zoneShape.w, h: end - start, rotation: 0 };
    });
  }

  /** Parses the query-range CSV: bron, recId, tabel, veld, waarde (English headers accepted). */
  function parseQueryRangesCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { rows: [], errors: ["Leeg bestand."] };
    const header = rows[0].map((h) => lc(h));
    const col = (names) => header.findIndex((h) => names.includes(h));
    const ci = { source: col(["bron", "source"]), key: col(["recid", "key"]), table: col(["tabel", "table"]), field: col(["veld", "field"]), value: col(["waarde", "value"]) };
    const missing = Object.entries(ci).filter(([, i]) => i < 0).map(([k]) => k);
    if (missing.length) return { rows: [], errors: ["Ontbrekende kolom(men): " + missing.join(", ") + ". Verwacht: bron, recId, tabel, veld, waarde."] };
    const out = [], errors = [];
    rows.slice(1).forEach((r, i) => {
      if (r.every((c) => !str(c))) return;
      const source = lc(r[ci.source]);
      if (!["directive", "action", "template"].includes(source)) { errors.push(`Regel ${i + 2}: bron "${r[ci.source]}" moet directive, action of template zijn.`); return; }
      if (!str(r[ci.key])) { errors.push(`Regel ${i + 2}: recId ontbreekt.`); return; }
      out.push({ source, key: str(r[ci.key]), table: str(r[ci.table]), field: str(r[ci.field]), value: str(r[ci.value]) });
    });
    return { rows: out, errors };
  }

  function parseCsv(text) {
    const delim = (str(text).split(/\r?\n/)[0] || "").includes(";") ? ";" : ",";
    const rows = []; let row = [], cell = "", q = false;
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  return {
    CATEGORIES, POINT_ROLES, categoryOf, normWorkType, normalize, classifyRanges, resolveAction, directivesForLine,
    findConflicts, buildFlows, runChecks, describeArea, distributeAisles, shapeIndex, shapeForLocation, placeLocations,
    parseQueryRangesCsv, parseCsv, valueMatcher, parseQueryText
  };
});
