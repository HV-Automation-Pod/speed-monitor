#!/usr/bin/env bash
# SpeedMonitor v4.0.0 — Manual installer
# Usage: curl -fsSL https://speed-monitor-six.vercel.app/install.sh | bash
#
# What this does:
#   1. Stops and removes any previous SpeedMonitor installation
#   2. Downloads speed_monitor.sh into ~/.local/bin/
#   3. Downloads and installs SpeedMonitor.app into ~/Applications/
#   4. Writes ~/.config/nkspeedtest/server_url
#   5. Provisions an API key from the server
#   6. Writes device_id and api_key to ~/.config/nkspeedtest/
#   7. Installs and loads the LaunchAgent (runs speed test every 10 min)
#   8. Launches SpeedMonitor.app

set -euo pipefail

SERVER_URL="https://speed-monitor-six.vercel.app"
CONFIG_DIR="$HOME/.config/nkspeedtest"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/nkspeedtest"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.speedmonitor.plist"
APP_DEST="$HOME/Applications/SpeedMonitor.app"

log() { echo "[SpeedMonitor install] $*"; }
die() { echo "[SpeedMonitor install] ERROR: $*" >&2; exit 1; }

log "Starting SpeedMonitor v4.0.0 installation..."

# 0. Stop and clean up any previous installation
log "Stopping previous installation (if any)..."
# Kill running app (any location)
killall SpeedMonitor 2>/dev/null || true
# Unload LaunchAgent (current user)
launchctl unload "$PLIST" 2>/dev/null || true
# Unload old watchdog LaunchAgent (previous versions had a separate watchdog)
launchctl unload "$LAUNCH_AGENTS/com.speedmonitor.watchdog.plist" 2>/dev/null || true
# Remove old app from /Applications (previous pkg installed here)
rm -rf /Applications/SpeedMonitor.app 2>/dev/null || true
# Remove old app from ~/Applications in case of partial previous run
rm -rf "$APP_DEST" 2>/dev/null || true

# 1. Create directories
mkdir -p "$CONFIG_DIR" "$BIN_DIR" "$DATA_DIR" "$LAUNCH_AGENTS" "$HOME/Applications"

# 2. Download speed_monitor.sh
log "Downloading speed_monitor.sh..."
curl -fsSL "$SERVER_URL/speed_monitor.sh" -o "$BIN_DIR/speed_monitor.sh"
chmod +x "$BIN_DIR/speed_monitor.sh"
log "speed_monitor.sh installed to $BIN_DIR/"

# 3. Write server_url
printf '%s\n' "$SERVER_URL" > "$CONFIG_DIR/server_url"
log "server_url set to $SERVER_URL"

# 4. Download and install SpeedMonitor.app
log "Downloading SpeedMonitor.app..."
TMP_ZIP=$(mktemp /tmp/SpeedMonitor-XXXXXX.zip)
curl -fsSL "$SERVER_URL/SpeedMonitor.app.zip" -o "$TMP_ZIP"
rm -rf "$APP_DEST"
unzip -q "$TMP_ZIP" -d "$HOME/Applications/"
rm -f "$TMP_ZIP"
log "SpeedMonitor.app installed to ~/Applications/"

# 5. Provision API key
log "Provisioning API key from server..."
PROVISION=$(curl -s -X POST \
    --max-time 15 --connect-timeout 5 \
    -H "Content-Type: application/json" \
    "$SERVER_URL/api/ingest/provision" 2>/dev/null || true)

DEVICE_ID=$(python3 -c \
    "import sys,json; d=json.loads(sys.stdin.read()); print(d['device_id'])" \
    <<< "$PROVISION" 2>/dev/null || true)
API_KEY=$(python3 -c \
    "import sys,json; d=json.loads(sys.stdin.read()); print(d['api_key'])" \
    <<< "$PROVISION" 2>/dev/null || true)

if [[ -n "$DEVICE_ID" && -n "$API_KEY" ]]; then
    printf '%s\n' "$DEVICE_ID" > "$CONFIG_DIR/device_id"
    printf '%s\n' "$API_KEY"   > "$CONFIG_DIR/api_key"
    chmod 600 "$CONFIG_DIR/api_key"
    log "API key provisioned — device_id: $DEVICE_ID"
else
    log "WARNING: Provisioning failed. Check your network and re-run the installer."
    log "Manual provision: curl -X POST $SERVER_URL/api/ingest/provision"
fi

# 6. Write LaunchAgent plist
cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.speedmonitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/speed_monitor.sh</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/launchd_stdout.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/launchd_stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# 7. Load LaunchAgent
launchctl load "$PLIST"
log "LaunchAgent loaded — speed tests will run every 10 minutes"

# 8. Launch the new SpeedMonitor.app
log "Launching SpeedMonitor.app..."
open "$APP_DEST"

echo ""
echo "SpeedMonitor v4.0.0 installation complete."
echo ""
echo "Next steps:"
echo "  1. Look for the SpeedMonitor icon in your menu bar"
echo "  2. The first speed test runs automatically within ~30 seconds"
echo "  3. Your device will appear in the IT dashboard within ~5 minutes"
echo ""
