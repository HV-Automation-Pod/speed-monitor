/**
 * syncToSupabase — forwards each device result into the Supabase speed_results
 * table so the Cloudflare dashboard (which reads Supabase) shows live data.
 *
 * WHY THIS EXISTS:
 *   Devices POST to this Apps Script, which appends to the Google Sheet. But the
 *   dashboard reads from Supabase, and nothing was writing there after May 2026
 *   — so "Active devices (last 24h)" showed 0. This function restores the link.
 *
 * HOW TO WIRE IT UP:
 *   1. Paste this whole function into your Apps Script project (Code.gs).
 *   2. Set the service key as a Script Property (Project Settings → Script
 *      Properties → add  SUPABASE_SERVICE_KEY = <your sb_secret_... key>).
 *      Keeping the key out of source avoids committing a secret to git.
 *   3. In your existing doPost(e), AFTER you append the row to the Sheet, add:
 *
 *          try { syncToSupabase(data); } catch (err) { /* non-fatal */ }
 *
 *      where `data` is the parsed payload object (JSON.parse(e.postData.contents)).
 *   4. Deploy → Manage deployments → Edit → Version: "New version" → Deploy.
 *
 * The column names below are the verified speed_results schema (tested: HTTP 201).
 * Several payload fields are renamed to match the table:
 *   width_mhz→channel_width, app_version→client_version,
 *   input_errors→interface_errors_in, output_errors→interface_errors_out,
 *   bssid_changed→bssid_changes.
 */
function syncToSupabase(data) {
  var SUPABASE_URL = 'https://qsawhnvhfuibnenolkiv.supabase.co';
  // Stored in Script Properties (Project Settings → Script Properties), never in git.
  var SERVICE_KEY  = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');

  var row = {
    device_id:            data.device_id,
    hostname:             data.hostname,
    timestamp_utc:        data.timestamp_utc,
    ssid:                 data.ssid,
    bssid:                data.bssid,
    band:                 data.band,
    channel:              data.channel,
    channel_width:        data.width_mhz,
    rssi_dbm:             data.rssi_dbm,
    mcs_index:            data.mcs_index,
    spatial_streams:      data.spatial_streams,
    snr_db:               data.snr_db,
    download_mbps:        data.download_mbps,
    upload_mbps:          data.upload_mbps,
    latency_ms:           data.latency_ms,
    jitter_ms:            data.jitter_ms,
    packet_loss_pct:      data.packet_loss_pct,
    vpn_status:           data.vpn_status,
    vpn_name:             data.vpn_name,
    interface_errors_in:  data.input_errors,
    interface_errors_out: data.output_errors,
    tcp_retransmits:      data.tcp_retransmits,
    bssid_changes:        data.bssid_changed,
    public_ip:            data.public_ip,
    status:               data.status,
    errors:               data.errors,
    client_version:       data.app_version,
    os_version:           data.os_version,
    user_email:           data.user_email
  };

  var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/speed_results', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Prefer': 'return=minimal'
    },
    payload: JSON.stringify(row),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('syncToSupabase failed: HTTP ' + code + ' — ' + resp.getContentText());
  }
  return code;
}
