import type { ConvertOptions, ConvertResult, OutputExt, RenderRequest } from "@/lib/formats";

export interface Job {
  id: number;
  action: "convert" | "tracks";
  input: Uint8Array;
  filename: string;
  target: OutputExt;
  options: ConvertOptions;
}
export type WorkerReply =
  | { type: "render"; id: number; input: Uint8Array; request: RenderRequest }
  | { type: "result"; id: number; result: ConvertResult | string[] }
  | { type: "error"; id: number; error: string };
export type RenderReply = { type: "renderResult"; id: number; data?: Uint8Array; error?: string };
