# CLAUDE.md

乐谱格式转换工具。React + Vite 前端，Web 使用 Bun API，桌面使用 Tauri Rust IPC。共用纯 TypeScript 转换核心，无数据库。

## 命令

```bash
bun run dev             # Vite localhost:3000 + Bun API localhost:3001
bun run build           # TypeScript 检查 + Vite 静态构建到 dist/
bun run start           # Bun 提供 dist/ 和 API，默认 127.0.0.1:3000
bun run verify          # Web HTTP 真实文件回归，需要 MuseScore 4
bun run verify --native # 自动构建原生校验入口，验证同一组 Rust 转换链路
bun tauri dev           # Vite + Tauri 开发窗口
bun tauri build         # 静态资源 + Rust 打包，产物在 src-tauri/target/release/bundle/
```

## 结构

- `lib/convert.ts` — 转换核心与路由
- `lib/song-json.ts` — LiberLive / 二维 GP 时间线 JSON → MusicXML 输入适配
- `lib/gp5-writer.ts` — GP5 v5.00 二进制写出器 + 弦品指派算法
- `lib/gp-to-musicxml.ts` — alphaTab 乐谱模型 → MusicXML 序列化器（保留 TAB/弦品）
- `server/convert.ts` — multipart 上传，校验后返回文件流
- `server/tracks.ts` — 返回音轨名列表，供前端勾选导出哪些轨
- `src/App.tsx` — 单页界面
- `src/convert.worker.ts` — 桌面后台转换，复用 `lib/convert.ts`
- `lib/formats.ts` / `lib/request.ts` — 格式、参数与上传校验
- `server/render.ts` / `src-tauri/src/render.rs` — 两端 MuseScore、PNG 适配
- `src-tauri/` — Tauri 静态页面与原生命令（见「桌面版」）

## 转换链路

分两条路径：

- **gp 系输入（gp/gpx/gp3/gp4/gp5；alphaTab JSON 和 alphaTex 先转成 `.gp` 再走这条）→ MusicXML 系 / gp / gp5 / json / atex**：alphaTab 直接解析原文件，不经过 MuseScore。MusicXML 由 `gp-to-musicxml.ts` 自研序列化——因为 MuseScore 的 MusicXML 导出会丢掉 TAB 谱表、调弦和全部弦/品信息。写 MusicXML 时**用实际发声音高、不写 `<transpose>` 八度声明**：MuseScore 4 导入时忽略该声明，按吉他记谱惯例写高八度会导致品位整体上移 12 品（曾实测踩坑）。
- **其余转换**：MuseScore 4 CLI 负责解析和导出（mid/pdf/png/mscz 及非 gp 输入）。非 gp 输入转 `.gp` / `.gp5` / `.atex` 走两段：MuseScore 先转 MusicXML，`.gp` 由 alphaTab 的 `Gp7Exporter` 写出，`.gp5` 由自研写出器写出，`.atex` 由 alphaTab 的 `AlphaTexExporter` 写出。

歌曲 JSON（LiberLive 原始详情与二维 GP 时间线）先由 `songJsonToXml` 生成 MusicXML，再直接交 alphaTab 解析，首次 GP 序列化前必须补齐调弦与弦品，并校验音高未改变、音符未丢失。`jsonTempo` 在两种歌曲 JSON 上覆盖 BPM；`jsonMiddleC` 仅影响原始详情，二维时间线已有 MIDI 音高不可再次移调。Web 和桌面 Worker 的 `.gp.json` 输入命名均应剥掉双后缀。修改此路径时，运行 `scripts/verify-song-gp.ts` 回读检查音高、起止 tick、歌词、和弦与调弦。

导出配置见 `ConvertOptions`（lib/formats.ts）：png 的 DPI/裁边走 `-r`/`-T`，pdf 的纸张/缩放走 `-S` 临时样式文件，mid 展开反复走 `--unroll-repeats`，MusicXML/pdf/png 目标的谱表类型（TAB/五线谱）由自研序列化器处理：gp 输入直接解析；非 gp 输入选 TAB 时先由 MuseScore 桥接成 MusicXML、`ensureFingerings` 指派弦品后重新序列化；pdf/png 最后交回 MuseScore 渲染。这些是 MuseScore CLI 仅有的相关开关，别的"配置项"CLI 不支持，gp/gp5/mscz 转换本身无参数。

