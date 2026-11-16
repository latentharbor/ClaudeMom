import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { runtimeConfig } from "./runtime.mjs";

const source = readFileSync(new URL("./browser-site-consent.js", import.meta.url), "utf8");
const configPath = "/__codex_plus/browser-site-consent.json";
const policyPath = "/api/web/url_hash_check/browser_extension";
const event = (patch = {}, input = {}) => ({ type: "tool_permission_request", sessionId: "local_fixture",
  request: { requestId: "fixture-request", sessionId: "local_fixture", toolName: "browser:open_site",
    ...patch, input: { origin: "https://example.com", domain: "example.com", ...input } } });
const verdict = (patch = {}) => ({ category: "category0", org_policy: null,
  domain: "example.com", url: "https://example.com/", ...patch });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ enabled = true, policy = verdict(), origin = "https://claude.ai", child = false, fetchOverride } = {}) {
  const answers = [], calls = [];
  let listener;
  const window = { "claude.web": { LocalSessions: {
    onOnEvent(fn) { listener = fn; },
    respondToToolPermission(...args) { answers.push(args); return Promise.resolve(); },
  } }, fetch: async (path, options) => {
    calls.push({ path, options });
    if (fetchOverride) return fetchOverride(path, options);
    return new Response(JSON.stringify(path === configPath ? { allowAllBrowserSites: enabled } : policy),
      { headers: { "content-type": "application/json" } });
  } };
  window.top = child ? {} : window;
  vm.runInNewContext(source, { window, location: { origin }, URL, AbortSignal });
  return { answers, calls, emit: value => listener?.(value), window };
}

test("only an explicit opt-in enables ordinary-site consent in any existing session mode", async () => {
  assert.equal(runtimeConfig({}).allowAllBrowserSites, false);
  assert.equal(runtimeConfig({ CLAUDE_LOCAL_ALLOW_ALL_BROWSER_SITES: "true" }).allowAllBrowserSites, false);
  assert.equal(runtimeConfig({ CLAUDE_LOCAL_ALLOW_ALL_BROWSER_SITES: "1" }).allowAllBrowserSites, true);
  for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]) {
    const h = harness(); h.emit(event({ permissionMode: mode })); await settle();
    assert.deepEqual(h.answers, [["fixture-request", "once"]]);
    const check = h.calls.find(call => call.path === policyPath);
    assert.equal(check.options.credentials, "omit");
    assert.equal(check.options.redirect, "error");
    assert.deepEqual(JSON.parse(check.options.body), { url: "https://example.com/" });
  }
  const h = harness({ enabled: false }); h.emit(event()); await settle();
  assert.deepEqual(h.answers, []);
  assert.equal(h.calls.length, 1);
});

test("sensitive sites, failed classification and mismatched policy replies retain their native cards", async () => {
  for (const policy of [null, {}, verdict({ category: "category1" }), verdict({ category: "category2" }),
    verdict({ category: "category3" }), verdict({ org_policy: "block" }), verdict({ org_policy: undefined }),
    verdict({ domain: "other.example" }), verdict({ url: "https://example.com/other" })]) {
    const h = harness({ policy }); h.emit(event()); await settle(); assert.deepEqual(h.answers, []);
  }
  for (const result of [() => { throw new Error("offline"); }, () => new Response("not JSON"),
    () => new Response("{}", { status: 503 }), () => new Response("x".repeat(65537), { headers: { "content-type": "application/json" } })]) {
    const h = harness({ fetchOverride: result }); h.emit(event()); await settle(); assert.deepEqual(h.answers, []);
  }
});

test("the opt-in cannot answer other tool requests or broaden site permissions", async () => {
  for (const patch of [{ toolName: "Bash" }, { toolName: "browser:submit_credentials" }, { toolName: "browser:open_file" },
    { toolName: "browser:domain_transition" }, { defaultToNo: true }, { onlyOnCard: true }, { outOfTurn: true },
    { decisionReason: "requires confirmation" }, { alwaysAllowWithheldBy: "managed_rules_only" },
    { viaHostCliLauncher: true }, { sessionId: "remote_fixture" }]) {
    const h = harness(); h.emit(event(patch)); await settle(); assert.deepEqual(h.calls, []);
  }
  for (const input of [{ reason: "financial" }, { reason: "high_risk" }, { privateNetwork: true },
    { origin: "https://user:secret@example.com" }, { origin: "https://example.com/?secret=yes" },
    { origin: "https://example.com/path" }, { domain: "other.example" },
    { origin: "http://192.168.1.1", domain: "192.168.1.1" }, { origin: "http://host.local", domain: "host.local" }]) {
    const h = harness(); h.emit(event({}, input)); await settle(); assert.deepEqual(h.calls, []);
  }
});

test("external documents, frames, duplicate requests and user cancellation cannot gain consent", async () => {
  for (const options of [{ origin: "https://example.com" }, { origin: "http://claude.ai" }, { child: true }]) {
    const h = harness(options); h.emit(event()); await settle(); assert.deepEqual(h.calls, []);
  }
  const h = harness(); h.emit(event()); h.emit(event()); await settle();
  assert.equal(h.answers.length, 1);
  const cancelled = harness(); cancelled.emit(event());
  cancelled.emit({ type: "tool_permission_resolved", sessionId: "local_fixture", requestId: "fixture-request" });
  await settle(); assert.deepEqual(cancelled.answers, []);
  const closed = harness(); closed.emit(event()); closed.emit({ type: "stopped", sessionId: "local_fixture" });
  await settle(); assert.deepEqual(closed.answers, []);
});

test("disabling before the verdict returns leaves the request untouched", async () => {
  let reads = 0;
  const h = harness({ fetchOverride: path => new Response(JSON.stringify(path === configPath
    ? { allowAllBrowserSites: ++reads === 1 } : verdict()), { headers: { "content-type": "application/json" } }) });
  h.emit(event()); await settle(); assert.deepEqual(h.answers, []);
});
