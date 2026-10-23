# ScoreTranslate

简体中文 | [English](README.en.md) · [官网](https://tpnet.github.io/ScoreTranslate/) · [下载桌面版](https://github.com/tpnet/ScoreTranslate/releases)

乐谱格式转换工具，支持 Guitar Pro、MusicXML、MIDI、歌曲 JSON 等格式互转，以及 PDF、PNG 导出。

桌面版在本机完成转换；Web 版由配套服务器处理文件，本机部署时文件不会上传到外部服务。前端使用 React + Vite，Web 服务使用 Bun，桌面版使用 Tauri；两端共用 TypeScript 转换核心，无数据库。

[支持的格式](#支持的格式) · [快速开始](#快速开始) · [歌曲 JSON 转 Guitar Pro](#歌曲-json-转-guitar-pro) · [HTTP 接口](#http-接口) · [开发与验证](#开发与验证) · [已知限制](#已知限制)

## 支持的格式

| 类型 | 输入 | 输出 |
| --- | --- | --- |
| Guitar Pro | `.gp` `.gpx` `.gp3` `.gp4` `.gp5` | `.gp`（GP7/8） `.gp5`（GP5 v5.00） |
| MusicXML | `.musicxml` `.xml` `.mxl` | `.musicxml` `.xml` `.mxl` |
| MIDI | `.mid` `.midi` | `.mid` |
| JSON | LL 原始歌曲详情、二维 GP 时间线、alphaTab 乐谱模型 | alphaTab 乐谱模型 `.json` |
| alphaTex | `.atex` | `.atex` |
| MuseScore / 文档 / 图片 | — | `.mscz` `.pdf` `.png`、PNG 长图 |

单文件上限 **50 MB**。`.json` 输出统一为 [alphaTab](https://alphatab.net) 乐谱模型，不会写回 LL 或二维时间线结构；[alphaTex](https://alphatab.net/docs/alphatex/syntax) 是可手写的文本谱格式，语法错误会提示行列。

可按需选择音轨，并配置以下导出选项：

| 目标 | 选项 |
| --- | --- |
| 全部格式 | 只导出选中的音轨 |
| MusicXML / PDF / PNG | 六线谱或五线谱 |
| PDF | 纸张大小、谱面缩放；谱表类型也可跟随原谱 |
| PNG / PNG 长图 | DPI、裁边；谱表类型也可跟随原谱 |
| MIDI | 展开反复记号 |
| GP / GP5 / MusicXML / PDF / PNG | 歌词并轨，将人声轨歌词按时间对齐到其他音轨 |

PNG 单页返回图片，多页自动打包为 ZIP；PNG 长图将各页纵向拼接，超过 **1 亿像素**时会报错，可降低 DPI 后重试。

## 快速开始

### 桌面版

从 [Releases](https://github.com/tpnet/ScoreTranslate/releases) 下载对应平台的文件：

| 平台 | 安装包 / 运行要求 |
| --- | --- |
| macOS Apple Silicon / Intel | 对应架构的 DMG，macOS 13 及以上 |
| Windows x64 | `ScoreTranslate_<版本>_x64-setup.exe` 安装版，或 `ScoreTranslate_<版本>_x64-portable.exe` 免安装版；免安装版需系统已有 WebView2 Runtime |

桌面版无需安装 Bun 或 Node.js，也不启动本地 HTTP 服务。**MuseScore 4 需单独安装**；未安装时，Guitar Pro / JSON / alphaTex 之间互转及导出 MusicXML 仍可用，其余转换需要 MuseScore。

应用未做正式开发者签名与公证。首次打开如被系统拦截：

- macOS：在「系统设置 → 隐私与安全性」选择「仍要打开」。
- Windows：在 SmartScreen 提示中选择「更多信息 → 仍要运行」。

### 本地运行 Web 版

安装 [Bun](https://bun.sh) 和 [MuseScore 4](https://musescore.org)，在项目目录执行：

```bash
bun install
bun run dev
```

打开 [http://localhost:3000](http://localhost:3000)。开发模式由 Vite 提供页面，`/api` 代理到本机 `3001` 端口的 Bun API。

### 生产部署

```bash
bun run build
bun run start
```

Bun 同时提供 `dist/` 静态页面和转换 API，默认监听 `127.0.0.1:3000`。远程部署时显式设置 `HOSTNAME` / `PORT`，并配置 HTTPS 反向代理。MuseScore 安装在服务器上，用户浏览器无需安装；仅部署 `dist/` 静态文件不能提供完整转换能力。

### MuseScore 路径配置

Web 和桌面版共用以下默认查找位置：

| 系统 | 默认路径 |
| --- | --- |
| macOS | `/Applications/MuseScore 4.app/Contents/MacOS/mscore` |
| Windows | `%ProgramFiles%\MuseScore 4\bin\MuseScore4.exe` |
| 其他系统 | 在 `PATH` 中查找 `mscore` |

安装在其他位置时，在启动服务或应用的环境中设置 `MSCORE_PATH`，指向 MuseScore 4 可执行文件。例如在 macOS / Linux 终端中：

```bash
export MSCORE_PATH="/your/path/to/mscore"
```

## 歌曲 JSON 转 Guitar Pro

上传歌曲 JSON，目标选择 **Guitar Pro (.gp)**，即可生成 GP7/8 文件。支持两种歌曲输入：

| 输入 | 元数据与速度 | 音高设置 |
| --- | --- | --- |
| LL 原始歌曲详情 `lyrics-*.json` | 自动读取标题、作者与 BPM；目前仅支持 4/4 拍 | 默认 `note=1, upOctave=0` 对应 C4（MIDI 60），不叠加 `tone/leadNote` |
| 二维 GP 时间线 `*.gp.json` | 不含速度元数据，默认 120 BPM；请填写原曲速度 | 已包含 MIDI 音高，不再应用八度设置 |

仅含文件索引的 `song.json` 不受支持。在界面「歌曲速度 BPM」或 HTTP 字段 `jsonTempo` 中可覆盖两种输入的速度（20–400 BPM）。如果原始详情试听相差八度，可在「原始谱八度」选择 C3 / C4 / C5，对应 HTTP `jsonMiddleC=48/60/72`。

转换保留独立音轨、歌词、和弦与段落，跨小节及重叠长音用连音线保留时长；可继续使用选轨和歌词并轨。导出前会补齐调弦、弦号与品位，若无法容纳全部音符或必须改变音高，转换会报错。

设备音色、自动伴奏与扩展控制事件不转换，各旋律轨先使用钢琴音色。力度折合 GP 支持的记谱档位，歌词首尾空白由导入器规范化。跨软件播放差异见[已知限制](#已知限制)。

## HTTP 接口

以下接口由 Web 版提供，先启动开发或生产服务。

### 转换文件

`POST /api/convert` 接收 multipart 表单，必填字段为 `file` 和 `target`：

```bash
curl -f -O -J \
  -F "file=@score.gp5" \
  -F "target=pdf" \
  http://localhost:3000/api/convert
```

`target` 可选值：`mid`、`musicxml`、`xml`、`mxl`、`gp`、`gp5`、`json`、`atex`、`mscz`、`pdf`、`png`、`png-long`。

成功返回文件流，文件名见 `Content-Disposition`，也可对 `X-Filename` 响应头进行 URL 解码获取；PNG 多页时实际返回 `.zip`。失败返回非 2xx 状态和 JSON `{"error":"..."}`。

可选表单字段如下；只对适用的输入或目标生效：

| 字段 | 取值 | 用途 |
| --- | --- | --- |
| `tracks` | 从 0 开始的音轨下标，逗号分隔，如 `0,2` | 全部目标；缺省导出全部，下标由 `/api/tracks` 获取 |
| `dpi` | 50–1200 | PNG 分辨率；普通 PNG 默认 360，长图默认 150 |
| `trim` | 0–500 | PNG 裁边后保留的像素边距 |
| `paper` | `a4` / `letter` | PDF 纸张大小；缺省沿用原谱 |
| `scale` | 50–200 | PDF 谱面缩放百分比；100 为原始大小 |
| `staffMode` | `tab` / `standard` | MusicXML / PDF / PNG 的六线谱或五线谱；PDF / PNG 缺省跟随原谱，Guitar Pro 系输入转 MusicXML 缺省为六线谱 |
| `unrollRepeats` | `1` | MIDI 展开反复 |
| `mergeLyrics` | `1` | GP / GP5 / MusicXML / PDF / PNG 歌词并轨 |
| `jsonTempo` | 20–400 | 覆盖歌曲 JSON 的 BPM |
| `jsonMiddleC` | 0–120 中的 C 音 MIDI 值（12 的倍数） | LL 原始详情的八度基准，默认 60；常用 48 / 60 / 72，二维时间线不受影响 |

数值字段会四舍五入并限制在上述范围内；空值或无法解析的数值、无效枚举值会忽略。`jsonMiddleC` 经范围处理后若不是 C 音，LL 导入会报错。

### 读取音轨

`POST /api/tracks` 接收 `file` 字段，返回 `{"tracks":["音轨名", "..."]}`，数组顺序对应 `tracks` 的下标：

```bash
curl -f -F "file=@score.gp5" http://localhost:3000/api/tracks
```

### 检查转换引擎

`GET /api/status` 返回 `{"path":"MuseScore 可执行文件路径","major":4}`；未检测到版本时 `major` 为 `null`。

## 开发与验证

### 常用命令

```bash
bun run build            # TypeScript 检查 + Vite 静态构建
bun run verify           # Web HTTP 真实文件回归，需要 MuseScore 4
bun run verify --native  # 同一组用例验证 Rust 路径，自动构建原生校验入口
bun tauri dev            # 桌面开发窗口，需要 Rust 工具链
bun tauri build          # 构建当前平台桌面包，需要 Rust 工具链
```

桌面构建需安装 [Rust](https://rustup.rs) 及对应平台的 Tauri 构建依赖，先执行 `bun install`。产物位于 `src-tauri/target/release/bundle/`，macOS DMG 在 `dmg/`，Windows 安装包在 `nsis/`。

`desktop` GitHub Actions 工作流支持手动构建 macOS Apple Silicon、macOS Intel 和 Windows x64 产物；发布 Release 时自动构建并上传安装包及 Windows 免安装版。手动运行只保存 Actions 产物。发布前同步更新项目版本号，Release 标签使用对应的 `v<版本>`。

回归覆盖全部输出格式、选轨、TAB、歌曲 JSON / alphaTab JSON / alphaTex、MIDI / MusicXML 桥接、多页 PNG 与长图、GP5 双解析器回读及错误输入，使用真实文件与 MuseScore，无 mock 转换引擎。

二维 GP 时间线转 GP 后，还可运行专项回读，比较音高、起止 tick、歌词、和弦及调弦弦品；检查完整音轨时不要启用选轨或歌词并轨：

```bash
bun scripts/verify-song-gp.ts /path/to/source.gp.json /path/to/output.gp
```

### 项目结构

| 路径 | 职责 |
| --- | --- |
| `lib/convert.ts` | 共用转换核心、路由与音轨过滤 |
| `lib/song-json.ts` | LL / 二维 GP 时间线 JSON 输入适配 |
| `lib/gp5-writer.ts` | GP5 二进制写出、调弦与弦品指派 |
| `lib/gp-to-musicxml.ts` | 保留 TAB 谱表与弦品信息的 MusicXML 序列化器 |
| `lib/formats.ts` / `lib/request.ts` | 格式定义、导出参数与上传校验 |
| `src/App.tsx` | 上传、格式与选项选择、下载界面 |
| `src/platform.ts` / `src/convert.worker.ts` | Web HTTP / 桌面 IPC 入口与桌面后台转换 |
| `server/` | Bun HTTP 服务、转换 / 音轨接口与 MuseScore / PNG 适配 |
| `src-tauri/` | 静态前端打包、Rust 原生命令与 MuseScore / PNG / ZIP 适配 |
| `scripts/` | 开发启动与真实文件校验 |

Guitar Pro 系输入（JSON / alphaTex 先转为 GP）通过 alphaTab 直接解析，转 MusicXML 时使用自研序列化器保留 TAB、调弦和弦品。其余转换由 MuseScore 4 解析或渲染；非 GP 输入导出 GP / GP5 / alphaTex 时先桥接为 MusicXML。

PDF 选择「跟随原谱」时，若 MuseScore 无法直接从 Guitar Pro 生成 PDF，会经 MusicXML 重试，保留原谱五线谱 / 六线谱显示设置。桌面版在 Worker 中执行共用核心，Rust 负责 MuseScore 与文件操作。

## 已知限制

- **旧格式只读**：`.gp3` / `.gp4` / `.gpx` 仅支持输入；`.gp` 输出为 GP7/8，`.gp5` 输出为 GP5 v5.00。
- **GP5 有格式与编码限制**：自研写出器保留音符、节奏、连音线、连音、力度、拍号调号、反复、调弦、变调夹及推弦、击勾弦、滑音、泛音、闷音、颤音等演奏效果；不保留和弦图，GP5 无法表达的效果会降级或跳过。非 ASCII 标题、歌词等文本降级为 `?`，中文歌词建议导出 MusicXML / PDF / PNG。MIDI 或钢琴 MusicXML 转 GP5 时会自动选择调弦并指派弦品，超出音域的音符可能按八度折叠；歌曲 JSON 路径会在音高改变时直接报错。
- **MIDI 与识别谱需要人工校正**：MIDI 不携带声部、连音线、临时记号拼写等谱面信息，MuseScore 需通过量化推断；演奏录制的 MIDI、自动识别草稿中的时值与记谱仍需对照原谱整理。
- **歌曲 JSON 的跨软件播放仍需确认**：历史样本《普通朋友》的 alphaTab 回读保留了全部 957 个音符的音高与起止时间，但 MuseScore 4 回读时会将结尾一处连音长音拆成两次起音。Guitar Pro 桌面端的实际发声与连音效果尚未人工试听确认。

## 许可证

[MIT](LICENSE)