`tracks`（只导出选中音轨，对全部目标格式生效）统一在 alphaTab 模型上过滤，下标由 `listTracks` 给出——它和转换走同一条解析链路（gp 系 alphaTab 直连，其余先经 MuseScore 桥接成 MusicXML），下标才对得上。因此 pdf/png/mid/mscz 这些本来直接丢给 MuseScore 的目标，在选轨时被迫先过一遍 alphaTab：gp 输入指定了谱表类型走自研 MusicXML 序列化，未指定则重新导出只含选中轨的 `.gp` 交回 MuseScore，避免改变"跟随原谱"的渲染；非 gp 输入一律 MuseScore 桥接成 MusicXML 后重新序列化。**gp/gp5/json/atex 目标必须排除在这段桥接之外**——它们下面有自己的桥接，过两遍会按已过滤后的下标再过滤一次。过滤不重排 `track.index`——`gp-to-musicxml.ts` 用它拼 part id。atex 目标是例外：`AlphaTexExporter` 只在 `index === 0` 的音轨上写小节级信息（拍号、调号、速度、反复、段落），滤掉首轨会全部静默丢失，所以导出前由 `reindexTracks` 重排 index，并同步改键按 index 索引的 stylesheet 逐轨设置。

和弦：MuseScore 读 .gp 时把和弦 ID 当数字解析，而 alphaTex 来源的 ID 是 `c00`、gp5 来源的是 GUID，会全被解析成 0，所有和弦都显示成第一个——所以 alphaTab 写 .gp 或 MusicXML 前一律先过 `normalizeChordIds` 重排成数字。MusicXML 的 `<harmony>` 把和弦名后缀原样放进 `kind` 的 `text`（MuseScore、alphaTab 都按它显示）；空后缀必须写 `major`，写 `other` 会被 MuseScore 显示成 "C°ther"。

## GP5 写出器（lib/gp5-writer.ts）

- 字节布局逐字段**镜像 alphaTab 的 `Gp3To5Importer`**（node_modules/@coderline/alphatab/dist/alphaTab.core.mjs 中搜 `Gp3To5Importer`）的 v5.00 读取分支。改字段顺序前必须对照该解析器，任何一个字节错位都会毁掉整个文件的后续解析。
- 验证方式是**双解析器回读**：alphaTab 重新导入逐拍比对 + MuseScore 转回 MusicXML 比对音高序列。两个独立实现都读对才算对，改动后两条都要跑。
- MusicXML/MIDI 来源的音符没有弦号品格（`note.string === -1`），由 `assignBeat` 贪心指派；alphaTab 的 MusicXML 导入还会把标题中的空格变成 U+00A0，`ascii()` 已处理。
- 演奏效果（beat/note effects）已完整写出，字节结构同样镜像 `readBeatEffects`/`readNoteEffects` 的 v5.00 分支。GP5 格式表达不了的会降级或跳过（wide 颤音→slight、arpeggio→brush、左手点弦/拨片刮弦/fade-out 无对应位），细节见 `gp5-writer.ts` 各写出函数的注释。
- **每个 `(track, staff)` 展开成一个独立 GP5 音轨**（`expandStaves`）。GP5 格式没有"多谱表音轨"的概念，钢琴大谱表的原生表示就是拆成两个音轨；多谱表时音轨名加 `(1)` `(2)` 后缀，与 `gp-to-musicxml.ts` 的分 part 规则一致。只取 `staves[0]` 会静默丢掉左手声部。
- **声部要按"非空优先"取，不能按下标取。** GP5 每小节固定 2 个声部，而 alphaTab 的声部下标沿用来源编号——MuseScore 导出的大谱表下谱表用 `<voice>5</voice>`，落到下标 4，下标 0–3 是空占位。直接取 `voices[0]`/`voices[1]` 会全取到空的。
- **同一音轨各小节写出的声部数必须一致**（`pickVoices` + `twoVoices`）。alphaTab 读到拍数为 0 的声部时干脆不建 `Voice`，于是"有的小节 2 个声部、有的 1 个"会让 `Bar.finish` 链接下一小节时取到 `voices[1] === undefined` 而崩（`nextVoice.beats`）；MuseScore 能正常打开，只有 alphaTab 侧炸。所以只要该轨任一小节写了 2 个声部，其余小节的第二声部就补一个 GP5"空拍"（`0x40` 后跟 `0`，不画休止符）。

## 改动时必须知道的三件事

