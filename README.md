# ScoreTranslate

简体中文 | [English](README.en.md)

本地乐谱格式转换 Web 工具：选择乐谱文件，转换为其它格式并下载。全程在本机完成，文件不上传到任何外部服务。

## 转换矩阵

| 输入 | 输出 |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.mscz` `.pdf` `.png` `.png` 长图 |

单文件上限 50MB。PNG 按页导出，多页时自动打包成 zip；「PNG 长图」把所有页纵向拼成单张图。

部分目标格式带导出选项：PNG 的 DPI 与裁边、PDF 的纸张与缩放、MIDI 的展开反复、MusicXML/PDF/PNG 的谱表类型（六线谱 / 五线谱）。

## 环境准备

需要 [bun](https://bun.sh) 和 [MuseScore 4](https://musescore.org)（转换引擎，需本机安装）。

MuseScore 默认读取路径为 macOS 的 `/Applications/MuseScore 4.app/Contents/MacOS/mscore`，其它系统或装在别处时用环境变量覆盖：

```bash
export MSCORE_PATH=/your/path/to/mscore
```

## 运行

```bash
bun install && bun run dev
```

打开 http://localhost:3000 。

## HTTP 接口

界面之外也可以直接调接口，`POST /api/convert` 接收 multipart 表单，字段为 `file` 和 `target`：

```bash
curl -O -J -F "file=@score.gp5" -F "target=pdf" http://localhost:3000/api/convert
```

成功返回文件流，文件名在 `Content-Disposition` 与 `X-Filename` 响应头里；失败返回 JSON `{"error": "..."}`。

导出选项作为可选表单字段传入，非法值直接忽略：`dpi`（50–1200）、`trim`（0–500 像素边距）、`scale`（50–200）、`paper`（`a4` / `letter`）、`staffMode`（`tab` / `standard`）、`unrollRepeats`（`1`）。

## 已知限制

**gp3 / gp4 / gpx 只能输入、不能输出。** 能打开 gp3/gp4 的软件都能打开 gp5，单独实现只服务于早已废弃的老版本软件；gpx 是 GP6 独有的 BCFZ 专有容器，GP6 已被官方放弃。`.gp` 输出为 Guitar Pro 7/8 格式（由 alphaTab 生成）。

**`.gp5` 输出为自研写出器生成**（开源生态无现成实现），保留音符、节奏、连音线、连音、力度、拍号调号、反复记号、调弦与变调夹，不保留演奏效果（推弦、滑音、泛音等）与和弦图。来源不是吉他谱时（MIDI / 钢琴 MusicXML），会按音域自动选择六弦吉他 / 七弦 / 贝斯调音并指派弦位品格，超出音域的音符按八度折叠；非 ASCII 的标题等元信息会降级为 `?`（GP5 格式的编码限制）。

**MIDI 转记谱格式的质量有天花板。** MIDI 不携带谱面信息（声部划分、连音线、临时记号的拼写），转换结果由 MuseScore 的量化算法推断，演奏录制的 MIDI 转出的谱子通常需要手工整理。这是格式本身的固有限制。

## 结构

- `lib/convert.ts` — 转换核心与路由；`.gp` / `.gp5` 目标经 MusicXML 桥接后导出
- `lib/gp5-writer.ts` — GP5 二进制写出器（含弦品指派算法）
- `lib/gp-to-musicxml.ts` — Guitar Pro 模型 → MusicXML 序列化器（保留 TAB 谱表与弦品信息）
- `app/api/convert/route.ts` — 转换接口，负责校验与文件流响应
- `app/page.tsx` — 上传 / 选择目标格式 / 下载的单页界面

## 许可证

[MIT](LICENSE)
