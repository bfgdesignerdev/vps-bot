/** Удаляет из строк токены и ключи доступа перед записью в журнал. */
export const redact = (s: string): string =>
  s.replace(/\d{6,}:[\w-]{30,}/g, "[bot-token]").replace(/zk_[\w-]{20,}/g, "[key]").replace(/bot\[bot-token\]/g, "bot[token]");
export function log(...a: unknown[]): void {
  console.log(new Date().toISOString(), ...a.map((x) => redact(x instanceof Error ? x.message : String(x))));
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
