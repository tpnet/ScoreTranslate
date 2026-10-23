import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { MuseScoreStatus } from "@/lib/formats";
import { getStatus } from "./platform";

export function MuseScoreNotice() {
  const [status, setStatus] = useState<MuseScoreStatus | null>(null);
  useEffect(() => { void getStatus().then(setStatus).catch(() => setStatus({ major: null, path: "MuseScore 4" })); }, []);
  if (!status) return null;
  const { major, path } = status;
  return <>
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
              未在 <code className="font-mono">{path}</code> 检测到 MuseScore 4。Guitar Pro / JSON / alphaTex
              之间及转 MusicXML 仍可用，其余转换需要安装 MuseScore。请从 musescore.org 安装（macOS 也可{" "}
              <code className="font-mono">brew install --cask musescore</code>
              ）；装在别处时，用环境变量 <code className="font-mono">MSCORE_PATH</code> 指向其可执行文件。
            </AlertDescription>
          </Alert>
        ) : null}
  </>;
}
