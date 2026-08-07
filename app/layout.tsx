import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "乐谱格式转换",
  description: "MIDI / Guitar Pro / MusicXML 乐谱格式互转，支持导出 PDF 与图片",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
