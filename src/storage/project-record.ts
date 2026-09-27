/** Explicit tagged relative locations, limited to structured path fields. Never rewrite prose. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { safeProjectPath } from "./content-project.js";
import { withHashedClaim } from "./claim-token.js";

const PATH_FIELDS = new Set(["project_root", "aroll_path", "handoff_path", "project_handoff_path", "path", "srt_path", "imagePath", "approvedImagePath", "jianying_draft", "coverImagePath", "sourcePath", "filePath"]);
const PATH_MAPS = new Set(["covers", "cover_copies", "imagePaths"]);
export function portableProjectRecord<T>(value: T, root: string, decode = false): T {
  let relocations: Record<string, string> = {};
  if (decode) {
    try { relocations = JSON.parse(readFileSync(path.join(root, "00-project/autocrew/relocations.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  function visit(v: unknown, key = "", isMap = false): unknown {
    if (typeof v === "string" && (PATH_FIELDS.has(key) || isMap)) {
      if (decode && relocations[v]) v = relocations[v];
      if (typeof v !== "string") throw new Error("invalid_relocation");
      if (decode && v.startsWith("@project/")) return v === "@project/." ? root : safeProjectPath(root, v.slice(9));
      if (!decode && path.isAbsolute(v)) {
        const rel = path.relative(root, v);
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return `@project/${rel || "."}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(item => visit(item, key, isMap));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, visit(item, k, PATH_MAPS.has(key))]));
    return v;
  }
  // 认领令牌只以哈希出现在项目文件夹里（Codex 共享这个文件夹）；读入时也换，旧明文随下一次写盘消失
  return withHashedClaim(visit(value) as T);
}

/** Resolve a historical Markdown/media reference without modifying the authored text. */
export function resolveProjectReference(reference: string, root: string): string {
  return portableProjectRecord({ path: reference }, root, true).path;
}

/** Only a transient publishing copy is rewritten; the approved manuscript is untouched. */
export function projectMarkdownExport(body: string, root: string): string {
  return body.replace(/(!\[[^\]]*\]\()([^\n)]+)(\))/g, (full, before: string, url: string, after: string) => {
    const resolved = resolveProjectReference(url, root);
    return resolved === url ? full : `${before}${resolved}${after}`;
  });
}
