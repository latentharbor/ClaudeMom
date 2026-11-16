import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { canonicalPolicyUrl, createSitePolicyHandler, isSitePolicyUrl, SITE_POLICY_ENDPOINT } from "./site-policy.mjs";

let upstream, front, upstreamPort, frontPort;
const received = [], failures = [];
const events = new EventEmitter();

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    const route = new URL(input.url).pathname;
    received.push({ path: req.url, method: req.method, headers: req.headers, input });
    res.once("close", () => events.emit("closed", route));
    events.emit("request", route);
    if (["/slow", "/cancel"].includes(route)) {
      const timer = setTimeout(() => { if (!res.destroyed) res.end("{}"); }, 1000); timer.unref(); return;
    }
    if (route === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/never-follow" }); return res.end(); }
    if (route === "/http-error") { res.writeHead(429); return res.end("private upstream diagnostics"); }
    if (route === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>challenge</html>"); }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": "upstream-secret=never-forward" });
    if (route === "/empty") return res.end("{}");
    if (route === "/invalid-json") return res.end("{bad");
    if (route === "/huge") return res.end('"' + "x".repeat(70 * 1024) + '"');
    if (route === "/unknown") return res.end(JSON.stringify({ category: "future-category", org_policy: null }));
    if (route === "/missing-policy") return res.end(JSON.stringify({ category: "category0" }));
    if (route === "/bad-policy") return res.end(JSON.stringify({ category: "category0", org_policy: {} }));
    const category = /^\/category[0-3]$/.test(route) ? route.slice(1) : "category0";
    res.end(JSON.stringify({ category, org_policy: route === "/org-deny" ? "block" : null,
      policy_source: route === "/org-deny" ? "org_settings" : null, extra: "must-not-echo" }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); upstreamPort = upstream.address().port;
  const handler = createSitePolicyHandler({ timeoutMs: 250, onFailure: reason => failures.push(reason),
    request: (target, options, callback) => {
      assert.equal(target.href, SITE_POLICY_ENDPOINT);
      assert.equal(options.hostname, "releases.claude.com");
      assert.equal(options.port, 443);
      return http.request({ hostname: "127.0.0.1", port: upstreamPort, path: options.path,
        method: options.method, headers: options.headers }, callback);
    } });
  front = http.createServer((req, res) => {
    const url = new URL(req.url, "https://" + req.headers.host);
    if (!isSitePolicyUrl(url)) { res.writeHead(404); return res.end(); }
    if (req.headers["x-fixture-abort-probe"] === "1") {
      req.once("data", () => events.emit("partial-body"));
      req.once("aborted", () => events.emit("partial-aborted"));
    }
    void handler(req, res, url);
  });
  front.listen(0, "127.0.0.1"); await once(front, "listening"); frontPort = front.address().port;
});
after(async () => {
  for (const server of [front, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function call(path, { method = "POST", body = { url: "https://example.com/" }, headers = {}, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({ hostname: "127.0.0.1", port: frontPort, path, method,
      headers: { host: "claude.ai", ...(data ? { "content-type": "application/json", ...(!chunked ? { "content-length": data.length } : {}) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString(), json: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.once("error", reject);
    req.end(data);
  });
}
const endpoint = "/api/web/url_hash_check/browser_extension";

test("only the exact site policy endpoints on expected Claude hosts are claimed", () => {
  for (const host of ["claude.ai", "claude.com", "www.claude.ai", "api.anthropic.com"]) {
    assert.equal(isSitePolicyUrl(new URL(`https://${host}${endpoint}`)), true);
  }
  for (const value of ["https://example.com" + endpoint, "https://claude.ai/api/other", "https://claude.ai" + endpoint + "/extra"]) {
    assert.equal(isSitePolicyUrl(new URL(value)), false);
  }
});

test("URL classification does not disclose credentials, query parameters or fragments", async () => {
  const result = await call(endpoint, { body: { url: "https://user:password@Example.COM.:443/path?token=secret#private", page_content: "never-forward", account_uuid: "private" },
    headers: { authorization: "Bearer desktop-token", cookie: "sessionKey=private", "x-organization-uuid": "private", "x-api-key": "gateway-secret" } });
  assert.equal(result.status, 200);
  assert.equal(result.json.url, "https://example.com/path");
  const sent = received.at(-1);
  assert.deepEqual(sent.input, { url: "https://example.com/path" });
  assert.equal(sent.path, "/api/web/url_hash_check/browser_extension?anonymous=1");
  assert.equal(sent.method, "POST");
  for (const key of ["authorization", "cookie", "x-organization-uuid", "x-api-key"]) assert.equal(sent.headers[key], undefined);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.json.extra, undefined);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("legacy domain queries use the same real classification path", async () => {
  const result = await call("/api/web/domain_info/browser_extension?domain=example.com&unused=do-not-forward", { method: "GET", body: undefined });
  assert.equal(result.status, 200);
  assert.deepEqual(received.at(-1).input, { url: "https://example.com/" });
  assert.equal(result.json.domain, "example.com");
  const ipv6 = await call("/api/web/domain_info/browser_extension?domain=%5B2606%3A4700%3A%3A1111%5D", { method: "GET", body: undefined });
  assert.equal(ipv6.status, 200); assert.equal(ipv6.json.domain, "[2606:4700::1111]");
});

for (const category of ["category0", "category1", "category2", "category3"]) {
  test(`upstream ${category} is preserved without changing the verdict`, async () => {
    const result = await call(endpoint, { body: { url: `https://example.com/${category}` } });
    assert.equal(result.status, 200); assert.equal(result.json.category, category);
  });
}
test("an organization deny is never discarded", async () => {
  const result = await call(endpoint, { body: { url: "https://example.com/org-deny" } });
  assert.equal(result.status, 200); assert.equal(result.json.org_policy, "block"); assert.equal(result.json.policy_source, "org_settings");
});

test("missing, invalid and non-JSON verdicts fail closed", async () => {
  for (const route of ["empty", "invalid-json", "unknown", "missing-policy", "bad-policy", "html", "huge", "http-error", "redirect"]) {
    const result = await call(endpoint, { body: { url: `https://example.com/${route}` } });
    assert.equal(result.status, 503, route);
    assert.equal(result.json.category, undefined, route);
    assert.equal(result.json.error.type, "site_policy_unavailable", route);
    assert.doesNotMatch(result.raw, /private upstream|challenge|never-follow/);
  }
});
test("a slow classifier is bounded and never returns an allow verdict", async () => {
  const result = await call(endpoint, { body: { url: "https://example.com/slow" } });
  assert.equal(result.status, 503); assert.equal(result.json.error.reason, "upstream_timeout");
  assert.equal(result.json.category, undefined);
});
test("a disconnected browser cancels its outstanding classification request", async () => {
  const arrived = new Promise(resolve => events.on("request", route => { if (route === "/cancel") resolve(); }));
  const closed = new Promise(resolve => events.on("closed", route => { if (route === "/cancel") resolve(); }));
  const req = http.request({ hostname: "127.0.0.1", port: frontPort, path: endpoint, method: "POST",
    headers: { host: "claude.ai", "content-type": "application/json" } });
  req.on("error", () => {}); req.end(JSON.stringify({ url: "https://example.com/cancel" }));
  await arrived; req.destroy(); await closed;
});

test("aborting a partially uploaded request cannot crash the policy server", async () => {
  const partial = once(events, "partial-body"), aborted = once(events, "partial-aborted");
  const req = http.request({ hostname: "127.0.0.1", port: frontPort, path: endpoint, method: "POST",
    headers: { host: "claude.ai", "content-type": "application/json", "content-length": 1000, "x-fixture-abort-probe": "1" } });
  req.on("error", () => {});
  req.write('{"url":');
  await partial;
  req.destroy(); await aborted;
  const result = await call(endpoint);
  assert.equal(result.status, 200);
});

test("malformed and oversized requests never reach the classifier", async () => {
  const before = received.length;
  for (const input of [null, {}, [], { url: "file:///tmp/test" }, { url: "javascript:alert(1)" }, { url: "https://exa mple.com" }]) {
    assert.equal((await call(endpoint, { body: input })).status, 400);
  }
  assert.equal((await call(endpoint, { body: "{invalid" })).status, 400);
  assert.equal((await call(endpoint, { body: "x".repeat(9000) })).status, 413);
  assert.equal((await call(endpoint, { body: "x".repeat(9000), chunked: true })).status, 413);
  assert.equal((await call(endpoint, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call(endpoint, { method: "GET", body: undefined })).status, 405);
  for (const query of ["", "?domain=a&domain=b", "?domain=a%2Fb", "?domain=user%40example.com", "?domain=example.com%3A443"]) {
    assert.equal((await call("/api/web/domain_info/browser_extension" + query, { method: "GET", body: undefined })).status, 400);
  }
  assert.equal(received.length, before);
});
test("URL normalization keeps the scheme, non-default port and path", () => {
  assert.equal(canonicalPolicyUrl("http://example.com:8080/a%20b?secret=1"), "http://example.com:8080/a%20b");
  assert.equal(canonicalPolicyUrl("https://[2606:4700::1111]/"), "https://[2606:4700::1111]/");
});
