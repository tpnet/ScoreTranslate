import { INPUT_EXTS, MAX_SIZE, type ConvertOptions } from "./formats";

export function validateFile(file: FormDataEntryValue | null): asserts file is File {
  if (!(file instanceof File)) throw new Error("缺少文件");
  if (file.size > MAX_SIZE) throw new Error("文件超过 50MB 限制");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(INPUT_EXTS as readonly string[]).includes(ext)) throw new Error(`不支持的输入格式：.${ext}`);
}

// 表单里的导出配置：数字字段做范围钳制，枚举字段白名单校验，非法值一律忽略
export function parseOptions(form: FormData): ConvertOptions {
  const num = (key: string, min: number, max: number): number | undefined => {
    const raw = form.get(key);
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
  };
  const opts: ConvertOptions = {
    jsonTempo: num("jsonTempo", 20, 400),
    jsonMiddleC: num("jsonMiddleC", 0, 120),
    dpi: num("dpi", 50, 1200),
    trim: num("trim", 0, 500),
    scale: num("scale", 50, 200),
  };
  if (form.get("unrollRepeats") === "1") opts.unrollRepeats = true;
  if (form.get("mergeLyrics") === "1") opts.mergeLyrics = true;
  const paper = form.get("paper");
  if (paper === "a4" || paper === "letter") opts.paper = paper;
  const staffMode = form.get("staffMode");
  if (staffMode === "tab" || staffMode === "standard") opts.staffMode = staffMode;
  const tracks = form.get("tracks");
  if (typeof tracks === "string" && tracks.trim() !== "") {
    const list = tracks.split(",").map(Number).filter(Number.isInteger);
    if (list.length) opts.tracks = list;
  }
  return opts;
}
