import { defineConfig } from "vite";

export default defineConfig({
  // 暴露 .env 中的 OPENAI_* / AGNES_*（本地演示用；勿把含真实 Key 的构建公开发布）
  envPrefix: ["VITE_", "OPENAI_", "AGNES_"],
  server: {
    port: 5173,
    strictPort: true,
    host: true, // 允许手机同一 Wi-Fi 访问
    open: true,
  },
  preview: {
    port: 5173,
    host: true,
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
});
