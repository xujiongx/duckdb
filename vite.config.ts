import { defineConfig } from "vite";

export default defineConfig({
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
