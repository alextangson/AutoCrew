import { createHash } from "node:crypto";
import type { Content } from "./local-store.js";

/**
 * 稿件指纹只认一份算法：editorial 的 draft_hash、宿主/引擎发布包的 draftHash、预检判过期都用它。
 * 放在 storage 层是因为 modules（video-kit）不能反向 import tools。
 */
export function draftHash(content: Pick<Content, "title" | "body" | "platform">): string {
  return createHash("sha256").update(JSON.stringify([content.title, content.body, content.platform])).digest("hex");
}
