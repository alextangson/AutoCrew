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
    const { definitions, pending } = buildDshTools({ data_dir: DATA_DIR });
    expect(definitions.map((d) => d.name)).toEqual([...PORTED_TOOLS]);
    expect(pending).toContain("autocrew_generate");
    expect(pending).not.toContain("autocrew_status");
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
