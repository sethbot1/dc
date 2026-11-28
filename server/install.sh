#!/usr/bin/env bash
# Sets up the Dueck Clicker server on Lubuntu / Ubuntu. You only run this once:
#   bash install.sh
# After that the Mac mini looks at GitHub every 5 minutes and updates itself when new server code is pushed.
set -euo pipefail
REPO="${REPO:-https://github.com/sethbot1/dc.git}"
BRANCH="${BRANCH:-main}"
ME="$(id -un)"
HOME_DIR="$(getent passwd "$ME" | cut -d: -f6)"
CODE="$HOME_DIR/dueck"          # the code, kept in step with GitHub
DATA="$HOME_DIR/dueck-data"     # players, saves, backups and settings: never touched by updates
say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
if [ "$ME" = root ]; then echo "Run this as your normal user (not with sudo). It asks for your password when it needs it."; exit 1; fi

say "Installing the tools it needs"
sudo apt-get update
sudo apt-get install -y git curl ca-certificates pciutils

# Node.js 22.13 or newer (the server uses Node's built-in SQLite)
need_node=1
if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node')"; maj="${v%%.*}"; min="$(echo "$v" | cut -d. -f2)"
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" = 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE="$(command -v node)"
say "Node $("$NODE" -v) is ready"

say "Getting the code from GitHub ($BRANCH)"
if [ -d "$CODE/.git" ]; then
  git -C "$CODE" fetch --depth 1 origin "$BRANCH" && git -C "$CODE" checkout -B "$BRANCH" FETCH_HEAD && git -C "$CODE" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$CODE"
fi

mkdir -p "$DATA/backups"
if [ ! -f "$DATA/server.env" ]; then
  pw="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  cat > "$DATA/server.env" <<ENV
PORT=8787
HOST=127.0.0.1
ADMIN_PASSWORD=$pw
ALLOWED_ORIGINS=https://sethbot1.github.io,http://localhost:8000,http://127.0.0.1:8000
DB_PATH=$DATA/dueck.db
BACKUP_DIR=$DATA/backups
ENV
  chmod 600 "$DATA/server.env"
fi

say "Installing the services"
# the server: starts at power-on (nobody has to log in) and restarts within 3 seconds if it ever stops
sudo tee /etc/systemd/system/dueck-server.service >/dev/null <<UNIT
[Unit]
Description=Dueck Clicker server
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$CODE/server
EnvironmentFile=$DATA/server.env
ExecStart=$NODE --no-warnings $CODE/server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# the updater: every 5 minutes, pulls new server code from GitHub and restarts the server if it changed
sudo tee /etc/systemd/system/dueck-update.service >/dev/null <<UNIT
[Unit]
Description=Update the Dueck Clicker server from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=DUECK_USER=$ME DUECK_CODE=$CODE DUECK_BRANCH=$BRANCH
ExecStart=/bin/bash $CODE/server/update.sh
UNIT
sudo tee /etc/systemd/system/dueck-update.timer >/dev/null <<UNIT
[Unit]
Description=Check GitHub for Dueck Clicker server updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

# turn the Mac mini back on by itself after a power cut. Macs need a chip setting for this,
# and it forgets it at every boot, so a tiny service sets it again each time.
POWER=""
if lspci -n -s 00:1f.0 2>/dev/null | grep -q " 8086:"; then POWER="setpci -s 00:1f.0 0xa4.b=0"        # 2011 / 2012 and newer Intel Mac minis
elif lspci -n -s 00:03.0 2>/dev/null | grep -q " 10de:"; then POWER="setpci -s 00:03.0 0x7b.b=0x19"   # 2009 / 2010 Mac minis (NVIDIA chipset)
fi
if [ -n "$POWER" ]; then
  sudo tee /etc/systemd/system/dueck-power-on.service >/dev/null <<UNIT
[Unit]
Description=Turn the Mac mini back on after a power cut

[Service]
Type=oneshot
ExecStart=$(command -v setpci) ${POWER#setpci }

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now dueck-power-on.service
else
  echo "Couldn't recognise this Mac's chipset, so power-on-after-power-cut was skipped."
fi

sudo systemctl daemon-reload
sudo systemctl enable dueck-server.service dueck-update.timer
sudo systemctl restart dueck-server.service
sudo systemctl start dueck-update.timer

say "Turning off sleep and suspend (a server must never fall asleep)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

sleep 2
if curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then say "The server is running"; else echo "The server didn't answer. See: journalctl -u dueck-server -n 50"; fi

if ! command -v tailscale >/dev/null; then
  say "Installing Tailscale (the tunnel, so you don't need port forwarding)"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

say "Done!"
echo "Admin password: $(grep ^ADMIN_PASSWORD= "$DATA/server.env" | cut -d= -f2)   (saved in $DATA/server.env)"
echo
echo "Last steps, run these one at a time:"
echo "   sudo tailscale up"
echo "   sudo tailscale funnel --bg 8787"
echo "   tailscale funnel status"
