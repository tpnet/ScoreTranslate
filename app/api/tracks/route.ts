import { NextResponse } from "next/server";
import { INPUT_EXTS, listTracks } from "@/lib/convert";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_SIZE = 50 * 1024 * 1024;

// 前端选择导出音轨前先拿音轨名，下标与 /api/convert 的 tracks 字段一致
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");

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

  try {
    const tracks = await listTracks(new Uint8Array(await file.arrayBuffer()), ext);
    return NextResponse.json({ tracks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "读取音轨失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
