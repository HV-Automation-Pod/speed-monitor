/**
 * Speed Monitor — Google Apps Script Ingest Layer  (source-of-truth copy)
 *
 * This mirrors the LIVE Apps Script project. The deployed copy lives in
 * script.google.com; keep this file in sync when you change either one.
 *
 * Script Properties required: INGEST_TOKEN, SUPABASE_URL, SUPABASE_KEY, SHEET_ID
 *
 * Flow:
 *   Device (every 10 min) → doPost() → appends a row to the Sheet
 *   Time trigger (every ~20 min) → syncToSupabase() → unsynced rows → Supabase REST API
 *
 * v4.1.4: added ZCC / tunnel-state columns (zcc_running, zcc_version, tunnel_mode,
 *         tunnel_interface, default_gateway, dns_servers) and made getHeaders()
 *         auto-create any missing header columns.
 */

// ---------------------------------------------------------------------------
// doPost — receives a speed test result from a device
// ---------------------------------------------------------------------------
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty('INGEST_TOKEN');

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (_) {
      return respond(400, 'Invalid JSON');
    }

    if (!expectedToken || payload.ingest_token !== expectedToken) {
      return respond(401, 'Unauthorized');
    }

    const sheet = getSheet();
    const headers = getHeaders(sheet);
    const row = buildRow(payload, headers);
    sheet.appendRow(row);

    try { syncToSupabase(payload); } catch (err) { console.error('syncToSupabase:', err); }

    return respond(202, 'accepted');
  } catch (err) {
    console.error('doPost error:', err);
    return respond(500, err.message);
  }
}

// ---------------------------------------------------------------------------
// syncToSupabase — reads unsynced rows and bulk-inserts into Supabase
// Called by a time-based trigger (and opportunistically from doPost).
// ---------------------------------------------------------------------------
function syncToSupabase() {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    console.error('syncToSupabase: missing SUPABASE_URL or SUPABASE_KEY');
    return;
  }

  const sheet = getSheet();
  const headers = getHeaders(sheet);
  const syncedColIdx = headers.indexOf('synced');          // 0-based

  if (syncedColIdx === -1) {
    console.error('syncToSupabase: "synced" column not found in sheet');
    return;
  }

  const allData = sheet.getDataRange().getValues();
  const dataRows = allData.slice(1); // skip header row

  // Collect unsynced rows (synced column is empty/false)
  const unsyncedIdxs = [];
  const records = [];

  dataRows.forEach(function(row, i) {
    if (!row[syncedColIdx]) {
      unsyncedIdxs.push(i + 2); // sheet row number (1-based, +1 for header)
      records.push(rowToSupabaseRecord(row, headers));
    }
  });

  if (records.length === 0) {
    console.log('syncToSupabase: nothing to sync');
    return;
  }

  console.log('syncToSupabase: syncing ' + records.length + ' rows');

  // POST to Supabase REST API in batches of 200
  const BATCH = 200;
  let successCount = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const response = UrlFetchApp.fetch(
      supabaseUrl + '/rest/v1/speed_results?on_conflict=device_id,timestamp_utc',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'resolution=ignore-duplicates,return=minimal',
        },
        payload: JSON.stringify(batch),
        muteHttpExceptions: true,
      }
    );

    const status = response.getResponseCode();
    if (status >= 200 && status < 300) {
      successCount += batch.length;
    } else {
      console.error('syncToSupabase: Supabase returned ' + status + ': ' + response.getContentText());
      // Don't mark these rows as synced — they'll retry next cycle
      continue;
    }

    // Mark rows in this batch as synced
    const batchIdxs = unsyncedIdxs.slice(i, i + BATCH);
    const now = new Date().toISOString();
    batchIdxs.forEach(function(rowNum) {
      sheet.getRange(rowNum, syncedColIdx + 1).setValue(now);
    });
  }

  console.log('syncToSupabase: done — ' + successCount + '/' + records.length + ' synced');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSheet() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID script property not set');
  return SpreadsheetApp.openById(sheetId).getSheets()[0];
}

