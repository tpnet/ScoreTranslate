import { convertScore } from "../lib/convert";
import { OUTPUT_EXTS, type OutputExt } from "../lib/formats";
import { validateFile, parseOptions } from "../lib/request";
import { render } from "./render";

// 非 ASCII 字符（如中文曲名）在 filename= 里不合法，替换为下划线作为回退
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const target = form.get("target");

  try { validateFile(file); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (typeof target !== "string" || !(OUTPUT_EXTS as readonly string[]).includes(target)) {
    return Response.json({ error: "不支持的目标格式" }, { status: 400 });
  }

  const baseName = file.name.replace(/\.gp\.json$|\.[^.]+$/i, "") || "score";
  try {
    const result = await convertScore(
      new Uint8Array(await file.arrayBuffer()),
      ext,
      target as OutputExt,
      baseName,
      parseOptions(form),
      render,
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
    return Response.json({ error: msg }, { status: 500 });
  }
}
