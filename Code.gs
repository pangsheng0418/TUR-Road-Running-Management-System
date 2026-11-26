/**
 * ============================================================================
 * TUR All-in-One Race Management System v3.0 (Governance Edition)
 * Google Apps Script Backend (Code.gs)
 * ============================================================================
 * 8 張核心工作表（Single Source of Truth）：
 *  1. Participants   - 選手報名、雙軌金流、發卡與出賽一條龍主檔
 *  2. Events         - 賽事活動主檔（含 ownerUsername、formSchemaJson、certConfigJson）
 *  3. Categories     - 分組表（含 customRaceStart）
 *  4. Stations       - 站點表（含 stationType）
 *  5. TimingLogs     - 感應紀錄明細檔（批次高吞吐寫入）
 *  6. HistoryResults - 歷屆成績與八百壯士 100K+ 歸併庫
 *  7. Users          - 四層權責帳號與站點鎖定表（super_admin / organizer / operator）
 *  8. GlobalConfig   - 系統環境參數、銀行轉帳帳號與 PAYUNi 金流設定
 *
 * 部署方式：
 *  1. 從 Google 試算表 -> 擴充功能 -> Apps Script 貼上本檔（或於下方填入 SPREADSHEET_ID）
 *  2. 執行 `setupSheets`（或 `initTurDatabase`）自動建表與初始化
 *  3. 部署 -> 新增部署作業 -> 網頁應用程式（執行身分：我；誰可以存取：所有人）
 * ============================================================================
 */

const SPREADSHEET_ID = '';

const SHEET_SCHEMAS = {
  Participants: [
    'participantId', 'eventId', 'catId', 'bibNumber', 'groupCode', 'groupName',
    'name', 'lastName', 'firstName', 'idCard', 'gender', 'birthday', 'age',
    'nationality', 'phone', 'email', 'city', 'emergencyName', 'emergencyPhone',
    'diet', 'remark', 'totalAmount', 'addonsDetail',
    'payMethod', 'remittanceLast5', 'merTradeNo', 'payStatus', 'paymentType',
    'tradeNo', 'payInfo', 'paidAt',
    'chipUid', 'checkinStatus', 'raceStatus', 'penaltySeconds', 'createdAt', 'customFieldsJson'
  ],
  Events: [
    'eventId', 'ownerUsername', 'nameZh', 'nameEn', 'organizerZh', 'organizerEn',
    'location', 'raceType', 'lapDistanceKm', 'debounceSeconds', 'status',
    'regStart', 'regEnd', 'raceStart', 'maxQuota', 'bannerUrl',
    'brochureText', 'formSchemaJson', 'certConfigJson'
  ],
  Categories: [
    'catId', 'eventId', 'name', 'distanceKm', 'timeLimitHours',
    'fee', 'bibPrefix', 'bibStartNum', 'quota', 'customRaceStart'
  ],
  Stations: [
    'stationId', 'eventId', 'stationCode', 'name', 'distanceKm', 'stationType', 'orderIndex'
  ],
  TimingLogs: [
    'logId', 'eventId', 'stationCode', 'bibNumber', 'idCardHash', 'sensedTime',
    'lapCount', 'operator', 'source', 'isValid', 'note'
  ],
  HistoryResults: [
    'historyId', 'eventDate', 'eventName', 'categoryName', 'bibNumber', 'name',
    'idCardHash', 'finishTime', 'distanceKm', 'lapCount', 'overallRank',
    'catRank', 'status', 'isWarrior800', 'remark'
  ],
  Users: [
    'username', 'passwordHash', 'displayName', 'role',
    'parentOrganizer', 'allowedEventId', 'allowedStation', 'enabled'
  ],
  GlobalConfig: [
    'configKey', 'configValue', 'description', 'updatedAt'
  ]
};

const KEY_FIELDS = {
  Participants: 'participantId',
  Events: 'eventId',
  Categories: 'catId',
  Stations: 'stationId',
  TimingLogs: 'logId',
  HistoryResults: 'historyId',
  Users: 'username',
  GlobalConfig: 'configKey'
};

function getTargetSpreadsheet() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('找不到綁定的 Google 試算表。請從試算表「擴充功能 -> Apps Script」開啟，或於 Code.gs 頂部填入 SPREADSHEET_ID。');
  }
  return ss;
}

/**
 * 一鍵初始化 8 張核心工作表與預設帳號/設定（重複執行不覆蓋既有資料）
 */
