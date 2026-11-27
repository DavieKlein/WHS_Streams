// The ONLY way this app talks to D365 F&O: a client that refuses every method except GET.
// tests/readonly-http.test.js enforces this. The OAuth token request goes to Entra ID
// (login.microsoftonline.com), not to D365, and lives in d365-adapter.js.

const ALLOWED = "GET";

function createReadOnlyClient(fetchImpl = globalThis.fetch) {
  async function request(method, url, { token, headers = {}, accept = "application/json" } = {}) {
    const m = String(method || "").toUpperCase();
    if (m !== ALLOWED) {
      throw Object.assign(new Error(`Read-only client: method ${m || "(empty)"} is not allowed, only GET.`), { statusCode: 405 });
    }
    const response = await fetchImpl(url, {
      method: ALLOWED,
      headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }
    });
    return response;
  }
  return {
    request,
    get: (url, opts) => request("GET", url, opts)
  };
}

module.exports = { createReadOnlyClient };
