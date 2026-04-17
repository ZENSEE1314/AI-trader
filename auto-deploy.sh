#!/bin/bash
# Auto-deploy: pull latest code every 60s and restart if changed
echo "[auto-deploy] Started"

while true; do
  BEFORE=$(git rev-parse HEAD)
  git pull origin main --quiet 2>/dev/null
  AFTER=$(git rev-parse HEAD)

  if [ "$BEFORE" != "$AFTER" ]; then
    echo "[auto-deploy] New code detected ($BEFORE → $AFTER) — restarting..."
    pm2 restart all
    echo "[auto-deploy] Restarted at $(date)"
  fi

  sleep 60
done
