import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { desktopFeatures, loadDesktopUiProfile } from "./desktop-ui.mjs";
import { gatewayBody, gatewayModel, runtimeConfig } from "./runtime.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-profile-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const now = Date.parse("2026-11-16T04:00:00Z");
const evaluated = {
  "123": { value: false, on: false, off: true, source: "defaultValue" },
  "124": { value: { layout: "native" }, on: true, off: false, source: "experiment" },
};
function fixture(overrides = {}) {
  const file = path.join(root, `profile-${fs.readdirSync(root).length}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, desktopVersion: "5.11492.5",
    source: "official-desktop-features", capturedAt: new Date(now).toISOString(), features: evaluated, ...overrides }));
  return file;
}

test("same-version evaluated values survive, including disabled features", () => {
  const profile = loadDesktopUiProfile(fixture(), "5.11492.5", now);
  assert.equal(profile.source, "official-reference");
  assert.equal(profile.warning, null);
  const result = desktopFeatures(profile, { computerUse: false, backgroundMode: true, forceBackgroundMode: false });
  assert.deepEqual(result.features["123"], evaluated["123"]);
  assert.deepEqual(result.features["124"], evaluated["124"]);
  assert.equal(result.features["1291166712"].value.enabled, false);
  assert.equal(result.features["1291166712"].value.appScopedEnabled, false);
  result.features["124"].value.layout = "changed";
  assert.equal(profile.features["124"].value.layout, "native");
});

test("a different Desktop version never receives an old feature snapshot", () => {
  const result = loadDesktopUiProfile(fixture(), "5.11492.6", now);
  assert.deepEqual(result.features, {});
  assert.match(result.warning, /another Desktop version/);
});

test("stale references are labeled without enabling their disabled features", () => {
  const result = loadDesktopUiProfile(fixture(), "5.11492.5", now + 8 * 86400000);
  assert.equal(result.source, "official-reference");
  assert.match(result.warning, /older than seven days/);
  assert.equal(result.features["123"].on, false);
});

test("invalid or symbolic profiles do not crash inference", () => {
  for (const overrides of [
    { source: "unknown" }, { capturedAt: "bad" }, { capturedAt: new Date(now + 86400000).toISOString() },
    { features: {} }, { features: { "1": { value: true, on: "yes", off: false, source: "force" } } },
  ]) {
    const result = loadDesktopUiProfile(fixture(overrides), "5.11492.5", now);
    assert.deepEqual(result.features, {});
    assert.ok(result.warning);
  }
  const bad = path.join(root, "bad.json");
  fs.writeFileSync(bad, "{invalid}");
  assert.ok(loadDesktopUiProfile(bad, "5.11492.5", now).warning);
  fs.writeFileSync(bad, "x".repeat(2 * 1024 * 1024 + 1));
  assert.ok(loadDesktopUiProfile(bad, "5.11492.5", now).warning);
  const link = path.join(root, "profile-link.json");
  fs.symlinkSync(fixture(), link);
  assert.ok(loadDesktopUiProfile(link, "5.11492.5", now).warning);
});

test("UI adaptation preserves gateway model, effort and thinking payload", () => {
  const config = runtimeConfig({ CLAUDE_LOCAL_MANAGED: "1", CLAUDE_LOCAL_GATEWAY_URL: "http://127.0.0.1:3425",
    CLAUDE_LOCAL_GATEWAY_KEY: "fixture-only-key", CLAUDE_LOCAL_GATEWAY_MODEL: "team/claude-opus-5-5" });
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const body = { model: config.model, messages: [{ role: "user", content: "fixture" }],
      thinking: { type: "adaptive" }, output_config: { effort }, stream: true };
    assert.deepEqual(JSON.parse(gatewayBody(config, Buffer.from(JSON.stringify(body)))), body);
  }
});

test("native Code model choices resolve to their configured gateway routes", () => {
  const config = { model: "team-a/claude-opus-5-5", smallModel: "team-a/claude-haiku-5-5",
    managed: true, models: ["team-a/claude-opus-5-5", "team-a/claude-sonnet-5-5", "team-b/claude-sonnet-5-5", "team-a/claude-sonnet-5-5[1m]"] };
  assert.equal(gatewayModel(config, "claude-sonnet-5-5"), "team-a/claude-sonnet-5-5");
  assert.equal(gatewayModel(config, "claude-sonnet-5-5[1m]"), "team-a/claude-sonnet-5-5[1m]");
  assert.equal(gatewayModel(config, "team-b/claude-sonnet-5-5"), "team-b/claude-sonnet-5-5");
  assert.throws(() => gatewayModel({ ...config, model: "group/default" }, "claude-sonnet-5-5"), /multiple configured routes/);
});

test("current web flags keep evaluated SHA-256 values without account attributes", () => {
  const key = "a".repeat(43) + "=";
  const web = { buildId: "web", gatedImports: {}, hashingAlgorithm: "sha256",
    features: { [key]: { value: false, on: false, off: true, source: "defaultValue" } } };
  const result = loadDesktopUiProfile(fixture({ web }), "5.11492.5", now);
  assert.equal(result.webFeatures.hashing_algorithm, "sha256");
  assert.equal(result.webFeatures.features[key].value, false);
  assert.deepEqual(result.webFeatures.user, {});
  const legacy = loadDesktopUiProfile(fixture({ web: { ...web, features: { [key]: { defaultValue: true } } } }), "5.11492.5", now);
  assert.equal(legacy.webFeatures, null);
});

test("selector metadata remains data and malformed model catalogs are ignored", () => {
  const web = { buildId: "web", gatedImports: {}, modelSelectorConfig: [{ id: "code", models: [
    { id: "claude-sonnet-5-5", thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "max" }] } },
  ] }] };
  const result = loadDesktopUiProfile(fixture({ web }), "5.11492.5", now);
  assert.equal(result.web.modelSelectorConfig[0].models[0].thinking.effort_options[1].id, "max");
  const bad = loadDesktopUiProfile(fixture({ web: { ...web, modelSelectorConfig: [null] } }), "5.11492.5", now);
  assert.equal(bad.web.modelSelectorConfig, undefined);
  assert.equal(bad.source, "official-reference");
});

test("current app_start djb2 definitions retain rules, disabled defaults and more than 4096 flags", () => {
  const features = Object.fromEntries(Array.from({ length: 4667 }, (_, i) => [String(i), { defaultValue: i % 2 === 0 }]));
  features["11"] = { defaultValue: false, rules: [{ condition: { client: "desktop" }, force: true }] };
  const web = { buildId: "current-web", gatedImports: {}, hashingAlgorithm: "djb2", features };
  const profile = loadDesktopUiProfile(fixture({ web }), "5.11492.5", now);
  assert.equal(profile.webFeatures.hashing_algorithm, "djb2");
  assert.equal(Object.keys(profile.webFeatures.features).length, 4667);
  assert.deepEqual(profile.webFeatures.features["11"], features["11"]);
  assert.equal(profile.webFeatures.features["1"].defaultValue, false);
  assert.deepEqual(profile.webFeatures.user, {});
  for (const invalid of [{ "bad": { defaultValue: true } }, { "1": { value: true } }, { "1": { defaultValue: false, rules: [null] } }]) {
    assert.equal(loadDesktopUiProfile(fixture({ web: { ...web, features: invalid } }), "5.11492.5", now).webFeatures, null);
  }
});

test("local computer-use switches preserve the other same-version capability settings", () => {
  const features = { ...evaluated, "1291166712": { value: { coordinateMode: "pixels", watchRecordEnabled: true, enabled: true }, on: true, off: false, source: "defaultValue" } };
  const profile = loadDesktopUiProfile(fixture({ features }), "5.11492.5", now);
  const result = desktopFeatures(profile, { computerUse: false, backgroundMode: false, forceBackgroundMode: false });
  assert.deepEqual(result.features["1291166712"].value, { coordinateMode: "pixels", watchRecordEnabled: true, enabled: false, appScopedEnabled: false });
  assert.equal(profile.features["1291166712"].value.enabled, true);
});
