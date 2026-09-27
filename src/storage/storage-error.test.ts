import { describe, expect, it } from "vitest";
import { storageFailure, STORAGE_NEXT_ACTION } from "./storage-error.js";
import { videoError } from "../tools/video-gates.js";

const errno = (code: string, message = `${code}: failed`) => Object.assign(new Error(message), { code });

describe("storageFailure（§13.4-A）", () => {
  it.each(["ENOTSUP", "EACCES", "ENOSPC", "EWRITELOCKED", "EROFS", "ENOTCONN"])("%s → storage_unavailable 且保留原文", (code) => {
    const out = storageFailure(errno(code, `${code}: operation not supported on socket, link 'a' -> 'b'`));
    expect(out).toEqual({ ok: false, code: "storage_unavailable", error: `${code}: operation not supported on socket, link 'a' -> 'b'`, next_action: STORAGE_NEXT_ACTION });
    expect(out?.next_action).toContain("资料库之外");
  });

  it("认得只在消息里、或包在 cause 里的存储故障，以及失去资料库写入权", () => {
    expect(storageFailure(new Error("publish brief: ENOTSUP: operation not supported"))?.code).toBe("storage_unavailable");
    expect(storageFailure(new Error("wrap", { cause: errno("ENOSPC") }))?.error).toBe("wrap");
    expect(storageFailure(new Error("library_writer_lost: 当前服务已失去资料库写入权"))?.code).toBe("storage_unavailable");
  });

  it("业务错误和 ENOENT 不归存储类，交回原口径", () => {
    expect(storageFailure(errno("ENOENT"))).toBeNull();
    expect(storageFailure(new Error("稿件不存在"))).toBeNull();
    expect(storageFailure("boom")).toBeNull();
  });

  it("视频工具的错误翻译也走同一口径", () => {
    expect(videoError(errno("ENOTSUP"))).toMatchObject({ ok: false, code: "storage_unavailable" });
  });
});
