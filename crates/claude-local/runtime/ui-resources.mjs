import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function selectUiResources(officialAssets, cacheDir, webReference, template) {
  let fallback = { kind: "installed", buildId: officialAssets.buildId, html: officialAssets.indexHtml,
    gatedImports: officialAssets.gatedImports };
  // A recording is a unit: shell + bootstrap + dependency manifest. Never
  // combine a new upstream shell with another recording's lazy modules.
  if (typeof template?.html === "string" && template.html.length >= 4096 && template.html.length <= 4 * 1024 * 1024) {
    const buildId = template.html.match(/<html\b[^>]*\bdata-build-id="([^"]+)"/i)?.[1];
    const bootstrap = template.bootstrap;
    if (buildId && bootstrap?.gated_imports_build_id === buildId && bootstrap.gated_imports &&
        typeof bootstrap.gated_imports === "object" && !Array.isArray(bootstrap.gated_imports)) {
      fallback = { kind: "recorded-template", buildId, html: template.html, gatedImports: bootstrap.gated_imports };
      if (template.selected) return fallback;
    }
  }
  // Keep the owner's matched official-login reference by default. An explicit
  // recording selection wins; otherwise a packaged recording precedes the
  // installed resources when there is no usable official reference.
  if (!webReference) return fallback;
  const key = crypto.createHash("sha1").update("claude.ai/epitaxy").digest("hex");
  try {
    const file = path.join(cacheDir, key);
    const meta = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
    if (meta.url !== "claude.ai/epitaxy" || meta.status !== 200 || fs.statSync(file).size > 4 * 1024 * 1024) return fallback;
    const html = fs.readFileSync(file, "utf8");
    const buildId = html.match(/<html\b[^>]*\bdata-build-id="([^"]+)"/i)?.[1];
    const timestamp = (value) => Number(value.match(/\bdata-build-timestamp="(\d+)"/i)?.[1] ?? 0);
    if (html.length < 4096 || buildId !== webReference.buildId || !timestamp(html) ||
        timestamp(html) < timestamp(officialAssets.indexHtml)) return fallback;
    return { kind: "web-cache", buildId, html, gatedImports: webReference.gatedImports };
  } catch { return fallback; }
}
