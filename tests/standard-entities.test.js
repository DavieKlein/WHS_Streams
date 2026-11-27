// Live-like data in the shape of the standard D365 entities (CDM field names, composite keys, query text fields).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const Core = require("../app/js/core");
const { createReadOnlyClient } = require("../app/lib/readonly-http");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "entities.json"), "utf8"));
const fieldsOf = (spec) => spec.split("+");
function mapRow(src, row) { // same mapping as d365-adapter.fetchSource
  const out = {};
  for (const [k, spec] of Object.entries(src.fields)) out[k] = fieldsOf(spec).map((f) => (row[f] === null || row[f] === undefined ? "" : row[f])).join("|");
  return out;
}
const xml = (table, field, value) => `<Query><DataSource Table="${table}"><Ranges><Range Field="${field}" Value="${value}"/></Ranges></DataSource></Query>`;
const D = { WarehouseLocationDirectiveWorkOrderType: "Purch", WarehouseLocationDirectiveId: "PO Put", WarehouseLocationDirectiveWorkType: "Put", WarehouseLocationDirectiveInventorySiteId: "S1", WarehouseLocationDirectiveWarehouseId: "W1" };

function liveFlat() {
  const s = cfg.sources;
  return {
    locations: [
      { WarehouseLocationId: "RECV", WarehouseId: "W1", WarehouseZoneId: "DOCK", IsDefaultReceiptWarehouseLocation: "Yes" },
      { WarehouseLocationId: "A-01", WarehouseId: "W1", WarehouseZoneId: "BULK", WarehouseAisleId: "A", IsDefaultReceiptWarehouseLocation: "No" }
    ].map((r) => mapRow(s.locations, r)),
    zones: [{ ZoneId: "DOCK" }, { ZoneId: "BULK" }].map((r) => mapRow(s.zones, r)),
    profiles: [], workClasses: [],
    directives: [{ WorkOrderType: "Purch", DirectiveId: "PO Put", WorkType: "Put", InventorySiteId: "S1", WarehouseId: "W1", SequenceNumber: 1, WarehouseLocationDirectiveCode: "", DirectiveQuery: "" }].map((r) => mapRow(s.directives, r)),
    directiveLines: [{ ...D, SequenceNumber: 1, MinimumWarehouseWorkOrderLineQuantity: 0, MaximumWarehouseWorkOrderLineQuantity: 0 }].map((r) => mapRow(s.directiveLines, r)),
    directiveActions: [{ ...D, WarehouseLocationDirectiveLineSequenceNumber: 1, ActionSequenceNumber: 1, ActionName: "Bulk", ActionStrategy: "None", ActionQuery: xml("WMSLocation", "zoneId", "BULK") }].map((r) => mapRow(s.directiveActions, r)),
    templates: [{ WorkOrderType: "Purch", TemplateId: "Inbound", TemplateSequenceNumber: 1, TemplateQuery: "" }].map((r) => mapRow(s.templates, r)),
    templateLines: [{ WarehouseWorkOrderType: "Purch", WarehouseWorkTemplateId: "Inbound", LineNumber: 1, WorkOrderLineType: "Pick" }, { WarehouseWorkOrderType: "Purch", WarehouseWorkTemplateId: "Inbound", LineNumber: 2, WorkOrderLineType: "Put" }].map((r) => mapRow(s.templateLines, r)),
    queryRanges: []
  };
}
const layout = { warehouse: "W1", grid: { cellMeters: 1, width: 50, height: 30 }, shapes: [
  { id: "z1", type: "zone", ref: "BULK", x: 0, y: 0, w: 20, h: 10 },
  { id: "z2", type: "zone", ref: "DOCK", x: 0, y: 20, w: 20, h: 5 } ] };

test("composite keys from the standard entities link directive, line and action", () => {
  const m = Core.normalize(liveFlat());
  assert.strictEqual(m.issues.filter((i) => i.type !== "location-no-zone").length, 0);
  const d = m.directives[0];
  assert.strictEqual(d.lines[0].actions[0].name, "Bulk");
  assert.deepStrictEqual(d.lines[0].actions[0].ranges, [{ table: "WMSLocation", field: "zoneId", value: "BULK" }]);
  assert.strictEqual(d.rangesKnown, true); // empty DirectiveQuery = no restrictions
});

