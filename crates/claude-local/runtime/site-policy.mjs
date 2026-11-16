// Public site classification used by the official Desktop's anonymous/3p
// path. This is not an inference gateway or an organization-policy service.
export const SITE_POLICY_ENDPOINT = "https://releases.claude.com/api/web/url_hash_check/browser_extension?anonymous=1";
const DOMAIN_PATH = "/api/web/domain_info/browser_extension";
const URL_PATH = "/api/web/url_hash_check/browser_extension";
const HOSTS = new Set(["claude.ai", "www.claude.ai", "claude.com", "www.claude.com", "api.anthropic.com"]);
const CATEGORIES = new Set(["category0", "category1", "category2", "category3"]);
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function isSitePolicyUrl(url) {
  return HOSTS.has(url.hostname.toLowerCase()) && [DOMAIN_PATH, URL_PATH].includes(url.pathname);
}

class PolicyError extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}

// Match Desktop's URL policy cache key: no credentials, query or fragment.
// Sending only this URL also keeps browsing secrets out of the service.
export function canonicalPolicyUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw new PolicyError(400, "invalid_url");
  let url;
  try { url = new URL(value); } catch { throw new PolicyError(400, "invalid_url"); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname) throw new PolicyError(400, "invalid_url");
  const host = url.hostname.replace(/\.+$/, "");
  if (!host) throw new PolicyError(400, "invalid_url");
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname}`;
}

function domainPolicyUrl(url) {
  const domains = url.searchParams.getAll("domain");
  if (domains.length !== 1 || !domains[0] || domains[0].length > 253 || /[\s\u0000-\u001f\u007f/@?#\\:%]/.test(domains[0])) {
    throw new PolicyError(400, "invalid_domain");
  }
  return canonicalPolicyUrl(`https://${domains[0]}/`);
}

function readRequest(req, deadline) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", error);
    };
    const fail = reason => { cleanup(); req.resume(); reject(reason); };
    const data = chunk => {
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) return fail(new PolicyError(413, "request_too_large"));
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const aborted = () => fail(new PolicyError(400, "request_aborted"));
    const error = () => fail(new PolicyError(400, "request_failed"));
    const timer = setTimeout(() => fail(new PolicyError(408, "request_timeout")), Math.max(1, deadline - Date.now()));
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", error);
  });
}

function classification(raw, policyUrl) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { throw new PolicyError(503, "invalid_response"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !CATEGORIES.has(body.category) ||
      ![null, "allow", "block"].includes(body.org_policy) ||
      body.policy_source != null && (typeof body.policy_source !== "string" || body.policy_source.length > 128)) {
    throw new PolicyError(503, "invalid_response");
  }
  return { url: policyUrl, domain: new URL(policyUrl).hostname, category: body.category,
    org_policy: body.org_policy, policy_source: body.policy_source ?? null };
}

function consult(request, policyUrl, deadline, res) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(SITE_POLICY_ENDPOINT);
    const body = Buffer.from(JSON.stringify({ url: policyUrl }));
    let upstream, finished = false;
    const cleanup = () => { clearTimeout(timer); res.off("close", disconnected); };
    const fail = error => {
      if (finished) return;
      finished = true; cleanup(); upstream?.destroy(); reject(error);
    };
    const disconnected = () => fail(new PolicyError(499, "client_disconnected"));
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => fail(new PolicyError(503, "upstream_timeout")), remaining);
    res.once("close", disconnected);
    try {
      // Deliberate header allowlist: never forward the Desktop's cookies,
      // OAuth token, organization ID, or inference gateway credential.
      upstream = request(endpoint, { hostname: endpoint.hostname, port: 443,
        path: endpoint.pathname + endpoint.search, method: "POST", timeout: remaining,
        headers: { "content-type": "application/json", accept: "application/json",
          "accept-encoding": "identity", "user-agent": "ClaudeMom site policy client",
          "content-length": body.length } }, response => {
        if (finished) { response.destroy(); return; }
        if (response.statusCode !== 200) { response.destroy(); return fail(new PolicyError(503, "upstream_status")); }
        if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(String(response.headers["content-type"] || "")) ||
            response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity" ||
            Number(response.headers["content-length"]) > MAX_RESPONSE_BYTES) {
          response.destroy(); return fail(new PolicyError(503, "invalid_response"));
        }
        let length = 0;
        const chunks = [];
        response.on("data", chunk => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) { response.destroy(); fail(new PolicyError(503, "response_too_large")); }
          else chunks.push(chunk);
        });
        response.once("aborted", () => fail(new PolicyError(503, "response_aborted")));
        response.once("error", () => fail(new PolicyError(503, "response_failed")));
        response.once("end", () => {
          if (finished) return;
          try {
            const result = classification(Buffer.concat(chunks), policyUrl);
            finished = true; cleanup(); resolve(result);
          } catch (error) { fail(error); }
        });
      });
      upstream.once("error", () => fail(new PolicyError(503, "upstream_failed")));
      upstream.once("timeout", () => fail(new PolicyError(503, "upstream_timeout")));
      upstream.end(body);
    } catch { fail(new PolicyError(503, "upstream_failed")); }
  });
}

function reply(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length,
    "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders });
  res.end(bytes);
}

export function createSitePolicyHandler({ request, timeoutMs = 4000, onFailure = () => {} }) {
  return async function handleSitePolicy(req, res, url) {
    const deadline = Date.now() + timeoutMs;
    try {
      const method = url.pathname === DOMAIN_PATH ? "GET" : "POST";
      if (req.method !== method) {
        req.resume(); return reply(res, 405, { error: { type: "invalid_site_policy_request", reason: "method_not_allowed" } }, { allow: method });
      }
      let policyUrl;
      if (method === "GET") { policyUrl = domainPolicyUrl(url); req.resume(); }
      else {
        if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json" ||
            req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new PolicyError(415, "invalid_content_type");
        if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) throw new PolicyError(413, "request_too_large");
        const raw = await readRequest(req, deadline);
        let input;
        try { input = JSON.parse(raw.toString("utf8")); } catch { throw new PolicyError(400, "invalid_json"); }
        policyUrl = canonicalPolicyUrl(input?.url);
      }
      const result = await consult(request, policyUrl, deadline, res);
      reply(res, 200, result);
    } catch (error) {
      req.resume();
      const status = error instanceof PolicyError ? error.status : 503;
      const reason = error instanceof PolicyError ? error.reason : "upstream_failed";
      // Only bounded reason codes; neither the visited URL nor upstream body
      // (which may be an HTML challenge) belongs in application logs.
      if (status >= 500 && status !== 499) onFailure(reason);
      reply(res, status, { error: { type: status < 500 ? "invalid_site_policy_request" : "site_policy_unavailable",
        message: status < 500 ? "Invalid site policy request." : "Site policy check is temporarily unavailable.", reason } });
    }
  };
}
