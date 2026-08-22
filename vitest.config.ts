import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // render/ 是独立 npm 包（禁止跨 workspace import 源码），但它的**纯函数**——字幕分行、
    // 估宽、强调词匹配——必须有确定性用例锁死，所以测试统一由根 vitest 跑。
    // 这些测试只 `import type` 拿 manifest 类型，不会把 render 的运行时依赖拖进来。
    include: ["src/**/*.test.ts", "frontend/src/**/*.test.ts", "mcp/**/*.test.ts", "render/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/modules/**/*.ts"],
      exclude: ["src/modules/publish/**"],
    },
  },
});
