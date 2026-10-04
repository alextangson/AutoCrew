/** MCP 表面预算（spec v1.3 M7）与契约不变（M1）：量法与 tools/list 同一套序列化 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "./server.js";
import { schemaShape } from "./schema-shape.js";
import { TOOL_GUIDE_PREFIX } from "./tool-docs.js";

const HOSTS = ["local-user", "workbuddy", "codex"] as const;
const access = (host: string) => ({ principal: { subject: host, plan: "local" as const }, host });
async function toolsFor(host: string) {
  const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, access(host));
  return (r!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
}

/**
 * 实测锁（2026-09-29）：总 27,322 / 单个最大 3,556（editorial）/ instructions 675；留一点余量。
 * 同日发布前把关给 autocrew_publish 加 check / propose_preference 的参数（已压到最少：overrides、value 不展开嵌套），
 * 实测 27,983 → 28,263，上限随之从 28,000 提到 28,500。
 */
/*
 * 2026-09-30 等你拍板 2a：autocrew_content 加 ask / answer_ask / withdraw_ask / mark_ready 与它们的参数（review、paths、pair_with、
 * fact_id、question、options、attachments、ask_id、option_id、founder_quote、asks_offset；kind 加六种请示），参数说明已压到零、
 * options / attachments 不展开嵌套，工具说明重写后与原来等长；实测 28,498 → 28,978，上限随之从 28,500 提到 29,000。
 */
/*
 * 2026-10-02 合 0.5.0：main 的选题会给 autocrew_insights 加 meeting_* 动作与参数（2,727 → 2,847），与 2a 各自都在预算内，
 * 合起来实测 28,968 → 29,088，上限随之从 29,000 提到 29,200。
 */
/*
 * 2026-10-03 发布标题方法库：autocrew_pre_publish 加 title_methods 动作与 kit.title_candidates / title_method（候选不展开嵌套），
 * 工具说明补一句三个动作；实测 29,232，上限随之从 29,200 提到 29,400。
 * 2026-10-03 判断要对账：autocrew_insights 加 calib_* 动作（status/blind/predict/retro/bump/observe/learn）与一个 calib 参数，
 * 用法全放 tool-guide 资源、工具说明只加一句；实测 29,088 → 约 29,230，上限随之从 29,200 提到 29,400。
 */
/*
 * 2026-10-03 回流认领：autocrew_insights 加 work_bind / history_create / history_delete 与一个 work 参数，
 * 用法放 tool-guide、工具说明只加一句；实测 29,470，上限随之从 29,400 提到 29,600。
 */
/*
 * 2026-10-04 灵感 → A-roll 薄路径：新增 autocrew_draft（7 个动作、20 个参数，说明已压到一句）；实测 30,728，上限随之从 29,600 提到 30,800。
 * 2026-10-04 首次验收：angle 加 chosen_option、citations 项加 kind 枚举；实测 30,850，上限随之从 30,800 提到 31,000。
 */
export const BUDGET = { total: 31_000, perTool: 4_000, instructions: 1_500 };

describe("M7 预算：外部宿主看到的 tools/list 与 initialize", () => {
  it.each(["workbuddy", "claude-code"])("%s：总量、单个工具、instructions 都在预算内；超了列出谁超、多少字", async (host) => {
    const tools = await toolsFor(host);
    const sizes = tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length }));
    const total = JSON.stringify(tools).length;
    const over = sizes.filter((s) => s.chars > BUDGET.perTool).map((s) => `${s.name} ${s.chars}`);
    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } }, access(host));
    const instructions = (init!.result as { instructions: string }).instructions.length;
    const report = `tools/list 共 ${total} 字（上限 ${BUDGET.total}）；超单个上限 ${BUDGET.perTool} 的：${over.join("，") || "无"}；instructions ${instructions} 字（上限 ${BUDGET.instructions}）。最大的五个：${[...sizes].sort((a, b) => b.chars - a.chars).slice(0, 5).map((s) => `${s.name} ${s.chars}`).join("，")}`;
    expect(total <= BUDGET.total && over.length === 0 && instructions <= BUDGET.instructions, report).toBe(true);
  });
});

