import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// D 期已清场:React 即主前端,base=/(保留 /v2 别名兼容书签)。
// dev 模式代理到本地 server(先起 npx tsx desktop/server.ts)。
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", sourcemap: true },
  server: {
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/config.js": "http://127.0.0.1:4317",
    },
  },
});
