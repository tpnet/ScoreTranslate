import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import type { model } from "@coderline/alphatab";

const run = promisify(execFile);

// 各平台 MuseScore 4 安装包的默认位置，MSCORE_PATH 可覆盖
export const MSCORE =
  process.env.MSCORE_PATH ??
  (process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MuseScore 4", "bin", "MuseScore4.exe")
    : "/Applications/MuseScore 4.app/Contents/MacOS/mscore");
const TIMEOUT_MS = 120_000;

export const INPUT_EXTS = [
  "mid", "midi", "gp", "gpx", "gp3", "gp4", "gp5", "mxl", "musicxml", "xml", "json", "atex",
] as const;

export const OUTPUT_EXTS = ["mid", "musicxml", "xml", "mxl", "gp", "gp5", "json", "atex", "pdf", "png", "png-long", "mscz"] as const;
export type OutputExt = (typeof OUTPUT_EXTS)[number];

// gp 系输入转 MusicXML/GP 时不经过 MuseScore：MuseScore 的 MusicXML 导出会丢掉
// TAB 谱表、调弦和全部弦/品信息，alphaTab 直接解析 gp 模型可完整保留
const GP_INPUT_EXTS = ["gp", "gpx", "gp3", "gp4", "gp5"];
const XML_TARGETS = ["musicxml", "xml", "mxl"];

// 主版本号，null 表示没装（或路径不对）。项目依赖 MuseScore 4：--unroll-repeats
// 等开关是 4 才有的，mscz 也按 4 的格式写出。
// 成功结果缓存，失败不缓存——装好之后刷新页面即可生效，不用重启服务
let mscoreMajorCache: number | undefined;
export async function mscoreMajor(): Promise<number | null> {
  if (mscoreMajorCache !== undefined) return mscoreMajorCache;
  const major = await run(MSCORE, ["-v"], { timeout: 10_000 })
    .then((r) => Number(r.stdout.match(/(\d+)\./)?.[1]) || null)
    .catch(() => null);
  if (major !== null) mscoreMajorCache = major;
  return major;
}

