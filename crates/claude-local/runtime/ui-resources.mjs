import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function selectUiResources(officialAssets, cacheDir, webReference) {
  const fallback = { kind: "installed", buildId: officialAssets.buildId, html: officialAssets.indexHtml,
    gatedImports: officialAssets.gatedImports };
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
