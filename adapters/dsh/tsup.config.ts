import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  // dsh bundle 是运行时按名加载的，不会被当库 import，所以不出 .d.ts。
  dts: false,
  // AutoCrew 主干是 TS 源码、从不产出 JS（根 tsconfig 是 --noEmit），所以
  // ../../../src/** 全靠这里内联进 bundle；npm 包必须自带这部分。
  // node_modules 里的依赖保持 external，由 package.json 的 dependencies 装。
});