**1. 不能用退出码判断 MuseScore 成败。** MuseScore 4 无头转换成功后，进程退出阶段会崩溃（`mutex lock failed`），退出码非零但产物已正常生成。Web 和 Rust 的渲染适配因此以产物是否存在判断成功，保留启动失败与超时处理。如果给它加上退出码检查，所有转换都会失败。

**2. PNG 是多文件输出。** MuseScore 把 `-o output.png` 展开成 `output-1.png`、`output-2.png`……单页直接返回 PNG，多页打包成 zip，所以返回的扩展名和用户选的目标格式不一定一致——前端靠响应头 `X-Filename` 拿真实文件名，不要假设它等于目标格式。

`png-long` 先检查所有页面总尺寸，超过 `MAX_LONG_PIXELS`（1 亿像素）直接报错。Web 保留 PNG 头预检与白底 RGBA 拼接；Rust 在预检后逐页解码、合成白底 RGB，降低峰值内存——否则 1200 DPI 的单页 A4 就有 1.4 亿像素，解码后必然 OOM。

`Content-Disposition` 同时给出 `filename=`（非 ASCII 字符替换为下划线）和 `filename*=UTF-8''`，两者缺一不可：浏览器用后者拿到中文原名，而 `curl -J` 只认前者，只给 `filename*=` 会导致 curl 存不下文件。

**3. gp3 / gp4 / gpx 只能读不能写。** 这三种旧版 Guitar Pro 格式在开源生态里没有可靠的写出实现，`OUTPUT_EXTS` 里不包含它们，这是刻意的。不要因为它们出现在 `INPUT_EXTS` 里就"补齐"输出（gp5 是例外，有自研写出器）。

## 桌面版（src-tauri/）

Vite 的 `dist/` 通过 `frontendDist` 嵌入 Rust 主程序，窗口加载 `tauri://localhost`，不携带 Bun/Node/Next.js，不启动 HTTP 服务。`src/platform.ts` 区分 Web API 与桌面 IPC，桌面在 `convert.worker.ts` 中执行共用转换核心，主线程只中转原生请求。Windows 安装包由 `.github/workflows/desktop.yml` 构建。

- **alphaTab 核心入口**：Vite alias 指向 `alphaTab.core.mjs`。完整入口会在 Worker 内自动初始化 alphaTab 自己的消息处理；本项目只需要模型导入导出，不能启用它。
- **二进制 IPC**：原始字节通过 Tauri raw body / `ipc::Response` 传输，避免大型数字 JSON 数组。Worker 使用 transferable；需要 PDF 回退的输入必须保留原缓冲。
- **原生边界**：只接受白名单输入/目标格式、限定导出参数和输入大小；临时文件由 `tempfile` 自动清理，MuseScore 设 120 秒超时。
- **`Cargo.toml` 的 `strip = false`**：Rust 工具链剥离后的 Mach-O 字符串表只按 4 字节对齐，macOS 27 的 dyld 会拒绝加载；保留该配置。
- **macOS 下载处理器**：WKWebView 需要 `on_download`，完成后在访达选中；Windows 使用 WebView2 自带下载界面。
- **`disable_drag_drop_handler()`**：让网页收到 HTML5 拖拽上传。
- **Web 默认仅监听本机**：`server/index.ts` 默认 `127.0.0.1`，远程部署必须显式配置 `HOSTNAME`。

## 验证方式

本项目不写 JVM/单元测试。修改转换逻辑后运行 `bun run build`、`bun run verify`；涉及 Rust 或桌面适配时再运行 `bun run verify --native`、`bun tauri build`。校验脚本使用真实 HTTP/MuseScore 和固定乐谱，包含 GP5 双解析器回读。也可用 curl 验证具体文件：

```bash
curl -s -o out.pdf -w "%{http_code}\n" -F "file=@score.musicxml" -F "target=pdf" http://localhost:3000/api/convert && file out.pdf
```

`file` 命令能确认产物是不是有效格式——转换失败时接口返回 JSON，`file` 会显示 `JSON data` 而不是预期的类型。

## 环境依赖

MuseScore 4 需本机安装（桌面版也不内置），默认读官方安装位置：macOS `/Applications/MuseScore 4.app/Contents/MacOS/mscore`，Windows `%ProgramFiles%\MuseScore 4\bin\MuseScore4.exe`，可用 `MSCORE_PATH` 覆盖。当前开发机版本 4.7.4。
