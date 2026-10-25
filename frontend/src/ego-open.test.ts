import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openConsoleMessage } from "./ego-open";

describe("在 ego lite 里打开后台", () => {
  it("成功照服务端说；失败原样给出下一步（没装 / 没开 ego lite）", () => {
    expect(openConsoleMessage({ ok: true, data: { message: "已在 ego lite 里打开视频号后台" } })).toBe("已在 ego lite 里打开视频号后台");
    expect(openConsoleMessage({ ok: false, error: "ego lite 没在运行：先打开 ego lite 再点一次" })).toContain("ego lite 没在运行");
  });

  it("「打开后台」入口不再用外链开默认浏览器（账号格 / 编辑页发布）", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "views");
    for (const f of ["Home.tsx", "EditorTools.tsx", "PullLoginReminder.tsx", "PullStatusPanel.tsx"]) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/href=\{(s\.consoleUrl|clip\.publishUrl|row\.consoleUrl|t\.consoleUrl)\}/);
      expect(src, f).toContain("openInEgo(");
    }
  });
});