function setupSheets() {
  const ss = getTargetSpreadsheet();
  Object.keys(SHEET_SCHEMAS).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    const headers = SHEET_SCHEMAS[name];
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#0f172a')
        .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    } else if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });

  // 預設四層權責帳號（密碼預設為簡易測試碼，建議上線前於專區 3 更改）
  const userSheet = ss.getSheetByName('Users');
  if (userSheet.getLastRow() <= 1) {
    const defaultUsers = [
      ['superadmin', 'tur2026', '最高管理員 Super Admin', 'super_admin', '', 'ALL', 'ALL', 1],
      ['org_north', 'org2026', '北區賽事承辦人', 'organizer', '', 'ALL', 'ALL', 1],
      ['org_south', 'org2026', '南區賽事承辦人', 'organizer', '', 'ALL', 'ALL', 1],
      ['writer01', '1234', '晶片寫入發卡組 01', 'operator', 'org_north', 'TUR-2026-50K', 'WRITER', 1],
      ['checkin01', '1234', '現場報到檢錄組 01', 'operator', 'org_north', 'TUR-2026-50K', 'CHECKIN', 1],
      ['cp1', '1234', 'CP1 水庫折返站', 'operator', 'org_north', 'TUR-2026-50K', 'CP1', 1],
      ['finish01', '1234', '終點衝線站', 'operator', 'org_north', 'TUR-2026-50K', 'FINISH', 1],
      ['lap01', '1234', '繞圈主拱門站', 'operator', 'org_north', 'TUR-2026-12H', 'LAP', 1]
    ];
    userSheet.getRange(2, 1, defaultUsers.length, defaultUsers[0].length).setValues(defaultUsers);
  }

  // 預設 GlobalConfig
  const cfgSheet = ss.getSheetByName('GlobalConfig');
  if (cfgSheet.getLastRow() <= 1) {
    const now = formatNow();
    const defaultCfg = [
      ['bankCode', '004', '大會收款銀行代碼', now],
      ['bankName', '台灣銀行 台北分行', '大會收款銀行名稱', now],
      ['bankAccount', '004-001-234567-8', '大會轉帳匯款帳號', now],
      ['bankAccountName', '社團法人台灣超級馬拉松運動協會', '收款戶名', now],
      ['payuniMerId', '', 'PAYUNi 統一金流商店代號 MerID', now],
      ['payuniHashKey', '', 'PAYUNi AES-256-GCM HashKey (32碼)', now],
      ['payuniHashIV', '', 'PAYUNi AES-256-GCM HashIV (16碼)', now],
      ['autoSendEmail', '1', '報名與入帳確認自動寄信開關 (1=開/0=關)', now]
    ];
    cfgSheet.getRange(2, 1, defaultCfg.length, defaultCfg[0].length).setValues(defaultCfg);
  }

  // 預設範例活動（若 Events 為空）
  const evSheet = ss.getSheetByName('Events');
  if (evSheet.getLastRow() <= 1) {
    const defaultCert = JSON.stringify({
      certMode: 'official', orientation: 'landscape', layoutId: 'classic', paletteId: 'tur-gold', fontId: 'noto-sans',
      showEventName: true, showRunnerName: true, showBib: true, showCategory: true,
      showPrimaryResult: true, showSecondaryResult: true, showDate: true,
      showOverallRank: true, showCatRank: true, showPace: true,
      showSplitAnalysis: true, showOfficialStamp: true,
      allowPublicPhotoQuote: true, enableWarrior800: true
    });
    const atmSchema = JSON.stringify({ paymentMode: 'MANUAL_ATM', customFields: [], addons: [] });
    const payuniSchema = JSON.stringify({ paymentMode: 'ONLINE_PAYUNi', customFields: [], addons: [] });
    const evRows = [
      ['TUR-2026-50K', 'org_north', '2026 TUR 台灣超級馬拉松挑戰賽', '2026 TUR Taiwan Ultra Marathon Challenge', 'TUR 台灣超馬協會', 'TUR Taiwan Ultra Runners', '新北市烏來區', 'distance', 0, 15, 'open', '2026-01-01 00:00:00', '2026-12-31 23:59:59', '2026-06-14 05:00:00', 800, 'dyn-trail', '【活動宗旨】挑戰台灣經典超馬路線。\n【起跑時間】2026-06-14 05:00 準時起跑。\n【補給站】每 5km 設置水站與熱食補給，請自備環保杯。', atmSchema, defaultCert],
      ['TUR-2026-12H', 'org_north', '2026 TUR 台北 12H 繞圈超馬賽', '2026 TUR Taipei 12H Lap Ultra', 'TUR 台灣超馬協會', 'TUR Taiwan Ultra Runners', '台北田徑暖身場', 'lap_timed', 1.0, 15, 'open', '2026-01-01 00:00:00', '2026-12-31 23:59:59', '2026-07-18 06:00:00', 400, 'dyn-track', '【活動賽制】標準繞圈限時賽，單圈 1.0 km，限時內完成之有效圈數累計總里程。\n【起跑時間】2026-07-18 06:00 準時起跑。\n【注意事項】超時圈次將留存紀錄但不計入有效里程。', payuniSchema, defaultCert]
    ];
    evSheet.getRange(2, 1, evRows.length, SHEET_SCHEMAS.Events.length).setValues(evRows);

    const catSheet = ss.getSheetByName('Categories');
    if (catSheet.getLastRow() <= 1) {
      catSheet.getRange(2, 1, 4, SHEET_SCHEMAS.Categories.length).setValues([
        ['CAT-50K', 'TUR-2026-50K', '50K 超馬組', 50, 8, 1800, 'A', '001', 300, ''],
        ['CAT-100K', 'TUR-2026-50K', '100K 八百壯士組', 100, 16, 2600, 'U', '001', 200, ''],
        ['CAT-12H', 'TUR-2026-12H', '12H 繞圈組', 1.0, 12, 2200, 'L', '001', 200, ''],
        ['CAT-6H', 'TUR-2026-12H', '6H 繞圈組', 1.0, 6, 1500, 'S', '001', 200, '']
      ]);
    }

    const stSheet = ss.getSheetByName('Stations');
    if (stSheet.getLastRow() <= 1) {
      stSheet.getRange(2, 1, 6, SHEET_SCHEMAS.Stations.length).setValues([
        ['ST-50K-0', 'TUR-2026-50K', 'CHECKIN', '起點報到檢錄', 0, 'checkin', 0],
        ['ST-50K-1', 'TUR-2026-50K', 'CP1', 'CP1 水庫折返站', 25, 'checkpoint', 1],
        ['ST-50K-2', 'TUR-2026-50K', 'CP2', 'CP2 山脊補給站', 50, 'checkpoint', 2],
        ['ST-50K-3', 'TUR-2026-50K', 'FINISH', '終點衝線拱門', 100, 'finish', 3],
        ['ST-12H-0', 'TUR-2026-12H', 'CHECKIN', '起點報到檢錄', 0, 'checkin', 0],
        ['ST-12H-1', 'TUR-2026-12H', 'LAP', '主會場繞圈計時拱門', 1.0, 'lap', 1]
      ]);
    }
  }

  return 'TUR v3.0 資料庫（8 張核心工作表）初始化完成！';
}

function initTurDatabase() {
  return setupSheets();
}

/**
 * 僅清空 6 張活動與成績工作表（保留 Users 帳號與 GlobalConfig 系統參數），
 * 方便從前台專區 5 點擊「⚡ 清空舊活動並重建 6 場全情境示範資料」重新寫入。
 */
