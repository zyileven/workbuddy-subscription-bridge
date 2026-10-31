#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '请先安装并启动 Docker。' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '需要 Docker Compose v2 或以上版本。' >&2
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  printf '%s\n' '已创建 .env。请填写 NGROK_AUTHTOKEN 后重新执行 sh start.sh。' >&2
  exit 1
fi

compose() { docker compose --env-file .env --profile public "$@"; }
compose config --quiet
if ! compose config --environment | awk '
  /^NGROK_AUTHTOKEN=/ { sub(/^[^=]*=/, ""); if ($0 ~ /[^[:space:]]/) configured = 1 }
  END { exit !configured }
'; then
  printf '%s\n' '请在 .env 中填写 NGROK_AUTHTOKEN 后重试。' >&2
  exit 1
fi

printf '%s\n' '正在构建并启动桥接与 ngrok…'
compose up -d --build --wait --wait-timeout 120
printf '%s\n' \
  '请在浏览器打开下面的授权链接。' \
  '无桌面服务器需要先在浏览器所在电脑建立 1455 的 SSH 回调转发，步骤见 README。' \
  '登录完成后将自动打印 Astra、Sol、Terra、Luna 各系列最新可用模型的 WorkBuddy 配置数组（包含公网 URL 和桥接 Key）。'
compose exec -T bridge node src/cli.mjs login --host 0.0.0.0 --no-open --require-public
