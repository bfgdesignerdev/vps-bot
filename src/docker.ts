import { spawn } from "node:child_process";

export interface Res { code: number; out: Buffer; err: string }
export function docker(args: string[], opts: { timeout?: number; input?: Buffer } = {}): Promise<Res> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "", size = 0;
    const t = setTimeout(() => p.kill("SIGKILL"), opts.timeout ?? 30000);
    p.stdout.on("data", (d: Buffer) => { if ((size += d.length) < 4_000_000) out.push(d); });
    p.stderr.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, out: Buffer.alloc(0), err: String(e) }); });
    p.on("close", (c) => { clearTimeout(t); resolve({ code: c ?? 1, out: Buffer.concat(out), err }); });
    p.stdin.on("error", () => {});
    p.stdin.end(opts.input);
  });
}

export const IMAGE = "zelenka-base:2";
const DOCKERFILE = `FROM node:22-bookworm
RUN apt-get update \\
 && apt-get install -y --no-install-recommends bash python3 git curl nano \\
 && rm -rf /var/lib/apt/lists/* \\
 && usermod --login user --home /home/user --move-home node \\
 && groupmod --new-name user node
USER user
WORKDIR /home/user
`;
export async function ensureImage(): Promise<void> {
  if ((await docker(["image", "inspect", IMAGE])).code === 0) return;
  console.log("Собираю базовый образ…");
  const r = await docker(["build", "-t", IMAGE, "-"], { timeout: 600000, input: Buffer.from(DOCKERFILE) });
  if (r.code !== 0) throw new Error("build failed: " + r.err);
}

/** Лимиты бесплатного тарифа: 512 МБ ОЗУ, 1 ГБ диск, 50% CPU (0.5 ядра). */
export const SPECS_TEXT = "512 МБ ОЗУ · 1 ГБ диск · 50 CPU";
const base = (name: string): string[] => ["run", "-d", "--name", name, "--hostname", "zelenka", "--label", "zc=1", "--restart", "unless-stopped",
  "--memory", "512m", "--memory-swap", "512m", "--cpus", "0.5", "--pids-limit", "128",
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ulimit", "nofile=1024:1024", "--ulimit", "nproc=128",
  "--tmpfs", "/tmp:size=64m,mode=1777", "-u", "1000:1000", "-w", "/home/user"];
export async function createContainer(name: string): Promise<{ ok: boolean; diskEnforced: boolean; err: string }> {
  let r = await docker([...base(name), "--storage-opt", "size=1G", IMAGE, "sleep", "infinity"], { timeout: 120000 });
  if (r.code === 0) return { ok: true, diskEnforced: true, err: "" };
  if (/storage-opt|quota|pquota/i.test(r.err)) {
    await docker(["rm", "-f", name]);
    r = await docker([...base(name), IMAGE, "sleep", "infinity"], { timeout: 120000 });
    if (r.code === 0) return { ok: true, diskEnforced: false, err: "" };
  }
  return { ok: false, diskEnforced: false, err: r.err };
}
export const state = async (name: string): Promise<string> => {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  return r.code === 0 ? r.out.toString().trim() : "missing";
};
export async function stats(name: string): Promise<{ cpu: string; mem: string; disk: string }> {
  const [s, d] = await Promise.all([
    docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", name], { timeout: 15000 }),
    docker(["exec", name, "sh", "-c", "du -sk /home/user | cut -f1"], { timeout: 10000 })]);
  const [cpu = "?", mem = "?"] = s.out.toString().trim().split("|");
  return { cpu, mem: mem.split("/")[0].trim(), disk: Math.max(0, Math.round(parseInt(d.out.toString()) / 1024 || 0)) + " МБ" };
}
export const exec = (name: string, cmd: string) =>
  docker(["exec", "-u", "user", "-w", "/home/user", name, "timeout", "-s", "KILL", "20", "bash", "-c", cmd], { timeout: 25000 });
