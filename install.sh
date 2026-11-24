#!/usr/bin/env bash
# 🍀 Zelenka Cloud Bot: установка одной командой для Ubuntu 22.04
# Запуск:  sudo bash install.sh
set -euo pipefail

APP=/opt/zelenka-cloud-bot
SVC=zelenka-bot
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo: sudo bash install.sh"; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "⚠️ Скрипт рассчитан на Ubuntu 22.04, у вас: ${PRETTY_NAME:-?}"
export DEBIAN_FRONTEND=noninteractive

echo "🌱 [1/6] Системные пакеты"
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync ufw >/dev/null

echo "🐳 [2/6] Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io >/dev/null
fi
systemctl enable --now docker

echo "🟢 [3/6] Node.js 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs >/dev/null
fi
echo "node $(node -v)"

echo "🌿 [4/6] Пользователь и файлы"
id zelenka >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin zelenka
usermod -aG docker zelenka
mkdir -p "$APP"
rsync -a --exclude node_modules --exclude dist --exclude data --exclude .git "$SRC"/ "$APP"/

if ! grep -qE '^BOT_TOKEN=.+' "$APP/.env" 2>/dev/null; then
  read -rp "Вставьте токен бота (от @BotFather): " TOKEN
  printf 'BOT_TOKEN=%s\nMAX_SERVERS=20\nDATA_DIR=./data\nTRAFFIC_LIMIT_GB=5\nSERVER_HOST=\n' "$TOKEN" > "$APP/.env"
fi
chmod 600 "$APP/.env"
chown -R zelenka:zelenka "$APP"

echo "🔨 [5/6] Сборка"
cd "$APP"
sudo -u zelenka -H npm install --no-audit --no-fund
sudo -u zelenka -H npm run build

echo "🚀 [6/6] Автозапуск 24/7 (systemd)"
cat > /etc/systemd/system/$SVC.service <<UNIT
[Unit]
Description=Zelenka Cloud Telegram bot
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=zelenka
Group=docker
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=/usr/bin/node dist/bot.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$APP

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now $SVC
sleep 3
systemctl --no-pager --lines=8 status $SVC || true

cat <<MSG

✅ Готово! Откройте в фаерволе диапазон портов Docker 32768-60999/tcp для SSH.
 Бот работает 24/7 и стартует после перезагрузки сервера.
Первый запуск собирает базовый образ (1-3 минуты), потом бот ответит на /start.

Полезные команды:
  journalctl -u $SVC -f        логи
  systemctl restart $SVC       перезапуск
  systemctl stop $SVC          остановка
Обновить после правок:  sudo bash $APP/install.sh
MSG