function clearEventsDataOnly() {
  const targets = ['Events', 'Categories', 'Stations', 'Participants', 'TimingLogs', 'HistoryResults'];
  targets.forEach(function (name) {
    const sheet = ensureSheet(name);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(SHEET_SCHEMAS[name].length, sheet.getLastColumn())).clearContent();
    }
  });
  return '已清空 6 張活動與成績工作表（已保留 Users 與 GlobalConfig）。';
}

/* ============================================================================
 * HTTP Entrypoints (doGet / doPost) - 支援 JSON 與 JSONP
 * ============================================================================ */

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const callback = params.callback || '';
  try {
    const action = params.action || 'health';
    if (action === 'health') {
      return apiResponse({ ok: true, version: 'v3.0', service: 'TUR Governance GAS API', serverTime: formatNow() }, callback);
    }
    if (action === 'getBootstrapData') {
      return apiResponse(handleGetBootstrapData(params.eventId || ''), callback);
    }
    if (action === 'publicLookup') {
      return apiResponse(handlePublicLookup(params.eventId || '', params.query || ''), callback);
    }
    return apiResponse({ ok: false, error: 'Unknown GET action: ' + action }, callback);
  } catch (err) {
    return apiResponse({ ok: false, error: err.message || String(err) }, callback);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    const action = payload.action || '';

    switch (action) {
      case 'batchUploadLogs':
        return jsonResponse(handleBatchUploadLogs(payload));
      case 'registerRunner':
        return jsonResponse(handleRegisterRunner(payload));
      case 'payuniConfirm':
        return jsonResponse(handlePayuniConfirm(payload));
      case 'lookupAuth':
        return jsonResponse(handleLookupAuth(payload));
      case 'updateSelfRegistration':
        return jsonResponse(handleUpdateSelfRegistration(payload));
      case 'updateParticipant':
        return jsonResponse(handleUpdateParticipant(payload));
      case 'deleteParticipant':
        return jsonResponse(handleDeleteParticipant(payload));
      case 'batchUpdateParticipants':
        return jsonResponse(handleBatchUpdateParticipants(payload));
      case 'triggerGunStart':
        return jsonResponse(handleTriggerGunStart(payload));
      case 'saveEvent':
        return jsonResponse(handleUpsertRow('Events', 'eventId', payload.event));
      case 'saveCategory':
        return jsonResponse(handleUpsertRow('Categories', 'catId', payload.category));
      case 'saveStation':
        return jsonResponse(handleUpsertRow('Stations', 'stationId', payload.station));
      case 'saveUser':
        return jsonResponse(handleUpsertRow('Users', 'username', payload.user));
      case 'saveGlobalConfig':
        return jsonResponse(handleSaveGlobalConfig(payload));
      case 'adjustTimingLog':
        return jsonResponse(handleUpsertRow('TimingLogs', 'logId', payload.log));
      case 'batchImportHistory':
        return jsonResponse(handleBatchImportHistory(payload));
      case 'adminBatchUpdateSheet':
        return jsonResponse(handleAdminBatchUpdateSheet(payload));
      default:
        return jsonResponse({ ok: false, error: 'Unknown POST action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ============================================================================
 * Core Handlers
 * ============================================================================ */

function handleGetBootstrapData(eventId) {
  const ss = getTargetSpreadsheet();
  if (!ss.getSheetByName('Events') || !ss.getSheetByName('GlobalConfig')) {
    setupSheets();
  }

  const events = readSheetAsObjects('Events', 'eventId');
  let categories = readSheetAsObjects('Categories', 'catId');
  let stations = readSheetAsObjects('Stations', 'stationId');
  let participants = readSheetAsObjects('Participants', 'participantId');
  let timingLogs = readSheetAsObjects('TimingLogs', 'logId');
  const historyResults = readSheetAsObjects('HistoryResults', 'historyId');
  const users = readSheetAsObjects('Users', 'username');
  const globalConfig = readSheetAsObjects('GlobalConfig', 'configKey');

  if (eventId) {
    categories = categories.filter(function (r) { return String(r.eventId) === String(eventId); });
    stations = stations.filter(function (r) { return String(r.eventId) === String(eventId); });
    participants = participants.filter(function (r) { return String(r.eventId) === String(eventId); });
    timingLogs = timingLogs.filter(function (r) { return String(r.eventId) === String(eventId); });
  }

  return {
    ok: true,
    version: 'v3.0',
    serverTime: formatNow(),
    data: {
      events: events,
      categories: categories,
      stations: stations,
      participants: participants,
      timingLogs: timingLogs,
      historyResults: historyResults,
      users: users,
      globalConfig: globalConfig
    }
  };
}

/**
 * 公開頁查詢：嚴格隱藏身分證字號、聯絡電話、Email 與報到時間 (CHECKIN)
 */
function handlePublicLookup(eventId, query) {
  const events = readSheetAsObjects('Events', 'eventId');
  const categories = readSheetAsObjects('Categories', 'catId');
  const stations = readSheetAsObjects('Stations', 'stationId').filter(function (s) {
    return String(s.stationCode).toUpperCase() !== 'CHECKIN';
  });
  let participants = readSheetAsObjects('Participants', 'participantId');
  let timingLogs = readSheetAsObjects('TimingLogs', 'logId').filter(function (l) {
    return String(l.stationCode).toUpperCase() !== 'CHECKIN';
  });
  const historyResults = readSheetAsObjects('HistoryResults', 'historyId');

  if (eventId) {
    participants = participants.filter(function (p) { return String(p.eventId) === String(eventId); });
    timingLogs = timingLogs.filter(function (l) { return String(l.eventId) === String(eventId); });
  }

  const q = String(query || '').trim().toUpperCase();
  const safeParticipants = participants
    .filter(function (p) {
      if (!q) return true;
      return String(p.bibNumber || '').toUpperCase().indexOf(q) >= 0 ||
        String(p.name || '').toUpperCase().indexOf(q) >= 0;
    })
    .map(function (p) {
      return {
        participantId: p.participantId,
        eventId: p.eventId,
        catId: p.catId,
        bibNumber: p.bibNumber,
        groupName: p.groupName || '',
        name: p.name,
        gender: p.gender,
        nationality: p.nationality || 'TWN',
        payStatus: p.payStatus,
        checkinStatus: String(p.checkinStatus || '').toLowerCase() === 'checked_in' ? 'checked_in' : 'pending',
        raceStatus: p.raceStatus,
        penaltySeconds: Number(p.penaltySeconds || 0)
      };
    });

  return {
    ok: true,
    data: {
      events: events,
      categories: categories.filter(function (c) { return !eventId || String(c.eventId) === String(eventId); }),
      stations: stations.filter(function (s) { return !eventId || String(s.eventId) === String(eventId); }),
      participants: safeParticipants,
      timingLogs: timingLogs,
      historyResults: historyResults
    }
  };
}

/**
 * 最高管理員直通後端 BatchUpdate：直接整表覆寫或批次 Upsert Google 試算表
 */
function handleAdminBatchUpdateSheet(payload) {
  const sheetName = String(payload.sheetName || '');
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const mode = payload.mode || 'replace';

  if (!SHEET_SCHEMAS[sheetName]) {
    return { ok: false, error: '不支援的工作表名稱：' + sheetName };
  }

  const sheet = ensureSheet(sheetName);
  const headers = SHEET_SCHEMAS[sheetName];

  if (mode === 'replace') {
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
    }
    if (rows.length > 0) {
      const matrix = rows.map(function (obj) {
        return headers.map(function (h) {
          return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
        });
      });
      sheet.getRange(2, 1, matrix.length, headers.length).setValues(matrix);
    }
    return { ok: true, sheetName: sheetName, mode: 'replace', updatedRows: rows.length, serverTime: formatNow() };
  }

  // Upsert mode
  const keyField = KEY_FIELDS[sheetName];
  let count = 0;
  rows.forEach(function (obj) {
    if (obj && obj[keyField]) {
      handleUpsertRow(sheetName, keyField, obj);
      count++;
    }
  });
  return { ok: true, sheetName: sheetName, mode: 'upsert', updatedRows: count, serverTime: formatNow() };
}

function handleSaveGlobalConfig(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const now = formatNow();
  items.forEach(function (it) {
    if (it && it.configKey) {
      handleUpsertRow('GlobalConfig', 'configKey', {
        configKey: it.configKey,
        configValue: it.configValue !== undefined ? String(it.configValue) : '',
        description: it.description || '',
        updatedAt: now
      });
    }
  });
  return { ok: true, count: items.length };
}

function handleBatchImportHistory(payload) {
  const items = Array.isArray(payload.rows) ? payload.rows : [];
  if (items.length === 0) return { ok: true, inserted: 0, skipped: 0 };

  const sheet = ensureSheet('HistoryResults');
  const headers = SHEET_SCHEMAS.HistoryResults;
  const lastRow = sheet.getLastRow();
  const existing = {};
  if (lastRow > 1) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function (r) { if (r[0]) existing[String(r[0])] = true; });
  }

  const toInsert = [];
  let skipped = 0;
  items.forEach(function (it, idx) {
    const hid = String(it.historyId || ('HIS-' + Date.now() + '-' + idx));
    if (existing[hid]) { skipped++; return; }
    existing[hid] = true;
    toInsert.push(headers.map(function (h) {
      if (h === 'historyId') return hid;
      if (h === 'isWarrior800') return Boolean(it.isWarrior800);
      return it[h] !== undefined && it[h] !== null ? it[h] : '';
    }));
  });

  if (toInsert.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toInsert.length, headers.length).setValues(toInsert);
  }
  return { ok: true, inserted: toInsert.length, skipped: skipped };
}

