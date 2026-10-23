import JSZip from "jszip";
import { songJsonToXml } from "./song-json";
import type { model } from "@coderline/alphatab";
import { CONTENT_TYPES, type ConvertOptions, type ConvertResult, type OutputExt, type Render } from "./formats";

const GP_INPUT_EXTS = ["gp", "gpx", "gp3", "gp4", "gp5"];
const XML_TARGETS = ["musicxml", "xml", "mxl"];

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

// Guitar Pro 自己写的和弦 ID 都是数字，MuseScore 读 .gp 时也按数字解析；而 alphaTex 来源的
// ID 是 "c00" 这类名字编码、gp5 来源的是 GUID，全被解析成 0，所有和弦都显示成第一个。
// 所以按谱表（写出器按谱表写和弦集合）把 ID 重排成 "0"、"1"……
// 引用不区分大小写匹配：有的外部工具生成的 .gp，定义用小写 ID、引用却用和弦原名；
// 仍对不上的引用清空，否则 MuseScore 会把它当成 0 号和弦显示
function normalizeChordIds(score: model.Score): void {
  for (const t of score.tracks) for (const st of t.staves) {
    const chords = [...(st.chords ?? [])];
    const to = new Map(chords.map(([k], i) => [k.toLowerCase(), String(i)]));
    if (chords.length) st.chords = new Map(chords.map(([, c], i) => [String(i), c]));
    for (const b of st.bars) for (const v of b.voices) for (const bt of v.beats)
      if (bt.chordId) bt.chordId = to.get(bt.chordId.toLowerCase()) ?? null;
  }
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
  normalizeChordIds(score);
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
  staffMode: "tab" | "standard" | "original" = "tab",
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
  normalizeChordIds(score);
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

async function scoreFromAlphaTabJson(input: Uint8Array, options: ConvertOptions = {}, title = "歌曲"): Promise<model.Score> {
  const alphaTab = await import("@coderline/alphatab");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input));
  } catch {
    throw new Error("转换失败：无法解析该 JSON");
  }
  const xml = songJsonToXml(parsed, options, title);
  if (xml) {
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), new alphaTab.Settings());
    // 歌曲 JSON 只有 MIDI 音高，MusicXML 导入不会提供调弦和弦品。
    // 必须在首次 GP 序列化前补齐，否则 GP 桌面端会显示六根 C-1 并无法正常播放。
    const notes = score.tracks.flatMap(t => t.staves.flatMap(st => st.bars.flatMap(b =>
      b.voices.flatMap(v => v.beats.flatMap(bt => bt.notes)))));
    const pitches = notes.map(n => n.realValue);
    const { ensureFingerings } = await import("./gp5-writer");
    ensureFingerings(score);
    // 现有弦品算法允许八度折叠；歌曲 JSON 不可静默移调或丢音，放不下时明确报错。
    if (notes.some((n, i) => n.string < 1 || n.fret < 0 || n.realValue !== pitches[i])) {
      throw new Error("歌曲音域或同时发声音数超出当前弦品范围，无法无损导出 GP");
    }
    return score;
  }
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
    const obj = lowerKeys(parsed);
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
export async function listTracks(input: Uint8Array, inputExt: string, render: Render): Promise<string[]> {
  const alphaTab = await import("@coderline/alphatab");
  let score: model.Score;
  if (inputExt === "json") {
    score = await scoreFromAlphaTabJson(input);
  } else if (inputExt === "atex") {
    score = await scoreFromAlphaTex(input);
  } else {
    let bytes = input;
    if (!GP_INPUT_EXTS.includes(inputExt)) {
      bytes = await render(input, { inputExt, target: "musicxml" }).catch(() => {
        throw new Error("读取音轨失败：MuseScore 未能解析该文件");
      });
    }
    try {
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
    } catch {
      throw new Error("读取音轨失败：无法解析该乐谱文件");
    }
  }
  return score.tracks.map((t, i) => t.name?.trim() || `音轨 ${i + 1}`);
}

export async function convertScore(
  input: Uint8Array,
  inputExt: string,
  target: OutputExt,
  baseName: string,
  options: ConvertOptions,
  render: Render,
): Promise<ConvertResult> {
  // alphaTab JSON / alphaTex 输入统一先转回 .gp 字节，之后完整复用 gp 系链路
  // （XML 目标走自研序列化，pdf/png/mid/mscz 由 MuseScore 读 .gp）
  if (inputExt === "json" || inputExt === "atex") {
    const alphaTab = await import("@coderline/alphatab");
    const settings = new alphaTab.Settings();
    const score = inputExt === "json" ? await scoreFromAlphaTabJson(input, options, baseName) : await scoreFromAlphaTex(input);
    if (options.mergeLyrics) mergeLyricsAcrossTracks(score);
    normalizeChordIds(score);
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

  // 非 GP 输入的桥接与选轨沿用同一条链路，平台适配只负责 MuseScore。
  if (!isGpInput && !isGpFamilyTarget && (options.staffMode === "tab" || options.tracks?.length)) {
    const bridge = await render(input, { inputExt, target: "musicxml" });
    const mode = options.staffMode ?? "standard";
    if (XML_TARGETS.includes(target))
      return gpToXmlTarget(bridge, target, baseName, mode, options.mergeLyrics, options.tracks);
    const staged = await gpToXmlTarget(bridge, "musicxml", baseName, mode, options.mergeLyrics, options.tracks);
    input = staged.data;
    inputExt = "musicxml";
  }

  if (isGpFamilyTarget) {
    const bridge = await render(input, { inputExt, target: "musicxml" });
    const data = await exportGpFamily(bridge, target, options.mergeLyrics, options.tracks);
    return { data, filename: `${baseName}.${target}`, contentType: CONTENT_TYPES[target] };
  }

  const request = {
    inputExt,
    target,
    dpi: options.dpi ?? (target === "png-long" ? 150 : undefined),
    trim: options.trim,
    unrollRepeats: options.unrollRepeats,
    style: target === "pdf" ? buildMss(options) ?? undefined : undefined,
  };
  let data: Uint8Array;
  try {
    data = await render(input, request);
  } catch (e) {
    // MuseScore 的 GP 导入器遇到跨小节音符可能失败，MusicXML 可正常读取。
    if (!isGpInput || target !== "pdf" || options.staffMode) throw e;
    const bridge = await gpToXmlTarget(input, "musicxml", baseName, "original", options.mergeLyrics);
    data = await render(bridge.data, { ...request, inputExt: "musicxml" });
  }

  if (target === "png" && data[0] === 0x50 && data[1] === 0x4b) {
    const source = await JSZip.loadAsync(data);
    const zip = new JSZip();
    for (const [name, page] of Object.entries(source.files)) {
      const n = name.match(/^output-(\d+)\.png$/)?.[1];
      if (n) zip.file(`${baseName}-${n}.png`, await page.async("uint8array"));
    }
    data = await zip.generateAsync({ type: "uint8array" });
    return { data, filename: `${baseName}.zip`, contentType: CONTENT_TYPES.zip };
  }
  const ext = target === "png-long" ? "png" : target;
  return { data, filename: `${baseName}.${ext}`, contentType: CONTENT_TYPES[ext] };
}
