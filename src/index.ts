// 🍀 Zelenka Cloud · Beta — Telegram-бот с реальными Docker-контейнерами (long polling)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { checkCommand } from "./guard.js";
import { docker, ensureImage, createContainer, state, stats, exec, SPECS_TEXT } from "./docker.js";

const TOKEN = process.env.BOT_TOKEN || "";
const MAX_SERVERS = parseInt(process.env.MAX_SERVERS || "20");
const DATA = process.env.DATA_DIR || "./data";
if (!TOKEN) { console.error("Задайте BOT_TOKEN"); process.exit(1); }

interface U { name?: string; email?: string; step: "idle" | "name" | "email" | "console"; container?: string; creating?: boolean; diskEnforced?: boolean; execs: number[]; balance?: number; traffic?: { day: string; bytes: number; last: number; blocked?: boolean } }
type Kb = { text: string; callback_data: string }[][];
mkdirSync(DATA, { recursive: true });
const DB = DATA + "/db.json";
const db: Record<string, U> = existsSync(DB) ? JSON.parse(readFileSync(DB, "utf8")) : {};
const save = () => writeFileSync(DB, JSON.stringify(db));
const START_BALANCE = 15, COST_PER_HOUR = 2, TRAFFIC_GB = parseFloat(process.env.TRAFFIC_LIMIT_GB || "5");
const getU = (id: number): U => { const u = (db[id] ??= { step: "idle", execs: [] }); u.balance ??= START_BALANCE; return u; };
const today = () => new Date().toISOString().slice(0, 10);
const bal = (u: U) => (Math.max(0, u.balance ?? 0)).toFixed(1);
const hoursLeft = (u: U) => ((u.balance ?? 0) / COST_PER_HOUR).toFixed(1);
const gb = (b: number) => (b / 1e9).toFixed(2);
const h = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
const cname = (id: number) => "zc-" + id;
const FLOWERS = ["🌱", "🌿", "🍀", "🌷", "🌼", "🌸", "🌺", "💐"];

async function tg(method: string, body: unknown): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok || data.ok !== true) throw new Error(`Telegram API ${method} failed (${r.status}): ${data.description || r.statusText}`);
  return data;
}
const send = (chat: number, text: string, kb?: Kb) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup: kb && { inline_keyboard: kb } });
const edit = (chat: number, id: number, text: string, kb?: Kb) => tg("editMessageText", { chat_id: chat, message_id: id, text, parse_mode: "HTML", reply_markup: kb && { inline_keyboard: kb } });

const welcome = (): [string, Kb] => ["🍀 <b>Zelenka Cloud</b> <i>· beta</i>\n\n🌸 <b>Добро пожаловать!</b>\nВы сможете бесплатно взять VDS, попользоваться и так далее.", [[{ text: "🌷 Перейти к тарифам", callback_data: "tariffs" }]]];
const tariffs = (): [string, Kb] => [`🌱 <b>Тариф</b>\n\n┏━━━━━━━━━━━━━━┓\n  🌸 <b>Free Бета · 0 ₽</b>\n┗━━━━━━━━━━━━━━┛\n🌼 Настоящий Linux-сервер: ${SPECS_TEXT}\n🌼 Команды для любых задач (python, node, git, curl)\n🌼 Веб-консоль, загрузка и скачивание файлов\n\n🚫 Docker и опасные команды запрещены\n🍃 Баланс: 15 листиков при регистрации. Пока сервер работает, каждый час списывается 2 листика (остановленный сервер ничего не стоит).\n📶 Трафик: до ${TRAFFIC_GB} ГБ в сутки\n⚠️ Мелкие ограничения: 20 сек на команду, 20 команд в минуту`,
  [[{ text: "🌺 Взять", callback_data: "take" }], [{ text: "← Назад", callback_data: "home" }]]];
const back: Kb = [[{ text: "← К серверу", callback_data: "my" }]];