test("enum symbol Purch + default receipt location give a complete inbound flow", () => {
  const m = Core.normalize(liveFlat());
  const fr = Core.buildFlows(m, layout, { warehouse: "W1" });
  assert.strictEqual(fr.flows.length, 1);
  assert.deepStrictEqual([fr.flows[0].fromAreas, fr.flows[0].toAreas, fr.flows[0].status], [["z2"], ["z1"], "complete"]);
  assert.strictEqual(fr.flows[0].category, "inkoop");
});

test("a query text in an unknown format is 'unknown', never 'no restrictions'", () => {
  const flat = liveFlat();
  flat.directiveActions[0].query = "AAEC+binary==";
  const m = Core.normalize(flat);
  const a = m.directives[0].lines[0].actions[0];
  assert.strictEqual(a.rangesKnown, false);
  const fr = Core.buildFlows(m, layout, { warehouse: "W1" });
  assert.strictEqual(fr.flows[0].status, "incomplete");
  assert.ok(fr.flows[0].notes.some((n) => /onbekend formaat/.test(n)));
  assert.strictEqual(m.queryStats.unknown, 1);
});

test("CSV rows override the query text and may use readable keys", () => {
  const flat = liveFlat();
  flat.directiveActions[0].query = "AAEC+binary==";
  flat.queryRanges = [{ source: "action", key: "PO Put/1/1", table: "WMSLocation", field: "zoneId", value: "DOCK" }];
  const a = Core.normalize(flat).directives[0].lines[0].actions[0];
  assert.deepStrictEqual([a.rangesKnown, a.rangesOrigin, a.ranges[0].value], [true, "export", "DOCK"]);
});

test("query text parser: attributes, child elements, empty", () => {
  assert.deepStrictEqual(Core.parseQueryText(xml("WMSLocation", "zoneId", "A,B")).ranges, [{ table: "WMSLocation", field: "zoneId", value: "A,B" }]);
  const child = "<Query><DataSource><Table>InventTable</Table><Ranges><Range><Field>ItemGroupId</Field><Value>KOEL</Value></Range></Ranges></DataSource></Query>";
  assert.deepStrictEqual(Core.parseQueryText(child).ranges, [{ table: "InventTable", field: "ItemGroupId", value: "KOEL" }]);
  assert.strictEqual(Core.parseQueryText("").status, "empty");
  assert.strictEqual(Core.parseQueryText('<Query><DataSource Table="WMSLocation"><Ranges/></DataSource></Query>').status, "empty");
  assert.strictEqual(Core.parseQueryText("0x0102").status, "unknown");
});

test("auto-detect finds entity sets in $metadata by their fields (GET only)", async () => {
  const d365 = require("../app/d365-adapter");
  const prop = (n) => `<Property Name="${n}" Type="Edm.String"/>`;
  const type = (name, fields) => `<EntityType Name="${name}">${fields.map(prop).join("")}</EntityType>`;
  const s = cfg.sources;
  const xmlMd = `<edmx:Edmx><Schema>${type("WarehouseLocationDirectiveV2", s.directives.match.concat(["Extra"]))}${type("WarehouseLocationDirective", ["DirectiveId", "WorkOrderType"])}` +
    `${type("WarehouseZone", s.zones.match)}</Schema><EntityContainer>` +
    `<EntitySet Name="WarehouseLocationDirectivesV2" EntityType="Microsoft.Dynamics.DataEntities.WarehouseLocationDirectiveV2"/>` +
    `<EntitySet Name="WarehouseLocationDirectives" EntityType="Microsoft.Dynamics.DataEntities.WarehouseLocationDirective"/>` +
    `<EntitySet Name="WarehouseZones" EntityType="Microsoft.Dynamics.DataEntities.WarehouseZone"/></EntityContainer></edmx:Edmx>`;
  const methods = [];
  d365._setClientForTests(createReadOnlyClient(async (url, init) => { methods.push(init.method); return { ok: true, text: async () => xmlMd }; }));
  d365._setConnectionForTests({ environmentUrl: "https://env.example", tenantId: "t", clientId: "c", clientSecret: "s", label: "ACC", source: "manual" });
  const r = await d365.autoDetect(cfg);
  assert.strictEqual(r.result.directives.chosen, "WarehouseLocationDirectivesV2");
  assert.strictEqual(r.result.zones.chosen, "WarehouseZones");
  assert.strictEqual(r.result.templates.status, "not-found");
  assert.ok(methods.every((m) => m === "GET"));
  d365._setConnectionForTests(null);
});