/**
 * 統一金流 PAYUNi 背景銷帳並自動配號
 */
function handlePayuniConfirm(payload) {
  const merTradeNo = String(payload.merTradeNo || '');
  const participantId = String(payload.participantId || '');
  const payStatus = String(payload.payStatus || 'PAID').toUpperCase();

  const sheet = ensureSheet('Participants');
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length <= 1) return { ok: false, error: '無選手資料' };

  const headers = values[0];
  const idxPid = headers.indexOf('participantId');
  const idxMer = headers.indexOf('merTradeNo');
  const idxPay = headers.indexOf('payStatus');
  const idxType = headers.indexOf('paymentType');
  const idxTrade = headers.indexOf('tradeNo');
  const idxInfo = headers.indexOf('payInfo');
  const idxPaidAt = headers.indexOf('paidAt');
  const idxBib = headers.indexOf('bibNumber');
  const idxEv = headers.indexOf('eventId');
  const idxCat = headers.indexOf('catId');
  const idxEmail = headers.indexOf('email');
  const idxName = headers.indexOf('name');
  const idxAmt = headers.indexOf('totalAmount');

  const cats = readSheetAsObjects('Categories', 'catId');
  const evMap = getEventNameMap();
  let matchedCount = 0;
  const paidMails = [];

  for (let r = 1; r < values.length; r++) {
    const match = (merTradeNo && String(values[r][idxMer]) === merTradeNo) ||
      (participantId && String(values[r][idxPid]) === participantId);
    if (!match) continue;

    const prevPay = String(values[r][idxPay] || '').toUpperCase();
    values[r][idxPay] = payStatus;
    if (payload.paymentType) values[r][idxType] = payload.paymentType;
    if (payload.tradeNo) values[r][idxTrade] = payload.tradeNo;
    if (payload.payInfo) values[r][idxInfo] = payload.payInfo;
    values[r][idxPaidAt] = payload.paidAt || formatNow();

    // 若已繳費且尚未配號，立即自動配號
    if (payStatus === 'PAID' && !values[r][idxBib]) {
      const cat = cats.find(function (c) { return String(c.catId) === String(values[r][idxCat]); });
      const prefix = cat ? String(cat.bibPrefix || 'R') : 'R';
      const startNum = cat ? parseInt(cat.bibStartNum || '1', 10) : 1;
      const used = {};
      for (let k = 1; k < values.length; k++) {
        if (String(values[k][idxEv]) === String(values[r][idxEv]) && values[k][idxBib]) {
          used[String(values[k][idxBib]).toUpperCase()] = true;
        }
      }
      let num = startNum;
      let bib = prefix + ('000' + num).slice(-3);
      while (used[bib.toUpperCase()]) {
        num++;
        bib = prefix + ('000' + num).slice(-3);
      }
      values[r][idxBib] = bib;
    }
    if (payStatus === 'PAID' && prevPay !== 'PAID') {
      paidMails.push({
        email: String(values[r][idxEmail] || ''),
        name: String(values[r][idxName] || ''),
        pid: String(values[r][idxPid] || ''),
        bib: String(values[r][idxBib] || ''),
        eventName: evMap[String(values[r][idxEv])] || String(values[r][idxEv]),
        amount: Number(values[r][idxAmt] || 0),
        paidAt: String(values[r][idxPaidAt] || ''),
        channel: 'PAYUNi 線上金流'
      });
    }
    matchedCount++;
  }

  if (matchedCount > 0) range.setValues(values);
  if (isAutoSendEmailEnabled()) {
    paidMails.forEach(function (m) { sendPaymentConfirmedEmail(m); });
  }
  return { ok: true, updated: matchedCount, payStatus: payStatus, emailsSent: paidMails.length };
}

