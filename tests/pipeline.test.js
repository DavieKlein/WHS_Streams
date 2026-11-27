// Pipeline tests on the fictional warehouse in sample-data/.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const Core = require("../app/js/core");

const DIR = path.join(__dirname, "..", "sample-data");
function sample() {
  const flat = {};
  for (const n of ["locations", "zones", "profiles", "directives", "directiveLines", "directiveActions", "templates", "templateLines", "workClasses"])
    flat[n] = JSON.parse(fs.readFileSync(path.join(DIR, "wh01", n + ".json"), "utf8"));
  flat.queryRanges = Core.parseQueryRangesCsv(fs.readFileSync(path.join(DIR, "wh01", "query-ranges.csv"), "utf8")).rows;
  return flat;
}
const layout = () => JSON.parse(fs.readFileSync(path.join(DIR, "layouts", "WH01.json"), "utf8"));
const run = (flat = sample(), lay = layout()) => {
  const model = Core.normalize(flat);
  const fr = Core.buildFlows(model, lay, { warehouse: "WH01" });
  return { model, fr, checks: Core.runChecks(model, lay, fr), lay };
};
const ref = (lay, id) => lay.shapes.find((s) => s.id === id).ref;

test("normalise links directives, lines and actions", () => {
  const { model } = run();
  const d = model.directives.find((x) => x.code === "PO-PUT-STD");
  assert.strictEqual(d.lines.length, 2);
  assert.deepStrictEqual(d.lines[0].actions.map((a) => a.name), ["Lege picklocatie", "Bulk"]);
  assert.ok(d.rangesKnown);
});

test("location without zone is reported", () => {
  const { model, checks } = run();
  assert.ok(model.issues.some((i) => i.type === "location-no-zone" && i.ref === "OVERFLOW-1"));
  assert.deepStrictEqual(checks.locationsWithoutZone.map((l) => l.id), ["OVERFLOW-1"]);
});

test("viewer shows exactly the expected flows and no extra", () => {
  const { fr, lay } = run();
  const summary = fr.flows.map((f) => `${f.templateId}#${f.pair}:${f.fromAreas.map((a) => ref(lay, a)).join("+")}>${f.to.map((a) => ref(lay, a.shape.id)).join(",")}:${f.status}`).sort();
  assert.deepStrictEqual(summary, [
    "Aanvulling min/max#1:BULK>:incomplete",
    "Inkoop standaard#1:DOCK-IN-1>KOEL,PICK,BULK:conflict",
    "Verkoop via staging#1:PICK+BULK>STAGE-01:complete",
    "Verkoop via staging#2:STAGE-01>DOCK-OUT-1:complete"
  ]);
});

test("choice order is numbered (1st KOEL, 2nd PICK, 3rd BULK)", () => {
  const { fr, lay } = run();
  const inbound = fr.flows.find((f) => f.templateId === "Inkoop standaard");
  assert.deepStrictEqual(inbound.to.map((a) => [ref(lay, a.shape.id), a.choice]), [["KOEL", 1], ["PICK", 2], ["BULK", 3]]);
});

test("directive without known ranges makes the flow incomplete, never hidden", () => {
  const { fr, checks } = run();
  const repl = fr.flows.find((f) => f.templateId === "Aanvulling min/max");
  assert.strictEqual(repl.status, "incomplete");
  assert.ok(repl.notes.some((n) => /REPL-PUT: query-ranges onbekend/.test(n)));
  assert.ok(checks.unresolvedActions.some((u) => u.directive === "REPL-PUT"));
});

test("overlapping directives are a conflict", () => {
  const { checks } = run();
  assert.strictEqual(checks.conflicts.length, 1);
  assert.match(checks.conflicts[0].message, /PO-PUT-STD, PO-PUT-OUD/);
});

test("zone without any directive action is flagged", () => {
  const { checks } = run();
  assert.deepStrictEqual(checks.zonesWithoutAction.map((z) => z.zone), ["RETOUR"]);
});

test("unplaced locations are counted per zone and drop when a zone is drawn", () => {
  const before = run();
  assert.deepStrictEqual(before.checks.unplacedByZone, { RETOUR: 3, "(geen zone)": 1 });
  const lay = layout();
  lay.shapes.push({ id: "s99", type: "zone", ref: "RETOUR", x: 34, y: 34, w: 12, h: 14, rotation: 0 });
  const after = run(sample(), lay);
  assert.deepStrictEqual(after.checks.unplacedByZone, { "(geen zone)": 1 });
});

test("unsupported ranges are marked, not ignored", () => {
  const flat = sample();
  const so = flat.directives.find((d) => d.code === "SO-PICK");
  flat.queryRanges = flat.queryRanges.filter((r) => !(r.source === "directive" && r.key === so.key));
  flat.queryRanges.push({ source: "directive", key: so.key, table: "SomeCustomTable", field: "Foo", value: "Bar" });
  const { fr } = run(flat);
  const f = fr.flows.find((x) => x.templateId === "Verkoop via staging" && x.pair === 1);
  assert.strictEqual(f.status, "incomplete");
  assert.ok(f.notes.some((n) => /Niet-ondersteunde range/.test(n)));
});

test("range syntax: lists, negation, wildcard, between", () => {
  const m = (v) => Core.valueMatcher(v);
  assert.ok(m("A,B")("b")); assert.ok(!m("A,B")("C"));
  assert.ok(m("!A")("B")); assert.ok(!m("!A")("A"));
  assert.ok(m("P0*")("P03")); assert.ok(m("B01..B02")("B015")); assert.ok(!m("B01..B02")("B03"));
});

test("auto-distribute aisles splits a zone into equal strips sorted by aisle", () => {
  const { model } = run();
  let n = 0;
  const strips = Core.distributeAisles({ id: "z", type: "zone", ref: "PICK", x: 52, y: 4, w: 32, h: 24 }, model, "WH01", () => "a" + n++);
  assert.deepStrictEqual(strips.map((s) => [s.ref, s.x, s.w]), [["P01", 52, 8], ["P02", 60, 8], ["P03", 68, 8], ["P04", 76, 8]]);
});

test("aisle outside its zone is warned", () => {
  const lay = layout();
  lay.shapes.push({ id: "s50", type: "aisle", ref: "P01", x: 90, y: 4, w: 4, h: 10, rotation: 0 });
  const { checks } = run(sample(), lay);
  assert.ok(checks.aisleWarnings.some((w) => w.aisle === "P01" && w.zone === "PICK"));
});

test("query-range CSV parser validates columns and sources", () => {
  assert.match(Core.parseQueryRangesCsv("a,b\n1,2").errors[0], /Ontbrekende kolom/);
  const r = Core.parseQueryRangesCsv("bron;recId;tabel;veld;waarde\naction;1;WMSLocation;zoneId;\"A,B\"\nfoo;2;x;y;z\n");
  assert.deepStrictEqual(r.rows, [{ source: "action", key: "1", table: "WMSLocation", field: "zoneId", value: "A,B" }]);
  assert.strictEqual(r.errors.length, 1);
});