// The authoritative column list. Everything maps by HEADER NAME, so the sheet's
// physical column order must equal this array. getHeaders() enforces that:
// it writes the header row on first run AND appends/repairs any missing or
// out-of-place columns on every run (idempotent), so new fields like the zcc_*
// columns appear automatically without a manual sheet edit.
function getHeaders(sheet) {
  const HEADERS = [
    'timestamp_utc', 'device_id', 'user_email', 'hostname',
    'os_version', 'client_version', 'timezone', 'interface',
    'ssid', 'bssid', 'band', 'channel', 'channel_width',
    'rssi_dbm', 'noise_dbm', 'snr_db', 'tx_rate_mbps',
    'mcs_index', 'spatial_streams', 'local_ip', 'public_ip',
    'latency_ms', 'jitter_ms', 'jitter_p50', 'jitter_p95',
    'packet_loss_pct', 'download_mbps', 'upload_mbps',
    'vpn_status', 'vpn_name',
    'interface_errors_in', 'interface_errors_out',
    'input_error_rate', 'output_error_rate',
    'tcp_retransmits', 'bssid_changes', 'roam_count',
    'errors', 'status',
    'received_at', 'synced',
    // v4.1.4 — ZCC / tunnel state (appended at the END so existing column
    // indices, including 'synced', never shift → no history re-sync).
    'zcc_running', 'zcc_version', 'tunnel_mode',
    'tunnel_interface', 'default_gateway', 'dns_servers',
    // v4.1.5 — path / hop measurement
    'zscaler_dc', 'zscaler_vip', 'gateway_rtt_ms', 'dc_rtt_ms',
    'hop_count', 'traceroute_path',
  ];

  const width = HEADERS.length;

  // Ensure the sheet grid is wide enough — appendRow-grown sheets may have exactly
  // the old column count, and getRange beyond the grid throws "out of bounds".
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  const current = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(v) { return String(v); });

  // Rewrite the header row only if it doesn't already match HEADERS exactly.
  // This creates headers on first run and adds any newly-introduced columns,
  // while guaranteeing the label row stays aligned with the mapping order.
  var mismatch = false;
  for (var c = 0; c < width; c++) {
    if (current[c] !== HEADERS[c]) { mismatch = true; break; }
  }
  if (mismatch) {
    sheet.getRange(1, 1, 1, width).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    console.log('getHeaders: header row created/updated (' + width + ' columns)');
  }

  return HEADERS;
}

