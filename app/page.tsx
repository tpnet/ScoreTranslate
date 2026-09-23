"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

const ACCEPT = ".mid,.midi,.gp,.gpx,.gp3,.gp4,.gp5,.mxl,.musicxml,.xml,.json,.atex";

const TARGETS = [
  { value: "mid", label: "MIDI (.mid)" },
  { value: "musicxml", label: "MusicXML (.musicxml)" },
  { value: "xml", label: "MusicXML (.xml)" },
  { value: "mxl", label: "MusicXML 压缩 (.mxl)" },
  { value: "gp", label: "Guitar Pro (.gp，GP7/8 可打开)" },
  { value: "gp5", label: "Guitar Pro 5 (.gp5，GP5 及以上可打开)" },
  { value: "json", label: "alphaTab JSON (.json)" },
  { value: "atex", label: "alphaTex (.atex)" },
  { value: "mscz", label: "MuseScore (.mscz)" },
  { value: "pdf", label: "PDF (.pdf)" },
  { value: "png", label: "PNG 图片（多页自动打包 zip）" },
  { value: "png-long", label: "PNG 长图（多页纵向拼接）" },
];

// 后端按 gp 系处理的输入（json / atex 先转成 .gp），MusicXML 目标缺省输出六线谱
const GP_INPUTS = ["gp", "gpx", "gp3", "gp4", "gp5", "json", "atex"];
const XML_TARGETS = ["musicxml", "xml", "mxl"];
// 各目标格式提交时携带的配置字段；不在表里的格式无配置项
const OPT_KEYS: Record<string, string[]> = {
  png: ["dpi", "trim", "staffMode", "mergeLyrics"],
  "png-long": ["dpi", "trim", "staffMode", "mergeLyrics"],
  mid: ["unrollRepeats"],
  pdf: ["paper", "scale", "staffMode", "mergeLyrics"],
  musicxml: ["staffMode", "mergeLyrics"],
  xml: ["staffMode", "mergeLyrics"],
  mxl: ["staffMode", "mergeLyrics"],
  gp: ["mergeLyrics"],
  gp5: ["mergeLyrics"],
};

