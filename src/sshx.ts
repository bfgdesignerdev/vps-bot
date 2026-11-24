// 🔗 SSHX: веб-терминал сервера по ссылке (https://sshx.io). Бинарник скачивается с обходами сброса HTTPS.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { docker } from "./docker.js";
import { log, sleep } from "./util.js";

const DATA = process.env.DATA_DIR || "./data";
const PROXY = process.env.SSHX_PROXY || "";           // например http://127.0.0.1:8080 или socks5h://127.0.0.1:1080
const SERVER = process.env.SSHX_SERVER || "";         // свой сервер sshx (self-hosted), если sshx.io заблокирован
const EXTRA_MIRRORS = (process.env.SSHX_MIRRORS || "").split(",").map((s) => s.trim()).filter(Boolean); // полные URL архивов, {ARCH} подставляется

export const SSHX_WARN = "⚠️ <b>ВНИМАНИЕ!</b> НИКОМУ не давайте эту ссылку и данные подключения. Кто откроет ссылку, получит доступ к терминалу вашего сервера и сможет перехватить контроль над ним. Не публикуйте и не пересылайте. Для отключения нажмите «Остановить SSHX».";

const archOf = (m: string): string | null => /^(x86_64|amd64|x64)$/.test(m) ? "x86_64" : /^(aarch64|arm64)$/.test(m) ? "aarch64" : null;
const urls = (arch: string): string[] => [
  ...EXTRA_MIRRORS.map((u) => u.replace("{ARCH}", arch)),
  `https://s3.amazonaws.com/sshx/sshx-${arch}-unknown-linux-musl.tar.gz`,
  `https://sshx.s3.amazonaws.com/sshx-${arch}-unknown-linux-musl.tar.gz`,
  `https://s3.us-east-1.amazonaws.com/sshx/sshx-${arch}-unknown-linux-musl.tar.gz`,
];
/** Наборы флагов curl для обхода сброса HTTPS: IPv4, HTTP/1.1, TLS 1.2, прокси. */
const VARIANTS: string[][] = [[], ["-4"], ["-4", "--http1.1"], ["-4", "--http1.1", "--tlsv1.2"], ...(PROXY ? [["-x", PROXY], ["-4", "-x", PROXY, "--http1.1"]] : [])];

function run(cmd: string, args: string[], timeout = 120000, input?: Buffer): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, out: Buffer.alloc(0), err: String(e) }); });
    p.on("close", (c) => { clearTimeout(t); resolve({ code: c ?? 1, out: Buffer.concat(out), err }); });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

/** Скачивает архив sshx на хосте (кэш в DATA_DIR): перебор зеркал × вариантов curl × повторы. */
async function fetchArchive(arch: string): Promise<Buffer | null> {
  mkdirSync(DATA, { recursive: true });
  const cache = `${DATA}/sshx-${arch}.tar.gz`;
  if (existsSync(cache) && statSync(cache).size > 500_000) return readFileSync(cache);
  for (const u of urls(arch)) for (const v of VARIANTS) {
    const r = await run("curl", ["-fsSL", "--connect-timeout", "15", "--max-time", "90", "--retry", "3", "--retry-all-errors", "--retry-delay", "2", ...v, "-o", cache, u]);
    if (r.code === 0 && existsSync(cache) && statSync(cache).size > 500_000) return readFileSync(cache);
    log("sshx download failed", u.slice(0, 60), v.join(" "), "code", r.code);
    await run("rm", ["-f", cache]);
    await sleep(1000);
  }
  return null;
}

const INSTALL_CMD = 'mkdir -p "$HOME/.sshx" && tar xzf - -C "$HOME/.sshx" && chmod 755 "$HOME/.sshx/sshx"';
const userExec = (c: string, script: string, input?: Buffer, env: string[] = [], timeout = 30000) =>
  docker(["exec", ...(input ? ["-i"] : []), ...env.flatMap((e) => ["-e", e]), "-u", "user", "-w", "/home/user", c, "bash", "-c", script], { timeout, input });

/** Убеждается, что бинарник sshx есть в контейнере. Сначала хост качает и кладёт файл (обход блокировок внутри контейнера), потом curl/wget внутри. */
async function ensureBinary(c: string): Promise<boolean> {
  if ((await userExec(c, 'test -x "$HOME/.sshx/sshx"')).code === 0) return true;
  const arch = archOf((await userExec(c, "uname -m")).out.toString().trim());
  if (!arch) return false;
  const buf = await fetchArchive(arch);
  if (buf && (await userExec(c, INSTALL_CMD, buf, [], 60000)).code === 0) return true;
  for (const u of urls(arch)) for (const v of VARIANTS) {
    const cur = v.length ? v.join(" ") : "";
    const r = await userExec(c, `(curl -fsSL ${cur} --connect-timeout 15 --retry 3 --retry-all-errors '${u}' || wget -qO- '${u}') | ${INSTALL_CMD}`, undefined, PROXY ? [`HTTPS_PROXY=${PROXY}`, `ALL_PROXY=${PROXY}`] : [], 120000);
    if (r.code === 0) return true;
  }
  return false;
}

const linkOf = (txt: string): string | null => {
  for (const line of txt.split("\n")) for (const w of line.split(" ")) if (w.startsWith("http") && w.includes("#")) return w.trim().replace("\u001b[0m", "");
  return null;
};

export async function stopSshx(c: string): Promise<void> {
  await userExec(c, 'pkill -u user -x sshx; rm -f "$HOME/.sshx/link.log"; true');
}

/** Запускает sshx внутри контейнера и возвращает ссылку. До 3 попыток (сброс соединения — повтор, с прокси если задан). */
export async function startSshx(c: string): Promise<{ ok: boolean; link?: string; why?: string }> {
  if (!(await ensureBinary(c))) return { ok: false, why: "не удалось скачать sshx (HTTPS сбрасывается). Админу: задайте SSHX_PROXY или SSHX_MIRRORS в .env" };
  const env = PROXY ? [`HTTPS_PROXY=${PROXY}`, `ALL_PROXY=${PROXY}`, `https_proxy=${PROXY}`] : [];
  const srv = SERVER ? ` --server '${SERVER.replace(/'/g, "")}'` : "";
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await stopSshx(c);
    await userExec(c, `setsid nohup "$HOME/.sshx/sshx" -q${srv} > "$HOME/.sshx/link.log" 2>&1 < /dev/null &`, undefined, env);
    for (let i = 0; i < 12; i++) {
      await sleep(2000);
      const r = await userExec(c, 'cat "$HOME/.sshx/link.log" 2>/dev/null | head -c 2000');
      last = r.out.toString();
      const link = linkOf(last);
      if (link) return { ok: true, link };
      if (/error|failed|reset|refused|timed out/i.test(last)) break;
    }
    await sleep(2000 * attempt);
  }
  await stopSshx(c);
  return { ok: false, why: "sshx не смог соединиться (" + last.replace(/https?:[^ ]+/g, "").trim().slice(0, 150) + ")" };
}
