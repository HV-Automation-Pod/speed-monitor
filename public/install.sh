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
#   8. Installs and loads the app LaunchAgent (auto-starts app at login)

set -euo pipefail

# When run as root via Jamf: install speedtest-cli system-wide (pip3, no admin needed),
# then re-exec as the logged-in console user for the rest of the install.
# Homebrew refuses root AND requires the user to be an admin — avoid both.
if [[ "$(id -u)" == "0" ]]; then
    CONSOLE_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "")
    if [[ -z "$CONSOLE_USER" || "$CONSOLE_USER" == "root" ]]; then
        echo "[SpeedMonitor install] ERROR: No user logged in at console. Deploy when a user is active." >&2
        exit 1
    fi

    # Install speedtest-cli as root so the non-admin user doesn't need to
    if ! command -v speedtest-cli &>/dev/null; then
        echo "[SpeedMonitor install] Installing speedtest-cli (pip3)..."
        pip3 install speedtest-cli --quiet --break-system-packages 2>/dev/null || \
        pip3 install speedtest-cli --quiet 2>/dev/null || \
        echo "[SpeedMonitor install] WARNING: speedtest-cli install failed — will use Cloudflare fallback"
    fi

    echo "[SpeedMonitor install] Running as root — re-launching as $CONSOLE_USER..."
    rm -f /tmp/speedmonitor_install_* 2>/dev/null || true  # clean up any stale temp files
    TMP=$(mktemp /tmp/speedmonitor_install_XXXXXX)         # no suffix — macOS mktemp requires X's at end
    curl -fsSL --retry 3 --retry-delay 2 "https://speed-monitor-six.vercel.app/install.sh" -o "$TMP"
    chmod 755 "$TMP"
    USER_UID=$(id -u "$CONSOLE_USER")
    # launchctl asuser establishes the full login session context (required for ~/Library access in Jamf)
    exec launchctl asuser "$USER_UID" sudo -u "$CONSOLE_USER" HOME="/Users/$CONSOLE_USER" USER="$CONSOLE_USER" /bin/bash "$TMP"
fi

SERVER_URL="https://speed-monitor-six.vercel.app"
CONFIG_DIR="$HOME/.config/nkspeedtest"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/nkspeedtest"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.speedmonitor.plist"
APP_PLIST="$LAUNCH_AGENTS/com.speedmonitor.app.plist"
APP_DEST="$HOME/Applications/SpeedMonitor.app"

log() { echo "[SpeedMonitor install] $*"; }
die() { echo "[SpeedMonitor install] ERROR: $*" >&2; exit 1; }

log "Starting SpeedMonitor v4.0.0 installation..."

# 0. Stop and clean up any previous installation
log "Stopping previous installation (if any)..."
# Kill running app and unload all LaunchAgents (idempotent)
killall SpeedMonitor 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor" 2>/dev/null || \
    launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor.app" 2>/dev/null || \
    launchctl unload "$APP_PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor.watchdog" 2>/dev/null || \
    launchctl unload "$LAUNCH_AGENTS/com.speedmonitor.watchdog.plist" 2>/dev/null || true
# Wait for app process to fully exit before relaunching
sleep 1
# Remove old app from /Applications (previous pkg installed here)
rm -rf /Applications/SpeedMonitor.app 2>/dev/null || true
# Remove old app from ~/Applications in case of partial previous run
rm -rf "$APP_DEST" 2>/dev/null || true

# 1. Create directories
mkdir -p "$CONFIG_DIR" "$BIN_DIR" "$DATA_DIR" "$LAUNCH_AGENTS" "$HOME/Applications"

# 2. Ensure speedtest-cli is available (installed as root in Jamf flow; try Homebrew as fallback)
if ! command -v speedtest-cli &>/dev/null; then
    log "speedtest-cli not found — attempting Homebrew install..."
    if ! command -v brew &>/dev/null; then
        NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 2>/dev/null || true
        eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
    fi
    brew install speedtest-cli --quiet 2>/dev/null || log "WARNING: speedtest-cli install failed — speeds will use Cloudflare fallback"
else
    log "speedtest-cli already installed"
fi

