// =============================================================
// Google Apps Script platform layer: Sheet storage, cache, lock, admin key.
// dev/mock-server.js provides an in-memory replacement with the same shape.
//
// ONE-TIME SETUP (in the Apps Script editor):
//   1. Create a Google Sheet, then Extensions → Apps Script. Paste Code.gs.
//   2. Run `setup` once (authorizes, creates the Store sheet, prints the admin key).
//   3. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
//   4. Paste the /exec URL into config.js (API_URL).
// =============================================================

var Platform = (function () {
  var STORE = 'Store';
  var BACKUPS = 'Backups';
  var CACHE_KEY = 'pub';
  var CHUNK = 30000;           // CacheService values max out at 100KB (bytes, and notes contain multi-byte characters)
  var _rows = null;            // per-execution index: key → row number

  function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

  function storeSheet() {
    var sh = ss().getSheetByName(STORE);
    if (!sh) {
      sh = ss().insertSheet(STORE);
      sh.getRange('A1:C1').setValues([['key', 'json', 'updated']]);
      sh.setFrozenRows(1);
    }
    return sh;
  }

  function storeLoadAll() {
    var sh = storeSheet();
    var vals = sh.getDataRange().getValues();
    var out = {};
    _rows = {};
    for (var i = 1; i < vals.length; i++) {
      var k = vals[i][0];
      if (!k) continue;
      _rows[k] = i + 1;
      try { out[k] = JSON.parse(vals[i][1]); } catch (e) { out[k] = null; }
    }
    return out;
  }

  function storeSet(key, value) {
    var sh = storeSheet();
    if (!_rows) storeLoadAll();
    var json = JSON.stringify(value);
    if (json.length > 49000) throw new Error('value_too_large:' + key);
    var row = _rows[key];
    if (!row) { row = sh.getLastRow() + 1; _rows[key] = row; }
    sh.getRange(row, 1, 1, 3).setValues([[key, json, new Date()]]);
  }

  // Backups are written after the lock is released, so a slow Sheets append never holds up a pick.
  var _pendingBackups = [];
  function backup(reason, league) {
    var json = JSON.stringify(league);
    if (json.length < 49000) _pendingBackups.push([new Date(), reason, json]);
  }
  function flushBackups() {
    if (!_pendingBackups.length) return;
    var rows = _pendingBackups; _pendingBackups = [];
    try {
      var sh = ss().getSheetByName(BACKUPS) || ss().insertSheet(BACKUPS);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    } catch (e) { /* backups must never break a request */ }
  }

  function cachePut(body, meta, ns) {
    try { cachePutUnsafe(body, meta, (ns || '') + CACHE_KEY); } catch (e) { /* a cache failure must never take the site down */ }
  }

  function cachePutUnsafe(body, meta, CACHE_KEY) {
    var c = CacheService.getScriptCache();
    var parts = {};
    var n = Math.ceil(body.length / CHUNK) || 1;
    for (var i = 0; i < n; i++) parts[CACHE_KEY + ':' + i] = body.substr(i * CHUNK, CHUNK);
    parts[CACHE_KEY + ':meta'] = JSON.stringify({ n: n, meta: meta });
    c.putAll(parts, 300);
  }

  function cacheGet(ns) {
    try { return cacheGetUnsafe((ns || '') + CACHE_KEY); } catch (e) { return null; }
  }

  function cacheGetUnsafe(CACHE_KEY) {
    var c = CacheService.getScriptCache();
    var metaRaw = c.get(CACHE_KEY + ':meta');
    if (!metaRaw) return null;
    var m = JSON.parse(metaRaw);
    var keys = [];
    for (var i = 0; i < m.n; i++) keys.push(CACHE_KEY + ':' + i);
    var got = c.getAll(keys);
    var body = '';
    for (var j = 0; j < keys.length; j++) {
      if (got[keys[j]] == null) return null;
      body += got[keys[j]];
    }
    return { body: body, meta: m.meta || {} };
  }

  function cacheClear(ns) {
    CacheService.getScriptCache().remove((ns || '') + CACHE_KEY + ':meta');
  }

  // Every lock is timed; anything slow shows up in the Apps Script "Executions" log.
  function withLock(label, fn) {
    var r = tryWithLock(8000, label, fn);
    if (r === null) { var e = new Error('server_busy'); e.code = 'server_busy'; throw e; }
    return r;
  }

  // Returns null (instead of waiting long) if another request holds the lock.
  function tryWithLock(waitMs, label, fn) {
    var lock = LockService.getScriptLock();
    var t0 = Date.now();
    if (!lock.tryLock(waitMs)) { console.warn('lock busy: ' + label + ' waited ' + (Date.now() - t0) + 'ms'); return null; }
    var t1 = Date.now();
    try { _rows = null; return fn(); }
    finally {
      lock.releaseLock();
      var held = Date.now() - t1;
      if (held > 2000 || t1 - t0 > 2000) console.warn('lock slow: ' + label + ' waited ' + (t1 - t0) + 'ms, held ' + held + 'ms');
      flushBackups();
    }
  }

  function adminKey() {
    return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  }

  function json(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }

  function raw(str) {
    return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
  }

  return {
    storeLoadAll: storeLoadAll, storeSet: storeSet, backup: backup,
    cachePut: cachePut, cacheGet: cacheGet, cacheClear: cacheClear,
    withLock: withLock, tryWithLock: tryWithLock, adminKey: adminKey, json: json, raw: raw
  };
})();

// Run once from the editor. Safe to re-run: keeps an existing admin key.
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('ADMIN_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('ADMIN_KEY', key);
  }
  Platform.withLock('setup', function () {
    var all = Platform.storeLoadAll();
    if (!all.league) Platform.storeSet('league', Engine.newLeague(51));
    if (!all['private']) Platform.storeSet('private', { byId: {} });
  });
  console.log('Admin key: ' + key);
  return key;
}