describe("M1 契约不变：工具名、参数名、类型、必填、枚举、长度与格式限制与瘦身前逐项一致", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tool-contract.json"), "utf-8")) as Record<string, Array<{ name: string; shape: unknown }>>;
  it.each(HOSTS)("%s 看到的工具清单与参数形状", async (host) => {
    const now = (await toolsFor(host)).map((t) => ({ name: t.name, shape: schemaShape(t.inputSchema) }));
    // 2026-10-02 起 codex 与别的命名宿主能力一样：它看到的就是 workbuddy 那一份，不另存一份快照
    expect(now).toEqual(fixture[host === "codex" ? "workbuddy" : host]);
  });
});

describe("M1 快照真的会拦住契约变化（评审 v1.3 P2）", () => {
  const topicShape = async () => structuredClone((await toolsFor("workbuddy")).find((t) => t.name === "autocrew_topic")!.inputSchema) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
  const fixtureTopic = () => (JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tool-contract.json"), "utf-8")).workbuddy as Array<{ name: string; shape: unknown }>).find((t) => t.name === "autocrew_topic")!.shape;
  it("名叫 title / description 的真参数在快照里", async () => {
    const shape = schemaShape(await topicShape()) as { properties: Record<string, unknown> };
    expect(Object.keys(shape.properties)).toEqual(expect.arrayContaining(["title", "description"]));
  });
  it.each([
    ["删掉一个参数", (s: { properties: Record<string, Record<string, unknown>> }) => { delete s.properties.title; }],
    ["改参数类型", (s: { properties: Record<string, Record<string, unknown>> }) => { s.properties.description.type = "number"; }],
    ["改长度限制", (s: { properties: Record<string, Record<string, unknown>> }) => { s.properties.title.maxLength = 1; }],
    ["改枚举", (s: { properties: Record<string, Record<string, unknown>> }) => { (s.properties.action as { enum: string[] }).enum = ["create"]; }],
  ])("%s → 快照不相等", async (_label, mutate) => {
    const schema = await topicShape();
    expect(schemaShape(schema)).toEqual(fixtureTopic());
    mutate(schema);
    expect(schemaShape(schema)).not.toEqual(fixtureTopic());
  });
});

describe("长说明搬进按需资源", () => {
  it("每个工具的完整用法可按需读取（瘦身前的原文）", async () => {
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: `${TOOL_GUIDE_PREFIX}autocrew_writer` } }, access("workbuddy"));
    const text = ((r!.result as { contents: Array<{ text: string }> }).contents[0].text);
    expect(text).toContain("pack_status");
    expect(text.length).toBeGreaterThan(1000);
    const missing = await handleMcpRequest({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `${TOOL_GUIDE_PREFIX}nope` } }, access("workbuddy"));
    expect(missing!.error).toBeDefined();
  });
  it("评审 v1.3 P2：完整用法里有原参数结构与每个参数的原说明（如 video report 的 request_id / binding_revision）", async () => {
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: `${TOOL_GUIDE_PREFIX}autocrew_video` } }, access("workbuddy"));
    const text = (r!.result as { contents: Array<{ text: string }> }).contents[0].text;
    for (const k of ["request_id", "binding_revision", "session_id", "files"]) expect(text).toContain(k);
    expect(text).toContain("## 参数");
  });
  it("评审 v1.3 P3：resources/list 列的是每个工具真实的完整用法 URI，没有字面占位", async () => {
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 7, method: "resources/list" }, access("workbuddy"));
    const uris = (r!.result as { resources: Array<{ uri: string }> }).resources.map((x) => x.uri);
    expect(uris).toContain(`${TOOL_GUIDE_PREFIX}autocrew_writer`);
    expect(uris.some((u) => u.includes("<"))).toBe(false);
    const codex = await handleMcpRequest({ jsonrpc: "2.0", id: 8, method: "resources/list" }, access("codex"));
    expect((codex!.result as { resources: Array<{ uri: string }> }).resources.map((x) => x.uri)).toEqual(uris);
  });
  it("短说明点名资源；instructions 点名写作守则", async () => {
    const tools = await toolsFor("workbuddy");
    for (const t of tools) expect(t.description).toContain(`${TOOL_GUIDE_PREFIX}${t.name}`);
    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }, access("workbuddy"));
    expect((init!.result as { instructions: string }).instructions).toContain("autocrew://writing-guide");
  });
});
