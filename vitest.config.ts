import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // 每个测试文件一个空 HOME，碰不到真实的 ~/.autocrew / 资料库 / 宿主配置；
    // 认稿弹窗的 open / 通知窗在测试里一律不碰系统（见各文件内说明）
    setupFiles: ["src/test-setup/sandbox-home.ts", "src/test-setup/no-desktop-side-effects.ts"],
    // render/ 是独立 npm 包（禁止跨 workspace import 源码），但它的**纯函数**——字幕分行、
    // 估宽、强调词匹配——必须有确定性用例锁死，所以测试统一由根 vitest 跑。
    // 这些测试只 `import type` 拿 manifest 类型，不会把 render 的运行时依赖拖进来。
    include: [
      "src/**/*.test.ts",
      "frontend/src/**/*.test.ts",
      "mcp/**/*.test.ts",
      "render/src/**/*.test.ts",
      "adapters/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/modules/**/*.ts"],
      exclude: ["src/modules/publish/**"],
    },
  },
});
