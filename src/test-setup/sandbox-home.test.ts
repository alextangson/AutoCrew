import { readdirSync } from "node:fs";
import os from "node:os";
import { expect, it } from "vitest";

it("每个测试文件拿到的是空的临时家目录，没有指回真实目录的变量", () => {
  expect(os.homedir()).toBe(process.env.HOME);
  expect(os.homedir().startsWith(os.tmpdir())).toBe(true);
  expect(readdirSync(os.homedir())).toEqual([]);
  for (const key of ["AUTOCREW_LOCAL_DIR", "AUTOCREW_DATA_DIR", "CODEX_HOME", "DSH_HOME", "CLAUDE_CONFIG_DIR"]) {
    expect(process.env[key]).toBeUndefined();
  }
});
