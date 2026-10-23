/// <reference lib="webworker" />
import { convertScore, listTracks } from "@/lib/convert";
import type { Render } from "@/lib/formats";
import type { Job, RenderReply, WorkerReply } from "./jobs";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const pending = new Map<number, { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>();
let sequence = 0;
const render: Render = (input, request) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  // 输入可能还用于 PDF 回退，不能转移原缓冲区。
  const bytes = input.slice();
  scope.postMessage({ type: "render", id, input: bytes, request } satisfies WorkerReply, [bytes.buffer]);
});

scope.onmessage = async ({ data }: MessageEvent<Job | RenderReply>) => {
  if ("type" in data) {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve(data.data!);
    return;
  }
  const { id, action, input, filename, target, options } = data;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  try {
    const result = action === "tracks"
      ? await listTracks(input, ext, render)
      : await convertScore(input, ext, target, filename.replace(/\.gp\.json$|\.[^.]+$/i, "") || "score", options, render);
    const transfer = Array.isArray(result) ? [] : [result.data.buffer];
    scope.postMessage({ type: "result", id, result } satisfies WorkerReply, transfer);
  } catch (e) {
    scope.postMessage({ type: "error", id, error: e instanceof Error ? e.message : String(e) } satisfies WorkerReply);
  }
};
