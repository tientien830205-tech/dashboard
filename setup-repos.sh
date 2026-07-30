#!/usr/bin/env bash
# 一次性建立兩個 repo 並開啟 GitHub Pages。
# 前置：gh 要以 tientien830205-tech 這個帳號登入
#   gh auth login          # 選 GitHub.com → HTTPS → 用瀏覽器登入 tientien830205-tech
#   gh auth switch --user tientien830205-tech
set -euo pipefail

OWNER=tientien830205-tech
BASE=/Users/Shared/Claude-Code

who=$(gh api user --jq .login)
if [ "$who" != "$OWNER" ]; then
  echo "✗ gh 目前是 $who，不是 $OWNER。先跑：gh auth login  然後 gh auth switch --user $OWNER" >&2
  exit 1
fi

echo "▸ 建立私有資料 repo"
cd "$BASE/dashboard-data"
gh repo create "$OWNER/dashboard-data" --private --source=. --remote=origin --push

echo "▸ 建立公開前端 repo"
cd "$BASE/dashboard"
gh repo create "$OWNER/dashboard" --public --source=. --remote=origin --push

echo "▸ 開啟 GitHub Pages"
gh api -X POST "repos/$OWNER/dashboard/pages" \
  --input - <<< '{"source":{"branch":"main","path":"/"}}' || echo "（Pages 可能已經開了，略過）"

echo
echo "✓ 完成。網址（第一次建置約等 1-2 分鐘）："
echo "  https://$OWNER.github.io/dashboard/"
echo
echo "接著去產生授權碼（只給資料 repo，權限 Contents: Read and write）："
echo "  https://github.com/settings/personal-access-tokens/new"
