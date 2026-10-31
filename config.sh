#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

case "${1:-}" in
  '') ;;
  --update)
    # Refresh the running image after a source update, retaining the login volume.
    docker compose --profile public up -d --build --wait
    ;;
  *)
    printf '%s\n' '用法：sh config.sh [--update]' '默认只获取配置；--update 先重建容器，保留登录状态。' >&2
    exit 2
    ;;
esac

exec docker compose --profile public exec -T bridge node src/cli.mjs connection --require-public
