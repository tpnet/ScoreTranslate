# 迁移验证记录

验证时间：2026-10-23，macOS arm64，Bun 1.3.14，MuseScore 4.7.4。

## 架构与产物

- React + Vite 共用界面，Web 由 Bun 提供静态资源和原有 HTTP API。
- 桌面通过 Tauri 静态资源启动，Worker 执行纯 TypeScript 转换，Rust 负责 MuseScore、临时文件、PNG/ZIP。
- 桌面实际窗口 URL 为 `tauri://localhost`，进程无 TCP 监听。最终 App 内只有主程序、图标、Info.plist 和代码签名文件；无 Bun、Next.js、node_modules 或 server 目录。
- 原 DMG：33,573,857 字节（33.57 MB）。新 DMG：2,521,030 字节（2.52 MB），减少 92.49%。App 文件合计 4,864,341 字节（4.86 MB），使用十进制 MB。
- 最终产物：`src-tauri/target/release/bundle/dmg/ScoreTranslate_0.1.0_aarch64.dmg`。

## 自动校验

以下命令均通过：

```bash
bun install --frozen-lockfile
bun run build
bun run verify
bun run verify --native
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
bun tauri build --bundles app,dmg
hdiutil verify src-tauri/target/release/bundle/dmg/ScoreTranslate_0.1.0_aarch64.dmg
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/ScoreTranslate.app
```

Web 38 组、Rust 39 组真实文件回归，覆盖全部 12 个输出目标、选第二轨、TAB、歌词并轨、JSON/alphaTex 输入、非 GP MusicXML/MIDI 桥接、PNG 多页 ZIP 与白底长图、中文文件名、GP5 alphaTab/MuseScore 双解析器音高回读、损坏输入与禁止旧格式输出。Rust 额外验证格式白名单、参数范围、50MB 和 1 亿像素保护。校验过程中损坏输入触发的 alphaTab 错误日志属于预期，最终断言通过。

临时对照旧版核心：GP、GP5、JSON、alphaTex、MusicXML 在默认与选第二轨配置下逐字节一致；MXL 文件名与成功结果一致，未对 ZIP 时间戳做逐字节比较。未修改 GP5 写出器或 MusicXML 序列化算法。

## 运行验证

- Web 生产页面真实上传双音轨 MusicXML，转换并下载有效两页 PDF。
- Vite 开发模式启动成功，API 代理版本检测和真实 GP5 转换返回 200。
- 最终桌面包启动成功；窗口内上传、音轨读取、Worker/IPC PDF 转换、下载目录保存通过。
- 桌面窗口取消 Guitar，只选 Bass，导出 GP5；alphaTab 回读确认只有 Bass 一轨、四小节。
- 用现有《成都》第 1 页自动识别 alphaTex 转 PDF，返回 200，`file` 确认为有效单页 PDF。
- 中文文件名 PDF 的 HTTP 响应同时保留 ASCII `filename=`、UTF-8 `filename*=` 与 `X-Filename`。
- 静态目录穿越请求返回 404；缺少 MuseScore 时状态为 null、依赖转换报错，独立 GP 转 MusicXML 仍成功。
- 独立只读审查覆盖调用方、选轨/TAB/PDF 回退、Worker/raw IPC、PNG、下载和打包配置；已修复单页 PNG 读取与 finally 清理之间的竞态，最终回归通过。

## 限制

- 未在 Windows、Intel Mac 或最低 macOS 13 实机运行；保留了对应构建配置与 GitHub Actions 矩阵。
- 没有承诺转换耗时的固定提升比例，未做超大乐谱的峰值内存基准。性能改动是移除服务端启动、后台 Worker 计算、二进制 IPC 与原生长图逐页解码。
- MuseScore 仍需另外安装。应用使用 ad-hoc 签名，未进行正式开发者签名或公证。
- 未新增 JVM/单元测试；新增的是实际文件端到端校验脚本与原生校验入口。
