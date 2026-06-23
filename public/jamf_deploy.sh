#!/bin/bash
#
# SpeedMonitor — Jamf Pro deploy script
# Pushed as a Jamf policy script (not a package).
# Runs as root; re-execs the update/install as the console user.
#
# Version logic:
#   v4.0.x installed  → update endpoint config + self-update script from GitHub
#   older / none      → full uninstall + fresh install of latest version
#
# Jamf script parameters:
#   $4 = Apps Script URL  (required)
#   $5 = Ingest token     (required)
#
# Usage from Jamf: set parameters 4 and 5 in the policy.

set -euo pipefail

APPS_SCRIPT_URL="${4:-}"
INGEST_TOKEN="${5:-}"
GITHUB_BASE="https://raw.githubusercontent.com/HV-Automation-Pod/speed-monitor/main/public"
INSTALL_BIN="/usr/local/speedmonitor/bin/speed_monitor.sh"
CONFIG_DIR_ROOT="/Users"   # will be scoped to console user below

log() { echo "[SpeedMonitor deploy] $1"; }

# ── Identify console user ──────────────────────────────────────────────────
CONSOLE_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "")
if [[ -z "$CONSOLE_USER" || "$CONSOLE_USER" == "root" ]]; then
    log "ERROR: No user at console. Run this policy when a user is logged in."
    exit 1
fi
USER_HOME=$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory | awk '{print $2}')
CONFIG_DIR="$USER_HOME/.config/nkspeedtest"

log "Console user: $CONSOLE_USER ($USER_HOME)"

# ── Validate parameters ────────────────────────────────────────────────────
if [[ -z "$APPS_SCRIPT_URL" || -z "$INGEST_TOKEN" ]]; then
    log "ERROR: Jamf parameters 4 (Apps Script URL) and 5 (Ingest token) are required."
    exit 1
fi

# ── Detect installed version ───────────────────────────────────────────────
INSTALLED_VERSION=""
if [[ -f "$INSTALL_BIN" ]]; then
    INSTALLED_VERSION=$(grep '^APP_VERSION=' "$INSTALL_BIN" 2>/dev/null | cut -d'"' -f2)
fi

log "Installed version: ${INSTALLED_VERSION:-none}"

# ── Version comparison helper ──────────────────────────────────────────────
# Returns 0 if $1 >= $2 (semantic version)
version_gte() {
    [[ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" == "$2" ]]
}

# ── Write config files (runs as root — fix ownership after) ───────────────
write_config() {
    mkdir -p "$CONFIG_DIR"
    printf '%s' "$APPS_SCRIPT_URL" > "$CONFIG_DIR/apps_script_url"
    chmod 600 "$CONFIG_DIR/apps_script_url"
    printf '%s' "$INGEST_TOKEN"    > "$CONFIG_DIR/ingest_token"
    chmod 600 "$CONFIG_DIR/ingest_token"
    chown -R "$CONSOLE_USER" "$CONFIG_DIR"
    log "Config written to $CONFIG_DIR"
}

# ── Path A: v4.0.x — update config + self-update script ───────────────────
do_update() {
    log "Path A: v4.0.x detected — updating config and self-updating script"
    write_config

    # Download latest speed_monitor.sh from GitHub and install directly
    local tmp
    tmp=$(mktemp /tmp/speed_monitor_XXXXXX.sh)
    if ! curl -fsSL --retry 3 --retry-delay 2 "$GITHUB_BASE/speed_monitor.sh" -o "$tmp"; then
        log "ERROR: Failed to download speed_monitor.sh from GitHub"
        rm -f "$tmp"
        exit 1
    fi

    # Verify checksum
    local expected_sum actual_sum
    expected_sum=$(curl -fsSL "$GITHUB_BASE/checksums.sha256" 2>/dev/null | awk '{print $1}')
    actual_sum=$(shasum -a 256 "$tmp" | awk '{print $1}')
    if [[ "$expected_sum" != "$actual_sum" ]]; then
        log "ERROR: Checksum mismatch — aborting update"
        rm -f "$tmp"
        exit 1
    fi

    # Verify shebang
    if ! head -1 "$tmp" | grep -q "#!/bin/bash"; then
        log "ERROR: Downloaded file is not a bash script"
        rm -f "$tmp"
        exit 1
    fi

    # Install to real path (symlink at ~/.local/bin/speed_monitor.sh points here)
    mv "$tmp" "$INSTALL_BIN"
    chmod +x "$INSTALL_BIN"
    log "Script updated to $(grep '^APP_VERSION=' "$INSTALL_BIN" | cut -d'"' -f2)"

    # Restart launchd agent so next run picks up new script immediately
    sudo -u "$CONSOLE_USER" launchctl unload \
        "$USER_HOME/Library/LaunchAgents/com.speedmonitor.plist" 2>/dev/null || true
    sleep 1
    sudo -u "$CONSOLE_USER" launchctl load \
        "$USER_HOME/Library/LaunchAgents/com.speedmonitor.plist" 2>/dev/null || true
    log "LaunchAgent restarted"
}

# ── Path B: older / none — full uninstall + fresh install ─────────────────
do_fresh_install() {
    log "Path B: old/missing install — running full uninstall + fresh install"

    # Uninstall: stop launchd, remove all SpeedMonitor artifacts for this user
    sudo -u "$CONSOLE_USER" launchctl unload \
        "$USER_HOME/Library/LaunchAgents/com.speedmonitor.plist" 2>/dev/null || true
    sudo -u "$CONSOLE_USER" launchctl unload \
        "$USER_HOME/Library/LaunchAgents/com.speedmonitor.app.plist" 2>/dev/null || true

    rm -f "$USER_HOME/Library/LaunchAgents/com.speedmonitor.plist"
    rm -f "$USER_HOME/Library/LaunchAgents/com.speedmonitor.app.plist"
    rm -f "$USER_HOME/.local/bin/speed_monitor.sh"
    rm -f "$USER_HOME/.local/bin/wifi_info"
    rm -rf "$USER_HOME/Applications/SpeedMonitor.app"
    rm -rf /usr/local/speedmonitor 2>/dev/null || true

    log "Uninstall complete"

    # Fresh install: download and run install.sh from GitHub
    local tmp_installer
    tmp_installer=$(mktemp /tmp/speedmonitor_install_XXXXXX)
    if ! curl -fsSL --retry 3 --retry-delay 2 "$GITHUB_BASE/install.sh" -o "$tmp_installer"; then
        log "ERROR: Failed to download install.sh"
        rm -f "$tmp_installer"
        exit 1
    fi
    chmod +x "$tmp_installer"

    # Pass Apps Script URL and token as env vars for install.sh to consume
    APPS_SCRIPT_URL="$APPS_SCRIPT_URL" \
    INGEST_TOKEN="$INGEST_TOKEN" \
        bash "$tmp_installer"

    rm -f "$tmp_installer"
    log "Fresh install complete"
}

# ── Route based on installed version ──────────────────────────────────────
if [[ -n "$INSTALLED_VERSION" ]] && version_gte "$INSTALLED_VERSION" "4.0.0"; then
    do_update
else
    do_fresh_install
fi

log "Done."
