import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConversation } from "../../storage/conversation-store.js";
import { cleanAgentEnv } from "./acp-process.js";
import { AskRegistry } from "./asks.js";
import { backendStatuses, pickPermissionOption } from "./backends.js";
import { maybeRunLocalTurn, resolveTurnBackend } from "./ipc-handlers.js";
import { ensurePersona } from "./persona.js";
import { classifyPublishAction } from "./publish-gate.js";
import { cardFromToolResult, redactAndTruncate, redactedTail } from "./redact.js";
import { resetChiefEditor } from "./service.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chief-editor-unit-"));
afterEach(() => resetChiefEditor());

describe("§地基 13：脱敏", () => {
  it("claim_token / Bearer / 长令牌先脱敏再截断——截断不会把半截令牌放出去", () => {
    const raw = `{"claim_token":"abc123","x":1} Authorization: Bearer ce_${"z".repeat(50)} ${"f".repeat(64)}`;
    const out = redactAndTruncate(raw, 40);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzzz");
    expect(redactedTail(`a\nb\nclaim_token=secretvalue\nlast line`)).toBe("a\nb\nclaim_token=[已隐藏]\nlast line");
  });
  it("卡片只挑白名单字段：正文与认领令牌不进卡片", () => {
    const card = cardFromToolResult("autocrew_writer", "submit", { ok: true, content: { id: "content-1-a", title: "T", body: "整篇正文", claim: { token: "x" } }, claim_token: "tok" }, "call-1");
    expect(JSON.stringify(card)).not.toMatch(/整篇正文|tok|claim/);
    expect(card).toMatchObject({ type: "agent_draft", data: { contentId: "content-1-a", title: "T" } });
  });
});

describe("§地基 2：发布类动作枚举", () => {
  it.each([
    ["autocrew_publish", { action: "wechat_mp_draft", content_id: "c" }, true],
    ["autocrew_publish", { action: "confirm_published", content_id: "c" }, true],
    ["autocrew_publish", { action: "ego_lite_prepare", content_id: "c" }, false],
    ["autocrew_publish", { action: "clipboard", content_id: "c" }, false],
    ["autocrew_content", { action: "transition", id: "c", target_status: "published" }, true],
    ["autocrew_content", { action: "transition", id: "c", target_status: "editing" }, false],
    ["autocrew_content", { action: "delete", id: "c" }, true],
    ["autocrew_asset", { action: "remove", content_id: "c" }, true],
    ["autocrew_pipeline", { action: "delete", id: "p" }, true],
    ["autocrew_writer", { action: "submit" }, false],
  ])("%s %o → %s", (tool, args, gated) => {
    expect(Boolean(classifyPublishAction(tool, args))).toBe(gated);
  });
});

describe("§地基 3 / 9：权限卡与单次消费", () => {
  it("只选「允许一次 / 拒绝一次」，永不选「总是允许」", () => {
    const opts = [{ optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
    expect(pickPermissionOption(opts, "allow")).toBe("once");
    expect(pickPermissionOption(opts, "deny")).toBe("no");
    expect(pickPermissionOption([{ optionId: "always", kind: "allow_always" }], "allow")).toBeNull();
  });
  it("多标签页同时应答：只有第一个算数", async () => {
    const reg = new AskRegistry({ issueApproval: () => ({ token: "t" }), emit: () => {} });
    const ask = reg.requestPermission({ turnId: "t", conversationId: "c", title: "x", detail: "y" });
    expect(reg.answer(ask.id, "allow").ok).toBe(true);
    expect(reg.answer(ask.id, "deny")).toMatchObject({ ok: false });
    expect(await ask.decision).toBe("allow");
  });
});

describe("§地基 12：工作目录与人设", () => {
  it("人设写在定界符里，用户自己的内容不动", () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "我自己的备注\n");
    ensurePersona(home, "claude");
    ensurePersona(home, "claude");
    const text = fs.readFileSync(path.join(home, "CLAUDE.md"), "utf-8");
    expect(text.startsWith("我自己的备注")).toBe(true);
    expect(text.match(/autocrew:start/g)).toHaveLength(1);
    expect(text).toContain("用中文回复");
  });
  it("子进程环境是白名单：宿主会话变量不漏进去", () => {
    const env = cleanAgentEnv({ PATH: "/usr/bin", HOME: "/h", ANTHROPIC_BASE_URL: "x", CLAUDE_CODE_SESSION_ID: "y", AUTOCREW_TOKEN: "z" }, "/h");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.AUTOCREW_TOKEN).toBeUndefined();
    expect(env.PATH).toContain("/h/.local/bin");
  });
});

describe("边界 13 / §地基 12：对话后端以服务端记录为准", () => {
  it("已有对话看记录，payload 里的后端不作数；新对话才看 payload", async () => {
    const dir = tmp();
    const claudeConv = await createConversation("a", dir, undefined, { backend: "claude" });
    const oldConv = await createConversation("b", dir);
    expect(await resolveTurnBackend({ conversation_id: claudeConv.id, backend: "builtin" }, dir)).toBe("claude");
    expect(await resolveTurnBackend({ conversation_id: oldConv.id, backend: "claude" }, dir)).toBe("builtin");
    expect(await resolveTurnBackend({ backend: "claude" }, dir)).toBe("claude");
    expect(await resolveTurnBackend({}, dir)).toBe("builtin");
  });
  it("本机后端强制带 turn_id / client_id", async () => {
    const r = await maybeRunLocalTurn({ message: "hi", backend: "claude" });
    expect(r).toMatchObject({ ok: false });
    expect(String(r?.error)).toContain("turn_id");
    expect(await maybeRunLocalTurn({ message: "hi" })).toBeNull();
  });
});

describe("边界 14 / §地基 14：就绪状态", () => {
  it("内置引擎没配置时置灰，本机 Claude 不受影响；Codex / WorkBuddy 即将支持；计费口径分开标", () => {
    const list = backendStatuses({ authFailed: new Set(), builtinConfigured: false });
    const by = Object.fromEntries(list.map((b) => [b.id, b]));
    expect(by.builtin.state).toBe("not_configured");
    expect(by.claude.state).toBe("ready");
    expect(by.claude.billing).toBe("用你的 Claude 订阅");
    expect(by.codex.state).toBe("coming_soon");
    expect(by.workbuddy.billing).toBe("用 WorkBuddy 额度");
  });
});