async function panel(u: U): Promise<[string, Kb]> {
  const st = await state(u.container!), on = st === "running";
  let info = "";
  if (on) { const s = await stats(u.container!); info = `\n📊 CPU ${h(s.cpu)} · ОЗУ ${h(s.mem)} / 512 МБ · диск ${s.disk}`; }
  const tr = u.traffic?.day === today() ? u.traffic : undefined;
  const t = `🌿 <b>Мой сервер</b>\n\n${on ? "🟢 Работает" : st === "missing" ? "⚪ Не найден" : "🔴 Остановлен"}\n💾 ${SPECS_TEXT}${info}\n🍃 Баланс: <b>${bal(u)}</b> листиков (-${COST_PER_HOUR}/час, хватит на ~${hoursLeft(u)} ч)\n📶 Трафик сегодня: ${gb(tr?.bytes ?? 0)} / ${TRAFFIC_GB} ГБ${tr?.blocked ? " 🚫 сеть отключена до завтра" : ""}`;
  return [t, [[on ? { text: "■ Остановить", callback_data: "stop" } : { text: "▶ Запустить", callback_data: "start" }, { text: "⟳ Перезагрузить", callback_data: "restart" }],
    [{ text: "🖥 Веб-консоль", callback_data: "console" }, { text: "📁 Файлы", callback_data: "files" }],
    [{ text: "🔄 Обновить", callback_data: "my" }, { text: "🗑 Удалить", callback_data: "del" }]]];
}

async function createFlow(chat: number, mid: number, id: number): Promise<void> {
  const u = getU(id), steps = ["Выделяем ресурсы", "Запускаем систему", "Настраиваем сеть", "Почти готово"];
  const work = (async () => { const cnt = await docker(["ps", "-aq", "--filter", "label=zc=1"]); if (cnt.out.toString().split("\n").filter(Boolean).length >= MAX_SERVERS) return { ok: false, diskEnforced: false, err: "Свободные места закончились" };
    return createContainer(cname(id)); })();
  let result: Awaited<typeof work> | null = null; work.then((r) => (result = r));
  for (let i = 1; i <= 150; i++) {              // до ~5 минут
    await new Promise((r) => setTimeout(r, 2000));
    if (result && i >= 8) break;                 // минимум ~16 сек красивой анимации
    const p = result ? 0.95 : Math.min(0.9, i / 40), f = Math.round(p * 10);
    await edit(chat, mid, `${FLOWERS[i % 8]} <b>Создаём ваш сервер…</b>\n\nНужно подождать 2–5 минут.\n\n${"🌸".repeat(f)}${"▫️".repeat(10 - f)}  ${Math.round(p * 100)}%\n<i>${steps[Math.min(3, Math.floor(p * 4))]}…</i>`);
  }
  const r = result ?? (await work);
  u.creating = false;
  if (!r.ok) { u.container = undefined; save(); console.log("create failed", r.err); return void (await edit(chat, mid, "😔 Не удалось создать сервер. Попробуйте позже.", [[{ text: "🌺 Повторить", callback_data: "take" }]])); }
  u.container = cname(id); u.diskEnforced = r.diskEnforced; save();
  await edit(chat, mid, "🌷 <b>Сервер готов!</b>\nТариф Free Бета подключён автоматически.", [[{ text: "🌿 Мой сервер", callback_data: "my" }]]);
}

