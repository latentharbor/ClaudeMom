import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { after, test } from "node:test";
import { selectUiResources } from "./ui-resources.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ui-resources-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const installed = { buildId: "installed", indexHtml: '<html data-build-id="installed" data-build-timestamp="200">', gatedImports: { bundled: {} } };
const key = crypto.createHash("sha1").update("claude.ai/epitaxy").digest("hex");
const reference = { buildId: "current-web", gatedImports: { current: { hash: "current-module" } } };
function cache({ build = "current-web", timestamp = 300, url = "claude.ai/epitaxy", size = 5000 } = {}) {
  const dir = fs.mkdtempSync(path.join(root, "cache-"));
  fs.writeFileSync(path.join(dir, key), `<html data-build-id="${build}" data-build-timestamp="${timestamp}">${"x".repeat(size)}</html>`);
  fs.writeFileSync(path.join(dir, key + ".json"), JSON.stringify({ status: 200, url }));
  return dir;
}
test("a newer official web document keeps its matching dependency manifest", () => {
  const result = selectUiResources(installed, cache(), reference);
  assert.equal(result.kind, "web-cache");
  assert.equal(result.buildId, "current-web");
  assert.deepEqual(result.gatedImports, reference.gatedImports);
});
test("installed resources win over old, mismatched or unreferenced web snapshots", () => {
  for (const options of [{ timestamp: 100 }, { build: "unrelated" }, { url: "elsewhere/epitaxy" }, { size: 0 }]) {
    assert.equal(selectUiResources(installed, cache(options), reference).kind, "installed");
  }
  assert.equal(selectUiResources(installed, cache(), null).kind, "installed");
});
test("a broken web cache remains an offline fallback rather than a startup failure", () => {
  const dir = cache();
  fs.writeFileSync(path.join(dir, key + ".json"), "{invalid}");
  assert.equal(selectUiResources(installed, dir, reference).kind, "installed");
});
