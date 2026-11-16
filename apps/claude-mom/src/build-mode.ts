export const LAB_BUILD = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>;
}).env?.VITE_CLAUDE_MOM_LAB_BUILD === "1";

export const APP_NAME = LAB_BUILD ? "ClaudeMom UI Lab" : "ClaudeMom";
