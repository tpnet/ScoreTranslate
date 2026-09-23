// 把当前运行的 bun 复制成 Tauri sidecar。externalBin 要求文件名带目标三元组后缀
// （如 bun-aarch64-apple-darwin），复制的是本机的 bun，所以只能构建本机架构的包
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

if (!process.versions.bun) throw new Error("请用 bun 运行：process.execPath 必须是 bun 本体");

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
const ext = process.platform === "win32" ? ".exe" : "";
const dir = new URL("binaries/", import.meta.url);
mkdirSync(dir, { recursive: true });
copyFileSync(process.execPath, new URL(`bun-${triple}${ext}`, dir));
