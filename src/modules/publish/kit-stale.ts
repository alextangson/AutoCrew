/**
 * 视频发布包过期判定：发布前检查和发布器出口共用这一处（摘自 confident-raman kit-stale，去掉补登记分支）。
 *
 * 换版：做包之后又登记了新成片（`registerHash` 对不上当前 `video.final.register_hash`——本体下就是当前登记记录 id）；
 * 老包没记 registerHash，就看它是不是在这次登记之前做的。改稿另由 draftHash 判（pre_publish 里）。
 */
import type { Content, VideoKit } from "../../storage/local-store.js";

export function kitBehindRegister(content: Content, kit: VideoKit): boolean {
  const final = content.video?.final;
  if (!final) return false;
  if (kit.registerHash) return kit.registerHash !== final.register_hash;
  return kit.generatedAt < final.at;
}

/** 做包时要落盘的登记指纹：开工时读到的那一份（生成途中换版 → 落库即过期） */
export function kitRegisterHash(content: Content): Pick<VideoKit, "registerHash"> {
  return content.video?.final ? { registerHash: content.video.final.register_hash } : {};
}

export const KIT_BEHIND_REGISTER = "视频发布包是按上一版登记的成片做的（成片后来换过版）：按当前成片重做发布包，再跑发布前检查";