export interface ConvertResult {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

// 各目标格式的导出配置。所有字段可选，缺省即原有默认行为。
// gp / gp5 / mscz 是全量结构转换，没有可配置项。
export interface ConvertOptions {
  /** png / png-long：导出分辨率 DPI（png 默认 360，png-long 默认 150） */
  dpi?: number;
  /** png / png-long：裁剪四周白边并保留指定像素边距 */
  trim?: number;
  /** mid：把反复记号展开为线性播放序列 */
  unrollRepeats?: boolean;
  /** pdf：纸张大小，缺省沿用原谱页面设置 */
  paper?: "a4" | "letter";
  /** pdf：谱面缩放百分比（50-200，100 为原始大小） */
  scale?: number;
  /**
   * MusicXML / pdf / png 目标的谱表类型：六线谱或标准五线谱。
   * 缺省时 gp 输入转 MusicXML 为 tab，其余走 MuseScore 原生行为；
   * 非 gp 来源选 tab 会自动推断调弦并指派弦品
   */
  staffMode?: "tab" | "standard";
  /** gp / gp5 / MusicXML / pdf / png：把人声轨歌词按时间对齐并入其他音轨（弹唱谱） */
  mergeLyrics?: boolean;
  /** 只导出这些音轨（下标同 listTracks 的返回顺序），缺省导出全部 */
  tracks?: number[];
}

// 只保留选中的音轨。不重排 index：gp-to-musicxml 用它拼 part id，
// alphaTab 的 stylesheet 也按原 index 索引
function filterTracks(score: model.Score, tracks?: number[]): void {
  if (!tracks?.length) return;
  const keep = score.tracks.filter((_, i) => tracks.includes(i));
  if (keep.length === 0) throw new Error("转换失败：选中的音轨不存在");
  score.tracks = keep;
}

// alphaTex 导出器只在 index 为 0 的音轨上写小节级信息（拍号、调号、速度、反复、段落），
// filterTracks 滤掉首轨后这些会全部丢失，所以导出前按现有顺序重排 index，
// 按 index 索引的 stylesheet 逐轨设置一并改键
function reindexTracks(score: model.Score): void {
  const to = new Map(score.tracks.map((t, i) => [t.index, i]));
  const rekey = <V>(m: Map<number, V> | null) =>
    m && new Map([...m].filter(([k]) => to.has(k)).map(([k, v]) => [to.get(k)!, v]));
  const ss = score.stylesheet;
  ss.perTrackDisplayTuning = rekey(ss.perTrackDisplayTuning);
  ss.perTrackChordDiagramsOnTop = rekey(ss.perTrackChordDiagramsOnTop);
  if (ss.perTrackMultiBarRest)
    ss.perTrackMultiBarRest = new Set([...ss.perTrackMultiBarRest].filter((k) => to.has(k)).map((k) => to.get(k)!));
  score.tracks.forEach((t, i) => (t.index = i));
}

// 找歌词拍最多的音轨作为来源，把每拍歌词对齐拷贝到其余音轨同小节最近的拍上。
// 幂等：目标拍原本就有歌词则跳过，重复调用不会叠加
function mergeLyricsAcrossTracks(score: model.Score): void {
  const lyricBeats = (t: model.Track) => {
    let n = 0;
    for (const s of t.staves) for (const b of s.bars) for (const v of b.voices) for (const bt of v.beats) if (bt.lyrics?.length) n++;
    return n;
  };
  let src: model.Track | null = null;
  let best = 0;
  for (const t of score.tracks) {
    const n = lyricBeats(t);
    if (n > best) { best = n; src = t; }
  }
  if (!src) return;

  const byBar = new Map<number, { start: number; text: string }[]>();
  for (const s of src.staves) for (const b of s.bars) for (const v of b.voices) for (const bt of v.beats) {
    if (!bt.lyrics?.length || !bt.lyrics[0]) continue;
    if (!byBar.has(b.index)) byBar.set(b.index, []);
    byBar.get(b.index)!.push({ start: bt.playbackStart, text: bt.lyrics[0] });
  }
  for (const t of score.tracks) {
    if (t === src) continue;
    for (const s of t.staves) for (const b of s.bars) {
      const entries = byBar.get(b.index);
      if (!entries) continue;
      const beats = b.voices
        .flatMap((v) => v.beats)
        .filter((bt) => !bt.isRest && (bt.graceType as number) === 0);
      if (beats.length === 0) continue;
      const written = new Set<model.Beat>();
      for (const e of entries) {
        let target = beats[0];
        for (const bt of beats) {
          if (Math.abs(bt.playbackStart - e.start) < Math.abs(target.playbackStart - e.start)) target = bt;
        }
        if (target.lyrics?.length && !written.has(target)) continue;
        // 人声比吉他密时多个音节落到同一拍，拼接显示
        if (written.has(target)) target.lyrics![0] += e.text;
        else {
          target.lyrics = [e.text];
          written.add(target);
        }
      }
    }
  }
}

// pdf 导出用的 MuseScore 样式文件，只写用户指定的字段
function buildMss(opts: ConvertOptions): string | null {
  const lines: string[] = [];
  if (opts.paper === "a4") lines.push("<pageWidth>8.27</pageWidth><pageHeight>11.69</pageHeight>");
  if (opts.paper === "letter") lines.push("<pageWidth>8.5</pageWidth><pageHeight>11</pageHeight>");
  if (opts.scale) lines.push(`<Spatium>${((1.74978 * opts.scale) / 100).toFixed(5)}</Spatium>`);
  if (lines.length === 0) return null;
  return `<?xml version="1.0" encoding="UTF-8"?><museScore version="4.70"><Style>${lines.join("")}</Style></museScore>`;
}

const CONTENT_TYPES: Record<string, string> = {
  mid: "audio/midi",
  musicxml: "application/vnd.recordare.musicxml+xml",
  xml: "application/vnd.recordare.musicxml+xml",
  mxl: "application/vnd.recordare.musicxml",
  gp: "application/octet-stream",
  gp5: "application/octet-stream",
  json: "application/json",
  atex: "text/plain; charset=utf-8",
  mscz: "application/x-musescore",
  pdf: "application/pdf",
  png: "image/png",
  zip: "application/zip",
};

async function mscore(inPath: string, outPath: string, extraArgs: string[] = []): Promise<void> {
  // MuseScore 4 无头模式完成转换后进程退出时可能崩溃（退出码非零但产物已生成），
  // 因此不看退出码，由调用方以产物是否存在判断成败
  await run(MSCORE, [inPath, "-o", outPath, ...extraArgs], { timeout: TIMEOUT_MS }).catch((e) => {
    if (e.code === "ENOENT") {
      throw new Error("未找到 mscore，可通过 MSCORE_PATH 环境变量指定路径");
    }
  });
}

// bytes 可以是 MusicXML 或任意 gp 系格式，ScoreLoader 自动识别
async function exportGpFamily(
  bytes: Uint8Array,
  target: "gp" | "gp5" | "json" | "atex",
  mergeLyrics = false,
  tracks?: number[],
): Promise<Uint8Array> {
  const alphaTab = await import("@coderline/alphatab");
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  if (mergeLyrics) mergeLyricsAcrossTracks(score);
  filterTracks(score, tracks);
  if (target === "gp5") {
    const { exportGp5 } = await import("./gp5-writer");
    return exportGp5(score);
  }
  if (target === "json") {
    return new TextEncoder().encode(alphaTab.model.JsonConverter.scoreToJson(score));
  }
  if (target === "atex") {
    reindexTracks(score);
    return new alphaTab.exporter.AlphaTexExporter().export(score, settings);
  }
  return new alphaTab.exporter.Gp7Exporter().export(score, settings);
}

// gp 系输入 → MusicXML 系目标：alphaTab 解析 + 自研序列化，保留 TAB/弦品
async function gpToXmlTarget(
  input: Uint8Array,
  target: OutputExt,
  baseName: string,
  staffMode: "tab" | "standard" = "tab",
  mergeLyrics = false,
  tracks?: number[],
): Promise<ConvertResult> {
  const alphaTab = await import("@coderline/alphatab");
  const { scoreToMusicXml } = await import("./gp-to-musicxml");
  let score;
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(input, new alphaTab.Settings());
  } catch {
    throw new Error("转换失败：无法解析该乐谱文件");
  }
  if (mergeLyrics) mergeLyricsAcrossTracks(score);
  filterTracks(score, tracks);
  // TAB 需要弦号品格；MusicXML/MIDI 来源没有，就地指派（GP 来源原样保留）
  if (staffMode === "tab") {
    const { ensureFingerings } = await import("./gp5-writer");
    ensureFingerings(score);
  }
  const xml = scoreToMusicXml(score, staffMode);
  if (target === "mxl") {
    const zip = new JSZip();
    // MusicXML 4.0 要求 mxl 的第一个条目是未压缩的 mimetype（JSZip 按插入顺序写出）
    zip.file("mimetype", "application/vnd.recordare.musicxml", { compression: "STORE" });
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`,
    );
    zip.file("score.xml", xml);
    const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { data, filename: `${baseName}.mxl`, contentType: CONTENT_TYPES.mxl };
  }
  return {
    data: new TextEncoder().encode(xml),
    filename: `${baseName}.${target}`,
    contentType: CONTENT_TYPES[target],
  };
}

async function scoreFromAlphaTabJson(input: Uint8Array): Promise<model.Score> {
  const alphaTab = await import("@coderline/alphatab");
  // alphaTab 1.8 的反序列化按全小写键做大小写敏感匹配，而旧版 alphaTab
  // 导出的是 camelCase 键（如 masterBars），会被整体跳过导致 finish 崩溃。
  // 递归把键转小写即可同时兼容新旧两种导出
  const lowerKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(lowerKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), lowerKeys(x)]))
        : v;
  try {
    const obj = lowerKeys(JSON.parse(new TextDecoder().decode(input)));
    return alphaTab.model.JsonConverter.jsObjectToScore(obj, new alphaTab.Settings());
  } catch {
    throw new Error("转换失败：无法解析该 alphaTab JSON");
  }
}

async function scoreFromAlphaTex(input: Uint8Array): Promise<model.Score> {
  const alphaTab = await import("@coderline/alphatab");
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(new TextDecoder().decode(input), new alphaTab.Settings());
  try {
    return importer.readScore();
  } catch {
    // alphaTex 多为手写或生成的文本，报出第一处错误的位置和原因，方便定位
    const d = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics]
      .flatMap((bag) => bag.errors)[0];
    if (!d) throw new Error("转换失败：无法解析该 alphaTex 文件");
    const at = d.start ? `第 ${d.start.line} 行第 ${d.start.col} 列` : "";
    // 部分诊断会列出全部候选值（如打击乐件名，数千字符），截断以免撑爆前端提示
    const msg = d.message.length > 150 ? `${d.message.slice(0, 150)}…` : d.message;
    throw new Error(`转换失败：alphaTex ${at}有误：${msg}`);
  }
}

// 列出音轨名供前端勾选。下标与 ConvertOptions.tracks 一致：解析链路和转换时
// 完全相同（gp 系由 alphaTab 直接解析，其余先经 MuseScore 桥接成 MusicXML）
export async function listTracks(input: Uint8Array, inputExt: string): Promise<string[]> {
  const alphaTab = await import("@coderline/alphatab");
  let score: model.Score;
  if (inputExt === "json") {
    score = await scoreFromAlphaTabJson(input);
  } else if (inputExt === "atex") {
    score = await scoreFromAlphaTex(input);
  } else {
    let bytes = input;
    if (!GP_INPUT_EXTS.includes(inputExt)) {
      const dir = await mkdtemp(path.join(tmpdir(), "score-"));
      try {
        const inPath = path.join(dir, `input.${inputExt}`);
        await writeFile(inPath, input);
        const outPath = path.join(dir, "bridge.musicxml");
        await mscore(inPath, outPath);
        bytes = await readFile(outPath).catch(() => {
          throw new Error("读取音轨失败：MuseScore 未能解析该文件");
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    try {
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
    } catch {
      throw new Error("读取音轨失败：无法解析该乐谱文件");
    }
  }
  return score.tracks.map((t, i) => t.name?.trim() || `音轨 ${i + 1}`);
}

const pageNo = (f: string) => Number(f.match(/-(\d+)\.png$/)![1]);

// 长图输出的像素上限（约 400MB RGBA）。A4 在默认 150 DPI 下约 2.2 百万像素/页，
// 够拼四十多页；1200 DPI 的单页就有 1.4 亿像素，会被挡下
const MAX_LONG_PIXELS = 100_000_000;

// 多页 PNG 纵向拼接为一张长图（页面宽度不同时左对齐）。
// MuseScore 导出的 PNG 是透明背景，深色背景的看图软件下黑色音符会"隐形"，
// 因此拼接时统一合成为不透明白底
async function stitchPngPages(pages: Buffer[]): Promise<Uint8Array> {
  // 拼接期间会同时持有全部页面和整张输出图的 RGBA 缓冲（每像素 4 字节），
  // 高 DPI 多页会直接打爆内存。先读 PNG 头（IHDR 的宽高在固定偏移 16/20）
  // 算出输出尺寸，超限就报错，避免解码后才 OOM
  const sizes = pages.map((p) => ({ width: p.readUInt32BE(16), height: p.readUInt32BE(20) }));
  const width = Math.max(...sizes.map((s) => s.width));
  const height = sizes.reduce((sum, s) => sum + s.height, 0);
  if (width * height > MAX_LONG_PIXELS) {
    throw new Error(
      `长图尺寸过大（${width}×${height} 像素，上限 ${MAX_LONG_PIXELS / 1e6} 百万像素），请降低 DPI 或减少页数`,
    );
  }

  const { PNG } = await import("pngjs");
  const decoded = pages.map((p) => PNG.sync.read(p));
  const out = new PNG({ width, height });
  out.data.fill(255);
  let y = 0;
  for (const p of decoded) {
    for (let row = 0; row < p.height; row++) {
      for (let x = 0; x < p.width; x++) {
        const si = (row * p.width + x) * 4;
        const a = p.data[si + 3] / 255;
        const di = ((y + row) * width + x) * 4;
        out.data[di] = p.data[si] * a + 255 * (1 - a);
        out.data[di + 1] = p.data[si + 1] * a + 255 * (1 - a);
        out.data[di + 2] = p.data[si + 2] * a + 255 * (1 - a);
      }
    }
    y += p.height;
  }
  return PNG.sync.write(out);
}

export async function convertScore(
  input: Uint8Array,
  inputExt: string,
  target: OutputExt,
  baseName: string,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  // alphaTab JSON / alphaTex 输入统一先转回 .gp 字节，之后完整复用 gp 系链路
  // （XML 目标走自研序列化，pdf/png/mid/mscz 由 MuseScore 读 .gp）
  if (inputExt === "json" || inputExt === "atex") {
    const alphaTab = await import("@coderline/alphatab");
    const settings = new alphaTab.Settings();
    const score = inputExt === "json" ? await scoreFromAlphaTabJson(input) : await scoreFromAlphaTex(input);
    if (options.mergeLyrics) mergeLyricsAcrossTracks(score);
    // 音轨过滤留给下游的 gp 链路：这里导出的 .gp 重新导入后下标会重排
    input = new alphaTab.exporter.Gp7Exporter().export(score, settings);
    inputExt = "gp";
  }

  const isGpInput = GP_INPUT_EXTS.includes(inputExt);

  // gp 系输入的 alphaTab 直连路径，不落盘、不经过 MuseScore
  if (isGpInput && XML_TARGETS.includes(target)) {
    return gpToXmlTarget(input, target, baseName, options.staffMode, options.mergeLyrics, options.tracks);
  }
  const isGpFamilyTarget = target === "gp" || target === "gp5" || target === "json" || target === "atex";
  if (isGpInput && isGpFamilyTarget) {
    const data = await exportGpFamily(input, target, options.mergeLyrics, options.tracks).catch((e) => {
      if (e instanceof Error && e.message.startsWith("转换失败：")) throw e;
      throw new Error("转换失败：无法解析该 Guitar Pro 文件");
    });
    return { data, filename: `${baseName}.${target}`, contentType: CONTENT_TYPES[target] };
  }

  const isRender = target === "pdf" || target === "png" || target === "png-long";

  // gp 输入渲染 pdf/png 时若指定了谱表类型，先经自研序列化器生成对应 MusicXML
  // 再交 MuseScore 渲染；不指定则 MuseScore 直接导入原文件
  if (isGpInput && isRender && options.staffMode) {
    const bridged = await gpToXmlTarget(input, "musicxml", baseName, options.staffMode, options.mergeLyrics, options.tracks);
    input = bridged.data;
    inputExt = "musicxml";
  } else if (isGpInput && options.tracks?.length) {
    // 剩下的 gp 输入目标（mid / mscz、以及谱表类型跟随原谱的 pdf/png）不能走
    // MusicXML 桥接（会改变渲染），改为用 alphaTab 重新导出只含选中音轨的 .gp
    input = await exportGpFamily(input, "gp", options.mergeLyrics, options.tracks);
    inputExt = "gp";
  }

  const dir = await mkdtemp(path.join(tmpdir(), "score-"));
  try {
    let inPath = path.join(dir, `input.${inputExt}`);
    await writeFile(inPath, input);

    // 非 gp 输入选择六线谱、或只导出部分音轨时：MuseScore 先桥接成 MusicXML，
    // 指派弦品 / 过滤音轨后重新序列化；XML 目标直接返回序列化结果，
    // pdf/png/mid/mscz 目标交回 MuseScore。
    // gp/gp5/json/atex 目标排除在外——它们下面有自己的桥接，会重复过滤一次
    if (
      !isGpInput &&
      !isGpFamilyTarget &&
      (options.staffMode === "tab" || options.tracks?.length)
    ) {
      const mode = options.staffMode ?? "standard";
      const bridgePath = path.join(dir, "bridge.musicxml");
      await mscore(inPath, bridgePath);
      const bridge = await readFile(bridgePath).catch(() => {
        throw new Error("转换失败：MuseScore 未能解析该文件");
      });
      if (XML_TARGETS.includes(target))
        return gpToXmlTarget(bridge, target, baseName, mode, options.mergeLyrics, options.tracks);
      const staged = await gpToXmlTarget(bridge, "musicxml", baseName, mode, options.mergeLyrics, options.tracks);
      inPath = path.join(dir, "staged.musicxml");
      await writeFile(inPath, staged.data);
    }

    if (isGpFamilyTarget) {
      // 非 gp 输入：MuseScore 统一转成 MusicXML，再导出：.gp 用 alphaTab 的
      // Gp7Exporter，.gp5 用自研 GP5 写出器，.json 用 alphaTab 的 JsonConverter，
      // .atex 用 alphaTab 的 AlphaTexExporter
      const xmlPath = path.join(dir, "bridge.musicxml");
      await mscore(inPath, xmlPath);
      const bridge = await readFile(xmlPath).catch(() => {
        throw new Error("转换失败：MuseScore 未能解析该文件");
      });
      const data = await exportGpFamily(bridge, target, options.mergeLyrics, options.tracks);
      return { data, filename: `${baseName}.${target}`, contentType: CONTENT_TYPES[target] };
    }

    // .xml 目标按 .musicxml 导出后改名，内容一致，避免依赖 mscore 对 .xml 后缀的识别
    const outExt = target === "xml" ? "musicxml" : target === "png-long" ? "png" : target;
    const outPath = path.join(dir, `output.${outExt}`);

    const args: string[] = [];
    if (target === "png" || target === "png-long") {
      // 长图默认 150 DPI：MuseScore 默认分辨率极高，多页拼接后像素量会到 GB 级，
      // 既拖慢编码又超出多数看图软件的渲染上限
      const dpi = options.dpi ?? (target === "png-long" ? 150 : undefined);
      if (dpi) args.push("-r", String(dpi));
      if (options.trim != null) args.push("-T", String(options.trim));
    }
    if (target === "mid" && options.unrollRepeats) args.push("--unroll-repeats");
    if (target === "pdf") {
      const mss = buildMss(options);
      if (mss) {
        const mssPath = path.join(dir, "style.mss");
        await writeFile(mssPath, mss);
        args.push("-S", mssPath);
      }
    }
    await mscore(inPath, outPath, args);

    if (target === "png" || target === "png-long") {
      // MuseScore 按页导出 output-1.png、output-2.png…，多页时打包为 zip
      const pages = (await readdir(dir))
        .filter((f) => /^output-\d+\.png$/.test(f))
        .sort((a, b) => pageNo(a) - pageNo(b));
      if (pages.length === 0) throw new Error("PNG 导出失败：未生成页面");
      if (target === "png-long") {
        // 单页也走拼接函数，统一合成白底
        const buffers = await Promise.all(pages.map((p) => readFile(path.join(dir, p))));
        return {
          data: await stitchPngPages(buffers),
          filename: `${baseName}.png`,
          contentType: CONTENT_TYPES.png,
        };
      }
      if (pages.length === 1) {
        return {
          data: await readFile(path.join(dir, pages[0])),
          filename: `${baseName}.png`,
          contentType: CONTENT_TYPES.png,
        };
      }
      const zip = new JSZip();
      for (const p of pages) {
        zip.file(`${baseName}-${pageNo(p)}.png`, await readFile(path.join(dir, p)));
      }
      const data = await zip.generateAsync({ type: "uint8array" });
      return { data, filename: `${baseName}.zip`, contentType: CONTENT_TYPES.zip };
    }

    const data = await readFile(outPath).catch(() => {
      throw new Error(`转换失败：MuseScore 未生成 ${target} 文件`);
    });
    return { data, filename: `${baseName}.${target}`, contentType: CONTENT_TYPES[target] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