// Build a sheet row array from a device JSON payload, matching the header order.
function buildRow(payload, headers) {
  const now = new Date().toISOString();
  const mapped = {
    timestamp_utc:       payload.timestamp_utc   || now,
    device_id:           payload.device_id        || '',
    user_email:          payload.user_email        || '',
    hostname:            payload.hostname          || '',
    os_version:          payload.os_version        || '',
    client_version:      payload.app_version       || payload.client_version || '',
    timezone:            payload.timezone          || '',
    interface:           payload.interface         || '',
    ssid:                payload.ssid              || '',
    bssid:               payload.bssid             || '',
    band:                payload.band              || '',
    channel:             payload.channel           || 0,
    channel_width:       String(payload.width_mhz  || payload.channel_width || ''),
    rssi_dbm:            payload.rssi_dbm          || 0,
    noise_dbm:           payload.noise_dbm         || 0,
    snr_db:              payload.snr_db            || 0,
    tx_rate_mbps:        payload.tx_rate_mbps      || 0,
    mcs_index:           payload.mcs_index         ?? -1,
    spatial_streams:     payload.spatial_streams   || 0,
    local_ip:            payload.local_ip          || '',
    public_ip:           payload.public_ip         || '',
    latency_ms:          payload.latency_ms        || 0,
    jitter_ms:           payload.jitter_ms         || 0,
    jitter_p50:          payload.jitter_p50        || 0,
    jitter_p95:          payload.jitter_p95        || 0,
    packet_loss_pct:     payload.packet_loss_pct   || 0,
    download_mbps:       payload.download_mbps     || 0,
    upload_mbps:         payload.upload_mbps       || 0,
    vpn_status:          payload.vpn_status        || '',
    vpn_name:            payload.vpn_name          || '',
    interface_errors_in: payload.input_errors      ?? payload.interface_errors_in  ?? 0,
    interface_errors_out:payload.output_errors     ?? payload.interface_errors_out ?? 0,
    input_error_rate:    payload.input_error_rate  || 0,
    output_error_rate:   payload.output_error_rate || 0,
    tcp_retransmits:     payload.tcp_retransmits   || 0,
    bssid_changes:       payload.bssid_changed     ?? payload.bssid_changes ?? 0,
    roam_count:          payload.roam_count        || 0,
    errors:              payload.errors            || '',
    status:              payload.status            || '',
    received_at:         now,
    synced:              '',  // empty = not yet synced
    // v4.1.4 — ZCC / tunnel state
    zcc_running:         payload.zcc_running       || '',
    zcc_version:         payload.zcc_version       || '',
    tunnel_mode:         payload.tunnel_mode       || '',
    tunnel_interface:    payload.tunnel_interface  || '',
    default_gateway:     payload.default_gateway   || '',
    dns_servers:         payload.dns_servers       || '',
    // v4.1.5 — path / hop measurement
    zscaler_dc:          payload.zscaler_dc        || '',
    zscaler_vip:         payload.zscaler_vip       || '',
    gateway_rtt_ms:      payload.gateway_rtt_ms    || 0,
    dc_rtt_ms:           payload.dc_rtt_ms         || 0,
    hop_count:           payload.hop_count         || '',
    traceroute_path:     payload.traceroute_path   || '',
  };

  return headers.map(function(h) { return mapped[h] !== undefined ? mapped[h] : ''; });
}

// Convert a sheet row back to a Supabase-compatible record (only columns that exist in the schema).
function rowToSupabaseRecord(row, headers) {
  const SUPABASE_COLUMNS = [
    'device_id', 'hostname', 'timestamp_utc',
    'ssid', 'bssid', 'band', 'channel', 'rssi_dbm', 'mcs_index',
    'spatial_streams', 'snr_db', 'channel_width',
    'download_mbps', 'upload_mbps', 'latency_ms', 'jitter_ms', 'packet_loss_pct',
    'vpn_status', 'vpn_name',
    'interface_errors_in', 'interface_errors_out', 'tcp_retransmits', 'bssid_changes',
    'public_ip',
    'status', 'errors', 'client_version', 'os_version', 'user_email',
    // v4.1.4 — ZCC / tunnel state (requires matching columns in Supabase;
    // run the ALTER TABLE migration BEFORE deploying this change).
    'zcc_running', 'zcc_version', 'tunnel_mode',
    'tunnel_interface', 'default_gateway', 'dns_servers',
    // v4.1.5 — path / hop measurement
    'zscaler_dc', 'zscaler_vip', 'gateway_rtt_ms', 'dc_rtt_ms',
    'hop_count', 'traceroute_path',
  ];

  const record = {};
  SUPABASE_COLUMNS.forEach(function(col) {
    const idx = headers.indexOf(col);
    var val = (idx !== -1) ? row[idx] : null;
    if (val === '' || val === undefined) val = null;
    record[col] = val;   // always include the key so every row in the batch matches
  });
  return record;
}

function respond(code, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: code, message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// One-time setup: create the time-based trigger for syncToSupabase
// Run manually once from the Apps Script editor (Run → setupTrigger)
// ---------------------------------------------------------------------------
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncToSupabase') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('syncToSupabase')
    .timeBased()
    .everyMinutes(15)
    .create();

  console.log('Trigger created: syncToSupabase every 15 minutes');
}

function testSupabase() {
  var code = syncToSupabase();
  Logger.log('syncToSupabase ran');
}
