import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import type { MuseScoreStatus, Render } from "../lib/formats";

const run = promisify(execFile);
export const MSCORE = process.env.MSCORE_PATH ?? (process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MuseScore 4", "bin", "MuseScore4.exe")
  : process.platform === "darwin" ? "/Applications/MuseScore 4.app/Contents/MacOS/mscore" : "mscore");
let majorCache: number | undefined;
export async function mscoreStatus(): Promise<MuseScoreStatus> {
  if (majorCache !== undefined) return { path: MSCORE, major: majorCache };
  const major = await run(MSCORE, ["-v"], { timeout: 10_000 })
    .then(r => Number(r.stdout.match(/(\d+)\./)?.[1]) || null).catch(() => null);
  if (major !== null) majorCache = major;
  return { path: MSCORE, major };
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

export const render: Render = async (input, request) => {
  const dir = await mkdtemp(path.join(tmpdir(), "score-"));
  try {
    const inPath = path.join(dir, `input.${request.inputExt}`);
    const outExt = request.target === "xml" ? "musicxml" : request.target === "png-long" ? "png" : request.target;
    const outPath = path.join(dir, `output.${outExt}`);
    await writeFile(inPath, input);
    const args: string[] = [];
    if (request.target === "png" || request.target === "png-long") {
      if (request.dpi) args.push("-r", String(request.dpi));
      if (request.trim != null) args.push("-T", String(request.trim));
    }
    if (request.target === "mid" && request.unrollRepeats) args.push("--unroll-repeats");
    if (request.target === "pdf" && request.style) {
      const stylePath = path.join(dir, "style.mss");
      await writeFile(stylePath, request.style);
      args.push("-S", stylePath);
    }
    // MuseScore 可能在退出时崩溃，产物存在才是成功依据。
    await run(MSCORE, [inPath, "-o", outPath, ...args], { timeout: 120_000 }).catch(e => {
      if (e.code === "ENOENT") throw new Error("未找到 mscore，可通过 MSCORE_PATH 环境变量指定路径");
    });
    if (request.target === "png" || request.target === "png-long") {
      const pages = (await readdir(dir)).filter(f => /^output-\d+\.png$/.test(f)).sort((a,b) => pageNo(a)-pageNo(b));
      if (!pages.length) throw new Error("PNG 导出失败：未生成页面");
      if (request.target === "png-long") return stitchPngPages(await Promise.all(pages.map(p => readFile(path.join(dir,p)))));
      if (pages.length === 1) return await readFile(path.join(dir,pages[0]));
      const zip = new JSZip();
      for (const p of pages) zip.file(p, await readFile(path.join(dir,p)));
      return zip.generateAsync({ type: "uint8array" });
    }
    return await readFile(outPath).catch(() => { throw new Error(`转换失败：MuseScore 未生成 ${request.target} 文件`); });
  } finally { await rm(dir, { recursive: true, force: true }); }
};
