export const INPUT_EXTS = [
  "mid", "midi", "gp", "gpx", "gp3", "gp4", "gp5", "mxl", "musicxml", "xml", "json", "atex",
] as const;

export const OUTPUT_EXTS = ["mid", "musicxml", "xml", "mxl", "gp", "gp5", "json", "atex", "pdf", "png", "png-long", "mscz"] as const;
export type OutputExt = (typeof OUTPUT_EXTS)[number];

export interface ConvertResult {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

// 各目标格式的导出配置。所有字段可选，缺省即原有默认行为。
// gp / gp5 / mscz 是全量结构转换，没有可配置项。
export interface ConvertOptions {
  /** 歌曲 JSON 的速度覆盖；二维 GP JSON 缺省为 120 BPM。 */
  jsonTempo?: number;
  /** 仅 LL 原始 JSON 使用，默认 C4=60，保持源调高。 */
  jsonMiddleC?: number;
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

export const MAX_SIZE = 50 * 1024 * 1024;

export const CONTENT_TYPES: Record<string, string> = {
  mid: "audio/midi", musicxml: "application/vnd.recordare.musicxml+xml",
  xml: "application/vnd.recordare.musicxml+xml", mxl: "application/vnd.recordare.musicxml",
  gp: "application/octet-stream", gp5: "application/octet-stream",
  json: "application/json", atex: "text/plain; charset=utf-8", mscz: "application/x-musescore",
  pdf: "application/pdf", png: "image/png", zip: "application/zip",
};

export interface RenderRequest {
  inputExt: string;
  target: "musicxml" | "xml" | "mxl" | "mid" | "mscz" | "pdf" | "png" | "png-long";
  dpi?: number;
  trim?: number;
  unrollRepeats?: boolean;
  style?: string;
}

// PNG 返回单页图片或多页 ZIP；png-long 返回白底长图。
export type Render = (input: Uint8Array, request: RenderRequest) => Promise<Uint8Array>;
export interface MuseScoreStatus { path: string; major: number | null }