function handleBatchUploadLogs(payload) {
  const incoming = Array.isArray(payload.timingLogs) ? payload.timingLogs : [];
  if (incoming.length === 0) return { ok: true, inserted: 0, skipped: 0 };

  const sheet = ensureSheet('TimingLogs');
  const headers = SHEET_SCHEMAS.TimingLogs;
  const lastRow = sheet.getLastRow();
  const existingIds = {};
  if (lastRow > 1) {
    const idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < idValues.length; i++) {
      if (idValues[i][0]) existingIds[String(idValues[i][0])] = true;
    }
  }

  const rowsToInsert = [];
  let skipped = 0;
  for (let j = 0; j < incoming.length; j++) {
    const log = incoming[j];
    const logId = String(log.logId || ('LOG-' + Date.now() + '-' + j));
    if (existingIds[logId]) { skipped++; continue; }
    existingIds[logId] = true;
    rowsToInsert.push(headers.map(function (h) {
      if (h === 'logId') return logId;
      if (h === 'isValid') return log.isValid === false ? false : true;
      return log[h] !== undefined && log[h] !== null ? log[h] : '';
    }));
  }

  if (rowsToInsert.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToInsert.length, headers.length).setValues(rowsToInsert);
  }
  return { ok: true, inserted: rowsToInsert.length, skipped: skipped, serverTime: formatNow() };
}

