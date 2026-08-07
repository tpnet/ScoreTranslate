# CLAUDE.md

乐谱格式转换 Web 工具。bun + Next.js 15 App Router，无数据库、无状态，转换在请求内同步完成。

## 命令

```bash
bun run dev     # 开发服务器，localhost:3000
bun run build   # 生产构建（改完转换逻辑后跑一次，确保类型和打包没问题）
```

⚠️ 两者共用 `.next` 目录，`build` 会覆盖 dev server 的产物，导致运行中的 dev server 报 `ENOENT ... route.js` 并对所有请求返回 500。**不要在 dev server 运行时跑 build**；若已发生，`rm -rf .next` 后重启 dev server。

## 结构

- `lib/convert.ts` — 转换核心与路由
- `lib/gp5-writer.ts` — GP5 v5.00 二进制写出器 + 弦品指派算法
- `lib/gp-to-musicxml.ts` — alphaTab 乐谱模型 → MusicXML 序列化器（保留 TAB/弦品）
- `app/api/convert/route.ts` — multipart 上传，校验后返回文件流
- `app/page.tsx` — 单页界面

## 转换链路

分两条路径：

- **gp 系输入（gp/gpx/gp3/gp4/gp5）→ MusicXML 系 / gp / gp5**：alphaTab 直接解析原文件，不经过 MuseScore。MusicXML 由 `gp-to-musicxml.ts` 自研序列化——因为 MuseScore 的 MusicXML 导出会丢掉 TAB 谱表、调弦和全部弦/品信息。写 MusicXML 时**用实际发声音高、不写 `<transpose>` 八度声明**：MuseScore 4 导入时忽略该声明，按吉他记谱惯例写高八度会导致品位整体上移 12 品（曾实测踩坑）。
- **其余转换**：MuseScore 4 CLI 负责解析和导出（mid/pdf/png/mscz 及非 gp 输入）。非 gp 输入转 `.gp` / `.gp5` 走两段：MuseScore 先转 MusicXML，`.gp` 由 alphaTab 的 `Gp7Exporter` 写出，`.gp5` 由自研写出器写出。

导出配置见 `ConvertOptions`（lib/convert.ts）：png 的 DPI/裁边走 `-r`/`-T`，pdf 的纸张/缩放走 `-S` 临时样式文件，mid 展开反复走 `--unroll-repeats`，MusicXML/pdf/png 目标的谱表类型（TAB/五线谱）由自研序列化器处理：gp 输入直接解析；非 gp 输入选 TAB 时先由 MuseScore 桥接成 MusicXML、`ensureFingerings` 指派弦品后重新序列化；pdf/png 最后交回 MuseScore 渲染。这些是 MuseScore CLI 仅有的相关开关，别的"配置项"CLI 不支持，gp/gp5/mscz 转换本身无参数。

## GP5 写出器（lib/gp5-writer.ts）

- 字节布局逐字段**镜像 alphaTab 的 `Gp3To5Importer`**（node_modules/@coderline/alphatab/dist/alphaTab.core.mjs 中搜 `Gp3To5Importer`）的 v5.00 读取分支。改字段顺序前必须对照该解析器，任何一个字节错位都会毁掉整个文件的后续解析。
- 验证方式是**双解析器回读**：alphaTab 重新导入逐拍比对 + MuseScore 转回 MusicXML 比对音高序列。两个独立实现都读对才算对，改动后两条都要跑。
- MusicXML/MIDI 来源的音符没有弦号品格（`note.string === -1`），由 `assignBeat` 贪心指派；alphaTab 的 MusicXML 导入还会把标题中的空格变成 U+00A0，`ascii()` 已处理。
- 不写出演奏效果（beat/note effects 的 flag 位保持 0），这是刻意的范围裁剪，加效果前先确认真的有人需要。
- **每个 `(track, staff)` 展开成一个独立 GP5 音轨**（`expandStaves`）。GP5 格式没有"多谱表音轨"的概念，钢琴大谱表的原生表示就是拆成两个音轨；多谱表时音轨名加 `(1)` `(2)` 后缀，与 `gp-to-musicxml.ts` 的分 part 规则一致。只取 `staves[0]` 会静默丢掉左手声部。
- **声部要按"非空优先"取，不能按下标取。** GP5 每小节固定 2 个声部，而 alphaTab 的声部下标沿用来源编号——MuseScore 导出的大谱表下谱表用 `<voice>5</voice>`，落到下标 4，下标 0–3 是空占位。直接取 `voices[0]`/`voices[1]` 会全取到空的。

## 改动时必须知道的三件事

**1. 不能用退出码判断 MuseScore 成败。** MuseScore 4 无头转换成功后，进程退出阶段会崩溃（`mutex lock failed`），退出码非零但产物已正常生成。`mscore()` 因此吞掉除 `ENOENT` 外的所有错误，改由调用方检查产物文件是否存在。如果给它加上退出码检查，所有转换都会失败。

**2. PNG 是多文件输出。** MuseScore 把 `-o output.png` 展开成 `output-1.png`、`output-2.png`……单页直接返回 PNG，多页打包成 zip，所以返回的扩展名和用户选的目标格式不一定一致——前端靠响应头 `X-Filename` 拿真实文件名，不要假设它等于目标格式。

`png-long` 拼接期间同时持有全部页面和整张输出图的 RGBA 缓冲，因此先读各页 PNG 头（IHDR 宽高在固定偏移 16/20）算出总尺寸，超过 `MAX_LONG_PIXELS`（1 亿像素）直接报错——否则 1200 DPI 的单页 A4 就有 1.4 亿像素，解码后必然 OOM。

`Content-Disposition` 同时给出 `filename=`（非 ASCII 字符替换为下划线）和 `filename*=UTF-8''`，两者缺一不可：浏览器用后者拿到中文原名，而 `curl -J` 只认前者，只给 `filename*=` 会导致 curl 存不下文件。

**3. gp3 / gp4 / gpx 只能读不能写。** 这三种旧版 Guitar Pro 格式在开源生态里没有可靠的写出实现，`OUTPUT_EXTS` 里不包含它们，这是刻意的。不要因为它们出现在 `INPUT_EXTS` 里就"补齐"输出（gp5 是例外，有自研写出器）。

## 验证方式

本项目不写 JVM/单元测试，改完转换逻辑用 curl 打真实文件验证：

```bash
curl -s -o out.pdf -w "%{http_code}\n" -F "file=@score.musicxml" -F "target=pdf" http://localhost:3000/api/convert && file out.pdf
```

`file` 命令能确认产物是不是有效格式——转换失败时接口返回 JSON，`file` 会显示 `JSON data` 而不是预期的类型。

## 环境依赖

MuseScore 4 需本机安装，默认读 `/Applications/MuseScore 4.app/Contents/MacOS/mscore`，可用 `MSCORE_PATH` 覆盖。当前开发机版本 4.7.4。
