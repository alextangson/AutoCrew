import { describe, expect, it } from "vitest";
import { registerAutocrewCapabilities } from "../../index.js";
import { createContext } from "./context.js";
import { ToolRunner } from "./tool-runner.js";

describe("AutoCrew capability registry", () => {
  it("is the single complete source for OpenClaw and MCP adapters", () => {
    const runner = new ToolRunner({ ctx: createContext({ data_dir: "/tmp/autocrew-capability-test" }) });
    registerAutocrewCapabilities(runner);
    const names = runner.getTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("autocrew_generate");
    expect(names).toContain("autocrew_revise");
    expect(names).toContain("autocrew_flywheel");
    expect(names).toContain("autocrew_publish");
  });
});