async function onCallback(q: any): Promise<void> {
  const id = q.from.id as number, chat = q.message.chat.id as number, mid = q.message.message_id as number, d = q.data as string;
  void tg("answerCallbackQuery", { callback_query_id: q.id }).catch((e) => console.log("callback query err", String(e)));
  const u = getU(id), show = (t: string, kb?: Kb) => edit(chat, mid, t, kb);
  if (d === "home") { u.step = "idle"; return void (await show(...welcome())); }
  if (d === "tariffs") return void (await show(...tariffs()));
  if (d === "take") {
    if (u.container) return void (await show(...(await panel(u))));
    if (u.creating) return void (await show("⏳ Сервер уже создаётся…"));
    u.step = "name"; save(); return void (await show("🌸 <b>Регистрация</b>\n\nКак вас зовут? Напишите имя сообщением."));
  }
  if (!u.container) return void (await show(...welcome()));
  const c = u.container;
  if (d === "my") { u.step = "idle"; return void (await show(...(await panel(u)))); }
  if (d === "start") { if ((u.balance ?? 0) <= 0) return void (await show("🍃 Листики закончились, запуск невозможен.", (await panel(u))[1])); await docker(["start", c]); }
  if (d === "stop") await docker(["stop", "-t", "5", c]);
  if (d === "restart") { await show("⟳ <b>Перезагрузка…</b> 🌿"); await docker(["restart", "-t", "5", c]); }
  if (["start", "stop", "restart"].includes(d)) return void (await show(...(await panel(u))));
  if (d === "del") return void (await show("🗑 <b>Удалить сервер?</b>\nВсе файлы будут потеряны.", [[{ text: "Да, удалить", callback_data: "delc" }, { text: "Отмена", callback_data: "my" }]]));
  if (d === "delc") { await docker(["rm", "-f", "-v", c]); u.container = undefined; u.step = "idle"; save(); return void (await show("🌱 Сервер удалён. Можно взять новый.", [[{ text: "🌺 Взять", callback_data: "take" }]])); }
  if ((await state(c)) !== "running") return void (await show("⚠️ Сервер остановлен. Запустите его.", (await panel(u))[1]));
  if (d === "console") { u.step = "console"; return void (await show("🖥 <b>Веб-консоль</b>\nОтправляйте команды сообщениями (bash). Попробуйте <code>uname -a</code> или <code>python3 --version</code>.\n📎 Файл (до 1 МБ), отправленный боту, попадёт в /home/user.", back)); }
  if (d === "files") {
    const r = await exec(c, "ls -1p | head -40"); const names = r.out.toString().split("\n").filter((n) => /^[\w.\-]{1,60}$/.test(n));
    return void (await show("📁 <b>Файлы</b> /home/user" + (names.length ? "" : "\n<i>пусто, отправьте файл боту</i>"), [...names.map((n) => [{ text: "📄 " + n, callback_data: "f:" + n }]), ...back]));
  }
  if (d.startsWith("f:") && /^[\w.\-]{1,60}$/.test(d.slice(2))) {
    const n = d.slice(2), r = await exec(c, `head -c 3000 -- "$HOME/${n}"`);
    return void (await show(`📄 <b>${h(n)}</b>\n<pre>${h(r.out.toString())}</pre>`, [[{ text: "⬇️ Скачать", callback_data: "dl:" + n }, { text: "← Файлы", callback_data: "files" }]]));
  }
  if (d.startsWith("dl:") && /^[\w.\-]{1,60}$/.test(d.slice(3))) {
    const n = d.slice(3), r = await docker(["exec", "-u", "user", c, "head", "-c", "5000000", `/home/user/${n}`]);
    const fd = new FormData(); fd.append("chat_id", String(chat)); fd.append("document", new Blob([Uint8Array.from(r.out)]), n);
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: fd });
  }
}