function handleRegisterRunner(payload) {
  const runners = Array.isArray(payload.runners) ? payload.runners : (payload.runner ? [payload.runner] : []);
  if (runners.length === 0) return { ok: false, error: '報名資料不可為空' };
  if (runners.length > 50) return { ok: false, error: '單筆團體報名上限為 50 人' };

  const sheet = ensureSheet('Participants');
  const headers = SHEET_SCHEMAS.Participants;
  const eventsMap = {};
  readSheetAsObjects('Events', 'eventId').forEach(function (ev) { eventsMap[String(ev.eventId)] = ev; });
  const existing = readSheetAsObjects('Participants', 'participantId');
  const existingKeySet = {};
  existing.forEach(function (p) {
    existingKeySet[String(p.eventId) + '::' + String(p.idCard || '').toUpperCase()] = true;
  });

  const rowsToInsert = [];
  const created = [];
  for (let i = 0; i < runners.length; i++) {
    const r = runners[i];
    const key = String(r.eventId) + '::' + String(r.idCard || '').toUpperCase();
    if (existingKeySet[key]) {
      return { ok: false, error: '身分證/護照 ' + r.idCard + ' (' + r.name + ') 已報名本場活動' };
    }
    // 伺服器端嚴格管制本活動設定之金流作業模式（外部名單匯入 EXTERNAL_IMPORT 除外）
    const evObj = eventsMap[String(r.eventId)];
    if (evObj && evObj.formSchemaJson && String(r.payMethod || '') !== 'EXTERNAL_IMPORT') {
      try {
        const sc = JSON.parse(evObj.formSchemaJson);
        if (sc && sc.paymentMode && String(r.payMethod || '') !== String(sc.paymentMode)) {
          return { ok: false, error: '本活動金流管制為 ' + sc.paymentMode + '，不允許使用 ' + (r.payMethod || '其他方式') + ' 報名' };
        }
      } catch (_) {}
    }
    existingKeySet[key] = true;
    const rec = {
      participantId: r.participantId || ('TUR-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd') + '-' + Math.floor(10000 + Math.random() * 90000)),
      eventId: r.eventId || '',
      catId: r.catId || '',
      bibNumber: r.bibNumber || '',
      groupCode: r.groupCode || '',
      groupName: r.groupName || '',
      name: r.name || '',
      lastName: r.lastName || '',
      firstName: r.firstName || '',
      idCard: String(r.idCard || '').toUpperCase(),
      gender: r.gender || 'M',
      birthday: r.birthday || '',
      age: Number(r.age || 0),
      nationality: String(r.nationality || 'TWN').toUpperCase(),
      phone: String(r.phone || ''),
      email: String(r.email || ''),
      city: String(r.city || ''),
      emergencyName: String(r.emergencyName || ''),
      emergencyPhone: String(r.emergencyPhone || ''),
      diet: r.diet || '葷',
      remark: r.remark || '',
      totalAmount: Number(r.totalAmount || 0),
      addonsDetail: typeof r.addonsDetail === 'string' ? r.addonsDetail : JSON.stringify(r.addons || []),
      payMethod: r.payMethod || 'MANUAL_ATM',
      remittanceLast5: String(r.remittanceLast5 || ''),
      merTradeNo: r.merTradeNo || '',
      payStatus: String(r.payStatus || 'UNPAID').toUpperCase(),
      paymentType: r.paymentType || 'MANUAL',
      tradeNo: r.tradeNo || '',
      payInfo: r.payInfo || '',
      paidAt: r.paidAt || '',
      chipUid: String(r.chipUid || ''),
      checkinStatus: r.checkinStatus || 'pending',
      raceStatus: r.raceStatus || 'dns',
      penaltySeconds: Number(r.penaltySeconds || 0),
      createdAt: r.createdAt || formatNow(),
      customFieldsJson: typeof r.customFieldsJson === 'string' ? r.customFieldsJson : JSON.stringify(r.customFields || {})
    };
    created.push(rec);
    rowsToInsert.push(headers.map(function (h) { return rec[h]; }));
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rowsToInsert.length, headers.length).setValues(rowsToInsert);

  let emailsSent = 0;
  if (isAutoSendEmailEnabled()) {
    const evMap = getEventNameMap();
    const bankTxt = getBankSummaryText();
    created.forEach(function (rec) {
      if (rec.email && rec.email.indexOf('@') > 0) {
        const evName = evMap[String(rec.eventId)] || rec.eventId;
        const isPaid = String(rec.payStatus).toUpperCase() === 'PAID';
        safeSendMail(
          rec.email,
          '【TUR 賽事報名確認】' + evName + '（序號 ' + rec.participantId + '）',
          '親愛的 ' + rec.name + ' 您好：\n\n您已完成「' + evName + '」報名作業！\n' +
          '────────────────────────\n' +
          '• 報名序號：' + rec.participantId + '\n' +
          (rec.groupCode ? '• 團報代碼：' + rec.groupCode + '（' + (rec.groupName || '') + '）\n' : '') +
          (rec.bibNumber ? '• 參賽號碼布：' + rec.bibNumber + '\n' : '') +
          '• 付款管道：' + rec.payMethod + '\n' +
          '• 應繳金額：NT$ ' + rec.totalAmount + '\n' +
          '• 目前繳費狀態：' + (isPaid ? '已繳費入帳 (PAID)' : '待繳費 (UNPAID)') + '\n' +
          (!isPaid && rec.payMethod === 'ONLINE_PAYUNi'
            ? '\n【線上金流付款說明】\n本場次採 PAYUNi 統一金流線上結帳，完成付款後將由系統自動秒級銷帳、配發號碼布並再次寄發入帳通知信。\n'
            : (!isPaid && bankTxt ? '\n【大會匯款資訊（轉帳核對末五碼）】\n' + bankTxt + '\n請完成匯款後至「雙因子查改 (/lookup)」填報帳號末五碼供大會對帳。\n' : '')) +
          '────────────────────────\n' +
          '【反向查詢與修改說明 (/lookup)】\n' +
          '您可隨時使用「身分證字號/護照」＋「報名序號或 Email」登入報名系統進行雙因子查改：\n' +
          '1. 尚未繳費前：可修改組別、加購服務、匯款末五碼及所有聯絡資料。\n' +
          '2. 確認繳費後：費用相關項目（組別、加購、金額、末五碼）將自動鎖定不可變更；其餘聯絡電話、緊急聯絡人、飲食與自訂欄位仍可修改。\n\n' +
          'TUR 台灣超馬賽事組委會 敬上'
        );
        emailsSent++;
        if (isPaid) {
          sendPaymentConfirmedEmail({
            email: rec.email, name: rec.name, pid: rec.participantId, bib: rec.bibNumber,
            eventName: evName, amount: rec.totalAmount, paidAt: rec.paidAt || formatNow(), channel: rec.payMethod
          });
          emailsSent++;
        }
      }
    });
  }

  return { ok: true, count: created.length, participants: created, emailsSent: emailsSent };
}

function handleLookupAuth(payload) {
  const idCard = String(payload.idCard || '').trim().toUpperCase();
  const credential = String(payload.credential || '').trim().toUpperCase();
  const list = readSheetAsObjects('Participants', 'participantId');
  const found = list.find(function (p) {
    return String(p.idCard || '').toUpperCase() === idCard &&
      (String(p.participantId || '').toUpperCase() === credential || String(p.email || '').toUpperCase() === credential);
  });
  if (!found) return { ok: false, error: '查無符合之報名資料' };
  return { ok: true, expiresAt: Date.now() + 45 * 60 * 1000, participant: found };
}

