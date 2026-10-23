export {};
const children = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], { env: { ...process.env, PORT: "3001", HOSTNAME: "127.0.0.1" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "x", "--no-install", "vite"], { stdout: "inherit", stderr: "inherit" }),
];
const stop = () => { for (const child of children) child.kill(); };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("exit", stop);
const code = await Promise.race(children.map(child => child.exited));
stop();
process.exit(code);
