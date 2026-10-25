#!/usr/bin/env bash
# 每日自动更新：本机（国内出口）作为权威检测源
# 由 crontab 调用：0 9 * * * /root/test/nav/scripts/daily.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG="reports/run.log"
mkdir -p reports
{
  echo "===== $(date '+%F %T') 开始 ====="

  # 先对齐远端，避免本地历史分叉
  git fetch -q origin main && git reset --hard -q origin/main

  node scripts/check.mjs --concurrency 8 --timeout 12000
  node scripts/discover.mjs --max 40
  node scripts/build.mjs

  git add data reports web/data.json web/sitemap.txt
  if git diff --cached --quiet; then
    echo "无变更，跳过提交"
    exit 0
  fi

  STAT=$(node -e "const s=require('./web/data.json').stats;console.log('live='+s.live+' limited='+s.limited+' dead='+s.dead+' pending='+s.pending)" 2>/dev/null || echo "stats=err")
  git commit -q -m "chore(auto): $(date +%F) 自动检测 $STAT"

  for i in 1 2 3; do
    if git push -q origin main; then
      echo "push 成功（第 $i 次）| $STAT"
      break
    fi
    echo "push 被拒，rebase 重试 $i/3"
    git pull --rebase -q --autostash origin main || { git rebase --abort 2>/dev/null; git fetch -q origin main && git reset --hard -q origin/main; }
    sleep 3
  done
  echo "===== $(date '+%F %T') 结束 ====="
} >>"$LOG" 2>&1

# 日志只保留最近 500 行
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
