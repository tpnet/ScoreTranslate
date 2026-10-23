import path from "node:path";
import { fileURLToPath } from "node:url";
import { POST as convert } from "./convert";
import { POST as tracks } from "./tracks";
import { mscoreStatus } from "./render";
import { MAX_SIZE } from "../lib/formats";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
export const server = Bun.serve({
  hostname: process.env.HOSTNAME ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 255,
  maxRequestBodySize: MAX_SIZE + 1024 * 1024,
  async fetch(req) {
    const pathname = new URL(req.url).pathname;
    try {
      if (pathname === "/api/status" && req.method === "GET") return Response.json(await mscoreStatus());
      if (pathname === "/api/convert" || pathname === "/api/tracks") {
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
        try { return await (pathname === "/api/convert" ? convert(req) : tracks(req)); }
        catch { return Response.json({ error: "无法读取上传表单" }, { status: 400 }); }
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
      const filename = path.resolve(dist, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
      if (!filename.startsWith(dist)) return new Response("Not Found", { status: 404 });
      const file = Bun.file(filename);
      if (!(await file.exists())) return new Response("Not Found", { status: 404 });
      return new Response(req.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type, "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    } catch { return Response.json({ error: "请求失败" }, { status: 400 }); }
  },
});
console.log(`ScoreTranslate: http://${server.hostname}:${server.port}`);
