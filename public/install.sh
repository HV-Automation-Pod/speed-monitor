#!/usr/bin/env bash
# SpeedMonitor Installer (version resolved at runtime from VERSION)
# Usage: curl -fsSL https://raw.githubusercontent.com/HV-Automation-Pod/speed-monitor/main/public/install.sh | bash
#
# What this does:
#   1. Stops and removes any previous SpeedMonitor installation
#   2. Downloads speed_monitor.sh from GitHub into ~/.local/bin/
#   3. Downloads and installs SpeedMonitor.app into ~/Applications/
#   4. Writes config: apps_script_url, ingest_token, device_id, user_email
#   5. Installs the LaunchAgent (speed test every 10 min)
#   6. Installs the app LaunchAgent (auto-starts at login)

set -euo pipefail

GITHUB_BASE="https://raw.githubusercontent.com/HV-Automation-Pod/speed-monitor/main/public"

# Version being installed — read from the VERSION file so install messages
# always reflect the real version instead of a hardcoded (drift-prone) string.
VERSION=$(curl -fsSL --max-time 10 "$GITHUB_BASE/VERSION" 2>/dev/null | tr -d '[:space:]'); VERSION=${VERSION:-latest}

# Accept overrides from env (used by jamf_deploy.sh and CI)
APPS_SCRIPT_URL="${APPS_SCRIPT_URL:-https://script.google.com/macros/s/AKfycbwVFU_laGOiqaZ7fLUyIYZ8eH55bQs7cxE4BptKhngSvx465r1i7XVitNN6y1Ebx52TaA/exec}"
INGEST_TOKEN="${INGEST_TOKEN:-47ca74e6e5510bfb2188cd9b556f7b8cc0ab9662cdec4e03}"
SERVER_URL="${SERVER_URL:-https://speed-monitor.riyan-b.workers.dev}"

# ── Root guard (Jamf runs scripts as root) ─────────────────────────────────
if [[ "$(id -u)" == "0" ]]; then
    CONSOLE_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "")
    if [[ -z "$CONSOLE_USER" || "$CONSOLE_USER" == "root" ]]; then
        echo "[SpeedMonitor install] ERROR: No user logged in at console." >&2
        exit 1
    fi

    # Install speedtest-cli system-wide while we still have root
    if ! command -v speedtest-cli &>/dev/null; then
        echo "[SpeedMonitor install] Installing speedtest-cli..."
        pip3 install speedtest-cli --quiet --break-system-packages 2>/dev/null || \
        pip3 install speedtest-cli --quiet 2>/dev/null || \
        echo "[SpeedMonitor install] WARNING: speedtest-cli install failed — Cloudflare fallback will be used"
    fi

    echo "[SpeedMonitor install] Re-launching as $CONSOLE_USER..."
    TMP=$(mktemp /tmp/speedmonitor_install_XXXXXX)
    curl -fsSL --retry 3 --retry-delay 2 "$GITHUB_BASE/install.sh" -o "$TMP"
    chmod 755 "$TMP"
    USER_UID=$(id -u "$CONSOLE_USER")
    exec launchctl asuser "$USER_UID" sudo -u "$CONSOLE_USER" \
        HOME="/Users/$CONSOLE_USER" USER="$CONSOLE_USER" \
        APPS_SCRIPT_URL="$APPS_SCRIPT_URL" INGEST_TOKEN="$INGEST_TOKEN" \
        /bin/bash "$TMP"
fi

CONFIG_DIR="$HOME/.config/nkspeedtest"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/nkspeedtest"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.speedmonitor.plist"
APP_PLIST="$LAUNCH_AGENTS/com.speedmonitor.app.plist"
APP_DEST="$HOME/Applications/SpeedMonitor.app"

log() { echo "[SpeedMonitor install] $*"; }

log "Starting SpeedMonitor v${VERSION} installation..."

# ── 0. Stop previous installation ─────────────────────────────────────────
log "Stopping previous installation (if any)..."
killall SpeedMonitor 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor"         2>/dev/null || launchctl unload "$PLIST"     2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor.app"     2>/dev/null || launchctl unload "$APP_PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.speedmonitor.watchdog" 2>/dev/null || true
sleep 1
rm -rf /Applications/SpeedMonitor.app 2>/dev/null || true
rm -rf "$APP_DEST" 2>/dev/null || true

# ── 1. Directories ─────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR" "$BIN_DIR" "$DATA_DIR" "$LAUNCH_AGENTS" "$HOME/Applications"

# ── 2. speedtest-cli (user-level fallback if root step was skipped) ────────
if ! command -v speedtest-cli &>/dev/null; then
    log "speedtest-cli not found — trying Homebrew..."
    if ! command -v brew &>/dev/null; then
        NONINTERACTIVE=1 /bin/bash -c \
            "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 2>/dev/null || true
        eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || \
        eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
    fi
    brew install speedtest-cli --quiet 2>/dev/null || \
        log "WARNING: speedtest-cli not available — Cloudflare fallback will be used"
fi

# ── 3. Download speed_monitor.sh ───────────────────────────────────────────
log "Downloading speed_monitor.sh..."
TMP_SCRIPT=$(mktemp /tmp/speed_monitor_XXXXXX)
curl -fsSL --retry 3 --retry-delay 2 "$GITHUB_BASE/speed_monitor.sh" -o "$TMP_SCRIPT"

