#!/bin/bash
#
# Speed Monitor v3.0.0 - Organization-Wide Internet Speed Monitoring
# Enhanced data collection for fleet deployment (300+ devices)
# v3.0.0: Unified versioning, self-update mechanism
# v2.4.0: Added curl timeout to prevent process hangs
# v2.3.0: Bug fixes - jitter percentiles, TCP retransmits delta, JSON escaping, status field
# v2.2.0: Fixed VPN detection - now checks for active tunnel, not just process running
# v2.1.0: Added WiFi debugging metrics (MCS, error rates, BSSID tracking)
#

APP_VERSION="4.1.2"

# Configuration
DATA_DIR="$HOME/.local/share/nkspeedtest"
CONFIG_DIR="$HOME/.config/nkspeedtest"
CSV_FILE="$DATA_DIR/speed_log.csv"
LOG_FILE="$DATA_DIR/speed_monitor.log"
WIFI_HELPER="$HOME/.local/bin/wifi_info"

# Server URL: config file > env var > hardcoded Vercel default
SERVER_URL_FILE="$CONFIG_DIR/server_url"
SERVER_URL="${SPEED_MONITOR_SERVER:-}"
if [[ -f "$SERVER_URL_FILE" ]]; then
    _cfg_url=$(tr -d '[:space:]' < "$SERVER_URL_FILE" 2>/dev/null)
    [[ "$_cfg_url" =~ ^https?:// ]] && SERVER_URL="$_cfg_url"
fi
[[ ! "$SERVER_URL" =~ ^https?:// ]] && SERVER_URL="https://speed-monitor.riyan-b.workers.dev"

# Edge Functions (Supabase) — used for remote commands (commands-poll / commands-ack)
EDGE_BASE="https://qsawhnvhfuibnenolkiv.supabase.co/functions/v1"

# Google Apps Script ingest endpoint + shared token
# Written to config files by the installer; overridable via env vars.
APPS_SCRIPT_URL_FILE="$CONFIG_DIR/apps_script_url"
INGEST_TOKEN_FILE="$CONFIG_DIR/ingest_token"
APPS_SCRIPT_URL="${SPEED_MONITOR_APPS_SCRIPT_URL:-}"
INGEST_TOKEN="${SPEED_MONITOR_INGEST_TOKEN:-}"
if [[ -f "$APPS_SCRIPT_URL_FILE" ]]; then
    _as_url=$(tr -d '[:space:]' < "$APPS_SCRIPT_URL_FILE" 2>/dev/null)
    [[ "$_as_url" =~ ^https?:// ]] && APPS_SCRIPT_URL="$_as_url"
fi
if [[ -f "$INGEST_TOKEN_FILE" ]]; then
    _tok=$(tr -d '[:space:]' < "$INGEST_TOKEN_FILE" 2>/dev/null)
    [[ -n "$_tok" ]] && INGEST_TOKEN="$_tok"
fi

# API key and provisioning config
API_KEY_FILE="$CONFIG_DIR/api_key"
DEVICE_ID_FILE="$CONFIG_DIR/device_id"
PROVISION_LOG="$DATA_DIR/provision_errors.log"
SELF_UPDATE_ENABLED="${SELF_UPDATE_ENABLED:-false}"  # Jamf is primary; self-update is emergency fallback

# Ensure directories exist
mkdir -p "$DATA_DIR" "$CONFIG_DIR"

# CSV Header (v2.1 schema - added MCS, error rates, BSSID tracking)
CSV_HEADER="timestamp_utc,device_id,os_version,app_version,timezone,interface,ssid,bssid,band,channel,width_mhz,rssi_dbm,noise_dbm,snr_db,tx_rate_mbps,mcs_index,spatial_streams,local_ip,public_ip,latency_ms,jitter_ms,jitter_p50,jitter_p95,packet_loss_pct,download_mbps,upload_mbps,vpn_status,vpn_name,input_errors,output_errors,input_error_rate,output_error_rate,tcp_retransmits,bssid_changed,roam_count,errors,raw_payload"

# Create CSV header if file doesn't exist
if [[ ! -f "$CSV_FILE" ]]; then
    echo "$CSV_HEADER" > "$CSV_FILE"
fi

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

# Provision this device with the server; stores api_key and device_id to config files.
# Returns 1 on failure (caller should skip speed test for this run).
provision_device() {
    log "No API key found — calling provisioning endpoint..."
    local response
    response=$(curl -s --max-time 15 --connect-timeout 10 \
        -X POST "$SERVER_URL/api/ingest/provision" \
        -H "Content-Type: application/json" \
        2>/dev/null)

    local api_key device_id
    api_key=$(echo "$response" | grep -o '"api_key":"[^"]*"' | cut -d'"' -f4)
    device_id=$(echo "$response" | grep -o '"device_id":"[^"]*"' | cut -d'"' -f4)

    if [[ -z "$api_key" || -z "$device_id" ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) PROVISION_FAILED server=$SERVER_URL response=$(echo "$response" | head -c 200)" >> "$PROVISION_LOG"
        log "Provisioning failed — skipping speed test this run"
        return 1
    fi

    # Write with restrictive permissions (600)
    install -m 600 /dev/null "$API_KEY_FILE"
    printf '%s' "$api_key" > "$API_KEY_FILE"
    install -m 600 /dev/null "$DEVICE_ID_FILE"
    printf '%s' "$device_id" > "$DEVICE_ID_FILE"

    log "Provisioning succeeded — device_id=$device_id"
    return 0
}

# Load API key and device ID from config files. Best-effort: never blocks
# ingest. The api_key is only needed for edge commands (poll_edge_commands);
# ingest goes via Apps Script and needs only a device_id. Always returns 0.
load_credentials() {
    API_KEY=""
    DEVICE_ID=""

    [[ -f "$API_KEY_FILE" ]] && API_KEY=$(tr -d '[:space:]' < "$API_KEY_FILE" 2>/dev/null)
    [[ -f "$DEVICE_ID_FILE" ]] && DEVICE_ID=$(tr -d '[:space:]' < "$DEVICE_ID_FILE" 2>/dev/null)

    # Try provisioning to obtain an api_key (for edge commands) — best-effort only.
    if [[ -z "$API_KEY" || -z "$DEVICE_ID" ]]; then
        provision_device || true
        [[ -f "$API_KEY_FILE" ]]   && API_KEY=$(tr -d '[:space:]' < "$API_KEY_FILE" 2>/dev/null)
        [[ -f "$DEVICE_ID_FILE" ]] && DEVICE_ID=$(tr -d '[:space:]' < "$DEVICE_ID_FILE" 2>/dev/null)
    fi

    # Ingest needs a device_id even if provisioning failed — generate one locally.
    if [[ -z "$DEVICE_ID" ]]; then
        DEVICE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        install -m 600 /dev/null "$DEVICE_ID_FILE" 2>/dev/null || true
        printf '%s' "$DEVICE_ID" > "$DEVICE_ID_FILE"
        log "Provisioning unavailable — generated local device_id: $DEVICE_ID"
    fi

    return 0
}

# GitHub base URL for updates (public/ dir is served at root by Next.js)
GITHUB_BASE="https://raw.githubusercontent.com/HV-Automation-Pod/speed-monitor/main/public"

# Semantic version comparison (returns 0 if v1 >= v2)
version_gte() {
    local v1=$1 v2=$2
    [[ "$(printf '%s\n' "$v1" "$v2" | sort -V | head -n1)" == "$v2" ]]
}

# Check for available updates (returns 0 if update available)
check_update() {
    local remote_version=$(curl -s --max-time 5 "$GITHUB_BASE/VERSION" 2>/dev/null | tr -d '[:space:]')
    if [[ -z "$remote_version" ]]; then
        return 1  # Can't reach server
    fi

    if version_gte "$APP_VERSION" "$remote_version"; then
        return 1  # Already on latest
    fi

    echo "$remote_version"
    return 0
}

# Self-update function
update_app() {
    if [[ "$SELF_UPDATE_ENABLED" != "true" ]]; then
        log "Self-update disabled (SELF_UPDATE_ENABLED=false) — skipping"
        return 0
    fi
    echo "Speed Monitor Update"
    echo "===================="
    echo "Current version: $APP_VERSION"
    echo ""

    # Check remote version
    echo "Checking for updates..."
    local remote_version=$(curl -s --max-time 5 "$GITHUB_BASE/VERSION" 2>/dev/null | tr -d '[:space:]')
    if [[ -z "$remote_version" ]]; then
        echo "Failed to check for updates (network error)"
        return 1
    fi

    echo "Latest version: $remote_version"

    # Compare versions
    if version_gte "$APP_VERSION" "$remote_version"; then
        echo ""
        echo "✓ Already on latest version ($APP_VERSION)"
        return 0
    fi

    echo ""
    echo "Updating from $APP_VERSION to $remote_version..."

    # Download to temp files
    local tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" EXIT

    echo "Downloading speed_monitor.sh..."
    if ! curl -s --max-time 30 "$GITHUB_BASE/speed_monitor.sh" -o "$tmp_dir/speed_monitor.sh"; then
        echo "Failed to download speed_monitor.sh"
        return 1
    fi

    # Download checksum manifest and verify before installing
    echo "Downloading checksums.sha256..."
    if ! curl -s --max-time 10 "$GITHUB_BASE/checksums.sha256" -o "$tmp_dir/checksums.sha256" 2>/dev/null; then
        echo "Failed to download checksums.sha256 — aborting update"
        return 1
    fi

    if ! (cd "$tmp_dir" && shasum -a 256 -c checksums.sha256 2>/dev/null); then
        echo "CHECKSUM MISMATCH — downloaded script rejected, keeping current version"
        log "CHECKSUM MISMATCH — update aborted"
        rm -f "$tmp_dir/speed_monitor.sh" "$tmp_dir/checksums.sha256"
        return 1
    fi
    echo "Checksum verified — installing update"
    log "Checksum verified — installing update"

    # Validate download (shebang check)
    if ! head -1 "$tmp_dir/speed_monitor.sh" | grep -q "#!/bin/bash"; then
        echo "Download validation failed for speed_monitor.sh"
        return 1
    fi

    # Create timestamped backup
    local backup_dir="$DATA_DIR/backups/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$backup_dir"
    echo "Backing up to $backup_dir..."
    cp "$HOME/.local/bin/speed_monitor.sh" "$backup_dir/" 2>/dev/null

    # Atomic install — write to the real pkg-managed path; ~/.local/bin/speed_monitor.sh
    # is a symlink created by the postinstall pointing here.
    local _real_bin="/usr/local/speedmonitor/bin/speed_monitor.sh"
    echo "Installing speed_monitor.sh..."
    mv "$tmp_dir/speed_monitor.sh" "$_real_bin"
    chmod +x "$_real_bin"

    echo ""
    echo "✓ Updated to version $remote_version"
    echo "  Backup saved to: $backup_dir"
    return 0
}

# Handle command-line arguments
case "${1:-}" in
    --version|-v)
        echo "Speed Monitor v$APP_VERSION"
        exit 0
        ;;
    --update|-u)
        update_app
        exit $?
        ;;
    --check-update)
        if new_version=$(check_update); then
            echo "Update available: $new_version"
            exit 0
        else
            echo "Up to date ($APP_VERSION)"
            exit 1
        fi
        ;;
    --help|-h)
        echo "Speed Monitor v$APP_VERSION"
        echo ""
        echo "Usage: speed_monitor.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --version, -v     Show version"
        echo "  --update, -u      Update to latest version"
        echo "  --check-update    Check if update is available"
        echo "  --help, -h        Show this help"
        echo ""
        echo "Without options, runs a speed test."
        exit 0
        ;;
esac

# macOS-compatible timeout function (timeout command not available on macOS)
run_with_timeout() {
    local timeout_secs=$1
    shift
    local cmd="$@"

    # Run command in background
    eval "$cmd" &
    local pid=$!

    # Wait for completion or timeout
    local count=0
    while kill -0 $pid 2>/dev/null; do
        sleep 1
        count=$((count + 1))
        if [[ $count -ge $timeout_secs ]]; then
            kill -9 $pid 2>/dev/null
            wait $pid 2>/dev/null
            return 124  # timeout exit code
        fi
    done

    wait $pid
    return $?
}

# Get stable device ID (persisted across reinstalls)
get_device_id() {
    local device_id_file="$CONFIG_DIR/device_id"
    if [[ -f "$device_id_file" ]]; then
        cat "$device_id_file"
    else
        # Generate from hardware UUID for stability
        local hw_uuid=$(ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { print $3 }' | tr -d '"')
        echo "$hw_uuid" | shasum -a 256 | cut -c1-16 > "$device_id_file"
        cat "$device_id_file"
    fi
}

# Get user identifier (email if set, otherwise macOS username)
get_user_email() {
    local email_file="$CONFIG_DIR/user_email"
    if [[ -f "$email_file" ]] && [[ -s "$email_file" ]]; then
        cat "$email_file"
    else
        # Fallback: use macOS full name or username
        local full_name=$(id -F 2>/dev/null || echo "")
        if [[ -n "$full_name" ]]; then
            echo "$full_name"
        else
            whoami
        fi
    fi
}

# Get hostname (computer name or hostname)
get_hostname() {
    # Try to get the friendly computer name first
    local computer_name=$(scutil --get ComputerName 2>/dev/null || echo "")
    if [[ -n "$computer_name" ]]; then
        echo "$computer_name"
    else
        hostname -s 2>/dev/null || hostname
    fi
}

# Get WiFi details via SpeedMonitor.app, Swift helper, or system_profiler fallback
get_wifi_details() {
    # Priority 0: Check cache file written by running SpeedMonitor.app menu bar app
    # This is the best source because the running app has Location Services permission
    local wifi_cache="$DATA_DIR/wifi_cache.txt"
    if [[ -f "$wifi_cache" ]]; then
        # Check if cache is fresh (less than 2 minutes old)
        local cache_age=$(($(date +%s) - $(stat -f%m "$wifi_cache" 2>/dev/null || echo 0)))
        if [[ $cache_age -lt 120 ]]; then
            local wifi_output=$(cat "$wifi_cache")
            # Verify it has valid data
            if echo "$wifi_output" | grep -q "CONNECTED=true"; then
                local cached_ssid=$(echo "$wifi_output" | grep "^SSID=" | cut -d= -f2)
                # Only use cache if SSID is not generic "WiFi" or "Not Connected"
                if [[ -n "$cached_ssid" && "$cached_ssid" != "WiFi" && "$cached_ssid" != "Not Connected" ]]; then
                    log "Using WiFi cache (age: ${cache_age}s, SSID: $cached_ssid)"
                    # Output with proper quoting for eval (handles SSIDs with spaces)
                    while IFS='=' read -r key value; do
                        [[ -n "$key" ]] && echo "${key}=\"${value}\""
                    done <<< "$wifi_output"
                    return
                fi
            fi
        fi
    fi

    # Priority 1: SpeedMonitor.app --output (launches new instance, may not have Location Services)
    local speedmonitor_app="/Applications/SpeedMonitor.app/Contents/MacOS/SpeedMonitor"
    if [[ -x "$speedmonitor_app" ]]; then
        local wifi_output=$("$speedmonitor_app" --output 2>/dev/null)
        # Check if helper returned valid data (CONNECTED=true)
        if echo "$wifi_output" | grep -q "CONNECTED=true"; then
            # Output with proper quoting for eval (handles SSIDs with spaces)
            while IFS='=' read -r key value; do
                [[ -n "$key" ]] && echo "${key}=\"${value}\""
            done <<< "$wifi_output"
            return
        fi
    fi

    # Priority 2: wifi_info Swift helper (if it has Location Services permission)
    if [[ -x "$WIFI_HELPER" ]]; then
        local wifi_output=$("$WIFI_HELPER" 2>/dev/null)
        # Check if helper returned valid data (CONNECTED=true)
        if echo "$wifi_output" | grep -q "CONNECTED=true"; then
            # Output with proper quoting for eval (handles SSIDs with spaces)
            while IFS='=' read -r key value; do
                [[ -n "$key" ]] && echo "${key}=\"${value}\""
            done <<< "$wifi_output"
            return
        fi
    fi

    # Fallback: try legacy airport command (pre-Sequoia)
    local airport="/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
    if [[ -x "$airport" ]]; then
        local ssid=$("$airport" -I 2>/dev/null | awk -F': ' '/^ *SSID/ {print $2}')
        if [[ -n "$ssid" ]]; then
            local bssid=$("$airport" -I 2>/dev/null | awk -F': ' '/^ *BSSID/ {print $2}')
            local channel=$("$airport" -I 2>/dev/null | awk -F': ' '/^ *channel/ {print $2}' | cut -d',' -f1)
            local rssi=$("$airport" -I 2>/dev/null | awk -F': ' '/^ *agrCtlRSSI/ {print $2}')
            local noise=$("$airport" -I 2>/dev/null | awk -F': ' '/^ *agrCtlNoise/ {print $2}')

            echo "CONNECTED=\"true\""
            echo "INTERFACE=\"en0\""
            echo "SSID=\"${ssid}\""
            echo "BSSID=\"${bssid:-unknown}\""
            echo "CHANNEL=\"${channel:-0}\""
            echo "BAND=\"unknown\""
            echo "WIDTH_MHZ=\"0\""
            echo "RSSI_DBM=\"${rssi:-0}\""
            echo "NOISE_DBM=\"${noise:-0}\""
            echo "SNR_DB=\"0\""
            echo "TX_RATE_MBPS=\"0\""
            return
        fi
    fi

    # Fallback: use system_profiler (works on macOS Sequoia, no permissions needed)
    local profiler_output=$(system_profiler SPAirPortDataType 2>/dev/null)
    if echo "$profiler_output" | grep -q "Status: Connected"; then
        # Parse WiFi info from system_profiler
        # Note: SSID may be <redacted> due to privacy, but other metrics are available
        local signal_line=$(echo "$profiler_output" | grep "Signal / Noise:" | head -1)
        local rssi=$(echo "$signal_line" | sed 's/.*Signal \/ Noise: \(-*[0-9]*\) dBm.*/\1/')
        local noise=$(echo "$signal_line" | sed 's/.*\/ \(-*[0-9]*\) dBm.*/\1/')
        local channel_line=$(echo "$profiler_output" | grep "Channel:" | grep -v "Supported" | head -1)
        local channel=$(echo "$channel_line" | sed 's/.*Channel: \([0-9]*\).*/\1/')
        local band="unknown"
        if echo "$channel_line" | grep -q "5GHz"; then
            band="5GHz"
        elif echo "$channel_line" | grep -q "2GHz"; then
            band="2.4GHz"
        fi
        local width=0
        if echo "$channel_line" | grep -q "80MHz"; then
            width=80
        elif echo "$channel_line" | grep -q "40MHz"; then
            width=40
        elif echo "$channel_line" | grep -q "20MHz"; then
            width=20
        fi
        local tx_rate=$(echo "$profiler_output" | grep "Transmit Rate:" | head -1 | sed 's/.*Transmit Rate: \([0-9]*\).*/\1/')
        local mcs=$(echo "$profiler_output" | grep "MCS Index:" | head -1 | sed 's/.*MCS Index: \([0-9]*\).*/\1/')

        # Calculate SNR
        local snr=0
        if [[ -n "$rssi" && -n "$noise" && "$rssi" =~ ^-?[0-9]+$ && "$noise" =~ ^-?[0-9]+$ ]]; then
            snr=$((rssi - noise))
        fi

        echo "CONNECTED=\"true\""
        echo "INTERFACE=\"en0\""
        echo "SSID=\"WiFi\""  # SSID is redacted by macOS privacy
        echo "BSSID=\"unknown\""
        echo "CHANNEL=\"${channel:-0}\""
        echo "BAND=\"${band}\""
        echo "WIDTH_MHZ=\"${width}\""
        echo "RSSI_DBM=\"${rssi:-0}\""
        echo "NOISE_DBM=\"${noise:-0}\""
        echo "SNR_DB=\"${snr}\""
        echo "TX_RATE_MBPS=\"${tx_rate:-0}\""
        echo "MCS_INDEX=\"${mcs:--1}\""
        return
    fi

    # Not connected to WiFi or using Ethernet
    echo "CONNECTED=\"false\""
    echo "INTERFACE=\"none\""
    echo "SSID=\"Unknown/Ethernet\""
    echo "BSSID=\"unknown\""
    echo "CHANNEL=\"0\""
    echo "BAND=\"unknown\""
    echo "WIDTH_MHZ=\"0\""
    echo "RSSI_DBM=\"0\""
    echo "NOISE_DBM=\"0\""
    echo "SNR_DB=\"0\""
    echo "TX_RATE_MBPS=\"0\""
}

# Detect VPN status
# Note: Process running does NOT mean VPN is connected - must check for active tunnel
detect_vpn() {
    local vpn_status="disconnected"
    local vpn_name="none"

    # Helper: Check if any utun interface has an IPv4 address (active tunnel)
    local has_active_tunnel=false
    if ifconfig 2>/dev/null | grep -A2 "^utun" | grep -q "inet "; then
        has_active_tunnel=true
    fi

    # Zscaler Client Connector - must have process AND active tunnel
    if pgrep -x "Zscaler" > /dev/null 2>&1 || pgrep -x "ZscalerTunnel" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="Zscaler"
        fi
        # If tunnel not active, status stays "disconnected" and name stays "none"
    # Cisco AnyConnect - check for vpnagentd AND tunnel
    elif pgrep -x "vpnagentd" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="Cisco_AnyConnect"
        fi
    # Palo Alto GlobalProtect
    elif pgrep -x "PanGPS" > /dev/null 2>&1 || pgrep -x "GlobalProtect" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="GlobalProtect"
        fi
    # Fortinet FortiClient
    elif pgrep -x "FortiClient" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="FortiClient"
        fi
    # OpenVPN - process typically only runs when connected
    elif pgrep -x "openvpn" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="OpenVPN"
        fi
    # Tunnelblick (OpenVPN GUI) - app can run without tunnel
    elif pgrep -x "Tunnelblick" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="Tunnelblick"
        fi
    # WireGuard
    elif pgrep -x "wireguard-go" > /dev/null 2>&1; then
        if [[ "$has_active_tunnel" == "true" ]]; then
            vpn_status="connected"
            vpn_name="WireGuard"
        fi
    # Generic: unknown VPN with active tunnel
    elif [[ "$has_active_tunnel" == "true" ]]; then
        vpn_status="connected"
        vpn_name="Unknown_VPN"
    fi

    echo "VPN_STATUS=$vpn_status"
    echo "VPN_NAME=$vpn_name"
}

# Zscaler IP ranges (CIDR notation)
# These are the IP ranges that Zscaler uses for egress traffic
ZSCALER_IP_RANGES=(
    "136.226.244.0/23"
    "167.103.88.0/23"
    "136.226.242.0/23"
    "136.226.252.0/23"
    "167.103.6.0/23"
    "167.103.54.0/23"
    "165.225.122.0/23"
    "167.103.70.0/23"
    "167.103.72.0/23"
    "167.103.74.0/23"
    "167.103.76.0/23"
    "167.103.78.0/23"
    "167.103.204.0/23"
    "167.103.206.0/23"
    "167.103.208.0/23"
    "167.103.210.0/23"
)

# Append custom Zscaler ranges from config (if present) — CLIENT-07
ZSCALER_RANGES_FILE="$CONFIG_DIR/zscaler_ranges.conf"
if [[ -f "$ZSCALER_RANGES_FILE" ]]; then
    while IFS= read -r _line; do
        [[ -z "$_line" || "$_line" == \#* ]] && continue
        ZSCALER_IP_RANGES+=("$_line")
    done < "$ZSCALER_RANGES_FILE"
fi

# Check if an IP address is within a CIDR range
# Args: $1 = IP address, $2 = CIDR (e.g., "192.168.1.0/24")
ip_in_cidr() {
    local ip="$1"
    local cidr="$2"

    # Split CIDR into base IP and prefix length
    local base_ip="${cidr%/*}"
    local prefix="${cidr#*/}"

    # Convert IP addresses to integers
    local ip_int=0
    local base_int=0
    local IFS='.'

    read -r a b c d <<< "$ip"
    ip_int=$((a * 16777216 + b * 65536 + c * 256 + d))

    read -r a b c d <<< "$base_ip"
    base_int=$((a * 16777216 + b * 65536 + c * 256 + d))

    # Calculate mask from prefix length
    local mask=$((0xFFFFFFFF << (32 - prefix) & 0xFFFFFFFF))

    # Check if IP is in range
    if [[ $((ip_int & mask)) -eq $((base_int & mask)) ]]; then
        return 0  # true - IP is in range
    else
        return 1  # false - IP is not in range
    fi
}

# Check if an IP is a Zscaler egress IP
# Args: $1 = IP address to check
# Returns: 0 if Zscaler, 1 if not
is_zscaler_ip() {
    local ip="$1"

    # Skip if not a valid IPv4 address
    if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 1
    fi

    for cidr in "${ZSCALER_IP_RANGES[@]}"; do
        if ip_in_cidr "$ip" "$cidr"; then
            return 0  # It's a Zscaler IP
        fi
    done

    return 1  # Not a Zscaler IP
}

# Get MCS index and spatial streams from system_profiler
# This is slower (~2-3 sec) but provides valuable link quality info
get_mcs_info() {
    local mcs_index=-1
    local spatial_streams=0

    # Only run if we have WiFi (skip for Ethernet)
    if [[ "$CONNECTED" == "true" ]]; then
        # Parse system_profiler for MCS Index (in Current Network Information section)
        local sp_output=$(system_profiler SPAirPortDataType 2>/dev/null | grep -A 20 "Current Network Information:" | head -25)

        # Extract MCS Index
        mcs_index=$(echo "$sp_output" | grep "MCS Index:" | awk '{print $NF}')
        mcs_index=${mcs_index:--1}

        # Estimate spatial streams from MCS and rate
        # MCS 0-7 = 1 stream, MCS 8-15 = 2 streams, MCS 16-23 = 3 streams, etc.
        if [[ "$mcs_index" -ge 0 ]]; then
            spatial_streams=$(( (mcs_index / 8) + 1 ))
            # Cap at reasonable max
            if [[ $spatial_streams -gt 4 ]]; then
                spatial_streams=4
            fi
        fi
    fi

    echo "MCS_INDEX=$mcs_index"
    echo "SPATIAL_STREAMS=$spatial_streams"
}

# Get interface statistics (packet errors, collisions)
get_interface_stats() {
    local input_errors=0
    local output_errors=0
    local input_packets=0
    local output_packets=0

    # Parse netstat -I en0 for interface stats
    local netstat_output=$(netstat -I en0 2>/dev/null | tail -1)

    if [[ -n "$netstat_output" ]]; then
        # Columns: Name Mtu Network Address Ipkts Ierrs Opkts Oerrs Coll
        input_packets=$(echo "$netstat_output" | awk '{print $5}')
        input_errors=$(echo "$netstat_output" | awk '{print $6}')
        output_packets=$(echo "$netstat_output" | awk '{print $7}')
        output_errors=$(echo "$netstat_output" | awk '{print $8}')
    fi

    # Ensure numeric values (default to 0 if empty, dash, or non-numeric)
    [[ "$input_packets" == "-" || -z "$input_packets" ]] && input_packets=0
    [[ "$input_errors" == "-" || -z "$input_errors" ]] && input_errors=0
    [[ "$output_packets" == "-" || -z "$output_packets" ]] && output_packets=0
    [[ "$output_errors" == "-" || -z "$output_errors" ]] && output_errors=0

    # Calculate error rates based on previous values
    local prev_stats_file="$DATA_DIR/prev_interface_stats"
    local input_error_rate=0
    local output_error_rate=0

    if [[ -f "$prev_stats_file" ]]; then
        local prev_ipkts=$(awk 'NR==1' "$prev_stats_file")
        local prev_ierrs=$(awk 'NR==2' "$prev_stats_file")
        local prev_opkts=$(awk 'NR==3' "$prev_stats_file")
        local prev_oerrs=$(awk 'NR==4' "$prev_stats_file")

        # Default to 0 if empty or dash
        [[ "$prev_ipkts" == "-" || -z "$prev_ipkts" ]] && prev_ipkts=0
        [[ "$prev_ierrs" == "-" || -z "$prev_ierrs" ]] && prev_ierrs=0
        [[ "$prev_opkts" == "-" || -z "$prev_opkts" ]] && prev_opkts=0
        [[ "$prev_oerrs" == "-" || -z "$prev_oerrs" ]] && prev_oerrs=0

        local delta_ipkts=$((input_packets - prev_ipkts))
        local delta_ierrs=$((input_errors - prev_ierrs))
        local delta_opkts=$((output_packets - prev_opkts))
        local delta_oerrs=$((output_errors - prev_oerrs))

        # Calculate error rate as percentage (avoid division by zero)
        if [[ $delta_ipkts -gt 0 ]]; then
            input_error_rate=$(awk "BEGIN {printf \"%.4f\", ($delta_ierrs / $delta_ipkts) * 100}")
        fi
        if [[ $delta_opkts -gt 0 ]]; then
            output_error_rate=$(awk "BEGIN {printf \"%.4f\", ($delta_oerrs / $delta_opkts) * 100}")
        fi
    fi

    # Save current values for next run (atomic write via temp+mv)
    local _tmp_stats
    _tmp_stats=$(mktemp "${prev_stats_file}.XXXXXX")
    printf '%s\n%s\n%s\n%s\n' "$input_packets" "$input_errors" "$output_packets" "$output_errors" > "$_tmp_stats"
    mv "$_tmp_stats" "$prev_stats_file"

    echo "INPUT_ERRORS=$input_errors"
    echo "OUTPUT_ERRORS=$output_errors"
    echo "INPUT_ERROR_RATE=$input_error_rate"
    echo "OUTPUT_ERROR_RATE=$output_error_rate"
}

# Get TCP retransmission count (delta since last test, not cumulative)
get_tcp_retransmits() {
    local tcp_retransmits=0
    local tcp_retransmits_delta=0

    # Parse netstat -s for TCP retransmit stats (cumulative since boot)
    local retransmit_line=$(netstat -s 2>/dev/null | grep "data packets.*retransmitted" | head -1)

    if [[ -n "$retransmit_line" ]]; then
        tcp_retransmits=$(echo "$retransmit_line" | awk '{print $1}')
    fi

    # Calculate delta since last test
    local prev_retransmits_file="$DATA_DIR/prev_tcp_retransmits"
    if [[ -f "$prev_retransmits_file" ]]; then
        local prev_retransmits=$(cat "$prev_retransmits_file")
        [[ -z "$prev_retransmits" ]] && prev_retransmits=0
        tcp_retransmits_delta=$((tcp_retransmits - prev_retransmits))
        # Handle counter reset (reboot)
        [[ $tcp_retransmits_delta -lt 0 ]] && tcp_retransmits_delta=$tcp_retransmits
    fi

    # Save current value for next run (atomic write via temp+mv)
    local _tmp_retransmits
    _tmp_retransmits=$(mktemp "${prev_retransmits_file}.XXXXXX")
    printf '%s\n' "$tcp_retransmits" > "$_tmp_retransmits"
    mv "$_tmp_retransmits" "$prev_retransmits_file"

    echo "TCP_RETRANSMITS=${tcp_retransmits_delta:-0}"
}

# Track BSSID changes (roaming detection)
track_bssid_changes() {
    local current_bssid="$1"
    local bssid_changed=0
    local roam_count=0

    local prev_bssid_file="$DATA_DIR/prev_bssid"
    local roam_count_file="$DATA_DIR/roam_count"

    # Load previous BSSID
    if [[ -f "$prev_bssid_file" ]]; then
        local prev_bssid=$(cat "$prev_bssid_file")

        # Check if BSSID changed (roaming event)
        if [[ "$current_bssid" != "$prev_bssid" && -n "$current_bssid" && "$current_bssid" != "unknown" ]]; then
            bssid_changed=1
            log "BSSID changed from $prev_bssid to $current_bssid (roaming detected)"

            # Increment roam count
            if [[ -f "$roam_count_file" ]]; then
                roam_count=$(cat "$roam_count_file")
            fi
            roam_count=$((roam_count + 1))
            echo "$roam_count" > "$roam_count_file"
        fi
    fi

    # Load current roam count
    if [[ -f "$roam_count_file" ]]; then
        roam_count=$(cat "$roam_count_file")
    fi

    # Save current BSSID (atomic write via temp+mv)
    local _tmp_bssid
    _tmp_bssid=$(mktemp "${prev_bssid_file}.XXXXXX")
    printf '%s\n' "$current_bssid" > "$_tmp_bssid"
    mv "$_tmp_bssid" "$prev_bssid_file"

    echo "BSSID_CHANGED=$bssid_changed"
    echo "ROAM_COUNT=${roam_count:-0}"
}

# Measure latency (ms) and jitter (ms) by pinging the default gateway.
# The gateway is local — always reachable, bypasses VPN/Zscaler, measures
# WiFi link quality rather than internet path.
# Outputs: LATENCY_MS=X JITTER_MS=X
measure_latency_ms() {
    local gateway
    gateway=$(route get default 2>/dev/null | awk '/gateway:/{print $2; exit}')
    # Fallback: parse netstat if route failed
    if [[ -z "$gateway" ]]; then
        gateway=$(netstat -rn 2>/dev/null | awk '/^default/{print $2; exit}')
    fi

    if [[ -z "$gateway" ]]; then
        echo "LATENCY_MS=0"
        echo "JITTER_MS=0"
        return
    fi

    local ping_out
    ping_out=$(ping -c 6 -q "$gateway" 2>/dev/null | tail -1)
    if echo "$ping_out" | grep -q "avg"; then
        # Format: round-trip min/avg/max/stddev = 1.234/5.678/9.012/1.111 ms
        local avg stddev
        avg=$(echo "$ping_out" | awk -F'[=/]' '{print $(NF-2)}')
        stddev=$(echo "$ping_out" | awk -F'[=/]' '{printf "%.2f", $(NF)}')   # stddev = NF, not max (NF-1)
        # Sanity cap: if somehow > 2000ms the measurement is bogus
        if (( $(echo "$avg > 2000" | bc -l 2>/dev/null || echo 0) )); then
            avg=0; stddev=0
        fi
        echo "LATENCY_MS=$(printf "%.1f" "$avg")"
        echo "JITTER_MS=$stddev"
    else
        echo "LATENCY_MS=0"
        echo "JITTER_MS=0"
    fi
}

# Run ping test for jitter and packet loss calculation
run_ping_test() {
    local target="${1:-8.8.8.8}"
    local count="${2:-15}"

    # Run ping and capture output
    local ping_output=$(ping -c "$count" -q "$target" 2>&1)
    local exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        echo "JITTER_MS=0"
        echo "JITTER_P50=0"
        echo "JITTER_P95=0"
        echo "PACKET_LOSS_PCT=100"
        return
    fi

    # Extract packet loss
    local packet_loss=$(echo "$ping_output" | grep "packet loss" | sed 's/.*\([0-9.]*\)% packet loss.*/\1/')
    packet_loss=${packet_loss:-0}

    # Run detailed ping for jitter calculation
    local detailed_ping=$(ping -c "$count" "$target" 2>&1)

    # Extract RTT values
    local rtt_values=$(echo "$detailed_ping" | grep "time=" | sed 's/.*time=\([0-9.]*\).*/\1/')

    # Calculate jitter using awk
    # Bug fix: P50/P95 now calculated on jitter deltas, not RTT values
    local jitter_stats=$(echo "$rtt_values" | awk '
    BEGIN { n=0; prev=0; jitter_n=0 }
    NF > 0 {
        rtt = $1
        if (n > 0) {
            diff = (rtt > prev) ? (rtt - prev) : (prev - rtt)
            jitter_values[jitter_n] = diff
            jitter_n++
        }
        prev = rtt
        n++
    }
    END {
        if (jitter_n <= 0) {
            print "0 0 0"
            exit
        }

        # Mean jitter
        sum = 0
        for (i = 0; i < jitter_n; i++) {
            sum += jitter_values[i]
        }
        mean_jitter = sum / jitter_n

        # Sort jitter values for percentiles
        for (i = 0; i < jitter_n; i++) {
            for (j = i + 1; j < jitter_n; j++) {
                if (jitter_values[i] > jitter_values[j]) {
                    tmp = jitter_values[i]
                    jitter_values[i] = jitter_values[j]
                    jitter_values[j] = tmp
                }
            }
        }

        # P50 (median) of jitter
        p50_idx = int(jitter_n * 0.5)
        p50 = jitter_values[p50_idx]

        # P95 of jitter
        p95_idx = int(jitter_n * 0.95)
        if (p95_idx >= jitter_n) p95_idx = jitter_n - 1
        p95 = jitter_values[p95_idx]

        printf "%.2f %.2f %.2f\n", mean_jitter, p50, p95
    }')

    local jitter=$(echo "$jitter_stats" | awk '{print $1}')
    local p50=$(echo "$jitter_stats" | awk '{print $2}')
    local p95=$(echo "$jitter_stats" | awk '{print $3}')

    echo "JITTER_MS=${jitter:-0}"
    echo "JITTER_P50=${p50:-0}"
    echo "JITTER_P95=${p95:-0}"
    echo "PACKET_LOSS_PCT=${packet_loss:-0}"
}

# Get local IP address
get_local_ip() {
    # Get IP of the primary interface
    local ip=$(ipconfig getifaddr en0 2>/dev/null)
    if [[ -z "$ip" ]]; then
        ip=$(ipconfig getifaddr en1 2>/dev/null)
    fi
    if [[ -z "$ip" ]]; then
        ip=$(ifconfig 2>/dev/null | grep "inet " | grep -v "127.0.0.1" | head -1 | awk '{print $2}')
    fi
    echo "${ip:-unknown}"
}

# Escape CSV formula injection characters from untrusted string fields (CLIENT-08)
escape_csv_field() {
    local val="$1"
    # Strip leading formula-injection characters (=, +, @, -)
    val="${val#=}"
    val="${val#+}"
    val="${val#@}"
    # Strip leading - only if it would be a formula (not a negative number)
    [[ "$val" =~ ^- && ! "$val" =~ ^-[0-9] ]] && val="${val#-}"
    # Quote if contains comma or double-quote
    if [[ "$val" == *","* || "$val" == *'"'* ]]; then
        val="${val//\"/\"\"}"
        val="\"$val\""
    fi
    echo "$val"
}

# Returns 0 if $1 is a valid non-negative number (integer or decimal)
is_positive_number() {
    local val="$1"
    [[ "$val" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 1
    awk "BEGIN { exit !($val >= 0) }" 2>/dev/null
}

# Escape string for JSON (handle quotes, backslashes, newlines)
json_escape() {
    local str="$1"
    str="${str//\\/\\\\}"      # Escape backslashes first
    str="${str//\"/\\\"}"      # Escape quotes
    str="${str//$'\n'/\\n}"    # Escape newlines
    str="${str//$'\r'/\\r}"    # Escape carriage returns
    str="${str//$'\t'/\\t}"    # Escape tabs
    echo "$str"
}

# Build JSON payload
build_json_payload() {
    local user_email=$(get_user_email)
    local hostname=$(get_hostname)
    # Escape strings that might contain special characters
    local safe_ssid=$(json_escape "$SSID")
    local safe_vpn_name=$(json_escape "$VPN_NAME")
    local safe_errors=$(json_escape "$ERRORS")
    local safe_hostname=$(json_escape "$hostname")

    local json="{"
    json+="\"timestamp_utc\":\"$TIMESTAMP_UTC\","
    json+="\"device_id\":\"$DEVICE_ID\","
    json+="\"user_email\":\"$user_email\","
    json+="\"hostname\":\"$safe_hostname\","
    json+="\"os_version\":\"$OS_VERSION\","
    json+="\"app_version\":\"$APP_VERSION\","
    json+="\"timezone\":\"$TIMEZONE\","
    json+="\"interface\":\"$INTERFACE\","
    json+="\"ssid\":\"$safe_ssid\","
    json+="\"bssid\":\"$BSSID\","
    json+="\"band\":\"$BAND\","
    json+="\"channel\":$CHANNEL,"
    json+="\"width_mhz\":$WIDTH_MHZ,"
    json+="\"rssi_dbm\":$RSSI_DBM,"
    json+="\"noise_dbm\":$NOISE_DBM,"
    json+="\"snr_db\":$SNR_DB,"
    json+="\"tx_rate_mbps\":$TX_RATE_MBPS,"
    json+="\"mcs_index\":$MCS_INDEX,"
    json+="\"spatial_streams\":$SPATIAL_STREAMS,"
    json+="\"local_ip\":\"$LOCAL_IP\","
    json+="\"public_ip\":\"$PUBLIC_IP\","
    json+="\"latency_ms\":$LATENCY_MS,"
    json+="\"jitter_ms\":$JITTER_MS,"
    json+="\"jitter_p50\":$JITTER_P50,"
    json+="\"jitter_p95\":$JITTER_P95,"
    json+="\"packet_loss_pct\":$PACKET_LOSS_PCT,"
    json+="\"download_mbps\":$DOWNLOAD_MBPS,"
    json+="\"upload_mbps\":$UPLOAD_MBPS,"
    json+="\"vpn_status\":\"$VPN_STATUS\","
    json+="\"vpn_name\":\"$safe_vpn_name\","
    json+="\"input_errors\":$INPUT_ERRORS,"
    json+="\"output_errors\":$OUTPUT_ERRORS,"
    json+="\"input_error_rate\":$INPUT_ERROR_RATE,"
    json+="\"output_error_rate\":$OUTPUT_ERROR_RATE,"
    json+="\"tcp_retransmits\":$TCP_RETRANSMITS,"
    json+="\"bssid_changed\":$BSSID_CHANGED,"
    json+="\"roam_count\":$ROAM_COUNT,"
    json+="\"errors\":\"$safe_errors\","
    json+="\"status\":\"$STATUS\""
    json+="}"
    echo "$json"
}

# Post speed test result to the Google Apps Script ingest endpoint.
post_result() {
    local payload="$1"

    if [[ -z "$APPS_SCRIPT_URL" ]]; then
        log "post_result: APPS_SCRIPT_URL not configured — skipping"
        return 1
    fi

    # Inject ingest_token into the payload before sending
    local auth_payload
    auth_payload=$(echo "$payload" | sed "s/^{/{\"ingest_token\":\"$INGEST_TOKEN\",/")

    # Apps Script runs doPost when the POST hits /exec, then returns a 302 to the
    # result URL (script.googleusercontent.com/macros/echo). doPost has already
    # executed (sheet write + Supabase forward) by then, so a 302 IS success.
    # Do NOT follow the redirect with --post302 — that re-POSTs to the GET-only
    # echo URL and yields a bogus "Page Not Found". Don't follow at all; accept 3xx.
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time 30 --connect-timeout 10 \
        -X POST "$APPS_SCRIPT_URL" \
        -H "Content-Type: application/json" \
        -d "$auth_payload" \
        2>/dev/null)
    if [[ "$http_code" -ge 200 && "$http_code" -lt 400 ]]; then
        log "POST to Apps Script succeeded (HTTP $http_code)"
        return 0
    fi
    log "ERROR: POST to Apps Script failed (HTTP $http_code)"
    return 1
}

# ============================================================================
# EDGE COMMANDS — v4.1.0
# Polls Supabase Edge for remote commands (force_update, restart_service, etc.)
# Ingest now goes via Google Apps Script, not Edge Functions.
# ============================================================================

EDGE_POLL_RESPONSE=""
poll_edge_commands() {
    EDGE_POLL_RESPONSE=""

    if [[ -z "$API_KEY" ]]; then
        log "poll_edge_commands: no API key — skipping"
        return 1
    fi

    local response
    response=$(curl -s --max-time 10 --connect-timeout 5 \
        -H "X-Api-Key: $DEVICE_ID:$API_KEY" \
        "$EDGE_BASE/commands-poll" 2>/dev/null)

    if [[ -z "$response" ]]; then
        log "poll_edge_commands: no response"
        return 1
    fi

    EDGE_POLL_RESPONSE="$response"
    return 0
}

# Main collection function
collect_metrics() {
    local errors=""
    STATUS="pending"  # Initialize status

    log "Starting speed test (v$APP_VERSION)..."

    # Timestamp and device info
    TIMESTAMP_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    DEVICE_ID=$(get_device_id)
    OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
    TIMEZONE=$(date +"%z")

    # WiFi details
    log "Collecting WiFi details..."
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(get_wifi_details)

    # Handle missing WiFi (Ethernet connection)
    if [[ "$CONNECTED" != "true" ]]; then
        SSID="${SSID:-Unknown/Ethernet}"
        BSSID="${BSSID:-none}"
        CHANNEL="${CHANNEL:-0}"
        BAND="${BAND:-none}"
        WIDTH_MHZ="${WIDTH_MHZ:-0}"
        RSSI_DBM="${RSSI_DBM:-0}"
        NOISE_DBM="${NOISE_DBM:-0}"
        SNR_DB="${SNR_DB:-0}"
        TX_RATE_MBPS="${TX_RATE_MBPS:-0}"
    fi

    # Safety net: every unquoted-numeric JSON field MUST be a number. An empty
    # value (e.g. WiFi width/snr that failed to parse on a connected device)
    # would emit `"width_mhz":,` → invalid JSON → the whole POST fails.
    CHANNEL="${CHANNEL:-0}";     WIDTH_MHZ="${WIDTH_MHZ:-0}";   RSSI_DBM="${RSSI_DBM:-0}"
    NOISE_DBM="${NOISE_DBM:-0}"; SNR_DB="${SNR_DB:-0}";         TX_RATE_MBPS="${TX_RATE_MBPS:-0}"
    MCS_INDEX="${MCS_INDEX:-0}"; SPATIAL_STREAMS="${SPATIAL_STREAMS:-0}"

    # Network info
    LOCAL_IP=$(get_local_ip)
    PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "unknown")

    # VPN detection
    log "Detecting VPN status..."
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(detect_vpn)

    # Zscaler detection: PUBLIC IP is the SOURCE OF TRUTH
    # - If public IP is a Zscaler IP → VPN is connected (Zscaler)
    # - If public IP is NOT a Zscaler IP → Zscaler VPN is disconnected
    # This overrides process-based detection because what matters is
    # whether traffic is actually going through Zscaler DC
    if is_zscaler_ip "$PUBLIC_IP"; then
        VPN_STATUS="connected"
        VPN_NAME="Zscaler"
        log "Zscaler detected via public IP: $PUBLIC_IP"
    elif [[ "$VPN_NAME" == "Zscaler" ]]; then
        # Process said Zscaler, but IP says no - trust the IP
        VPN_STATUS="disconnected"
        VPN_NAME="none"
        log "Zscaler process running but traffic not via Zscaler DC (IP: $PUBLIC_IP)"
    fi

    # Write VPN status file for SpeedMonitor.app to read (atomic write)
    local _vpn_cache="$DATA_DIR/vpn_status.txt"
    local _tmp_vpn
    _tmp_vpn=$(mktemp "${_vpn_cache}.XXXXXX")
    printf 'VPN_STATUS=%s\nVPN_NAME=%s\n' "$VPN_STATUS" "$VPN_NAME" > "$_tmp_vpn"
    mv "$_tmp_vpn" "$_vpn_cache"

    # MCS index and spatial streams (WiFi link quality)
    log "Collecting MCS info..."
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(get_mcs_info)

    # Interface error stats
    log "Collecting interface stats..."
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(get_interface_stats)

    # TCP retransmits
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(get_tcp_retransmits)

    # BSSID change tracking (roaming detection)
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(track_bssid_changes "$BSSID")

    # Ping/jitter test
    log "Running ping test for jitter..."
    while IFS='=' read -r _key _value; do
        [[ "$_key" =~ ^[A-Z_]+$ ]] || continue
        printf -v "$_key" '%s' "${_value//\"/}"
    done < <(run_ping_test)

    # Multi-strategy speed test with fallbacks
    log "Running speed test (multi-strategy)..."

    # Detect proxy settings (PAC file or explicit proxy)
    local proxy_url=""
    local pac_url=$(scutil --proxy 2>/dev/null | grep "ProxyAutoConfigURLString" | awk '{print $3}')
    local http_proxy_val=$(scutil --proxy 2>/dev/null | grep "HTTPProxy" | awk '{print $3}')
    local http_port_val=$(scutil --proxy 2>/dev/null | grep "HTTPPort" | awk '{print $3}')

    if [[ -n "$http_proxy_val" && -n "$http_port_val" ]]; then
        proxy_url="http://${http_proxy_val}:${http_port_val}"
        export http_proxy="$proxy_url"
        export https_proxy="$proxy_url"
        export HTTP_PROXY="$proxy_url"
        export HTTPS_PROXY="$proxy_url"
        log "Using explicit proxy: $proxy_url"
    elif [[ -n "$pac_url" ]]; then
        log "PAC file detected: $pac_url (speedtest-cli doesn't support PAC)"
    fi

    local speedtest_success=false

    # Strategy 1 (PRIMARY): Cloudflare — measure true wire throughput from the
    # interface byte counters (netstat -ib), the same mechanism the app's live
    # meter uses. curl's own speed numbers are unreliable through Zscaler
    # (download under-reads during TCP slow-start; upload over-reads into the
    # local proxy buffer). Counting actual bytes on the wire over a sustained
    # 4-stream transfer matches Ookla closely (validated against Ookla Chennai).
    if [[ "$speedtest_success" == "false" ]]; then
        local _cf_host="speed.cloudflare.com"

        # Active interface (default route); fall back to en0
        local _ifc
        _ifc=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
        [[ -z "$_ifc" ]] && _ifc="en0"

        # Cumulative interface byte counters (first matching row carries totals)
        _if_ibytes() { netstat -ib | awk -v i="$_ifc" '$1==i{print $(NF-4); exit}'; }
        _if_obytes() { netstat -ib | awk -v i="$_ifc" '$1==i{print $(NF-1); exit}'; }
        _epoch_ms()  { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

        # Latency — ICMP ping to the test server (bypasses curl/proxy issues)
        log "Strategy 1: pinging ${_cf_host} for latency..."
        local _raw_ping
        _raw_ping=$(ping -c 8 -q "$_cf_host" 2>/dev/null | tail -1)
        if echo "$_raw_ping" | grep -q "avg"; then
            # macOS: round-trip min/avg/max/stddev = a/b/c/d ms  (NF=8 on [=/] split)
            # latency = avg (NF-2), jitter = stddev (NF) — NOT min (NF-3) / max (NF-1)
            LATENCY_MS=$(echo "$_raw_ping" | awk -F'[=/]' '{printf "%.1f", $(NF-2)}')
            JITTER_MS=$(echo "$_raw_ping"  | awk -F'[=/]' '{printf "%.2f", $(NF)}')
        else
            # ICMP blocked — fall back to gateway ping
            while IFS='=' read -r _lk _lv; do
                [[ "$_lk" =~ ^[A-Z_]+$ ]] && printf -v "$_lk" '%s' "$_lv"
            done < <(measure_latency_ms)
        fi
        JITTER_P50=${JITTER_MS}; JITTER_P95=${JITTER_MS}
        log "Latency: ${LATENCY_MS}ms  Jitter: ${JITTER_MS}ms"

        # Download — 4 streams looping for ~7s; measure real bytes on $_ifc
        log "Strategy 1: measuring download via ${_ifc} byte counters..."
        local _b0 _t0 _b1 _t1 _dl_end
        _b0=$(_if_ibytes); _t0=$(_epoch_ms)
        _dl_end=$(( $(date +%s) + 7 ))
        for _i in 1 2 3 4; do
            ( while [ "$(date +%s)" -lt "$_dl_end" ]; do
                curl -s -o /dev/null --max-time 8 "https://${_cf_host}/__down?bytes=25000000" 2>/dev/null
              done ) &
        done
        wait
        _b1=$(_if_ibytes); _t1=$(_epoch_ms)

        if is_positive_number "$_b0" && is_positive_number "$_b1" && [[ "$_b1" -gt "$_b0" ]]; then
            # Mbps = bytes*8 / ms / 1000
            DOWNLOAD_MBPS=$(awk "BEGIN{printf \"%.2f\", ($_b1-$_b0)*8/($_t1-$_t0)/1000}")
            log "Download: ${DOWNLOAD_MBPS} Mbps (${_ifc} wire bytes)"

            # Upload — 4 streams looping for ~7s; measure real bytes out on $_ifc
            log "Strategy 1: measuring upload via ${_ifc} byte counters..."
            local _o0 _s0 _o1 _s1 _ul_end
            _o0=$(_if_obytes); _s0=$(_epoch_ms)
            _ul_end=$(( $(date +%s) + 7 ))
            for _i in 1 2 3 4; do
                ( while [ "$(date +%s)" -lt "$_ul_end" ]; do
                    dd if=/dev/zero bs=1048576 count=25 2>/dev/null | \
                    curl -s -o /dev/null --max-time 8 -X POST --data-binary @- "https://${_cf_host}/__up" 2>/dev/null
                  done ) &
            done
            wait
            _o1=$(_if_obytes); _s1=$(_epoch_ms)

            if is_positive_number "$_o0" && is_positive_number "$_o1" && [[ "$_o1" -gt "$_o0" ]]; then
                UPLOAD_MBPS=$(awk "BEGIN{printf \"%.2f\", ($_o1-$_o0)*8/($_s1-$_s0)/1000}")
                log "Upload: ${UPLOAD_MBPS} Mbps (${_ifc} wire bytes)"
            else
                UPLOAD_MBPS="0"
                log "Upload measurement failed (no byte delta on ${_ifc})"
            fi

            STATUS="success_cloudflare"
            speedtest_success=true
            log "Strategy 1 succeeded (Cloudflare wire-bytes) - Down: ${DOWNLOAD_MBPS} Mbps, Up: ${UPLOAD_MBPS} Mbps, Latency: ${LATENCY_MS}ms"
        else
            log "Strategy 1 failed: no download byte delta on ${_ifc}"
        fi
    fi

    # Fallback A: speedtest-cli with --secure flag (HTTPS, may work better with proxy)
    if [[ "$speedtest_success" == "false" ]]; then
        log "Fallback A: speedtest-cli --secure"
        local tmp_output=$(mktemp)

        # Run speedtest with timeout (macOS-compatible)
        speedtest-cli --secure --simple > "$tmp_output" 2>&1 &
        local pid=$!
        local count=0
        while kill -0 $pid 2>/dev/null && [[ $count -lt 90 ]]; do
            sleep 1
            count=$((count + 1))
        done
        if kill -0 $pid 2>/dev/null; then
            kill -9 $pid 2>/dev/null
            wait $pid 2>/dev/null
            log "Strategy 1 timed out after 90s"
        else
            wait $pid
            local speedtest_exit=$?
            local speedtest_output=$(cat "$tmp_output")

            if [[ $speedtest_exit -eq 0 ]] && echo "$speedtest_output" | grep -q "Download:"; then
                DOWNLOAD_MBPS=$(echo "$speedtest_output" | grep "Download:" | awk '{print $2}')
                UPLOAD_MBPS=$(echo "$speedtest_output"  | grep "Upload:"   | awk '{print $2}')
                # Use speedtest-cli's own Ping (it pings the nearest server).
                # Sanity-cap at 2000ms — if Zscaler spoofs the value, fall back to gateway ping.
                local _cli_ping
                _cli_ping=$(echo "$speedtest_output" | grep "Ping:" | awk '{print $2}')
                if is_positive_number "${_cli_ping:-}" && \
                   awk "BEGIN{exit !($_cli_ping < 2000)}" 2>/dev/null; then
                    LATENCY_MS="$_cli_ping"
                    JITTER_MS="0"
                else
                    while IFS='=' read -r _lk _lv; do
                        [[ "$_lk" =~ ^[A-Z_]+$ ]] && printf -v "$_lk" '%s' "$_lv"
                    done < <(measure_latency_ms)
                fi
                STATUS="success"
                speedtest_success=true
                log "Strategy 1 succeeded - Down: ${DOWNLOAD_MBPS} Mbps, Up: ${UPLOAD_MBPS} Mbps, Lat: ${LATENCY_MS}ms"
            else
                log "Strategy 1 failed: exit=$speedtest_exit, output=$(head -1 "$tmp_output")"
            fi
        fi
        rm -f "$tmp_output"
    fi

    # Fallback B: speedtest-cli without --secure (plain HTTP, might bypass some filters)
    if [[ "$speedtest_success" == "false" ]]; then
        log "Fallback B: speedtest-cli standard"
        local tmp_output=$(mktemp)

        # Run speedtest with timeout (macOS-compatible)
        speedtest-cli --simple > "$tmp_output" 2>&1 &
        local pid=$!
        local count=0
        while kill -0 $pid 2>/dev/null && [[ $count -lt 90 ]]; do
            sleep 1
            count=$((count + 1))
        done
        if kill -0 $pid 2>/dev/null; then
            kill -9 $pid 2>/dev/null
            wait $pid 2>/dev/null
            log "Strategy 2 timed out after 90s"
        else
            wait $pid
            local speedtest_exit=$?
            local speedtest_output=$(cat "$tmp_output")

            if [[ $speedtest_exit -eq 0 ]] && echo "$speedtest_output" | grep -q "Download:"; then
                DOWNLOAD_MBPS=$(echo "$speedtest_output" | grep "Download:" | awk '{print $2}')
                UPLOAD_MBPS=$(echo "$speedtest_output"  | grep "Upload:"   | awk '{print $2}')
                local _cli_ping2
                _cli_ping2=$(echo "$speedtest_output" | grep "Ping:" | awk '{print $2}')
                if is_positive_number "${_cli_ping2:-}" && \
                   awk "BEGIN{exit !($_cli_ping2 < 2000)}" 2>/dev/null; then
                    LATENCY_MS="$_cli_ping2"
                    JITTER_MS="0"
                else
                    while IFS='=' read -r _lk _lv; do
                        [[ "$_lk" =~ ^[A-Z_]+$ ]] && printf -v "$_lk" '%s' "$_lv"
                    done < <(measure_latency_ms)
                fi
                STATUS="success"
                speedtest_success=true
                log "Strategy 2 succeeded - Down: ${DOWNLOAD_MBPS} Mbps, Up: ${UPLOAD_MBPS} Mbps, Lat: ${LATENCY_MS}ms"
            else
                log "Strategy 2 failed: exit=$speedtest_exit, output=$(head -1 "$tmp_output")"
            fi
        fi
        rm -f "$tmp_output"
    fi

    # Strategy 4: Fast.com test (Netflix - often whitelisted by corporate)
    if [[ "$speedtest_success" == "false" ]]; then
        log "Strategy 4: Fast.com API test"
        # Try to get a test URL from fast.com API
        local fast_token=$(curl -s --connect-timeout 5 --max-time 10 \
            "https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=1" 2>&1 | \
            grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4)

        if [[ -n "$fast_token" ]]; then
            local fast_result=$(curl -s -o /dev/null -w "%{speed_download},%{http_code}" \
                --connect-timeout 10 --max-time 30 "$fast_token" 2>&1)
            local fast_speed=$(echo "$fast_result" | cut -d',' -f1)
            local fast_code=$(echo "$fast_result" | cut -d',' -f2)

            if [[ "$fast_code" == "200" ]] && [[ -n "$fast_speed" ]] && [[ "$fast_speed" != "0" ]]; then
                DOWNLOAD_MBPS=$(echo "scale=2; $fast_speed * 8 / 1000000" | bc 2>/dev/null || echo "0")

                # Measure latency via default gateway (local, bypasses VPN)
                while IFS='=' read -r _lkey _lval; do
                    [[ "$_lkey" =~ ^[A-Z_]+$ ]] || continue
                    printf -v "$_lkey" '%s' "$_lval"
                done < <(measure_latency_ms)
                JITTER_P50=${JITTER_MS}
                JITTER_P95=${JITTER_MS}
                log "Measured latency: ${LATENCY_MS}ms, jitter: ${JITTER_MS}ms (gateway ping)"

                UPLOAD_MBPS="0"
                STATUS="success_fastcom"
                speedtest_success=true
                log "Strategy 4 succeeded (Fast.com) - Down: ${DOWNLOAD_MBPS} Mbps, Latency: ${LATENCY_MS}ms"
            else
                log "Strategy 4 failed: code=$fast_code"
            fi
        else
            log "Strategy 4 failed: couldn't get fast.com token"
        fi
    fi

    # All strategies failed
    if [[ "$speedtest_success" == "false" ]]; then
        LATENCY_MS="0"
        DOWNLOAD_MBPS="0"
        UPLOAD_MBPS="0"

        if [[ "$VPN_STATUS" == "connected" ]]; then
            STATUS="vpn_blocked"
            errors="vpn_blocking_speedtest"
            log "All speed test strategies failed with VPN. Corporate firewall likely blocking."
        else
            STATUS="failed"
            errors="all_strategies_failed"
            log "All speed test strategies failed without VPN. Network issue?"
        fi
    fi

    # Validate numeric speed test output (CLIENT-06)
    if [[ "$speedtest_success" == "true" ]]; then
        if ! is_positive_number "$DOWNLOAD_MBPS" || \
           ! is_positive_number "$UPLOAD_MBPS" || \
           ! is_positive_number "$LATENCY_MS"; then
            log "Invalid speed test output: down=${DOWNLOAD_MBPS} up=${UPLOAD_MBPS} lat=${LATENCY_MS} — marking failed"
            DOWNLOAD_MBPS=0
            UPLOAD_MBPS=0
            LATENCY_MS=0
            STATUS="failed"
            speedtest_success=false
        fi
    fi

    # Set defaults for any missing values
    LATENCY_MS=${LATENCY_MS:-0}
    DOWNLOAD_MBPS=${DOWNLOAD_MBPS:-0}
    UPLOAD_MBPS=${UPLOAD_MBPS:-0}
    JITTER_MS=${JITTER_MS:-0}
    JITTER_P50=${JITTER_P50:-0}
    JITTER_P95=${JITTER_P95:-0}
    PACKET_LOSS_PCT=${PACKET_LOSS_PCT:-0}
    MCS_INDEX=${MCS_INDEX:--1}
    SPATIAL_STREAMS=${SPATIAL_STREAMS:-0}
    INPUT_ERRORS=${INPUT_ERRORS:-0}
    OUTPUT_ERRORS=${OUTPUT_ERRORS:-0}
    INPUT_ERROR_RATE=${INPUT_ERROR_RATE:-0}
    OUTPUT_ERROR_RATE=${OUTPUT_ERROR_RATE:-0}
    TCP_RETRANSMITS=${TCP_RETRANSMITS:-0}
    BSSID_CHANGED=${BSSID_CHANGED:-0}
    ROAM_COUNT=${ROAM_COUNT:-0}

    ERRORS="$errors"

    # Build JSON payload
    local raw_payload=$(build_json_payload)
    # Escape quotes for CSV
    local csv_payload=$(echo "$raw_payload" | sed 's/"/\\"/g')

    # Sanitize CSV fields that may contain untrusted content (CLIENT-08)
    local _csv_ssid
    _csv_ssid=$(escape_csv_field "${SSID:-}")
    local _csv_errors
    _csv_errors=$(escape_csv_field "${ERRORS:-}")

    # Append to CSV (v2.1 schema)
    echo "$TIMESTAMP_UTC,$DEVICE_ID,$OS_VERSION,$APP_VERSION,$TIMEZONE,$INTERFACE,$_csv_ssid,$BSSID,$BAND,$CHANNEL,$WIDTH_MHZ,$RSSI_DBM,$NOISE_DBM,$SNR_DB,$TX_RATE_MBPS,$MCS_INDEX,$SPATIAL_STREAMS,$LOCAL_IP,$PUBLIC_IP,$LATENCY_MS,$JITTER_MS,$JITTER_P50,$JITTER_P95,$PACKET_LOSS_PCT,$DOWNLOAD_MBPS,$UPLOAD_MBPS,$VPN_STATUS,$VPN_NAME,$INPUT_ERRORS,$OUTPUT_ERRORS,$INPUT_ERROR_RATE,$OUTPUT_ERROR_RATE,$TCP_RETRANSMITS,$BSSID_CHANGED,$ROAM_COUNT,$_csv_errors,\"$csv_payload\"" >> "$CSV_FILE"

    # Post result to Apps Script ingest endpoint
    log "Sending result to Apps Script..."
    post_result "$raw_payload" || log "WARNING: Apps Script ingest failed — result saved to CSV"

    # Poll Edge for remote commands (non-blocking — failure is silent)
    poll_edge_commands && process_edge_commands "$EDGE_POLL_RESPONSE"

    # Print summary
    echo "=== Speed Test Results (v$APP_VERSION) ==="
    echo "Time: $TIMESTAMP_UTC"
    echo "Device: $DEVICE_ID"
    echo "OS: macOS $OS_VERSION"
    echo "Network: $SSID ($INTERFACE)"
    echo "BSSID: $BSSID"
    echo "Band: $BAND | Channel: $CHANNEL | Width: ${WIDTH_MHZ}MHz"
    echo "Signal: ${RSSI_DBM}dBm | Noise: ${NOISE_DBM}dBm | SNR: ${SNR_DB}dB"
    echo "Link: MCS $MCS_INDEX | Streams: $SPATIAL_STREAMS | TX Rate: ${TX_RATE_MBPS}Mbps"
    echo "VPN: $VPN_NAME ($VPN_STATUS)"
    echo "Download: $DOWNLOAD_MBPS Mbps"
    echo "Upload: $UPLOAD_MBPS Mbps"
    echo "Latency: $LATENCY_MS ms"
    echo "Jitter: $JITTER_MS ms (P50: $JITTER_P50 | P95: $JITTER_P95)"
    echo "Packet Loss: $PACKET_LOSS_PCT%"
    echo "Errors: In=${INPUT_ERROR_RATE}% Out=${OUTPUT_ERROR_RATE}% | Retransmits: $TCP_RETRANSMITS"
    echo "Roaming: Changed=$BSSID_CHANGED | Total Roams: $ROAM_COUNT"
    echo "Status: $STATUS"
    echo "Results saved to: $CSV_FILE"

    # Write last_result.txt for SpeedMonitor.app menu bar display
    local _result_file="$DATA_DIR/last_result.txt"
    local _tmp_result
    _tmp_result=$(mktemp "${_result_file}.XXXXXX")
    printf 'DOWNLOAD_MBPS=%s\nUPLOAD_MBPS=%s\nLATENCY_MS=%s\nJITTER_MS=%s\nTIMESTAMP=%s\n' \
        "$DOWNLOAD_MBPS" "$UPLOAD_MBPS" "$LATENCY_MS" "$JITTER_MS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_tmp_result"
    mv "$_tmp_result" "$_result_file"

    log "Test completed"
}

# ============================================================================
# REMOTE COMMANDS - Edge-based (v4.1.0) + legacy Vercel fallback
# ============================================================================

# Ack a single command via Edge commands-ack.
ack_edge_command() {
    local cmd_id="$1"
    local status="$2"
    local result="$3"

    local safe_result
    safe_result=$(echo "$result" | head -c 500 | sed 's/"/\\"/g' | tr '\n' ' ')

    curl -s -o /dev/null --max-time 10 \
        -X POST "$EDGE_BASE/commands-ack" \
        -H "Content-Type: application/json" \
        -H "X-Api-Key: $DEVICE_ID:$API_KEY" \
        -d "{\"command_id\":$cmd_id,\"status\":\"$status\",\"result\":\"$safe_result\"}" \
        2>/dev/null
}

# Process commands from an Edge commands-poll response JSON string.
# Handles flush_now (triggers buffer flush) plus the existing command types.
# Acks each command via Edge commands-ack.
process_edge_commands() {
    local response="$1"

    if [[ -z "$response" ]]; then
        return
    fi

    local commands
    commands=$(echo "$response" | grep -o '"command":"[^"]*"' | cut -d'"' -f4)
    local ids
    ids=$(echo "$response" | grep -o '"id":[0-9]*' | cut -d':' -f2)

    if [[ -z "$commands" ]]; then
        log "No pending Edge commands"
        return
    fi

    local i=1
    echo "$commands" | while read -r cmd; do
        local cmd_id
        cmd_id=$(echo "$ids" | sed -n "${i}p")
        log "Executing Edge command: $cmd (id: $cmd_id)"

        local result=""
        local status="completed"

        case "$cmd" in
            force_update)
                log "Force update requested"
                result=$("$0" --update 2>&1) || status="failed"
                ;;
            force_speedtest)
                result="Speedtest already completed in this cycle"
                ;;
            restart_service)
                log "Restarting launchd service..."
                launchctl unload "$HOME/Library/LaunchAgents/com.speedmonitor.plist" 2>/dev/null
                sleep 1
                launchctl load "$HOME/Library/LaunchAgents/com.speedmonitor.plist" 2>/dev/null
                result="Service restarted"
                ;;
            collect_diagnostics)
                result=$(collect_diagnostics_data 2>&1) || status="failed"
                ;;
            *)
                log "Unknown command: $cmd"
                result="Unknown command"
                status="failed"
                ;;
        esac

        [[ -n "$cmd_id" ]] && ack_edge_command "$cmd_id" "$status" "$result"
        i=$((i + 1))
    done
}


# Collect diagnostics data for remote diagnostics command
collect_diagnostics_data() {
    echo "=== Speed Monitor Diagnostics ==="
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Device ID: $DEVICE_ID"
    echo "App Version: $APP_VERSION"
    echo "OS Version: $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
    echo ""
    echo "=== LaunchD Status ==="
    launchctl list | grep -i speedmonitor 2>/dev/null || echo "No launchd jobs found"
    echo ""
    echo "=== Script Location ==="
    ls -la "$HOME/.local/bin/speed_monitor.sh" 2>/dev/null || echo "Script not found at default location"
    echo ""
    echo "=== Speedtest CLI ==="
    which speedtest-cli 2>/dev/null || echo "speedtest-cli not found"
    speedtest-cli --version 2>/dev/null || echo "Cannot get version"
    echo ""
    echo "=== Network Interfaces ==="
    ifconfig | grep -E "^[a-z]|inet " | head -20
    echo ""
    echo "=== Recent Log Entries ==="
    tail -20 "$SCRIPT_DIR/launchd_stderr.log" 2>/dev/null || echo "No error log found"
}

# Load credentials (best-effort; always succeeds with at least a local device_id).
# Ingest is NOT gated on provisioning — a device with no api_key still reports
# data via Apps Script; only edge commands are skipped when the key is absent.
load_credentials

# Run main collection
collect_metrics
