import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 桌面版把 .next/standalone 整体打进 Electron 包（见 desktop/main.js）
  output: "standalone",
  // 桌面包里用不到、只占体积的依赖：没用到图片优化，sharp 还是构建机平台的原生库；
  // standalone 的配置已内联进 server.js，运行时不需要 typescript
  outputFileTracingExcludes: {
    "*": ["node_modules/sharp/**", "node_modules/@img/**", "node_modules/typescript/**"],
  },
  serverExternalPackages: ["@coderline/alphatab"],
};

export default nextConfig;
