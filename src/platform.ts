import { isTauri, invoke } from "@tauri-apps/api/core";
import type { MuseScoreStatus } from "@/lib/formats";

// 桌面始终保留原生渲染，即使复用了静态模式的构建环境。
export const STATIC_MODE = import.meta.env.VITE_STATIC_MODE === "1" && !isTauri();

export async function request(action: "convert" | "tracks", form: FormData): Promise<Response> {
  if (isTauri() || STATIC_MODE) return (await import("./worker-client")).request(action, form);
  return fetch(`/api/${action}`, { method: "POST", body: form });
}

export async function getStatus(): Promise<MuseScoreStatus> {
  if (isTauri()) {
    return invoke<MuseScoreStatus>("mscore_status");
  }
  if (STATIC_MODE) return { path: "", major: null };
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error("无法检测 MuseScore");
  return response.json();
}
