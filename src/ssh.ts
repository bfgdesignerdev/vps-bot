import { docker } from "./docker.js";

/** Внешний порт SSH контейнера (проброс 2222). null, если контейнер создан без проброса (старый). */
export async function sshPort(name: string): Promise<number | null> {
  const r = await docker(["port", name, "2222/tcp"]);
  const m = r.code === 0 ? r.out.toString().match(/:(\d+)\s*$/m) : null;
  return m ? parseInt(m[1]) : null;
}

/** Настраивает sshd (только вход по ключу, без пароля), запускает его и выдаёт НОВЫЙ приватный ключ. Старый ключ перестаёт работать. */
const SSH_SETUP = `set -e
mkdir -p ~/.ssh/host && chmod 700 ~/.ssh
[ -f ~/.ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/host/ssh_host_ed25519_key
cat > ~/.ssh/sshd_config <<EOF
Port 2222
HostKey /home/user/.ssh/host/ssh_host_ed25519_key
PidFile /home/user/.ssh/sshd.pid
AuthorizedKeysFile /home/user/.ssh/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
PermitRootLogin no
AllowUsers user
MaxAuthTries 3
EOF
rm -f /tmp/zk /tmp/zk.pub
ssh-keygen -q -t ed25519 -N '' -C zelenka -f /tmp/zk
cp /tmp/zk.pub ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
pgrep -u user -x sshd >/dev/null || /usr/sbin/sshd -f ~/.ssh/sshd_config -E ~/.ssh/sshd.log
cat /tmp/zk; rm -f /tmp/zk /tmp/zk.pub`;

export async function setupSsh(name: string): Promise<{ ok: boolean; key: string }> {
  const r = await docker(["exec", "-u", "user", "-w", "/home/user", name, "bash", "-c", SSH_SETUP], { timeout: 30000 });
  const key = r.out.toString();
  return { ok: r.code === 0 && key.includes("BEGIN OPENSSH PRIVATE KEY"), key };
}

export const SSH_WARN = "⚠️ <b>ВНИМАНИЕ!</b> НИКОМУ не давайте данные SSH-подключения (адрес, порт и ключ). Кто их получит, сможет зайти на ваш сервер и перехватить контроль над ним. Не публикуйте и не пересылайте ключ.";
