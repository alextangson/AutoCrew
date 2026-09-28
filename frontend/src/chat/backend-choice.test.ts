import { describe, expect, it } from "vitest";
import { decideBackendPick, defaultBackend, markNoticeSeen, noticeSeen, parseBackends, selectable, type BackendStatus } from "./backend-choice";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const list: BackendStatus[] = [
  { id: "claude", label: "本机 Claude", state: "ready", billing: "用你的 Claude 订阅" },
  { id: "codex", label: "本机 Codex", state: "coming_soon" },
  { id: "builtin", label: "内置引擎（备用）", state: "not_configured" },
];

describe("后端切换器", () => {
  it("边界 13：对话中途换后端 → 新开对话；新对话里换 → 原地", () => {
    expect(decideBackendPick({ conversationId: "conv-1-a", backend: "claude" }, "builtin")).toBe("new_conversation");
    expect(decideBackendPick({ backend: "claude" }, "builtin")).toBe("stay");
    expect(decideBackendPick({ conversationId: "conv-1-a", backend: "claude" }, "claude")).toBe("stay");
  });

  it("边界 14：内置没配置就不能选；即将支持的不能选；记住的默认值不可选时退回本机 Claude", () => {
    expect(selectable(list[2])).toBe(false);
    expect(selectable(list[1])).toBe(false);
    const s = mem();
    s.setItem("autocrew.chat.backend", "builtin");
    expect(defaultBackend(list, s)).toBe("claude");
  });

  it("边界 1：未登录仍可选（发出去拿带修法的报错，不悄悄换后端）", () => {
    expect(selectable({ id: "claude", label: "x", state: "not_logged_in" })).toBe(true);
  });

  it("解析服务端清单，脏项丢弃；首次使用提示只出现一次", () => {
    const parsed = parseBackends({ ok: true, data: { backends: [...list, { id: "evil" }], running: { conversationId: "c", backend: "claude", otherLibrary: true } } });
    expect(parsed.backends).toHaveLength(3);
    expect(parsed.running?.otherLibrary).toBe(true);
    const s = mem();
    expect(noticeSeen(s)).toBe(false);
    markNoticeSeen(s);
    expect(noticeSeen(s)).toBe(true);
  });
});
