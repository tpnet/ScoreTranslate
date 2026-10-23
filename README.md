# ScoreTranslate

简体中文 | [English](README.en.md) · [官网](https://tpnet.github.io/ScoreTranslate/)

乐谱格式转换工具，使用 React + Vite，支持 Web 和 Tauri 桌面端。桌面版在本机完成转换；Web 版通过配套服务器转换，本机部署时文件不会上传到外部服务。

## 转换矩阵

| 输入 | 输出 |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` `.json` `.atex` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.json` `.atex` `.mscz` `.pdf` `.png` `.png` 长图 |

单文件上限 50MB。PNG 按页导出，多页时自动打包成 zip；「PNG 长图」把所有页纵向拼成单张图。`.json` 是 [alphaTab](https://alphatab.net) 的乐谱模型序列化格式，便于在网页端直接渲染或做二次处理；`.atex` 是 alphaTab 的文本谱格式 [alphaTex](https://alphatab.net/docs/alphatex/syntax)，可以直接手写，语法有误时会提示出错的行列。

部分目标格式带导出选项：PNG 的 DPI 与裁边、PDF 的纸张与缩放、MIDI 的展开反复、MusicXML/PDF/PNG 的谱表类型（六线谱 / 五线谱）、弹唱谱的歌词并轨。多轨谱还可以只导出选中的音轨，对全部目标格式生效。

PDF 选择「跟随原谱」时，如果 MuseScore 未能直接导入 Guitar Pro 文件并生成 PDF，会改经 MusicXML 重试，保留原谱的五线谱 / 六线谱显示设置。自动识别草稿中的错误时值仍需对照原谱校正。

## 环境准备

需要 [bun](https://bun.sh) 和 [MuseScore 4](https://musescore.org)（转换引擎，需本机安装）。

MuseScore 默认读取官方安装包的位置：macOS 为 `/Applications/MuseScore 4.app/Contents/MacOS/mscore`，Windows 为 `C:\Program Files\MuseScore 4\bin\MuseScore4.exe`。装在别处时用环境变量覆盖：

```bash
export MSCORE_PATH=/your/path/to/mscore
```

## 运行

```bash
bun install && bun run dev
```

打开 http://localhost:3000 。开发模式由 Vite 提供页面，`/api` 代理到本机 3001 端口的 Bun API。

生产部署：

```bash
bun run build
bun run start
```

Bun 同时提供 `dist/` 静态页面和转换 API，默认只监听 `127.0.0.1:3000`。远程部署可配置 `HOSTNAME` / `PORT`，并在前面设置 HTTPS 反向代理。MuseScore 安装在服务器上，用户浏览器无需安装。仅部署 `dist/` 静态文件不能提供完整转换能力。

## 桌面版

桌面版直接加载静态页面，通过 Tauri IPC 调用 Rust，安装包不包含 Bun、Node.js 或 Next.js，也不启动本地 HTTP 服务。macOS arm64 DMG 约 2.5MB，安装后的 App 约 4.9MB，无需安装 Bun。

**MuseScore 4 仍需单独安装**。没有 MuseScore 时，Guitar Pro / JSON / alphaTex 之间及转 MusicXML 仍可用。乐谱解析和写出在 Worker 执行，Rust 负责 MuseScore 与文件操作，PNG 长图逐页解码并保留 1 亿像素保护。

构建需要 [Rust](https://rustup.rs) 工具链，只能构建本机平台的包：

```bash
bun install && bun tauri build
```

产物在 `src-tauri/target/release/bundle/`（macOS 为 `dmg/`，Windows 为 `nsis/`）。Windows 包也可以在 GitHub Actions 里手动运行 `desktop` 工作流构建。macOS 要求 13 及以上。

应用没有正式签名，首次打开会被系统拦截：macOS 到「系统设置 → 隐私与安全性」点「仍要打开」（或执行 `xattr -dr com.apple.quarantine /Applications/ScoreTranslate.app`）；Windows 在 SmartScreen 提示里点「更多信息 → 仍要运行」。

## 校验

```bash
bun run build            # TypeScript + Vite
bun run verify           # Web HTTP 真实文件转换（需要 MuseScore 4）
bun run verify --native  # 同一组用例验证 Rust 转换路径，自动构建原生校验入口
bun tauri dev            # 桌面开发窗口
```

校验覆盖全部输出格式、选轨、TAB、JSON/alphaTex、MIDI/MusicXML 桥接、多页 PNG 与长图、GP5 双解析器回读及错误输入；不使用 mock 转换引擎。

## HTTP 接口

界面之外也可以直接调接口，`POST /api/convert` 接收 multipart 表单，字段为 `file` 和 `target`：

```bash
curl -O -J -F "file=@score.gp5" -F "target=pdf" http://localhost:3000/api/convert
```

成功返回文件流，文件名在 `Content-Disposition` 与 `X-Filename` 响应头里；失败返回 JSON `{"error": "..."}`。

导出选项作为可选表单字段传入，非法值直接忽略：`dpi`（50–1200）、`trim`（0–500 像素边距）、`scale`（50–200）、`paper`（`a4` / `letter`）、`staffMode`（`tab` / `standard`）、`unrollRepeats`（`1`）、`mergeLyrics`（`1`，把人声轨歌词按时间对齐并入其他音轨）、`tracks`（逗号分隔的音轨下标，只导出这些轨，缺省导出全部）。

`tracks` 的下标由 `POST /api/tracks` 给出，同样接收 `file` 字段，返回 `{"tracks": ["音轨名", ...]}`，数组顺序即下标：

```bash
curl -F "file=@score.gp5" http://localhost:3000/api/tracks
```

## 已知限制

**gp3 / gp4 / gpx 只能输入、不能输出。** 能打开 gp3/gp4 的软件都能打开 gp5，单独实现只服务于早已废弃的老版本软件；gpx 是 GP6 独有的 BCFZ 专有容器，GP6 已被官方放弃。`.gp` 输出为 Guitar Pro 7/8 格式（由 alphaTab 生成）。

**`.gp5` 输出为自研写出器生成**（开源生态无现成实现），保留音符、节奏、连音线、连音、力度、拍号调号、反复记号、调弦变调夹，以及演奏效果（推弦、击勾弦、滑音、泛音、闷音、延音、颤音、倚音、扫弦、断奏、重音、指法等；GP5 格式没有的除外，如左手点弦与拨片刮弦）。和弦图不保留。来源不是吉他谱时（MIDI / 钢琴 MusicXML），会按音域自动选择六弦吉他 / 七弦 / 贝斯调音并指派弦位品格，超出音域的音符按八度折叠；非 ASCII 的标题、歌词等文本会降级为 `?`（GP5 格式的编码限制），中文歌词请改用 MusicXML / pdf / png 等目标格式。

**MIDI 转记谱格式的质量有天花板。** MIDI 不携带谱面信息（声部划分、连音线、临时记号的拼写），转换结果由 MuseScore 的量化算法推断，演奏录制的 MIDI 转出的谱子通常需要手工整理。这是格式本身的固有限制。

## 结构

- `lib/convert.ts` — 转换核心与路由；Guitar Pro 输入直接解析，其余先经 MusicXML 桥接
- `lib/gp5-writer.ts` — GP5 二进制写出器（含弦品指派算法）
- `lib/gp-to-musicxml.ts` — Guitar Pro 模型 → MusicXML 序列化器（保留 TAB 谱表与弦品信息）
- `server/convert.ts` — 转换接口，负责校验与文件流响应
- `server/tracks.ts` — 音轨名列表接口，供前端勾选导出哪些轨
- `src/App.tsx` — 上传 / 选择目标格式 / 下载的单页界面
- `src/convert.worker.ts` — 桌面端后台转换，共用 `lib/convert.ts`
- `src/platform.ts` — Web HTTP / 桌面 IPC 调用入口
- `server/render.ts` — Web 端 MuseScore 与 PNG 适配
- `src-tauri/src/render.rs` — 桌面端 MuseScore、临时文件、PNG/ZIP 实现
- `src-tauri/` — Tauri 静态前端与原生命令，不包含服务端运行时

## 许可证

[MIT](LICENSE)
