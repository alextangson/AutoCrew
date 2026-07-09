import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base=/v2/:迁移期与 vanilla 并存(frontend-v2 契约 A-D 期),D 期清场后才接管 /。
// dev 模式代理到本地 server(先起 npx tsx desktop/server.ts)。
export default defineConfig({
  plugins: [react()],
  base: "/v2/",
  build: { outDir: "dist", sourcemap: true },
  server: {
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/config.js": "http://127.0.0.1:4317",
    },
  },
});
