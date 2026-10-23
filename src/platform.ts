import { isTauri, invoke } from "@tauri-apps/api/core";
import type { MuseScoreStatus } from "@/lib/formats";

export async function request(action: "convert" | "tracks", form: FormData): Promise<Response> {
  if (isTauri()) return (await import("./desktop")).request(action, form);
  return fetch(`/api/${action}`, { method: "POST", body: form });
}

export async function getStatus(): Promise<MuseScoreStatus> {
  if (isTauri()) {
    return invoke<MuseScoreStatus>("mscore_status");
  }
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error("无法检测 MuseScore");
  return response.json();
}