function handleUpdateSelfRegistration(payload) {
  const pid = String(payload.participantId || '');
  const idCard = String(payload.idCard || '').toUpperCase();
  const patch = payload.patch || {};
  const sheet = ensureSheet('Participants');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxPid = headers.indexOf('participantId');
  const idxId = headers.indexOf('idCard');
  const idxPay = headers.indexOf('payStatus');
  const idxEv = headers.indexOf('eventId');
  const idxEmail = headers.indexOf('email');
  const idxName = headers.indexOf('name');
  const idxRace = headers.indexOf('raceStatus');

  const events = readSheetAsObjects('Events', 'eventId');
  const evById = {};
  events.forEach(function (ev) { evById[String(ev.eventId)] = ev; });

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idxPid]) === pid && String(values[r][idxId]).toUpperCase() === idCard) {
      const ev = evById[String(values[r][idxEv])];
      const paySt = String(values[r][idxPay] || '').toUpperCase();
      if (paySt === 'CANCELLED') return { ok: false, error: '此筆報名已取消，無法修改' };
      if (ev && String(ev.status) === 'finished') return { ok: false, error: '本活動已結案鎖定，不再開放反向修改' };
      if (idxRace >= 0 && String(values[r][idxRace]) === 'finished') return { ok: false, error: '您已完成賽事並寫入正式成績，無法再修改報名資料' };

      const isPaid = paySt === 'PAID';
      // 嚴格把關：已繳費 (PAID) 絕對禁止修改任何費用相關欄位 (catId, addonsDetail, totalAmount, remittanceLast5, payMethod)
      const allowed = isPaid
        ? ['phone', 'email', 'city', 'emergencyName', 'emergencyPhone', 'diet', 'remark', 'customFieldsJson']
        : ['phone', 'email', 'city', 'emergencyName', 'emergencyPhone', 'diet', 'remark', 'customFieldsJson', 'catId', 'addonsDetail', 'totalAmount', 'remittanceLast5', 'nationality'];
      allowed.forEach(function (f) {
        const c = headers.indexOf(f);
        if (c >= 0 && patch[f] !== undefined) values[r][c] = patch[f];
      });
      sheet.getRange(r + 1, 1, 1, headers.length).setValues([values[r]]);

      if (isAutoSendEmailEnabled()) {
        const mailTo = String(values[r][idxEmail] || '');
        const runnerName = String(values[r][idxName] || '');
        const evName = ev ? ev.nameZh : String(values[r][idxEv]);
        if (mailTo && mailTo.indexOf('@') > 0) {
          safeSendMail(
            mailTo,
            '【TUR 報名資料修改通知】' + evName + '（序號 ' + pid + '）',
            '親愛的 ' + runnerName + ' 您好：\n\n您已於 ' + formatNow() + ' 透過雙因子查改系統完成報名資料更新。\n' +
            '• 活動名稱：' + evName + '\n' +
            '• 報名序號：' + pid + '\n' +
            '• 繳費狀態：' + (isPaid ? '已繳費 (PAID) — 費用相關選項已維持鎖定' : '待繳費 (UNPAID) — 已同步更新組別/加購與金額') + '\n\n' +
            '若非本人操作，請盡速聯繫大會組委會。\nTUR 台灣超馬賽事組委會 敬上'
          );
        }
      }
      return { ok: true, lockedPaidFields: isPaid };
    }
  }
  return { ok: false, error: '找不到報名資料' };
}

function handleUpdateParticipant(payload) {
  const u = payload.participant || payload.update;
  if (!u || !u.participantId) return { ok: false, error: '缺少 participantId' };
  return handleBatchUpdateParticipants({ updates: [u], sendMail: Boolean(payload.sendMail) });
}

/**
 * 承辦人 / 最高管理員刪除指定選手資料
 */
function handleDeleteParticipant(payload) {
  const pid = String(payload.participantId || '');
  if (!pid) return { ok: false, error: '缺少 participantId' };
  const sheet = ensureSheet('Participants');
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { ok: true, deleted: 0 };
  const idxPid = values[0].indexOf('participantId');
  for (let r = values.length - 1; r >= 1; r--) {
    if (String(values[r][idxPid]) === pid) {
      sheet.deleteRow(r + 1);
      return { ok: true, deleted: 1, participantId: pid };
    }
  }
  return { ok: true, deleted: 0, participantId: pid };
}

function handleBatchUpdateParticipants(payload) {
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (updates.length === 0) return { ok: true, updated: 0 };

  const sheet = ensureSheet('Participants');
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length <= 1) return { ok: true, updated: 0 };

  const headers = values[0];
  const idxPid = headers.indexOf('participantId');
  const idxPay = headers.indexOf('payStatus');
  const idxEmail = headers.indexOf('email');
  const idxName = headers.indexOf('name');
  const idxBib = headers.indexOf('bibNumber');
  const idxEv = headers.indexOf('eventId');
  const idxAmt = headers.indexOf('totalAmount');
  const idxPaidAt = headers.indexOf('paidAt');
  const evMap = getEventNameMap();
  const updateMap = {};
  updates.forEach(function (u) { if (u && u.participantId) updateMap[String(u.participantId)] = u; });

  let count = 0;
  const mails = [];
  for (let r = 1; r < values.length; r++) {
    const pid = String(values[r][idxPid]);
    const patch = updateMap[pid];
    if (!patch) continue;
    const prevPay = String(values[r][idxPay]).toUpperCase();
    Object.keys(patch).forEach(function (k) {
      const c = headers.indexOf(k);
      if (c >= 0 && k !== 'participantId' && patch[k] !== undefined) values[r][c] = patch[k];
    });
    count++;
    if (payload.sendMail !== false && prevPay !== 'PAID' && String(values[r][idxPay]).toUpperCase() === 'PAID') {
      mails.push({
        email: String(values[r][idxEmail] || ''),
        name: String(values[r][idxName] || ''),
        pid: pid,
        bib: String(values[r][idxBib] || ''),
        eventName: evMap[String(values[r][idxEv])] || String(values[r][idxEv]),
        amount: Number(values[r][idxAmt] || 0),
        paidAt: String(values[r][idxPaidAt] || formatNow()),
        channel: '大會對帳入帳確認'
      });
    }
  }
  if (count > 0) range.setValues(values);
  if (isAutoSendEmailEnabled()) {
    mails.forEach(function (m) { sendPaymentConfirmedEmail(m); });
  }
  return { ok: true, updated: count, emailsSent: mails.length };
}

