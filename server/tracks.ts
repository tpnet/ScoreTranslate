import { listTracks } from "../lib/convert";
import { validateFile } from "../lib/request";
import { render } from "./render";

// 前端选择导出音轨前先拿音轨名，下标与 /api/convert 的 tracks 字段一致
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");

  try { validateFile(file); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  try {
    const tracks = await listTracks(new Uint8Array(await file.arrayBuffer()), ext, render);
    return Response.json({ tracks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "读取音轨失败";
    return Response.json({ error: msg }, { status: 500 });
  }
}
