import fs from "node:fs";

const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const MAX_FEATURES = 2048;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function referenceWebFeatures(web) {
  if (!web || !["sha256", "djb2"].includes(web.hashingAlgorithm) || !record(web.features)) return null;
  const entries = Object.entries(web.features);
  if (!entries.length || entries.length > 8192) return null;
  if (web.hashingAlgorithm === "sha256") {
    if (entries.some(([key, feature]) => !/^[A-Za-z0-9+/]{43}=$/.test(key) || !record(feature) ||
        !Object.hasOwn(feature, "value") || typeof feature.on !== "boolean" ||
        typeof feature.off !== "boolean" || typeof feature.source !== "string")) return null;
  } else {
    // Current app_start bootstraps ship djb2 feature definitions, not evaluated
    // SHA-256 results. Keep their rules and disabled defaults as delivered.
    if (entries.some(([key, feature]) => !/^\d{1,10}$/.test(key) || Number(key) > 0xffffffff ||
        !record(feature) || !Object.hasOwn(feature, "defaultValue") ||
        feature.rules !== undefined && (!Array.isArray(feature.rules) || feature.rules.length > 256 ||
          feature.rules.some(rule => !record(rule))))) return null;
  }
  return { features: structuredClone(web.features), hashing_algorithm: web.hashingAlgorithm, user: {} };
}

// This is an optional evaluated response captured by the owner from the
// official endpoint, never a list of features to force on. Keep it outside
// application assets: an update must not replace the owner's reference.
export function loadDesktopUiProfile(file, desktopVersion, now = Date.now()) {
  if (!file || !fs.existsSync(file)) return { features: {}, warning: null, source: "local" };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_BYTES) throw new Error("profile");
    const profile = JSON.parse(fs.readFileSync(file, "utf8"));
    if (profile.schema !== 1 || !desktopVersion || profile.desktopVersion !== desktopVersion ||
        profile.source !== "official-desktop-features" || !record(profile.features)) throw new Error("version");
    const captured = Date.parse(profile.capturedAt);
    if (!Number.isFinite(captured) || captured > now + 5 * 60 * 1000) throw new Error("date");
    const entries = Object.entries(profile.features);
    if (!entries.length || entries.length > MAX_FEATURES) throw new Error("features");
    for (const [key, feature] of entries) {
      if (!/^\d{1,10}$/.test(key) || Number(key) > 0xffffffff || !record(feature) ||
          !Object.hasOwn(feature, "value") || typeof feature.on !== "boolean" ||
          typeof feature.off !== "boolean" || typeof feature.source !== "string") throw new Error("feature");
    }
    const web = record(profile.web) && typeof profile.web.buildId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(profile.web.buildId) && record(profile.web.gatedImports)
      ? { ...profile.web } : null;
    if (web?.modelSelectorConfig !== undefined && (!Array.isArray(web.modelSelectorConfig) ||
        web.modelSelectorConfig.length > 64 || web.modelSelectorConfig.some((selector) => !record(selector) ||
          typeof selector.id !== "string" || !Array.isArray(selector.models) || selector.models.length > 4096 ||
          selector.models.some((model) => !record(model) || typeof model.id !== "string" ||
            model.thinking !== undefined && model.thinking !== null && !record(model.thinking))))) {
      delete web.modelSelectorConfig;
    }
    return {
      features: profile.features,
      web,
      webFeatures: referenceWebFeatures(web),
      source: "official-reference",
      warning: now - captured > WEEK
        ? "Desktop UI reference is older than seven days; refresh it to follow the official rollout."
        : null,
    };
  } catch {
    return {
      features: {}, source: "local",
      warning: "Desktop UI reference is invalid or belongs to another Desktop version; local defaults are in use.",
    };
  }
}

export function desktopFeatures(reference, runtime) {
  const features = structuredClone(reference.features);
  // These two controls remain owned by the user's explicit local settings.
  features["1291166712"] = {
    value: { ...(record(features["1291166712"]?.value) ? features["1291166712"].value : {}),
      enabled: runtime.computerUse, appScopedEnabled: runtime.computerUse && runtime.backgroundMode },
    on: runtime.computerUse, off: !runtime.computerUse, source: "force",
    experiment: null, experimentResult: null,
  };
  if (runtime.forceBackgroundMode) {
    features["1346958739"] = {
      value: { major: 99, minor: 9999 }, on: true, off: false, source: "force",
      experiment: null, experimentResult: null,
    };
  }
  return { features };
}