function handleTriggerGunStart(payload) {
  const eventId = String(payload.eventId || '');
  const raceStart = String(payload.raceStart || formatNow());
  if (!eventId) return { ok: false, error: '缺少 eventId' };

  const evSheet = ensureSheet('Events');
  const evRange = evSheet.getDataRange();
  const evValues = evRange.getValues();
  const evH = evValues[0];
  const idxEv = evH.indexOf('eventId');
  const idxStart = evH.indexOf('raceStart');
  for (let i = 1; i < evValues.length; i++) {
    if (String(evValues[i][idxEv]) === eventId) { evValues[i][idxStart] = raceStart; break; }
  }
  evRange.setValues(evValues);

  const pSheet = ensureSheet('Participants');
  const pRange = pSheet.getDataRange();
  const pValues = pRange.getValues();
  const pH = pValues[0];
  const pEv = pH.indexOf('eventId');
  const pPay = pH.indexOf('payStatus');
  const pRace = pH.indexOf('raceStatus');
  let started = 0;
  for (let r = 1; r < pValues.length; r++) {
    if (String(pValues[r][pEv]) === eventId && String(pValues[r][pPay]).toUpperCase() === 'PAID') {
      if (!pValues[r][pRace] || String(pValues[r][pRace]) === 'dns') {
        pValues[r][pRace] = 'on_track';
        started++;
      }
    }
  }
  if (started > 0) pRange.setValues(pValues);
  return { ok: true, eventId: eventId, raceStart: raceStart, startedCount: started };
}

function handleUpsertRow(sheetName, keyField, obj) {
  if (!obj || !obj[keyField]) return { ok: false, error: '缺少主鍵 ' + keyField };
  const sheet = ensureSheet(sheetName);
  const headers = SHEET_SCHEMAS[sheetName];
  const values = sheet.getDataRange().getValues();
  const keyIdx = headers.indexOf(keyField);
  const rowArr = headers.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? obj[h] : ''; });

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][keyIdx]) === String(obj[keyField])) {
      sheet.getRange(r + 1, 1, 1, headers.length).setValues([rowArr]);
      return { ok: true, mode: 'updated', id: obj[keyField] };
    }
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([rowArr]);
  return { ok: true, mode: 'inserted', id: obj[keyField] };
}

/* ============================================================================
 * Utilities
 * ============================================================================ */

function ensureSheet(name) {
  const ss = getTargetSpreadsheet();
  let sheet = ss.getSheetByName(name);
  const headers = SHEET_SCHEMAS[name];
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else if (headers && sheet.getLastRow() >= 1) {
    const curCols = sheet.getLastColumn();
    const curHeaders = curCols > 0 ? sheet.getRange(1, 1, 1, curCols).getValues()[0].map(function (h) { return String(h || '').trim(); }) : [];
    const missing = headers.filter(function (h) { return curHeaders.indexOf(h) === -1; });
    if (missing.length > 0) {
      sheet.getRange(1, curCols + 1, 1, missing.length).setValues([missing]);
    }
  }
  return sheet;
}

function readSheetAsObjects(name, requiredKey) {
  const sheet = ensureSheet(name);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0].map(function (h) { return String(h || '').trim(); });
  const result = [];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      let val = values[r][c];
      if (val instanceof Date) val = Utilities.formatDate(val, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
      if (val !== '' && val !== null && val !== undefined) hasValue = true;
      obj[h] = val;
    }
    if (!hasValue) continue;
    if (requiredKey) {
      const kv = obj[requiredKey];
      if (kv === '' || kv === null || kv === undefined) continue;
      obj[requiredKey] = String(kv).trim();
    }
    result.push(obj);
  }
  return result;
}

function formatNow() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

function safeSendMail(to, subject, body) {
  try { MailApp.sendEmail(to, subject, body); } catch (err) { Logger.log('Mail skipped: ' + err.message); }
}

function isAutoSendEmailEnabled() {
  try {
    const cfgs = readSheetAsObjects('GlobalConfig', 'configKey');
    const found = cfgs.find(function (c) { return String(c.configKey) === 'autoSendEmail'; });
    if (!found) return true;
    return String(found.configValue).trim() !== '0';
  } catch (_) { return true; }
}

function getEventNameMap() {
  const map = {};
  try {
    readSheetAsObjects('Events', 'eventId').forEach(function (e) { map[String(e.eventId)] = e.nameZh || e.eventId; });
  } catch (_) {}
  return map;
}

function getBankSummaryText() {
  try {
    const map = {};
    readSheetAsObjects('GlobalConfig', 'configKey').forEach(function (c) { map[String(c.configKey)] = c.configValue; });
    if (!map.bankAccount) return '';
    return '銀行：(' + (map.bankCode || '004') + ') ' + (map.bankName || '') + '\n帳號：' + map.bankAccount + '\n戶名：' + (map.bankAccountName || '');
  } catch (_) { return ''; }
}

function sendPaymentConfirmedEmail(m) {
  if (!m || !m.email || m.email.indexOf('@') <= 0) return;
  safeSendMail(
    m.email,
    '【TUR 繳費入帳確認通知】' + (m.eventName || '') + '（序號 ' + m.pid + '）',
    '親愛的 ' + m.name + ' 您好：\n\n您的報名款項已確認入帳完成（PAID）！\n' +
    '────────────────────────\n' +
    '• 活動名稱：' + (m.eventName || '-') + '\n' +
    '• 報名序號：' + m.pid + '\n' +
    '• 參賽號碼布：' + (m.bib || '即將依組別自動配發') + '\n' +
    '• 實繳金額：NT$ ' + (m.amount || 0) + '\n' +
    '• 入帳方式：' + (m.channel || '系統確認') + '\n' +
    '• 入帳時間：' + (m.paidAt || formatNow()) + '\n' +
    '────────────────────────\n' +
    '【重要提醒：費用選項已鎖定】\n' +
    '因款項已入帳，系統已自動鎖定「組別、加購服務、應繳金額與匯款末五碼」不可再修改。\n' +
    '若需修改聯絡電話、Email、緊急聯絡人、飲食習慣或自訂非費用欄位，仍可於賽前隨時至「雙因子查改 (/lookup)」自行更新。\n\n' +
    '祝您順利完賽！\nTUR 台灣超馬賽事組委會 敬上'
  );
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiResponse(obj, callback) {
  const json = JSON.stringify(obj);
  const safeCb = String(callback || '').replace(/[^a-zA-Z0-9_$.]/g, '');
  if (safeCb) {
    return ContentService.createTextOutput(safeCb + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
