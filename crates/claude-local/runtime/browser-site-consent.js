// A device-owner opt-in for ordinary Code browser site admissions. Answer only
// the native open_site request, once: never save a grant or change session mode.
// Classification and native per-action checks remain independent of this helper.
(function () {
  "use strict";
  if (window.top !== window || location.origin !== "https://claude.ai") return;
  const api = window["claude.web"]?.LocalSessions;
  if (typeof api?.onOnEvent !== "function" || typeof api?.respondToToolPermission !== "function" ||
      typeof window.fetch !== "function" || window.__claudeMomSiteConsent) return;
  window.__claudeMomSiteConsent = true;
  const fetch = window.fetch.bind(window);
  const pending = new Map();
  const configPath = "/__codex_plus/browser-site-consent.json";

  async function readJson(path, options) {
    const response = await fetch(path, { ...options, credentials: "omit", cache: "no-store",
      redirect: "error", signal: AbortSignal.timeout(4500) });
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return null;
    const body = await response.text();
    return body.length <= 65536 ? JSON.parse(body) : null;
  }

  function site(request) {
    if (request?.toolName !== "browser:open_site" ||
        typeof request.requestId !== "string" || request.requestId.length > 128 || !request.requestId ||
        typeof request.sessionId !== "string" || !request.sessionId.startsWith("local_") ||
        request.decisionReason != null || request.blockedPath != null || request.alwaysAllowWithheldBy != null ||
        ["defaultToNo", "onlyOnCard", "outOfTurn", "viaHostCliLauncher", "suppressAlwaysAllowRule"].some(key => request[key] === true)) return null;
    const input = request.input;
    if (!input || Object.keys(input).some(key => !["origin", "domain"].includes(key)) ||
        typeof input.origin !== "string" || input.origin.length > 4096) return null;
    let url;
    try { url = new URL(input.origin); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || input.domain !== url.hostname || !url.hostname.includes(".") ||
        url.hostname.includes(":") || /^[\d.]+$/.test(url.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)\.?$/i.test(url.hostname)) return null;
    return url;
  }

  const unsubscribe = api.onOnEvent(event => {
    if (event?.type === "tool_permission_resolved") {
      pending.delete(event.requestId ?? event.request?.requestId);
      // Native versions which omit the request ID must never let an in-flight
      // check answer a card the person may already have denied.
      if (!event.requestId && !event.request?.requestId) pending.clear();
      return;
    }
    if (["stopped", "close", "deleted", "archived", "error"].includes(event?.type)) {
      for (const [id, item] of pending) if (item.sessionId === event.sessionId) pending.delete(id);
      return;
    }
    if (event?.type !== "tool_permission_request") return;
    const request = event.request;
    const url = site(request);
    if (!url || event.sessionId !== request.sessionId || pending.has(request.requestId) || pending.size >= 8) return;
    const token = { sessionId: request.sessionId };
    pending.set(request.requestId, token);
    (async () => {
      if ((await readJson(configPath))?.allowAllBrowserSites !== true) return;
      // A native site card does not expose whether its earlier policy lookup
      // failed. Obtain a valid ordinary-site verdict instead of treating an
      // unverified or high-risk card as ordinary consent.
      const verdict = await readJson("/api/web/url_hash_check/browser_extension", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.origin + "/" }),
      });
      if (verdict?.category !== "category0" || ![null, "allow"].includes(verdict.org_policy) ||
          verdict.domain !== url.hostname || verdict.url !== url.origin + "/") return;
      if ((await readJson(configPath))?.allowAllBrowserSites !== true || pending.get(request.requestId) !== token) return;
      await api.respondToToolPermission(request.requestId, "once");
    })().catch(() => {
      // Offline, changed API or rejected response: leave the native card alone.
    }).finally(() => {
      if (pending.get(request.requestId) === token) pending.delete(request.requestId);
    });
  });
  window.addEventListener?.('pagehide', () => {
    pending.clear();
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch {}
  }, { once: true });
})();
