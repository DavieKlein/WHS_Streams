// Stroomviewer WMS: local, dependency-free server. Binds to 127.0.0.1 only.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnvFile } = require("./lib/env-file");

loadEnvFile(path.resolve(__dirname, "..", ".env"));

const d365 = require("./d365-adapter");
const store = require("./data-store");

const port = Number(process.env.PORT || 5176);
const STATIC_ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

d365.initFromEnv();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request, maxChars = 5e6) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxChars) { request.destroy(); reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 })); }
    });
    request.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("Request body is not valid JSON."), { statusCode: 400 })); }
    });
    request.on("error", reject);
  });
}

const methodNotAllowed = () => Object.assign(new Error("Method not allowed."), { statusCode: 405 });

async function handleD365Api(request, response, url) {
  await d365.restoreRemembered();
  const route = url.pathname.replace(/^\/api\/d365\//, "");
  const m = request.method;
  if (route === "status" && m === "GET") return sendJson(response, 200, d365.status());
  if (route === "connection" && m === "POST") return sendJson(response, 200, await d365.connect(await readJsonBody(request)));
  if (route === "connection" && m === "DELETE") return sendJson(response, 200, d365.disconnect());
  if (route === "test" && m === "GET") return sendJson(response, 200, await d365.testConnection());
  if (route === "metadata/search" && m === "GET") return sendJson(response, 200, await d365.searchMetadata(url.searchParams.get("q")));
  if (route === "metadata/autodetect" && m === "GET") return sendJson(response, 200, await d365.autoDetect(store.getEntities().config));
  if (route === "metadata/check" && m === "GET") return sendJson(response, 200, await d365.checkEntities(store.getEntities().config));
  throw methodNotAllowed();
}

async function handleAppApi(request, response, url) {
  await d365.restoreRemembered();
  const p = url.pathname, m = request.method;
  if (p === "/api/settings" && m === "GET") return sendJson(response, 200, store.getSettings());
  if (p === "/api/settings" && m === "POST") return sendJson(response, 200, store.saveSettings(await readJsonBody(request)));
  if (p === "/api/entities" && m === "GET") return sendJson(response, 200, store.getEntities());
  if (p === "/api/entities" && m === "POST") return sendJson(response, 200, store.saveEntities(await readJsonBody(request)));
  if (p === "/api/entities" && m === "DELETE") return sendJson(response, 200, store.resetEntities());
  if (p === "/api/dataset" && m === "GET") return sendJson(response, 200, store.getDataset());
  if (p === "/api/data/refresh" && m === "POST") return sendJson(response, 200, await store.refreshLive());
  if (p === "/api/data/query-samples" && m === "GET") return sendJson(response, 200, store.querySamples());
  if (p === "/api/query-ranges" && m === "GET") return sendJson(response, 200, store.queryRangesStatus());
  if (p === "/api/query-ranges" && m === "POST") return sendJson(response, 200, store.saveQueryRanges((await readJsonBody(request)).csv));
  const lay = p.match(/^\/api\/layouts\/([^/]+)$/);
  if (lay && m === "GET") return sendJson(response, 200, store.getLayout(decodeURIComponent(lay[1])));
  if (lay && m === "POST") return sendJson(response, 200, store.saveLayout(decodeURIComponent(lay[1]), await readJsonBody(request)));
  throw Object.assign(new Error("Unknown API route."), { statusCode: 404 });
}

function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); return response.end(); }
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.normalize(path.join(STATIC_ROOT, rel));
  const allowed = file.startsWith(STATIC_ROOT + path.sep) && !file.includes(`${path.sep}lib${path.sep}`) &&
    (rel.startsWith("/js/") || rel.startsWith("/assets/") || ["/index.html", "/styles.css"].includes(rel));
  if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404, { "Content-Type": "text/plain" }); return response.end("Not found"); }
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const fail = (error) => sendJson(response, error.statusCode || 500, { error: error.message || "Request failed." });
  if (url.pathname.startsWith("/api/d365/")) { handleD365Api(request, response, url).catch(fail); return; }
  if (url.pathname.startsWith("/api/")) { handleAppApi(request, response, url).catch(fail); return; }
  serveStatic(request, response, url);
});

server.listen(port, "127.0.0.1", () => console.log(`Stroomviewer WMS: http://127.0.0.1:${port}`));
