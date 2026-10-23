# React + Vite + Tauri 迁移

目标：桌面端移除 Bun/Next.js 和本地 HTTP 服务，保留全部格式与选项；Web 使用同一 React 界面与转换核心，兼容原有 HTTP 接口。

实现顺序：提取纯 TypeScript 转换与平台渲染接口；Web 用 Bun 提供 API/静态资源；桌面端 Worker 调用共用核心，Rust 负责临时文件、MuseScore、PNG/ZIP；最后更新打包、CI 与说明。

代码沿用当前 TypeScript/Rust 风格，例如 `await render(input, { inputExt, target: "musicxml" })`；只在平台边界校验文件和参数，不重写乐谱算法。

命令：`bun run dev`、`bun run build`、`bun run start`、`bun run verify`、`bun tauri build`。

验收：类型/Vite/Cargo 构建通过；真实文件覆盖全部目标、选轨、TAB、JSON/alphaTex、PNG 多页与长图、失败输入；GP5 双解析器回读；Web 页面和桌面 IPC/下载工作；DMG 不含 Bun/Next.js，记录新旧体积。不得新增 JVM/单元测试，使用可重复的真实转换验证脚本。

边界：保留 MuseScore 单独安装、超时和产物判断、50MB 上传上限与 1 亿像素长图保护；不改写 GP5 字节布局，不升级无关依赖。用户已授权实现、构建与测试；发布和正式签名不在范围内。
