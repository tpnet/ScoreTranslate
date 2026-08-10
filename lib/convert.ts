import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const run = promisify(execFile);

const MSCORE =
  process.env.MSCORE_PATH ?? "/Applications/MuseScore 4.app/Contents/MacOS/mscore";
const TIMEOUT_MS = 120_000;

export const INPUT_EXTS = [
  "mid", "midi", "gp", "gpx", "gp3", "gp4", "gp5", "mxl", "musicxml", "xml",
] as const;

export const OUTPUT_EXTS = ["mid", "musicxml", "xml", "mxl", "gp", "gp5", "pdf", "png", "png-long", "mscz"] as const;
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
async function exportGpFamily(bytes: Uint8Array, target: "gp" | "gp5"): Promise<Uint8Array> {
  const alphaTab = await import("@coderline/alphatab");
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  if (target === "gp5") {
    const { exportGp5 } = await import("./gp5-writer");
    return exportGp5(score);
  }
  return new alphaTab.exporter.Gp7Exporter().export(score, settings);
}

// gp 系输入 → MusicXML 系目标：alphaTab 解析 + 自研序列化，保留 TAB/弦品
async function gpToXmlTarget(
  input: Uint8Array,
  target: OutputExt,
  baseName: string,
  staffMode: "tab" | "standard" = "tab",
): Promise<ConvertResult> {
  const alphaTab = await import("@coderline/alphatab");
  const { scoreToMusicXml } = await import("./gp-to-musicxml");
  let score;
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(input, new alphaTab.Settings());
  } catch {
    throw new Error("转换失败：无法解析该乐谱文件");
  }
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
  const isGpInput = GP_INPUT_EXTS.includes(inputExt);

  // gp 系输入的 alphaTab 直连路径，不落盘、不经过 MuseScore
  if (isGpInput && XML_TARGETS.includes(target)) {
    return gpToXmlTarget(input, target, baseName, options.staffMode);
  }
  if (isGpInput && (target === "gp" || target === "gp5")) {
    const data = await exportGpFamily(input, target).catch(() => {
      throw new Error("转换失败：无法解析该 Guitar Pro 文件");
    });
    return { data, filename: `${baseName}.${target}`, contentType: CONTENT_TYPES[target] };
  }

  // gp 输入渲染 pdf/png 时若指定了谱表类型，先经自研序列化器生成对应 MusicXML
  // 再交 MuseScore 渲染；不指定则 MuseScore 直接导入原文件
  if (isGpInput && (target === "pdf" || target === "png" || target === "png-long") && options.staffMode) {
    const bridged = await gpToXmlTarget(input, "musicxml", baseName, options.staffMode);
    input = bridged.data;
    inputExt = "musicxml";
  }

  const dir = await mkdtemp(path.join(tmpdir(), "score-"));
  try {
    let inPath = path.join(dir, `input.${inputExt}`);
    await writeFile(inPath, input);

    // 非 gp 输入选择六线谱时：MuseScore 先桥接成 MusicXML，指派弦品后按 TAB
    // 重新序列化；XML 目标直接返回序列化结果，pdf/png 目标交回 MuseScore 渲染
    if (
      !isGpInput &&
      options.staffMode === "tab" &&
      (XML_TARGETS.includes(target) || target === "pdf" || target === "png" || target === "png-long")
    ) {
      const bridgePath = path.join(dir, "bridge.musicxml");
      await mscore(inPath, bridgePath);
      const bridge = await readFile(bridgePath).catch(() => {
        throw new Error("转换失败：MuseScore 未能解析该文件");
      });
      if (XML_TARGETS.includes(target)) return gpToXmlTarget(bridge, target, baseName, "tab");
      const tab = await gpToXmlTarget(bridge, "musicxml", baseName, "tab");
      inPath = path.join(dir, "tab.musicxml");
      await writeFile(inPath, tab.data);
    }

    if (target === "gp" || target === "gp5") {
      // 非 gp 输入：MuseScore 统一转成 MusicXML，再导出 Guitar Pro：
      // .gp 用 alphaTab 的 Gp7Exporter，.gp5 用自研的 GP5 二进制写出器
      const xmlPath = path.join(dir, "bridge.musicxml");
      await mscore(inPath, xmlPath);
      const bridge = await readFile(xmlPath).catch(() => {
        throw new Error("转换失败：MuseScore 未能解析该文件");
      });
      const data = await exportGpFamily(bridge, target);
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