async function onMessage(m: any): Promise<void> {
  const id = m.from.id as number, chat = m.chat.id as number, text = (m.text || "").trim(), u = getU(id);
  if (text.startsWith("/start") || text === "/menu") return void (u.container ? await send(chat, ...(await panel(u))) : await send(chat, ...welcome()));
  if (m.document && u.container) {
    const doc = m.document;
    if (doc.file_size > 1_000_000 || !/^[\w.\-]{1,60}$/.test(doc.file_name || "")) return void (await send(chat, "Файл до 1 МБ, имя из букв, цифр, точки и дефиса 🌼"));
    const f = await tg("getFile", { file_id: doc.file_id });
    const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`)).arrayBuffer());
    const r = await docker(["exec", "-i", "-u", "user", u.container, "sh", "-c", 'cat > "/home/user/$1"', "sh", doc.file_name], { input: buf });
    return void (await send(chat, r.code === 0 ? `✅ <b>${h(doc.file_name)}</b> загружен в /home/user` : "Не удалось загрузить (сервер запущен?)", back));
  }
  if (u.step === "name") {
    if (text.length < 2 || text.length > 40) return void (await send(chat, "Введите имя от 2 до 40 символов 🌼"));
    u.name = text; u.step = "email"; save(); return void (await send(chat, `Приятно познакомиться, <b>${h(text)}</b>! 🌷\nТеперь напишите вашу почту.`));
  }
  if (u.step === "email") {
    if (!/^\S+@\S+\.\S+$/.test(text)) return void (await send(chat, "Похоже, почта неверная. Попробуйте ещё раз 🌼"));
    u.email = text.toLowerCase(); u.step = "idle"; u.creating = true; u.balance = START_BALANCE; save();
    const r = await send(chat, "🌱 <b>Аккаунт создан!</b>\nТариф Free Бета подключён автоматически.\n🍃 Вам начислено 15 листиков.\n\n⏳ Нужно подождать 2–5 минут…");
    return void createFlow(chat, r.result.message_id, id);
  }
  if (u.step === "console" && u.container) {
    const bad = checkCommand(text);
    if (bad) return void (await send(chat, "⛔ " + h(bad)));
    const now = Date.now(); u.execs = u.execs.filter((t) => now - t < 60000);
    if (u.execs.length >= 20) return void (await send(chat, "⏱ Лимит: 20 команд в минуту"));
    u.execs.push(now);
    const r = await exec(u.container, text);
    let out = (r.out.toString() + (r.code === 137 ? "\n[остановлено: превышено 20 секунд]" : r.err.replace(/^.*Error response.*$/gm, ""))).trim() || "(пусто)";
    if (out.length > 3500) out = out.slice(0, 3500) + "\n…обрезано";
    return void (await send(chat, `<pre>$ ${h(text)}\n${h(out)}</pre>`, back));
  }
  await send(chat, "Нажмите /start 🌿");
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return; ticking = true;
  try {
    for (const [k, u] of Object.entries(db)) {
      const c = u.container, id = Number(k);
      if (!c || (await state(c)) !== "running") continue;
      u.balance = (u.balance ?? START_BALANCE) - COST_PER_HOUR / 60;           // -2 листика в час
      const t = (u.traffic ??= { day: today(), bytes: 0, last: 0 });
      if (t.day !== today()) { t.day = today(); t.bytes = 0; t.last = 0; if (t.blocked) { await docker(["network", "connect", "bridge", c]); t.blocked = false; send(id, "📶 Новый день: сеть сервера снова включена 🌿"); } }
      if (!t.blocked) {
        const r = await docker(["exec", c, "sh", "-c", "awk '/eth0/{gsub(\":\",\" \");print $2+$10}' /proc/net/dev"], { timeout: 10000 });
        const cur = parseInt(r.out.toString());
        if (!isNaN(cur)) { t.bytes += cur >= t.last ? cur - t.last : cur; t.last = cur; }
        if (t.bytes > TRAFFIC_GB * 1e9) { await docker(["network", "disconnect", "bridge", c]); t.blocked = true; send(id, `🚫 Лимит трафика ${TRAFFIC_GB} ГБ в сутки исчерпан. Сеть сервера отключена до завтра.`); }
      }
      if (u.balance <= 0) { u.balance = 0; await docker(["stop", "-t", "5", c]); send(id, "🍃 Листики закончились, сервер остановлен.", [[{ text: "🌿 Мой сервер", callback_data: "my" }]]); }
    }
    save();
  } catch (e) { console.log("tick err", String(e)); }
  ticking = false;
}
setInterval(tick, 60000);
await ensureImage();
console.log("🍀 Zelenka Cloud bot запущен");
let offset = 0;
for (;;) {
  try {
    const r = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
    for (const up of r.result ?? []) {
      offset = up.update_id + 1;
      console.log("update received", up.update_id, up.message ? "message" : up.callback_query ? "callback_query" : "other");
      const run = up.callback_query ? onCallback(up.callback_query) : up.message ? onMessage(up.message) : null;
      run?.catch((e) => console.log("err", String(e)));
    }
  } catch (e) { console.log("poll err", String(e)); await new Promise((r) => setTimeout(r, 3000)); }
}
