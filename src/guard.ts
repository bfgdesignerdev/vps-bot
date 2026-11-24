/** Фильтр команд: Docker и опасные команды запрещены. Реальную защиту дают лимиты контейнера. */
const DOCKER = /\b(docker|podman|containerd|ctr|nerdctl|kubectl|crictl)\b|docker\.sock/i;
const DANGEROUS: RegExp[] = [
  /\b(sudo|su|doas|shutdown|reboot|halt|poweroff|init|telinit|mkfs\w*|fdisk|parted|mount|umount|iptables|nft|insmod|modprobe|chroot|nsenter|unshare|setcap|chown|passwd|crontab|nc|ncat|nmap|masscan|hping3|xmrig|minerd|cpuminer)\b/i,
  /\brm\s+(-\S+\s+)*(\/|~|\*|\.\.?)(\s|$)/, /\bdd\b.*\bof=/, /:\s*\(\s*\)\s*\{/, />\s*\/dev\/(sd|vd|nvme|mem|kmem)/,
  /\/proc\/sysrq|\/sys\/|\/proc\/\d+\/mem/, /\bkill(all)?\s+(-\S+\s+)*-?1\b/, /(curl|wget)[^|]*\|\s*(ba)?sh/i,
  /\bchmod\s+(-\S+\s+)*[0-7]*777\s+\//, /stratum\+|monero|cryptonight/i, /\bwhile\s+true\b.*\bfork\b/i,
];
export function checkCommand(raw: string): string | null {
  const c = raw.trim();
  if (!c) return "Пустая команда";
  if (c.length > 500) return "Слишком длинная команда (макс. 500 символов)";
  if (DOCKER.test(c)) return "🐳 Docker недоступен внутри сервера";
  if (DANGEROUS.some((r) => r.test(c))) return "Опасная команда запрещена";
  return null;
}
