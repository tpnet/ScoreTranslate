# ScoreTranslate

简体中文 | [English](README.en.md) · [官网](https://tpnet.github.io/ScoreTranslate/)

本地乐谱格式转换 Web 工具：选择乐谱文件，转换为其它格式并下载。全程在本机完成，文件不上传到任何外部服务。

## 转换矩阵

| 输入 | 输出 |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` `.json` `.atex` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.json` `.atex` `.mscz` `.pdf` `.png` `.png` 长图 |

单文件上限 50MB。PNG 按页导出，多页时自动打包成 zip；「PNG 长图」把所有页纵向拼成单张图。`.json` 支持 LL 原始歌曲详情（`lyrics-*.json`）、二维 GP 时间线（`*.gp.json`），以及 [alphaTab](https://alphatab.net) 的乐谱模型序列化格式，便于在网页端直接渲染或做二次处理；`.atex` 是 alphaTab 的文本谱格式 [alphaTex](https://alphatab.net/docs/alphatex/syntax)，可以直接手写，语法有误时会提示出错的行列。

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

打开 http://localhost:3000 。

## 桌面版

也可以打包成 macOS / Windows 桌面应用（Tauri，macOS 安装包约 32MB）：自带运行时，双击即用，不需要装 bun。**MuseScore 4 仍需单独安装**，没装时只有 Guitar Pro 转 MusicXML / gp / gp5 可用。

构建需要 [Rust](https://rustup.rs) 工具链，只能构建本机平台的包：

```bash
bun install && bun tauri build
```

产物在 `src-tauri/target/release/bundle/`（macOS 为 `dmg/`，Windows 为 `nsis/`）。Windows 包也可以在 GitHub Actions 里手动运行 `desktop` 工作流构建。macOS 要求 13 及以上。

应用没有正式签名，首次打开会被系统拦截：macOS 到「系统设置 → 隐私与安全性」点「仍要打开」（或执行 `xattr -dr com.apple.quarantine /Applications/ScoreTranslate.app`）；Windows 在 SmartScreen 提示里点「更多信息 → 仍要运行」。

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
- `app/api/convert/route.ts` — 转换接口，负责校验与文件流响应
- `app/api/tracks/route.ts` — 音轨名列表接口，供前端勾选导出哪些轨
- `app/page.tsx` — 上传 / 选择目标格式 / 下载的单页界面
- `src-tauri/` — 桌面版外壳：用随包的 bun 启动 Next.js standalone 服务，再开窗口加载

## 许可证

[MIT](LICENSE)

## LiberLive / GP 时间线 JSON 转 GP

上传原始 `lyrics-*.json` 或此前生成的二维 `.gp.json`，目标选择 **Guitar Pro (.gp)** 即可。不要上传仅含文件索引的 `song.json`。原始歌曲详情自动读取标题、作者与 BPM；二维时间线没有速度元数据，在「歌曲速度 BPM」填写原曲速度（《普通朋友》为 **89**；留空默认 120）。也可在 HTTP 表单传入 `jsonTempo=89`。

原始谱目前支持 4/4，默认 `note=1, upOctave=0` 对应 C4（MIDI 60），不叠加 `tone/leadNote`。若试听确认相差八度，可在「原始谱八度」选择 C3/C5（HTTP `jsonMiddleC=48/72`）。二维时间线已经有 MIDI 音高，不再应用这个设置。设备音色、自动伴奏与扩展控制事件不转换；各旋律轨先用钢琴音色。力度折合 GP 支持的记谱档位，歌词首尾空白由导入器规范化。

转换保留独立音轨、歌词、和弦及段落，跨小节与重叠长音用连音线保留时长。只导出选中音轨和现有歌词并轨功能继续适用。`.gp` 为 GP7/8 文件，不是 JSON 改扩展名。

维护验证：按本项目约定用真实文件请求接口，并回读生成的 GP 比较所有音符（合并连音线后）：

```sh
bun scripts/verify-song-gp.ts /path/to/source.gp.json /path/to/output.gp
```

《普通朋友》两种输入均已核对：86 小节、5 音轨、957 个音符的音高与起止 tick 一致，BPM 89；歌词内容一致（忽略首尾空白）。音高基准仍以试听确认为准。

独立 MuseScore 4 回读能打开全部 5 轨和 86 小节；其 GP 导入器会把结尾 LEAD 3 的一个 G3 长音（480 PPQ 下 161400–165120）拆成 161400–161520 与 161520–165120 两次起音。alphaTab 回读同一 GP 时该连音线完整。此项跨软件兼容性差异尚未在 Guitar Pro 桌面端试听确认。

歌曲 JSON 导出 GP 前会补齐标准调弦及弦号、品位，避免 Guitar Pro 将缺失调弦显示成六根 C-1。若弦品分配需要移调或无法容纳全部音符，转换会报错，不静默折叠音高。回读脚本同时校验调弦、弦品与 MIDI 音高一致；《普通朋友》修复版全部 957 音符通过，MuseScore 可渲染非静音 WAV。Guitar Pro 桌面端实际发声仍需试听确认。
