import { NextResponse } from "next/server";
import {
  convertScore,
  INPUT_EXTS,
  OUTPUT_EXTS,
  type ConvertOptions,
  type OutputExt,
} from "@/lib/convert";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_SIZE = 50 * 1024 * 1024;

// 非 ASCII 字符（如中文曲名）在 filename= 里不合法，替换为下划线作为回退
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");

// 表单里的导出配置：数字字段做范围钳制，枚举字段白名单校验，非法值一律忽略
function parseOptions(form: FormData): ConvertOptions {
  const num = (key: string, min: number, max: number): number | undefined => {
    const raw = form.get(key);
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
  };
  const opts: ConvertOptions = {
    dpi: num("dpi", 50, 1200),
    trim: num("trim", 0, 500),
    scale: num("scale", 50, 200),
  };
  if (form.get("unrollRepeats") === "1") opts.unrollRepeats = true;
  const paper = form.get("paper");
  if (paper === "a4" || paper === "letter") opts.paper = paper;
  const staffMode = form.get("staffMode");
  if (staffMode === "tab" || staffMode === "standard") opts.staffMode = staffMode;
  return opts;
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const target = form.get("target");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "文件超过 50MB 限制" }, { status: 400 });
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(INPUT_EXTS as readonly string[]).includes(ext)) {
    return NextResponse.json({ error: `不支持的输入格式：.${ext}` }, { status: 400 });
  }
  if (typeof target !== "string" || !(OUTPUT_EXTS as readonly string[]).includes(target)) {
    return NextResponse.json({ error: "不支持的目标格式" }, { status: 400 });
  }

  const baseName = file.name.replace(/\.[^.]+$/, "") || "score";
  try {
    const result = await convertScore(
      new Uint8Array(await file.arrayBuffer()),
      ext,
      target as OutputExt,
      baseName,
      parseOptions(form),
    );
    return new Response(result.data as BodyInit, {
      headers: {
        "Content-Type": result.contentType,
        // 同时给出 ASCII 回退名与 UTF-8 原名：curl -J 等客户端只认前者
        "Content-Disposition":
          `attachment; filename="${asciiName(result.filename)}"; ` +
          `filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "X-Filename": encodeURIComponent(result.filename),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "转换失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
