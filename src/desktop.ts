import { invoke } from "@tauri-apps/api/core";
import { OUTPUT_EXTS, type ConvertResult, type OutputExt } from "@/lib/formats";
import { validateFile, parseOptions } from "@/lib/request";
import type { Job, RenderReply, WorkerReply } from "./jobs";

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (result: ConvertResult | string[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const current = new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" });
  worker = current;
  current.onmessage = async ({ data }: MessageEvent<WorkerReply>) => {
    if (data.type === "render") {
      try {
        const bytes = new Uint8Array(await invoke<ArrayBuffer>("render_score", data.input, {
          headers: { "x-score-options": JSON.stringify(data.request) },
        }));
        current.postMessage({ type: "renderResult", id: data.id, data: bytes } satisfies RenderReply, [bytes.buffer]);
      } catch (e) {
        current.postMessage({ type: "renderResult", id: data.id, error: String(e) } satisfies RenderReply);
      }
      return;
    }
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.type === "error") task.reject(new Error(data.error));
    else task.resolve(data.result);
  };
  current.onerror = () => {
    for (const task of pending.values()) task.reject(new Error("转换进程异常，请重试或减小文件"));
    pending.clear();
    current.terminate();
    worker = undefined;
  };
  return current;
}

export async function request(action: "convert" | "tracks", form: FormData): Promise<Response> {
  const file = form.get("file");
  validateFile(file);
  const target = form.get("target") ?? "pdf";
  if (typeof target !== "string" || !(OUTPUT_EXTS as readonly string[]).includes(target)) throw new Error("不支持的目标格式");
  const input = new Uint8Array(await file.arrayBuffer());
  const current = getWorker();
  const result = await new Promise<ConvertResult | string[]>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    current.postMessage({ id, action, input, filename: file.name, target: target as OutputExt, options: parseOptions(form) } satisfies Job, [input.buffer]);
  });
  if (Array.isArray(result)) return Response.json({ tracks: result });
  return new Response(result.data as BodyInit, {
    headers: { "Content-Type": result.contentType, "X-Filename": encodeURIComponent(result.filename) },
  });
}