// 表单行：左侧固定标签 + 右侧控件
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <Label className="text-muted-foreground font-normal">{label}</Label>
      {children}
    </div>
  );
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [opts, setOpts] = useState<Record<string, string>>({ mergeLyrics: "1" });
  const [tracks, setTracks] = useState<string[] | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const inputExt = file?.name.split(".").pop()?.toLowerCase() ?? "";
  const isGpInput = GP_INPUTS.includes(inputExt);

  // 选定文件后读音轨名（非 gp 输入要跑一趟 MuseScore，所以只在换文件时读一次）。
  // 读取失败不报错，只是不显示勾选框，转换时导出全部音轨
  useEffect(() => {
    if (!file) return;
    let stale = false;
    const form = new FormData();
    form.append("file", file);
    fetch("/api/tracks", { method: "POST", body: form })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { tracks?: string[] } | null) => {
        if (stale || !body?.tracks) return;
        setTracks(body.tracks);
        setSel(body.tracks.map((_, i) => i));
      })
      .catch(() => {});
    return () => {
      stale = true;
      setTracks(null);
    };
  }, [file]);

  const setOpt = (key: string) => (value: string) =>
    setOpts((o) => ({ ...o, [key]: value }));

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setError("");
  };

  const convert = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("target", target);
      for (const key of OPT_KEYS[target] ?? []) {
        if (opts[key]) form.append(key, opts[key]);
      }
      // 全选等同缺省，不用传
      if (tracks && sel.length < tracks.length) form.append("tracks", sel.join(","));
      const res = await fetch("/api/convert", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `转换失败（HTTP ${res.status}）`);
      }
      const filename = decodeURIComponent(res.headers.get("X-Filename") ?? "score");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "转换失败");
    } finally {
      setBusy(false);
    }
  };

  const hasOpts = (OPT_KEYS[target] ?? []).length > 0;
  const trackList = tracks && tracks.length > 1 ? tracks : null;

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>乐谱格式转换</CardTitle>
          <CardDescription>
            支持 MIDI、Guitar Pro（gp / gpx / gp3-5）、MusicXML（mxl / musicxml /
            xml）、alphaTab JSON、alphaTex 互转，并可导出 PDF 与图片。
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <div
            className={cn(
              "rounded-lg border-2 border-dashed px-5 py-9 text-center text-sm cursor-pointer transition-colors",
              dragging || file
                ? "border-primary/50"
                : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            )}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files[0]);
            }}
          >
            {file ? (
              <span className="font-medium break-all">{file.name}</span>
            ) : (
              <>点击选择或拖入乐谱文件</>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </div>

          <Row label="转换为">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGETS.filter((t) => t.value !== inputExt).map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          {(hasOpts || trackList) && (
            <div className="ml-3 flex flex-col gap-3 border-l-2 pl-4">
              {(target === "png" || target === "png-long") && (
                <>
                  <Row label="分辨率 DPI">
                    <Input
                      type="number"
                      min={50}
                      max={1200}
                      placeholder={target === "png-long" ? "默认 150" : "默认 360"}
                      value={opts.dpi ?? ""}
                      onChange={(e) => setOpt("dpi")(e.target.value)}
                    />
                  </Row>
                  <Row label="裁剪白边">
                    <Input
                      type="number"
                      min={0}
                      max={500}
                      placeholder="不裁剪；填保留的边距像素"
                      value={opts.trim ?? ""}
                      onChange={(e) => setOpt("trim")(e.target.value)}
                    />
                  </Row>
                </>
              )}

              {target === "mid" && (
                <Row label="展开反复">
                  <Label className="font-normal">
                    <Checkbox
                      checked={opts.unrollRepeats === "1"}
                      onCheckedChange={(checked) =>
                        setOpts((o) => ({
                          ...o,
                          unrollRepeats: checked === true ? "1" : "",
                        }))
                      }
                    />
                    反复记号展开为线性序列
                  </Label>
                </Row>
              )}

              {target === "pdf" && (
                <>
                  <Row label="纸张">
                    <Select
                      value={opts.paper || "original"}
                      onValueChange={(v) => setOpt("paper")(v === "original" ? "" : v)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="original">原谱设置</SelectItem>
                        <SelectItem value="a4">A4</SelectItem>
                        <SelectItem value="letter">Letter</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>
                  <Row label="谱面缩放 %">
                    <Input
                      type="number"
                      min={50}
                      max={200}
                      placeholder="默认 100"
                      value={opts.scale ?? ""}
                      onChange={(e) => setOpt("scale")(e.target.value)}
                    />
                  </Row>
                </>
              )}

              {XML_TARGETS.includes(target) && (
                <Row label="谱表类型">
                  <Select
                    value={opts.staffMode || (isGpInput ? "tab" : "standard")}
                    onValueChange={setOpt("staffMode")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tab">六线谱（TAB）</SelectItem>
                      <SelectItem value="standard">标准五线谱</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
              )}

              {(OPT_KEYS[target] ?? []).includes("mergeLyrics") && (
                <Row label="弹唱谱">
                  <Label className="font-normal">
                    <Checkbox
                      checked={opts.mergeLyrics === "1"}
                      onCheckedChange={(checked) =>
                        setOpts((o) => ({
                          ...o,
                          mergeLyrics: checked === true ? "1" : "",
                        }))
                      }
                    />
                    歌词并入吉他等其他音轨
                  </Label>
                </Row>
              )}

              {(target === "pdf" || target === "png" || target === "png-long") && (
                <Row label="谱表类型">
                  <Select
                    value={opts.staffMode || "original"}
                    onValueChange={(v) =>
                      setOpt("staffMode")(v === "original" ? "" : v)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="original">跟随原谱</SelectItem>
                      <SelectItem value="tab">六线谱（TAB）</SelectItem>
                      <SelectItem value="standard">标准五线谱</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
              )}

              {trackList && (
                <Row label="导出音轨">
                  <div className="flex flex-col gap-1.5">
                    {trackList.map((name, i) => (
                      <Label key={i} className="font-normal">
                        <Checkbox
                          checked={sel.includes(i)}
                          onCheckedChange={(checked) =>
                            setSel((s) =>
                              checked === true ? [...s, i].sort((a, b) => a - b) : s.filter((x) => x !== i)
                            )
                          }
                        />
                        {name}
                      </Label>
                    ))}
                  </div>
                </Row>
              )}
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="flex-col gap-4">
          <Button
            className="w-full"
            onClick={convert}
            disabled={!file || busy || (!!trackList && sel.length === 0)}
          >
            {busy ? "转换中…" : "转换并下载"}
          </Button>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Guitar Pro 谱转 MusicXML / GP 时直接解析原文件，保留六线谱、调弦与弦位品格；
            其余转换由 MuseScore 引擎完成。选择六线谱时，非 Guitar Pro
            来源会自动推断调弦并指派弦位品格。不支持导出 gp3 / gp4 / gpx。
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
