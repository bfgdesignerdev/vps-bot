import { docker, state } from "./docker.js";
import { log } from "./util.js";

export const START_BALANCE = 15, COST_PER_HOUR = 2;
export const TRAFFIC_GB = parseFloat(process.env.TRAFFIC_LIMIT_GB || "5");
export interface Traffic { day: string; bytes: number; last: number; blocked?: boolean }
export interface Billable { container?: string; balance?: number; traffic?: Traffic }
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Раз в минуту: списывает листики (2 в час), считает трафик, отключает сеть при превышении лимита. */
export async function tickOne(u: Billable, notify: (text: string) => void): Promise<void> {
  const c = u.container;
  if (!c || (await state(c)) !== "running") return;
  u.balance = (u.balance ?? START_BALANCE) - COST_PER_HOUR / 60;
  const t = (u.traffic ??= { day: today(), bytes: 0, last: 0 });
  if (t.day !== today()) {
    t.day = today(); t.bytes = 0; t.last = 0;
    if (t.blocked) { await docker(["network", "connect", "bridge", c]); t.blocked = false; notify("📶 Новый день: сеть сервера снова включена 🌿"); }
  }
  if (!t.blocked) {
    const r = await docker(["exec", c, "sh", "-c", "awk '/eth0/{gsub(\":\",\" \");print $2+$10}' /proc/net/dev"], { timeout: 10000 });
    const cur = parseInt(r.out.toString());
    if (!isNaN(cur)) { t.bytes += cur >= t.last ? cur - t.last : cur; t.last = cur; }
    if (t.bytes > TRAFFIC_GB * 1e9) {
      await docker(["network", "disconnect", "bridge", c]); t.blocked = true;
      notify(`🚫 Лимит трафика ${TRAFFIC_GB} ГБ в сутки исчерпан. Сеть сервера отключена до завтра.`);
    }
  }
  if (u.balance <= 0) { u.balance = 0; await docker(["stop", "-t", "5", c]); notify("🍃 Листики закончились, сервер остановлен."); log("balance zero, stopped", c); }
}
