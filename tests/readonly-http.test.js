// Acceptance: the backend can send no other HTTP method than GET to D365 F&O.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createReadOnlyClient } = require("../app/lib/readonly-http");

test("read-only client refuses every method except GET without calling fetch", async () => {
  let calls = 0;
  const client = createReadOnlyClient(async () => { calls++; return { ok: true }; });
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "MERGE", "OPTIONS", "HEAD", "", "get-ish"]) {
    await assert.rejects(client.request(m, "https://x.example/data/Foo"), /only GET/);
  }
  assert.strictEqual(calls, 0);
});

test("read-only client sends GET with bearer token", async () => {
  let seen;
  const client = createReadOnlyClient(async (url, init) => { seen = { url, init }; return { ok: true }; });
  await client.get("https://x.example/data/Foo", { token: "t" });
  assert.strictEqual(seen.init.method, "GET");
  assert.strictEqual(seen.init.headers.Authorization, "Bearer t");
  assert.strictEqual(seen.init.body, undefined);
});

test("d365 adapter fetches entities through the GET-only client (with paging)", async () => {
  const d365 = require("../app/d365-adapter");
  const methods = [];
  let page = 0;
  d365._setClientForTests(createReadOnlyClient(async (url, init) => {
    methods.push(init.method);
    page++;
    const body = page === 1
      ? { value: [{ ZoneId: "A", ZoneName: "Zone A" }], "@odata.nextLink": "https://env.example/data/WarehouseZones?$skiptoken=1" }
      : { value: [{ ZoneId: "B", ZoneName: "Zone B" }] };
    return { ok: true, json: async () => body };
  }));
  d365._setConnectionForTests({ environmentUrl: "https://env.example", tenantId: "t", clientId: "c", clientSecret: "s", label: "ACC", source: "manual" });
  const rows = await d365.fetchSource({ label: "Zones", entitySet: "WarehouseZones", legalEntityField: "dataAreaId", warehouseField: "", fields: { id: "ZoneId", name: "ZoneName" } }, { legalEntity: "NL01" });
  assert.deepStrictEqual(rows, [{ id: "A", name: "Zone A" }, { id: "B", name: "Zone B" }]);
  assert.deepStrictEqual(methods, ["GET", "GET"]);
  await assert.rejects(d365.fetchSource({ label: "x", entitySet: "Zones", fields: { id: "ZoneId" }, legalEntityField: "dataAreaId" }, { legalEntity: "NL01' or 1 eq 1" }), /legal entity/);
  d365._setConnectionForTests(null);
});

test("no D365 code path calls fetch with a non-GET method (source scan)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "d365-adapter.js"), "utf8");
  // The only POST allowed is the token request to Entra ID (login.microsoftonline.com).
  const posts = src.split("\n").filter((l) => /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(l));
  assert.strictEqual(posts.length, 1);
  const tokenFn = src.slice(src.indexOf("async function getAccessToken"), src.indexOf("function status()"));
  assert.match(tokenFn, /login\.microsoftonline\.com/);
  assert.match(tokenFn, /method: "POST"/);
});