# 2b. Download speed_monitor.sh
log "Downloading speed_monitor.sh..."
curl -fsSL --retry 3 --retry-delay 2 "$SERVER_URL/speed_monitor.sh" -o "$BIN_DIR/speed_monitor.sh"
chmod +x "$BIN_DIR/speed_monitor.sh"
log "speed_monitor.sh installed to $BIN_DIR/"

# 3. Write server_url
printf '%s\n' "$SERVER_URL" > "$CONFIG_DIR/server_url"
log "server_url set to $SERVER_URL"

# 3a. Detect user email from signed-in Apple ID
APPLE_ID=$(python3 -c "
import subprocess, re
out = subprocess.run(['defaults', 'read', 'MobileMeAccounts', 'Accounts'],
                     capture_output=True, text=True).stdout
m = re.search(r'AccountID\s*=\s*\"([^\"]+)\"', out)
print(m.group(1) if m else '')
" 2>/dev/null || true)

if [[ -n "$APPLE_ID" ]]; then
    printf '%s\n' "$APPLE_ID" > "$CONFIG_DIR/user_email"
    log "user_email set from Apple ID: $APPLE_ID"
else
    log "WARNING: Could not detect Apple ID — user_email not set. Employee portal will not link to this device."
fi

# 4. Download and install SpeedMonitor.app
log "Downloading SpeedMonitor.app..."
TMP_ZIP=$(mktemp /tmp/SpeedMonitor-XXXXXX.zip)
curl -fsSL --retry 3 --retry-delay 2 "$SERVER_URL/SpeedMonitor.app.zip" -o "$TMP_ZIP"
rm -rf "$APP_DEST"
unzip -q "$TMP_ZIP" -d "$HOME/Applications/"
rm -f "$TMP_ZIP"
log "SpeedMonitor.app installed to ~/Applications/"

# 5. Provision API key (reuse existing device_id on reinstall so the same device
#    is updated in the dashboard rather than creating a duplicate entry)
log "Provisioning API key from server..."
EXISTING_DEVICE_ID=""
[[ -f "$CONFIG_DIR/device_id" ]] && EXISTING_DEVICE_ID=$(tr -d '[:space:]' < "$CONFIG_DIR/device_id" 2>/dev/null || true)

if [[ -n "$EXISTING_DEVICE_ID" ]]; then
    PROVISION_BODY="{\"device_id\":\"$EXISTING_DEVICE_ID\"}"
    log "Re-provisioning existing device: $EXISTING_DEVICE_ID"
else
    PROVISION_BODY="{}"
fi

PROVISION=$(curl -s -X POST \
    --max-time 15 --connect-timeout 5 \
    -H "Content-Type: application/json" \
    -d "$PROVISION_BODY" \
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
  <key>StartInterval</key><integer>1200</integer>
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

# 7. Load LaunchAgent (try modern bootstrap first, fall back to legacy load)
launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
    launchctl load "$PLIST" 2>/dev/null || \
    log "WARNING: LaunchAgent could not be loaded — speed tests will not run automatically"
log "LaunchAgent loaded — speed tests will run every 20 minutes"

# 8. Write and load app LaunchAgent (auto-starts SpeedMonitor.app at every login)
cat > "$APP_PLIST" << APP_PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.speedmonitor.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DEST/Contents/MacOS/SpeedMonitor</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/app_stdout.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/app_stderr.log</string>
</dict>
</plist>
APP_PLIST_EOF

launchctl bootout "gui/$(id -u)/com.speedmonitor.app" 2>/dev/null || \
    launchctl unload "$APP_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$APP_PLIST" 2>/dev/null || \
    launchctl load "$APP_PLIST" 2>/dev/null || \
    log "WARNING: App LaunchAgent could not be loaded — open ~/Applications/SpeedMonitor.app manually"
log "App LaunchAgent loaded — SpeedMonitor.app will start automatically at every login"

echo ""
echo "SpeedMonitor v4.0.0 installation complete."
echo ""
echo "Next steps:"
echo "  1. Look for the SpeedMonitor icon in your menu bar"
echo "  2. The first speed test runs automatically within ~30 seconds"
echo "  3. Your device will appear in the IT dashboard within ~5 minutes"
echo ""
