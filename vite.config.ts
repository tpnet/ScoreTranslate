import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "@": fileURLToPath(new URL(".", import.meta.url)),
    // 只做模型转换，避免完整入口自动初始化 alphaTab 自己的 Worker。
    "@coderline/alphatab": fileURLToPath(new URL("./node_modules/@coderline/alphatab/dist/alphaTab.core.mjs", import.meta.url)),
  } },
  server: {
    host: "127.0.0.1", port: 3000, strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { target: "es2022" },
  worker: { format: "es" },
});