# Verify checksum
EXPECTED_SUM=$(curl -fsSL "$GITHUB_BASE/checksums.sha256" 2>/dev/null | awk '{print $1}')
ACTUAL_SUM=$(shasum -a 256 "$TMP_SCRIPT" | awk '{print $1}')
if [[ -n "$EXPECTED_SUM" && "$EXPECTED_SUM" != "$ACTUAL_SUM" ]]; then
    echo "[SpeedMonitor install] ERROR: Checksum mismatch — aborting" >&2
    rm -f "$TMP_SCRIPT"; exit 1
fi

mv "$TMP_SCRIPT" "$BIN_DIR/speed_monitor.sh"
chmod +x "$BIN_DIR/speed_monitor.sh"
log "speed_monitor.sh installed"

# ── 4. Write config files ──────────────────────────────────────────────────
printf '%s' "$APPS_SCRIPT_URL" > "$CONFIG_DIR/apps_script_url"
chmod 600 "$CONFIG_DIR/apps_script_url"

printf '%s' "$INGEST_TOKEN" > "$CONFIG_DIR/ingest_token"
chmod 600 "$CONFIG_DIR/ingest_token"

# Dashboard server URL — overwrite any stale value (e.g. old Vercel URL)
printf '%s' "$SERVER_URL" > "$CONFIG_DIR/server_url"

# Throughput test origin (must NOT be behind a CDN — own S3 object or VM — so the shared
# Zscaler egress isn't 429-rate-limited by Cloudflare). Baked in when provided via env.
[[ -n "${SPEED_DL_URL:-}" ]] && { printf '%s' "$SPEED_DL_URL" > "$CONFIG_DIR/dl_url"; log "download origin set: $SPEED_DL_URL"; }
[[ -n "${SPEED_UL_URL:-}" ]] && { printf '%s' "$SPEED_UL_URL" > "$CONFIG_DIR/ul_url"; log "upload origin set: $SPEED_UL_URL"; }

log "Apps Script endpoint configured"

# Reuse existing device_id on reinstall (keeps same device in dashboard)
if [[ ! -f "$CONFIG_DIR/device_id" ]]; then
    uuidgen | tr '[:upper:]' '[:lower:]' > "$CONFIG_DIR/device_id"
fi
log "device_id: $(cat "$CONFIG_DIR/device_id")"

# Detect user email from Apple ID
APPLE_ID=$(python3 -c "
import subprocess, re
out = subprocess.run(['defaults', 'read', 'MobileMeAccounts', 'Accounts'],
                     capture_output=True, text=True).stdout
m = re.search(r'AccountID\s*=\s*\"([^\"]+)\"', out)
print(m.group(1) if m else '')
" 2>/dev/null || true)

if [[ -n "$APPLE_ID" ]]; then
    printf '%s\n' "$APPLE_ID" > "$CONFIG_DIR/user_email"
    log "user_email: $APPLE_ID"
else
    log "WARNING: Could not detect Apple ID — user_email not set"
fi

# ── 5. Download and install SpeedMonitor.app ───────────────────────────────
log "Downloading SpeedMonitor.app..."
TMP_ZIP=$(mktemp /tmp/SpeedMonitor_XXXXXX.zip)
curl -fsSL --retry 3 --retry-delay 2 "$GITHUB_BASE/SpeedMonitor.app.zip" -o "$TMP_ZIP"
unzip -q "$TMP_ZIP" -d "$HOME/Applications/"
rm -f "$TMP_ZIP"
log "SpeedMonitor.app installed"

# ── 6. LaunchAgent — speed test every 10 minutes ──────────────────────────
cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.speedmonitor</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/speed_monitor.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/launchd_stdout.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/launchd_stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- Marks launchd-scheduled runs so the client applies round-robin slotting
         (each device speed-tests once per 20-min window in its own 5-min slot).
         Fires every 5 min; the script decides whether it is this device's slot. -->
    <key>SPEED_SCHEDULED</key>
    <string>1</string>
  </dict>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/com.speedmonitor" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
    launchctl load "$PLIST" 2>/dev/null || \
    log "WARNING: LaunchAgent could not be loaded"
log "LaunchAgent loaded — speed tests every 10 minutes"

# ── 7. App LaunchAgent — auto-start at login ───────────────────────────────
cat > "$APP_PLIST" << APP_PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.speedmonitor.app</string>
  <key>ProgramArguments</key>
  <array><string>$APP_DEST/Contents/MacOS/SpeedMonitor</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/app_stdout.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/app_stderr.log</string>
</dict>
</plist>
APP_PLIST_EOF

launchctl bootout "gui/$(id -u)/com.speedmonitor.app" 2>/dev/null || launchctl unload "$APP_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$APP_PLIST" 2>/dev/null || \
    launchctl load "$APP_PLIST" 2>/dev/null || \
    log "WARNING: App LaunchAgent could not be loaded"
log "App LaunchAgent loaded — SpeedMonitor.app starts at login"

echo ""
echo "SpeedMonitor v${VERSION} installation complete."
echo "  • First speed test runs within ~30 seconds"
echo "  • Tests run every 10 minutes automatically"
echo "  • Look for the SpeedMonitor icon in your menu bar"
echo ""
