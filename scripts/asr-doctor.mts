/**
 * `autocrew doctor` 的转写环境一项：复用认稿转写器的 `funasrNotReady`（uv / .venv / 模型），
 * 只输出 JSON 结论与「怎么装」。纯检查：不装、不预热（预热是约 1GB 下载，要创始人自己按下）。
 */
import { funasrNotReady, notReadyFix } from "../src/modules/production/match/transcribe.js";

const dataDir = process.argv[2];
try {
  if (!dataDir) throw new Error("用法：asr-doctor.mts <工作区目录>");
  const reason = await funasrNotReady(dataDir);
  console.log(JSON.stringify(reason ? { ready: false, reason, fix: notReadyFix(reason) } : { ready: true }));
} catch (e) {
  console.log(JSON.stringify({ ready: false, reason: `检查没跑成：${e instanceof Error ? e.message : String(e)}`, fix: "看上面的原因；修好后重跑 autocrew doctor" }));
}
