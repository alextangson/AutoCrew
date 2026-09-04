/**
 * 桥的回归锁。三条不变量按重要性排：
 *   1. ok:false 必须抛 —— 失败绝不能穿成「成功结果里带个 error 字段」。
 *   2. dsh 交下来的参数是冻结的，桥不许就地改。
 *   3. 每个放行的工具都带齐 dsh 强制的输出契约。
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDshTools, PORTED_TOOLS } from "./tools.js";

const DATA_DIR = path.join(os.tmpdir(), "autocrew-dsh-bridge-test");

/** dsh 的 ToolRunContext 桥没用到，测试里给个最小占位。 */
const EXEC = { signal: new AbortController().signal } as never;

function statusTool() {
  const tool = buildDshTools({ data_dir: DATA_DIR }).definitions.find((d) => d.name === "autocrew_status");
  if (!tool) throw new Error("autocrew_status not built");
  return tool;
}

describe("ToolRunner → dsh 工具桥", () => {
  it("只放行 PORTED_TOOLS，其余记进 pending 而不是静默消失", () => {
    const { definitions, pending, missing } = buildDshTools({ data_dir: DATA_DIR });
    const built = definitions.map((d) => d.name);
    // 放行的 = 清单 - 还没落地的；两边并起来必须正好是清单，一个不多一个不少。
    expect([...built, ...missing].sort()).toEqual([...PORTED_TOOLS].sort());
    for (const name of built) expect(PORTED_TOOLS).toContain(name);
    for (const name of pending) expect(PORTED_TOOLS).not.toContain(name);
    expect(pending).toContain("autocrew_publish");
    expect(built).toContain("autocrew_status");
  });

  it("没放行的高危工具一个都不许漏进来", () => {
    // 逐条对应 README 审计表里判定「不放行」的那几行。这条锁的不是名单长度，
    // 而是那几个具体的坑：bundle 后指错的 REPO_ROOT、需要 Gemini key、
    // 拿不到数据就造占位结果还报 ok:true、需要常驻 daemon。
    const { definitions } = buildDshTools({ data_dir: DATA_DIR });
    const built = definitions.map((d) => d.name);
    for (const name of [
      "autocrew_publish", // wechat-mp.ts 的 REPO_ROOT 打包后必然指错
      "autocrew_cover_review", // 需要 Gemini key
      "autocrew_research", // 适配器空手时造占位选题、仍 ok:true
      "autocrew_pipeline", // 只写调度定义，执行要常驻 daemon
    ]) {
      expect(built).not.toContain(name);
    }
  });

  it("参数 schema 是 lossless JSON —— TypeBox 的 symbol 必须被剥掉", () => {
    // dsh 注册表投影 schema 时见到 own symbol 会抛
    // 「parameters must be lossless JSON before schema projection」，
    // 而 AutoCrew 的 schema 全是 TypeBox 造的，天然带 Symbol(TypeBox.Kind)。
    for (const tool of buildDshTools({ data_dir: DATA_DIR }).definitions) {
      const params = tool.parameters as Record<string, unknown>;
      expect(Object.getOwnPropertySymbols(params)).toEqual([]);
      expect(params).toEqual(JSON.parse(JSON.stringify(params)));
    }
  });

  it("每个放行的工具都带齐 dsh 强制的 output 契约", () => {
    for (const tool of buildDshTools({ data_dir: DATA_DIR }).definitions) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(tool.output.schema).toMatchObject({ type: "object" });
      expect(tool.output.render({}, { ok: true })).toEqual([{ type: "text", text: '{\n  "ok": true\n}' }]);
    }
  });

  it("成功调用返回 canonical 对象", async () => {
    const value = (await statusTool().execute({ action: "overview" }, EXEC)) as Record<string, unknown>;
    expect(value).toMatchObject({ ok: true, action: "overview" });
    expect(typeof value.topics).toBe("number");
  });

  it("ok:false 抛出去，不许当成功值返回", async () => {
    // compare 缺 content_id —— AutoCrew 侧返回 {ok:false}，桥必须把它变成失败。
    await expect(statusTool().execute({ action: "compare" }, EXEC)).rejects.toThrow(/content_id is required/);
  });

  it("冻结的参数不会被就地写入", async () => {
    const frozen = Object.freeze({ action: "overview" });
    await expect(statusTool().execute(frozen, EXEC)).resolves.toMatchObject({ ok: true });
    expect(Object.keys(frozen)).toEqual(["action"]);
  });
});
