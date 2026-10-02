/**
 * 全体测试的安全网：认稿弹窗的系统动作（open 预览、交接成功通知窗）换成不碰系统的假实现。
 * 大量 handoff 测试不自己换 pull-deps，没有这层它们会在 Mac 上真 open、真弹窗。
 * 要断言这些动作的测试照旧用 setPullDeps 注入自己的假的。
 */
import { vi } from "vitest";

vi.mock("../modules/video/handoff/desktop-open.js", () => ({
  systemOpener: async () => ({ ok: false, reason: "测试里不真打开" }),
  osascriptNotifier: async () => ({ ok: true }),
  benchReachable: async () => false,
  mediaDuration: async () => null,
}));

// 原片内容比对（1b §2）：默认转写器在测试里永远「没就绪」，绝不真跑 ffmpeg / FunASR。
// 要测核对流程的测试用 setMatchDeps 注入自己的假转写器。
vi.mock("../modules/production/match/transcribe.js", async (importActual) => ({
  ...(await importActual<typeof import("../modules/production/match/transcribe.js")>()),
  funasrTranscriber: () => ({
    transcribe: async () => ({ ok: false, unavailable: true, reason: "测试里不跑转写" }),
    notReady: async () => "测试里不跑转写",
  }),
}));
