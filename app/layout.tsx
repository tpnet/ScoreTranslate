import type { Metadata } from "next";
import "./globals.css";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MSCORE, mscoreMajor } from "@/lib/convert";

// 每次请求都重新查一遍，否则构建期的检测结果会被固化进静态产物
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "乐谱格式转换",
  description: "MIDI / Guitar Pro / MusicXML 乐谱格式互转，支持导出 PDF 与图片",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const major = await mscoreMajor();
  return (
    <html lang="zh-CN">
      <body>
        {major !== null && major < 4 ? (
          <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
            <AlertDescription className="block">
              检测到 MuseScore {major}，本工具依赖 MuseScore 4（<code className="font-mono">--unroll-repeats</code>{" "}
              等命令行开关和 mscz 格式都以 4 为准），请从 musescore.org 升级（macOS 也可{" "}
              <code className="font-mono">brew install --cask musescore</code>），并让{" "}
              <code className="font-mono">MSCORE_PATH</code> 指向 4 的可执行文件。
            </AlertDescription>
          </Alert>
        ) : major === null ? (
          <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
            <AlertDescription className="block">
              未在 <code className="font-mono">{MSCORE}</code> 检测到 MuseScore 4，仅 Guitar Pro 输入转 MusicXML / gp /
              gp5 可用，其余格式会转换失败。请从 musescore.org 安装（macOS 也可{" "}
              <code className="font-mono">brew install --cask musescore</code>
              ）；装在别处时，用环境变量 <code className="font-mono">MSCORE_PATH</code> 指向其可执行文件。
            </AlertDescription>
          </Alert>
        ) : null}
        {children}
      </body>
    </html>
  );
}
