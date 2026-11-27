/**
 * ============================================================================
 * TUR v3.0 Main Application Controller (js/tur-app.js)
 * 四層權責隔離、零紀錄登入、雙軌金流、14項防呆、離線 NFC 站點感應、雙向同步
 * ============================================================================
 */
(function (global) {
  'use strict';

  const C = global.TurCore;
  const Z = global.TurZones;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function toast(msg, type = 'info') {
    const colors = { success: 'bg-emerald-600 text-white', warn: 'bg-amber-500 text-slate-950', error: 'bg-rose-600 text-white', info: 'bg-slate-900 text-white' };
    const el = document.createElement('div');
    el.className = `px-3.5 py-2.5 rounded-xl shadow-lg text-xs font-bold ${colors[type] || colors.info}`;
    el.textContent = msg;
    $('#toastBox').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3400);
  }

  /* --------------------------------------------------------------------------
   * Hardware Feedback Engine (綠/黃/紅閃 + Web Audio API + Vibration)
   * -------------------------------------------------------------------------- */
  const Feedback = (() => {
    let ctx = null;
    function ac() {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function beep(freq, ms, delay = 0, type = 'sine') {
      try {
        const a = ac(); if (!a) return;
        const o = a.createOscillator(), g = a.createGain();
        o.type = type; o.frequency.value = freq; g.gain.value = 0.22;
        o.connect(g); g.connect(a.destination);
        const t = a.currentTime + delay / 1000;
        o.start(t); o.stop(t + ms / 1000);
      } catch (_) {}
    }
    function flash(cls, ms = 260) {
      const ov = $('#flashOverlay');
      ov.className = 'flash-overlay ' + cls;
      setTimeout(() => { ov.className = 'flash-overlay'; }, ms);
    }
    return {
      success() { flash('flash-green', 240); beep(1180, 90, 0); beep(1560, 110, 110); navigator.vibrate?.([80]); },
      writeOk() { flash('flash-green', 300); beep(1046, 80, 0); beep(1318, 80, 100); beep(1568, 120, 200); navigator.vibrate?.([70, 50, 70]); },
      warn() { flash('flash-yellow', 300); beep(660, 110, 0, 'triangle'); beep(540, 130, 140, 'triangle'); navigator.vibrate?.([80, 60, 80]); },
      error() { flash('flash-red', 420); beep(240, 380, 0, 'sawtooth'); navigator.vibrate?.([400]); }
    };
  })();

  /* --------------------------------------------------------------------------
   * Application State (Zero-Trace Auth in Memory / sessionStorage Only)
   * -------------------------------------------------------------------------- */
  const CFG = global.TUR_CONFIG || {};
  const initGasUrl = (localStorage.getItem('TUR_GAS_URL') || '').trim() || String(CFG.gasUrl || '').trim() || C.DEFAULT_GAS_URL || '';
  const savedSyncMode = localStorage.getItem('TUR_SYNC_MODE');
  const initSyncMode = (savedSyncMode === 'offline' || savedSyncMode === 'cloud')
    ? savedSyncMode
    : (CFG.defaultSyncMode === 'offline' ? 'offline' : (initGasUrl ? 'cloud' : 'offline'));

  const State = {
    events: [], categories: [], stations: [], participants: [], timingLogs: [],
    historyResults: [], users: [], globalConfig: [], syncQueue: [],
    gasUrl: initGasUrl,
    syncMode: initSyncMode, // 'offline' (📴 單機離線) | 'cloud' (🌐 雲端連線)
    currentUser: { username: 'public', displayName: '民眾 / 跑者', role: 'public', allowedStation: '' },
    activePillar: 'portal', // 'portal' | 'register' | 'scores' | 'timing' | 'admin'
    activeView: 'portal-home',
    scoreSubTab: 'live', // 'live' | 'history' | 'warriors' | 'cert'
    hostSubTab: 'create', // 'create' | 'recon'
    hostReconEventId: '',
    regEventId: '',
    regMode: 'solo', // 'solo' | 'group'
    multiOwner: '', // 先鎖定單一承辦人 (ownerUsername)，不同承辦人收款帳戶不同不可混單
    multiPayMode: '', // 'MANUAL_ATM' | 'ONLINE_PAYUNi'
    multiSelected: {}, // { [eventId]: { selected, catId, addons: [], customFields: {} } }
    multiLastReceipt: null,
    z1EventId: '',
    z1ViewMode: 'lobby', // 'lobby' (活動卡片列表) | 'detail' (點入單一活動細部)
    z1LobbyOwnerFilter: 'all',
    loginAdminTab: 'super_admin', // 'super_admin' | 'organizer'
    z2EventId: '',
    opEventId: '',
    opLockedStation: '',
    groupCart: [],
    lookupSession: null,
    selectedWriterPid: null,
    nfcScanning: false,
    lastScanMap: new Map(),
    pickedOpUser: null,
    // O(1) Memory Indices
    idxById: new Map(), idxByBib: new Map(), idxByUid: new Map(), idxByIdCard: new Map()
  };

  function getConfigVal(key, fallback = '') {
    const found = State.globalConfig.find((c) => c.configKey === key);
    return found && found.configValue !== '' ? found.configValue : fallback;
  }

  function rebuildIndices(scopeEventId = '') {
    State.idxById.clear(); State.idxByBib.clear(); State.idxByUid.clear(); State.idxByIdCard.clear();
    const targetEv = scopeEventId || State.opEventId || State.regEventId || State.z1EventId;
    for (const p of State.participants) {
      State.idxById.set(p.participantId, p);
      if (targetEv && p.eventId !== targetEv) continue;
      if (p.bibNumber) State.idxByBib.set(String(p.bibNumber).toUpperCase(), p);
      if (p.chipUid) State.idxByUid.set(String(p.chipUid).toUpperCase(), p);
      if (p.idCard) State.idxByIdCard.set(String(p.idCard).toUpperCase(), p);
    }
  }

  /* --------------------------------------------------------------------------
   * Sync Engine (📴 單機離線 ⇄ 🌐 雲端連線 ＋ 雙向同步 ＋ 進階單向同步)
   * -------------------------------------------------------------------------- */
  let syncInFlight = false;
  let syncAgainAfter = false;
  let batchTimer = null;

  function isCloudSyncEnabled() {
    return State.syncMode === 'cloud' && Boolean(State.gasUrl) && navigator.onLine;
  }

  function setSyncMode(mode, silent = false) {
    const next = mode === 'offline' ? 'offline' : 'cloud';
    State.syncMode = next;
    localStorage.setItem('TUR_SYNC_MODE', next);
    updateNetworkBadge();
    if (!silent) {
      if (next === 'offline') {
        toast('📴 已切換至「單機離線」模式：所有異動只存本機，不自動上傳雲端', 'warn');
      } else if (!State.gasUrl) {
        toast('🌐 已切換至「雲端連線」，但尚未設定 GAS 網址（請至「四、後台管理 → 五、資料庫專區」設定）', 'warn');
      } else if (!navigator.onLine) {
        toast('🌐 已切換至「雲端連線」（目前裝置斷網，待恢復網路後再按「☁️ 同步」雙向同步）', 'warn');
      } else if (State.syncQueue.length > 0) {
        toast(`🌐 已切回「雲端連線」！本機有 ${State.syncQueue.length} 筆待同步資料，請點右上角「☁️ 同步 (${State.syncQueue.length})」立即雙向同步`, 'success');
      } else {
        toast('🌐 已切換至「雲端連線」模式：多機即時共用 Google 試算表', 'success');
      }
    }
    if (State.activeView === 'zone5') Z.renderZone5(AppBridge);
  }

  async function enqueueSync(action, payload, immediate = true) {
    const item = { qid: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action, payload, createdAt: Date.now() };
    State.syncQueue.push(item);
    await C.TurDB.put('syncQueue', item);
    updateQueueBadge();

    // 📴 單機離線模式或無網路／無 GAS 時，只安全暫存於本機佇列，絕不自動上傳
    if (!isCloudSyncEnabled()) return;

    // 賽道高頻刷卡採 8 秒背景批次合併上傳（不阻塞 <10ms 感應）；報名/對帳/設定則立即寫入雲端
    if (action === 'addTimingLog' && !immediate) {
      if (!batchTimer) {
        batchTimer = setTimeout(() => {
          batchTimer = null;
          if (isCloudSyncEnabled()) syncPushNow(true);
        }, 8000);
      }
    } else {
      syncPushNow(true);
    }
  }

  function shouldShowSyncControls() {
    const role = State.currentUser?.role || 'public';
    const pillar = getPillarForView(State.activeView);
    return role !== 'public' || pillar === 'timing' || pillar === 'admin';
  }

  function updateQueueBadge() {
    const cnt = State.syncQueue.length;
    const el = $('#pendingQueueCount');
    if (el) el.textContent = cnt;
    const btn = $('#btnSyncBidirectional');
    if (btn) {
      const show = shouldShowSyncControls();
      btn.className = `${show ? '' : 'hidden '}px-2.5 py-1.5 rounded-lg ${cnt > 0 ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-black shadow' : 'bg-sky-600 hover:bg-sky-500 text-white font-bold'} flex items-center gap-1 whitespace-nowrap`;
    }
  }

  function updateNetworkBadge() {
    const isOff = State.syncMode === 'offline';
    const online = navigator.onLine;
    const hasUrl = Boolean(State.gasUrl);
    const cnt = State.syncQueue.length;
    const showSync = shouldShowSyncControls();

    let label = '🌐 雲端連線';
    let badgeCls = 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    let lightBadgeCls = 'bg-emerald-100 text-emerald-800 border border-emerald-300';
    if (isOff) {
      label = '📴 單機離線';
      badgeCls = 'bg-slate-700 text-amber-300 border border-amber-400/50';
      lightBadgeCls = 'bg-amber-100 text-amber-900 border border-amber-300';
    } else if (!online) {
      label = '⚠️ 斷網暫存中';
      badgeCls = 'bg-rose-500/25 text-rose-200 border border-rose-400/50';
      lightBadgeCls = 'bg-rose-100 text-rose-800 border border-rose-300';
    } else if (!hasUrl) {
      label = '💻 本機模式（未綁 GAS）';
      badgeCls = 'bg-sky-500/20 text-sky-200 border border-sky-400/40';
      lightBadgeCls = 'bg-sky-100 text-sky-900 border border-sky-300';
    }

    const b = $('#netBadge');
    if (b) { b.textContent = label; b.className = `${showSync ? '' : 'hidden '}whitespace-nowrap text-[11px] px-2 py-0.5 rounded-full font-bold ${badgeCls}`; }
    const sw = $('#syncModeSwitcher');
    if (sw) sw.classList.toggle('hidden', !showSync);

    const dutyB = $('#opDutySyncBadge');
    if (dutyB) {
      dutyB.textContent = `${label}${cnt > 0 ? ` · 待傳 ${cnt}` : ''}`;
      dutyB.className = `px-2.5 py-1.5 rounded-xl font-black ${badgeCls}`;
    }
    const inlineB = $('#opInlineSyncBadge');
    if (inlineB) {
      inlineB.textContent = `${label}${cnt > 0 ? ` · 待傳 ${cnt}` : ''}`;
      inlineB.className = `px-2.5 py-1 rounded-full text-[11px] font-black ${lightBadgeCls}`;
    }

    const btnOff = $('#btnSyncModeOffline');
    const btnCloud = $('#btnSyncModeCloud');
    if (btnOff && btnCloud) {
      btnOff.className = isOff
        ? 'px-2 py-1 rounded text-[11px] font-black bg-amber-400 text-slate-950 whitespace-nowrap transition'
        : 'px-2 py-1 rounded text-[11px] font-bold text-slate-300 hover:bg-slate-800 whitespace-nowrap transition';
      btnCloud.className = !isOff
        ? 'px-2 py-1 rounded text-[11px] font-black bg-emerald-500 text-slate-950 whitespace-nowrap transition'
        : 'px-2 py-1 rounded text-[11px] font-bold text-slate-300 hover:bg-slate-800 whitespace-nowrap transition';
    }
    updateQueueBadge();
  }

  async function syncPushNow(silent = false) {
    if (!State.syncQueue.length) { if (!silent) toast('本機無待上傳紀錄，雲端已同步', 'info'); return { ok: true, uploaded: 0 }; }
    if (State.syncMode === 'offline') { if (!silent) toast('目前為 📴 單機離線模式，請先切回 🌐 雲端連線後再同步', 'warn'); return { ok: false, error: '單機離線模式' }; }
    if (!State.gasUrl) { if (!silent) toast(`本機已保存 ${State.syncQueue.length} 筆待同步資料（請於資料庫專區設定 GAS 網址）`, 'warn'); return { ok: false, error: '尚未設定 GAS URL' }; }
    if (!navigator.onLine) { if (!silent) toast('目前離線中，待恢復網路後請點「🔄 立即雙向同步」', 'warn'); return { ok: false, error: '目前為離線狀態' }; }

    if (syncInFlight) { syncAgainAfter = true; return { ok: true, queued: true }; }
    syncInFlight = true;

    const snap = [...State.syncQueue];
    const logItems = [], logQids = [], partUpd = [], partQids = [], others = [];
    for (const q of snap) {
      if (q.action === 'addTimingLog') { logItems.push(q.payload); logQids.push(q.qid); }
      else if (q.action === 'updateParticipant') { partUpd.push(q.payload); partQids.push(q.qid); }
      else others.push(q);
    }

    let uploaded = 0;
    let lastError = '';
    try {
      // 1. 先執行建檔與結構寫入（registerRunner / saveEvent / saveCategory 等），確保列已存在於試算表
      for (const it of others) {
        const res = await C.gasPost(State.gasUrl, { action: it.action, ...it.payload });
        if (!res || !res.ok) throw new Error((res && res.error) || `同步 ${it.action} 失敗`);
        await C.TurDB.remove('syncQueue', it.qid);
        State.syncQueue = State.syncQueue.filter((x) => x.qid !== it.qid);
        uploaded++;
      }
      // 2. 再批次更新選手狀態 / 配號 / 晶片
      if (partUpd.length) {
        const res = await C.gasPost(State.gasUrl, { action: 'batchUpdateParticipants', updates: partUpd, sendMail: true });
        if (!res || !res.ok) throw new Error((res && res.error) || '批次更新選手失敗');
        for (const id of partQids) { await C.TurDB.remove('syncQueue', id); State.syncQueue = State.syncQueue.filter((x) => x.qid !== id); }
        uploaded += partUpd.length;
      }
      // 3. 最後批次寫入高頻感應紀錄（伺服器端自動依 logId 去重）
      if (logItems.length) {
        const res = await C.gasPost(State.gasUrl, { action: 'batchUploadLogs', timingLogs: logItems });
        if (!res || !res.ok) throw new Error((res && res.error) || '批次上傳感應紀錄失敗');
        for (const id of logQids) { await C.TurDB.remove('syncQueue', id); State.syncQueue = State.syncQueue.filter((x) => x.qid !== id); }
        uploaded += logItems.length;
      }
      updateNetworkBadge();
      if (!silent) toast(`☁️ 上傳完成！共寫入 ${uploaded} 筆至 Google 試算表`, 'success');
    } catch (err) {
      lastError = err.message || String(err);
      updateNetworkBadge();
      if (!silent) toast(`上傳失敗：${lastError}`, 'error');
      else console.warn('[TUR AutoSync error]', lastError);
    } finally {
      syncInFlight = false;
      if (syncAgainAfter && State.syncQueue.length > 0 && isCloudSyncEnabled()) {
        syncAgainAfter = false;
        setTimeout(() => syncPushNow(true), 600);
      }
    }
    return lastError ? { ok: false, error: lastError, uploaded } : { ok: true, uploaded };
  }

  async function applyCloudBootstrap(d) {
    const keys = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users', 'globalConfig'];
    for (const k of keys) {
      if (Array.isArray(d[k]) && (k !== 'users' || d[k].length)) {
        const rows = k === 'events' ? d[k].map((e) => C.normalizeEventData({ ...e })) : d[k];
        State[k] = rows;
        await C.TurDB.clearAndFill(k, rows);
      }
    }
    const cloudInited = (State.globalConfig || []).some((g) => g.configKey === 'platformInitialized' && String(g.configValue) === '1');
    if (cloudInited || (Array.isArray(d.events) && d.events.length === 0)) {
      localStorage.setItem('TUR_CLEAN_RESET', '1');
    }
    if (State.currentUser && State.currentUser.role !== 'public') {
      const refreshed = State.users.find((x) => x.username === State.currentUser.username && Number(x.enabled));
      if (refreshed) State.currentUser = refreshed;
    }
    rebuildIndices();
    renderAll();
  }

  // 步驟 3：🔄 立即雙向同步（先上傳本機異動自動去重，再下載雲端最新資料）
  async function syncBidirectional(silent = false) {
    if (State.syncMode === 'offline') {
      if (silent) return;
      if (!confirm('目前為 📴 單機離線模式。\n是否切換至 🌐 雲端連線，並立即執行「🔄 雙向同步（先上傳本機異動，再下載雲端最新資料）」？')) return;
      setSyncMode('cloud', true);
    }
    if (!State.gasUrl) { if (!silent) toast('尚未設定 GAS 網址（/exec），請先至「四、後台管理 → 五、資料庫專區」設定', 'warn'); return; }
    if (!navigator.onLine) { if (!silent) toast('目前裝置無網路連線，請待恢復網路後再同步', 'warn'); return; }
    try {
      let pushed = 0;
      if (State.syncQueue.length > 0) {
        const pushRes = await syncPushNow(true);
        if (!pushRes.ok) {
          if (!silent) toast(`⚠️ 上傳本機異動失敗（${pushRes.error}），已中止下載以避免覆蓋本機資料！`, 'error');
          return;
        }
        pushed = pushRes.uploaded || 0;
      }
      const res = await C.gasGet(State.gasUrl, { action: 'getBootstrapData' });
      if (!res || !res.ok) throw new Error(res?.error || '下載雲端資料失敗');
      await applyCloudBootstrap(res.data || {});
      updateNetworkBadge();
      if (!silent) toast(`🔄 雙向同步完成！${pushed ? `已上傳 ${pushed} 筆，` : ''}已載入雲端最新 ${State.events.length} 場賽事、${State.participants.length} 位選手`, 'success');
    } catch (err) {
      if (!silent) toast(`雙向同步失敗：${err.message}`, 'error');
      else console.warn('[TUR AutoSync skipped]', err.message);
    }
  }

  // 向下相容別名
  async function syncPullFromGas(silent = false) {
    return syncBidirectional(silent);
  }

  // 步驟 4A（進階單向）：⬇️ 僅拉取雲端（新手機抓全量資料，不推送本機佇列）
  async function syncPullOnlyFromCloud() {
    if (!State.gasUrl) return toast('尚未設定 GAS 網址（/exec）', 'warn');
    if (!navigator.onLine) return toast('目前無網路連線，無法拉取雲端資料', 'warn');
    const pending = State.syncQueue.length;
    const msg = pending > 0
      ? `⚠️ 確定執行「⬇️ 僅拉取雲端」？\n\n本機目前尚有 ${pending} 筆未上傳異動，執行此操作將「捨棄這 ${pending} 筆待傳資料」並以雲端全量資料覆寫本機！`
      : '確定執行「⬇️ 僅拉取雲端」？\n\n將直接下載雲端 Google 試算表最新全量資料覆寫本機資料庫（適合新手機初次同步）。';
    if (!confirm(msg)) return;
    try {
      toast('⬇️ 正在從雲端抓取全量資料...', 'info');
      const res = await C.gasGet(State.gasUrl, { action: 'getBootstrapData' });
      if (!res || !res.ok) throw new Error(res?.error || '拉取失敗');
      State.syncQueue = [];
      await C.TurDB.clear('syncQueue');
      await applyCloudBootstrap(res.data || {});
      updateNetworkBadge();
      toast(`⬇️ 僅拉取雲端完成！已覆寫載入 ${State.events.length} 場活動、${State.participants.length} 位選手、${State.timingLogs.length} 筆計時紀錄`, 'success');
    } catch (err) {
      toast(`拉取失敗：${err.message}`, 'error');
    }
  }

  // 步驟 4B（進階單向）：📤 強制推送本機設定至雲端（推送全 8 張資料表覆寫雲端）
  async function syncForcePushAllToCloud() {
    if (State.currentUser?.role !== 'super_admin') return toast('⛔ 僅最高管理員可執行強制推送至雲端', 'error');
    if (!State.gasUrl) return toast('尚未設定 GAS 網址（/exec）', 'warn');
    if (!navigator.onLine) return toast('目前無網路連線，無法推送至雲端', 'warn');
    const word = prompt(
      `⚠️ 高風險單向覆寫操作！即將把「本機全部 8 張資料表」強制覆寫上傳至雲端 Google 試算表：\n` +
      `• GlobalConfig (${State.globalConfig.length})、Users (${State.users.length})\n` +
      `• Events (${State.events.length})、Categories (${State.categories.length})、Stations (${State.stations.length})\n` +
      `• Participants (${State.participants.length})、TimingLogs (${State.timingLogs.length})、HistoryResults (${State.historyResults.length})\n\n` +
      `適用於剛用 JSON 還原備份後要整機覆蓋雲端。確定執行請輸入大寫 PUSH：`
    );
    if (word !== 'PUSH') return toast('輸入不符，已取消強制推送', 'info');

    const pairs = [
      ['GlobalConfig', State.globalConfig],
      ['Users', State.users],
      ['Events', State.events],
      ['Categories', State.categories],
      ['Stations', State.stations],
      ['Participants', State.participants],
      ['TimingLogs', State.timingLogs],
      ['HistoryResults', State.historyResults]
    ];
    let okCnt = 0;
    let totalRows = 0;
    toast('📤 正在強制推送本機全 8 張資料表至雲端試算表...', 'info');
    try {
      for (const [sheetName, rows] of pairs) {
        const res = await C.gasPost(State.gasUrl, {
          action: 'adminBatchUpdateSheet',
          sheetName,
          rows: rows || [],
          mode: 'replace'
        });
        if (!res || !res.ok) throw new Error(`${sheetName} 寫入失敗：${res?.error || '未知錯誤'}`);
        okCnt++;
        totalRows += Number(res.updatedRows || 0);
      }
      State.syncQueue = [];
      await C.TurDB.clear('syncQueue');
      updateNetworkBadge();
      toast(`📤 強制推送完成！已覆寫雲端全部 ${okCnt}/8 張表（共 ${totalRows} 列）`, 'success');
    } catch (err) {
      toast(`強制推送中斷（已完成 ${okCnt}/8 表）：${err.message}`, 'error');
    }
  }

  function buildConfigJsContent() {
    const safeUrl = String(State.gasUrl || '').trim().replace(/'/g, "\\'");
    const mode = State.syncMode === 'offline' ? 'offline' : 'cloud';
    return [
      '/**',
      ' * 跑管家｜TUR 賽事管理系統 雲端連線設定檔 (config.js)',
      ` * 產生時間：${C.formatDateTime()}`,
      ' */',
      'window.TUR_CONFIG = {',
      `  gasUrl: '${safeUrl}',`,
      `  defaultSyncMode: '${mode}',`,
      `  version: '6.0'`,
      '};',
      ''
    ].join('\n');
  }

  /* --------------------------------------------------------------------------
   * Auto-Assign Bibs (Used by Stage 2 & PAYUNi Instant Auto-Checkout)
   * -------------------------------------------------------------------------- */
  async function autoAssignBibsForEvent(eventId, specificPids = null) {
    const cats = State.categories.filter((c) => c.eventId === eventId);
    const evParts = State.participants.filter((p) => p.eventId === eventId);
    const used = new Set(evParts.map((p) => String(p.bibNumber || '').toUpperCase()).filter(Boolean));
    let count = 0;

    for (const cat of cats) {
      const prefix = String(cat.bibPrefix || 'R').toUpperCase();
      const startStr = String(cat.bibStartNum || '001');
      const width = Math.max(3, startStr.length);
      let num = parseInt(startStr, 10) || 1;
      const targets = evParts.filter((p) =>
        p.catId === cat.catId &&
        String(p.payStatus).toUpperCase() === 'PAID' &&
        !p.bibNumber &&
        (!specificPids || specificPids.includes(p.participantId))
      );
      for (const p of targets) {
        let bib = `${prefix}${String(num).padStart(width, '0')}`;
        while (used.has(bib)) { num++; bib = `${prefix}${String(num).padStart(width, '0')}`; }
        used.add(bib);
        p.bibNumber = bib;
        num++; count++;
        await C.TurDB.put('participants', p);
        await enqueueSync('updateParticipant', { participantId: p.participantId, bibNumber: bib });
      }
    }
    rebuildIndices(eventId);
    renderAll();
    if (!specificPids) {
      toast(count ? `🏷️ 自動配號完成！新配發 ${count} 組號碼布` : '目前所有已繳費選手皆已配號', count ? 'success' : 'info');
    }
    return count;
  }

  /* --------------------------------------------------------------------------
   * Hub-and-Spoke Navigation：首頁四大區塊大廳 → 單區專注作業 → 回首頁
   * -------------------------------------------------------------------------- */
  function getPillarForView(viewId) {
    if (viewId === 'portal-home') return 'portal';
    if (['public-home', 'public-register', 'public-multi', 'public-lookup', 'host-ops'].includes(viewId)) return 'register';
    if (viewId === 'scores') return 'scores';
    if (viewId === 'operator-station') return 'timing';
    return 'admin';
  }

  function goPortalHome() {
    if (State.currentUser?.role === 'operator') {
      toast('🔒 目前為現場作業員執勤中，請先按右上角「🚪 登出」結束執勤再返回首頁', 'warn');
      return;
    }
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    }
    switchView('portal-home');
  }

  function renderPortalHome() {
    const box = $('#view-portal-home');
    if (!box) return;
    const u = State.currentUser;
    const isAdminOrOrg = u && (u.role === 'super_admin' || u.role === 'organizer');
    const openCnt = State.events.filter((e) => e.status === 'open' || e.status === 'auto').length;
    const activeCnt = State.events.filter((e) => e.status !== 'finished').length;
    const finCnt = State.events.filter((e) => e.status === 'finished').length;
    const syncTag = State.syncMode === 'offline' ? '📴 單機離線' : (navigator.onLine ? '🌐 雲端連線' : '⚠️ 斷網暫存');
    const adminTag = u.role === 'super_admin'
      ? `🛡️ 已登入：${u.displayName}`
      : (u.role === 'organizer' ? `👤 已登入：${u.displayName}` : '🔒 需承辦人／管理員登入');

    box.innerHTML = `
      <div class="max-w-5xl mx-auto space-y-4 py-1 sm:py-2">
        <div class="bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 text-white rounded-2xl p-4 sm:p-5 shadow-lg border border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3.5">
            <div class="bg-white rounded-xl px-3 py-1.5 shadow shrink-0">
              <img src="assets/tur-logo.jpg" alt="TUR Taiwan Ultra Runners" class="h-9 sm:h-10 w-auto object-contain" />
            </div>
            <div>
              <h1 class="text-lg sm:text-xl font-black tracking-wide">跑管家｜賽事管理系統</h1>
              <p class="text-xs text-slate-300 mt-0.5">請點選下方四大功能區塊進入作業；處理完成後，按左上角「← 回首頁」即可切換其他區塊。</p>
            </div>
          </div>
          ${isAdminOrOrg ? `<span class="px-3 py-1.5 rounded-xl bg-amber-400/20 border border-amber-400/50 text-amber-300 text-xs font-black">${C.escapeHtml(adminTag)}</span>` : ''}
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5 sm:gap-4">
          <!-- 區塊一：報名 -->
          <button type="button" data-enter-pillar="register" class="group text-left bg-white hover:bg-sky-50/60 rounded-2xl border-2 border-slate-200 hover:border-sky-500 p-4 sm:p-5 shadow-sm hover:shadow-lg transition flex flex-col justify-between gap-3">
            <div class="space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="w-10 h-10 rounded-xl bg-sky-600 text-white text-xl flex items-center justify-center shadow group-hover:scale-105 transition">📝</span>
                <span class="px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-900 text-xs font-black mono">開放報名 ${openCnt} 場</span>
              </div>
              <div>
                <div class="text-lg font-black text-slate-900 group-hover:text-sky-800">一、報名</div>
                <p class="text-xs text-slate-600 mt-1 leading-relaxed">選場次個人／團體報名、同主辦人多場聯合報名、主辦建立活動與核帳對帳、報名查詢修改。</p>
              </div>
            </div>
            <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 text-xs font-black text-sky-700">
              <span>選場次 · 聯報 · 主辦作業</span>
              <span class="group-hover:translate-x-1 transition">進入作業 →</span>
            </div>
          </button>

          <!-- 區塊二：成績查詢 -->
          <button type="button" data-enter-pillar="scores" class="group text-left bg-white hover:bg-amber-50/60 rounded-2xl border-2 border-slate-200 hover:border-amber-500 p-4 sm:p-5 shadow-sm hover:shadow-lg transition flex flex-col justify-between gap-3">
            <div class="space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="w-10 h-10 rounded-xl bg-amber-500 text-slate-950 text-xl flex items-center justify-center shadow group-hover:scale-105 transition">🏆</span>
                <span class="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-xs font-black mono">進行中 ${activeCnt} · 已結案 ${finCnt}</span>
              </div>
              <div>
                <div class="text-lg font-black text-slate-900 group-hover:text-amber-800">二、成績查詢</div>
                <p class="text-xs text-slate-600 mt-1 leading-relaxed">即時賽事分組進度／站點通過／成績排名、歷年年度／個人／場次查詢、八百壯士英雄榜與完賽證書。</p>
              </div>
            </div>
            <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 text-xs font-black text-amber-700">
              <span>即時 · 歷年 · 八百壯士 · 證書</span>
              <span class="group-hover:translate-x-1 transition">進入查詢 →</span>
            </div>
          </button>

          <!-- 區塊三：晶片計時 -->
          <button type="button" data-enter-pillar="timing" class="group text-left bg-white hover:bg-emerald-50/60 rounded-2xl border-2 border-slate-200 hover:border-emerald-500 p-4 sm:p-5 shadow-sm hover:shadow-lg transition flex flex-col justify-between gap-3">
            <div class="space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="w-10 h-10 rounded-xl bg-emerald-600 text-white text-xl flex items-center justify-center shadow group-hover:scale-105 transition">📡</span>
                <span class="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 text-xs font-black">${syncTag}</span>
              </div>
              <div>
                <div class="text-lg font-black text-slate-900 group-hover:text-emerald-800">三、晶片計時</div>
                <p class="text-xs text-slate-600 mt-1 leading-relaxed">現場作業員三步驟登錄（選活動 → 選組別 → 帳密進入），執行 NFC 發卡寫入、站點感應與手動補登。</p>
              </div>
            </div>
            <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 text-xs font-black text-emerald-700">
              <span>三步驟登錄 · 離線感應作業</span>
              <span class="group-hover:translate-x-1 transition">進入作業 →</span>
            </div>
          </button>

          <!-- 區塊四：後台管理 -->
          <button type="button" data-enter-pillar="admin" class="group text-left bg-white hover:bg-indigo-50/60 rounded-2xl border-2 border-slate-200 hover:border-indigo-500 p-4 sm:p-5 shadow-sm hover:shadow-lg transition flex flex-col justify-between gap-3">
            <div class="space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="w-10 h-10 rounded-xl bg-indigo-600 text-white text-xl flex items-center justify-center shadow group-hover:scale-105 transition">⚙️</span>
                <span class="px-2.5 py-0.5 rounded-full ${isAdminOrOrg ? 'bg-indigo-100 text-indigo-900' : 'bg-slate-100 text-slate-700'} text-xs font-black">${C.escapeHtml(adminTag)}</span>
              </div>
              <div>
                <div class="text-lg font-black text-slate-900 group-hover:text-indigo-800">四、後台管理</div>
                <p class="text-xs text-slate-600 mt-1 leading-relaxed">賽事作業區（活動／手動名單／起跑站點／作業員）、已結案報表與批次證書、樹狀帳號、歷年匯入與資料庫同步。</p>
              </div>
            </div>
            <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 text-xs font-black text-indigo-700">
              <span>五大管理專區 · 備份與同步</span>
              <span class="group-hover:translate-x-1 transition">進入管理 →</span>
            </div>
          </button>
        </div>
      </div>`;

    $$('[data-enter-pillar]').forEach((btn) => {
      btn.onclick = () => {
        const p = btn.dataset.enterPillar;
        if (p === 'register') switchView('public-home');
        else if (p === 'scores') switchView('scores');
        else if (p === 'timing') switchView('operator-station');
        else if (p === 'admin') {
          if (isAdminOrOrg) {
            State.z1ViewMode = 'lobby';
            switchView('zone1');
          } else {
            openLoginModal('organizer');
          }
        }
      };
    });
  }

  function renderNavAndHeader() {
    const u = State.currentUser;
    const isStaff = u.role !== 'public';
    const isAdminOrOrg = u.role === 'super_admin' || u.role === 'organizer';
    $('#btnOpenLogin').classList.toggle('hidden', isStaff);
    $('#btnLogout').classList.toggle('hidden', !isStaff);

    const roleLabels = {
      public: '🏃 民眾 / 跑者',
      operator: `📡 作業員：${u.displayName} [${State.opLockedStation}]`,
      organizer: `👤 承辦人：${u.displayName}`,
      super_admin: `🛡️ 最高管理員：${u.displayName}`
    };
    $('#roleStatusBadge').textContent = roleLabels[u.role] || roleLabels.public;

    const pillar = getPillarForView(State.activeView);
    State.activePillar = pillar;

    const focusBar = $('#sectionFocusBar');
    const mainNavBar = $('#mainNavBar');
    const pillarTitleEl = $('#activePillarTitle');
    const pillarTitles = {
      register: '📝 一、報名',
      scores: '🏆 二、成績查詢',
      timing: '📡 三、晶片計時',
      admin: '⚙️ 四、後台管理'
    };

    if (pillar === 'portal') {
      if (focusBar) focusBar.classList.add('hidden');
      if (mainNavBar) mainNavBar.classList.add('hidden');
      updateNetworkBadge();
      return;
    }

    if (focusBar) focusBar.classList.remove('hidden');
    if (pillarTitleEl) pillarTitleEl.textContent = pillarTitles[pillar] || '';

    const nav = $('#mainNavInner');
    let pills = [];
    if (pillar === 'register') {
      pills = [
        ['public-home', '🏁 （一）選場次報名'],
        ['public-multi', '🛒 （二）聯合報名'],
        ['host-ops', '🛠️ （三）主辦作業（建立活動／核帳）'],
        ['public-lookup', '🔍 報名查詢與修改']
      ];
    } else if (pillar === 'scores') {
      pills = [
        ['scores:live', '📊 （一）即時賽事'],
        ['scores:history', '📚 （二）歷年成績'],
        ['scores:warriors', '🏅 （三）八百壯士'],
        ['scores:cert', '🏆 （四）完賽證書']
      ];
    } else if (pillar === 'timing') {
      pills = []; // 晶片計時採極簡單頁專注，無需次級頁籤
    } else if (pillar === 'admin') {
      if (u.role === 'super_admin') {
        pills = [
          ['zone1', '🏟️ 一、賽事作業區'],
          ['zone2', '📦 二、已結案區'],
          ['zone3', '👥 三、帳號管理'],
          ['zone4', '📚 四、歷年活動成績匯入'],
          ['zone5', '🗄️ 五、資料庫專區']
        ];
      } else if (u.role === 'organizer') {
        pills = [
          ['zone1', '🏟️ 一、賽事作業區'],
          ['zone2', '📦 二、已結案區'],
          ['zone5', '🗄️ 五、資料庫同步']
        ];
      }
    }

    if (mainNavBar) mainNavBar.classList.toggle('hidden', pills.length === 0);

    const activeKey = State.activeView === 'scores'
      ? `scores:${State.scoreSubTab || 'live'}`
      : (State.activeView === 'public-register' ? 'public-home' : State.activeView);

    nav.innerHTML = pills.map(([key, label]) => `
      <button type="button" data-nav-view="${key}" class="nav-pill ${activeKey === key ? 'active' : 'hover:bg-slate-100'} px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold whitespace-nowrap transition">${label}</button>
    `).join('');

    $$('[data-nav-view]').forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.navView;
        if (key.startsWith('scores:')) {
          State.scoreSubTab = key.split(':')[1] || 'live';
          switchView('scores');
          return;
        }
        if (key === 'zone1') State.z1ViewMode = 'lobby';
        if (key === 'zone1' && !isAdminOrOrg) { openLoginModal('organizer'); return; }
        switchView(key);
      };
    });
    updateNetworkBadge();
  }

  function switchView(viewId) {
    const role = State.currentUser?.role || 'public';

    if (role === 'operator' && ['zone1', 'zone2', 'zone3', 'zone4', 'zone5', 'host-ops', 'portal-home'].includes(viewId)) {
      toast('⛔ 權限不足：現場作業員執勤中無法切換至其他畫面，請先登出', 'error');
      viewId = 'operator-station';
    } else if (role === 'public' && ['zone1', 'zone2', 'zone3', 'zone4', 'zone5'].includes(viewId)) {
      toast('🔒 請先登入最高管理員或活動承辦人帳號', 'warn');
      openLoginModal('organizer');
      return;
    } else if (role === 'organizer' && (viewId === 'zone3' || viewId === 'zone4')) {
      toast('⛔ 權限不足：此專區僅限最高權責管理員存取', 'error');
      viewId = 'zone1';
    }

    State.activeView = viewId;
    $$('.app-view').forEach((v) => v.classList.add('hidden'));
    const target = $(`#view-${viewId}`);
    if (target) target.classList.remove('hidden');
    if (viewId !== 'operator-station') document.body.classList.remove('outdoor-mode');
    renderNavAndHeader();
    renderCurrentView();
  }

  function renderCurrentView() {
    const v = State.activeView;
    if (v === 'portal-home') renderPortalHome();
    else if (v === 'public-home') renderPublicHome();
    else if (v === 'public-register') renderPublicRegister();
    else if (v === 'public-multi') renderPublicMultiRegister();
    else if (v === 'host-ops') renderHostOps();
    else if (v === 'scores') {
      if (global.TurScores?.renderScoresView) global.TurScores.renderScoresView(AppBridge);
    }
    else if (v === 'operator-station') renderOperatorStation();
    else if (v === 'zone1') Z.renderZone1(AppBridge);
    else if (v === 'zone2') Z.renderZone2(AppBridge);
    else if (v === 'zone3') Z.renderZone3(AppBridge);
    else if (v === 'zone4') Z.renderZone4(AppBridge);
    else if (v === 'zone5') Z.renderZone5(AppBridge);
  }

  function renderAll() {
    renderNavAndHeader();
    renderCurrentView();
  }

  /* --------------------------------------------------------------------------
   * View C2：一、報名 →（三）主辦作業（1.建立活動欄位表格 2.核帳明細對帳）
   * -------------------------------------------------------------------------- */
  let hostCreateCats = [
    { name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2400, earlyBirdFee: 2100, bibPrefix: 'A', quota: 150, isWarrior800: true },
    { name: '50K 超馬挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 1500, bibPrefix: 'B', quota: 250, isWarrior800: false }
  ];

  function renderHostOps() {
    const box = $('#view-host-ops');
    if (!box) return;
    const u = State.currentUser;
    const isAdminOrOrg = u && (u.role === 'super_admin' || u.role === 'organizer');

    if (!isAdminOrOrg) {
      box.innerHTML = `
        <div class="max-w-xl mx-auto bg-white rounded-2xl border-2 border-sky-200 p-6 text-center space-y-4 shadow-sm">
          <div class="text-3xl">🛠️</div>
          <h2 class="text-lg font-black text-slate-900">主辦作業（建立活動 ／ 核帳）</h2>
          <p class="text-xs text-slate-600">此區提供活動承辦人與最高管理員建立新活動並即時開放報名，以及核對報名匯款明細。</p>
          <div class="flex flex-wrap justify-center gap-2">
            <button type="button" id="btnHostPromptOrgLogin" class="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-black text-xs shadow">👤 承辦人登入</button>
            <button type="button" id="btnHostPromptSuperLogin" class="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-amber-300 font-black text-xs shadow">🛡️ 最高管理員登入</button>
          </div>
        </div>`;
      $('#btnHostPromptOrgLogin').onclick = () => openLoginModal('organizer');
      $('#btnHostPromptSuperLogin').onclick = () => openLoginModal('super_admin');
      return;
    }

    const isSuper = u.role === 'super_admin';
    const managed = State.events.filter((e) => e.status !== 'finished' && (isSuper || e.ownerUsername === u.username));
    const sub = State.hostSubTab === 'recon' ? 'recon' : 'create';
    const totalPendingUnpaid = managed.reduce((sum, ev) => {
      return sum + State.participants.filter((p) => p.eventId === ev.eventId && ['UNPAID', 'PENDING_PAY'].includes(String(p.payStatus || '').toUpperCase())).length;
    }, 0);

    box.innerHTML = `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div>
            <h2 class="font-black text-base text-slate-900">🛠️ 一、報名 →（三）主辦作業</h2>
            <p class="text-[11px] text-slate-500 mt-0.5">登入身分：<b>${C.escapeHtml(u.displayName || u.username)}</b>（${isSuper ? '最高管理員' : '活動承辦人'}）｜建立活動即可直接開放報名，並於核帳區一鍵對帳配號</p>
          </div>
          <div class="flex gap-1.5">
            <button type="button" data-host-sub="create" class="px-4 py-2 rounded-xl font-black transition ${sub === 'create' ? 'bg-slate-900 text-amber-300 shadow' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">１．建立活動（欄位表）</button>
            <button type="button" data-host-sub="recon" class="px-4 py-2 rounded-xl font-black transition flex items-center gap-1.5 ${sub === 'recon' ? 'bg-emerald-600 text-white shadow' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">
              <span>２．核帳（明細對帳）</span>
              ${totalPendingUnpaid > 0 ? `<span class="px-1.5 py-0.5 rounded-full text-[10px] mono ${sub === 'recon' ? 'bg-white text-rose-700' : 'bg-rose-600 text-white'}">${totalPendingUnpaid}</span>` : ''}
            </button>
          </div>
        </div>
        <div id="hostOpsBody" class="space-y-4"></div>
      </div>`;

    $$('[data-host-sub]').forEach((b) => {
      b.onclick = () => { State.hostSubTab = b.dataset.hostSub; renderHostOps(); };
    });

    if (sub === 'create') renderHostCreateEventTable($('#hostOpsBody'), u);
    else renderHostReconView($('#hostOpsBody'), managed, isSuper);
  }

  function renderHostCreateEventTable(container, u) {
    const payuniOn = Boolean(C.PAYUNi_FEATURE_ENABLED);
    const defaultStart = '2026-12-20T05:00:00';
    const defaultRegEnd = '2026-12-15T23:59:59';
    const defaultEbEnd = '2026-12-05T23:59:59';

    container.innerHTML = `
      <form id="hostCreateEventForm" class="space-y-4 text-xs">
        <!-- 表格 1：活動基本欄位表格 -->
        <div class="rounded-xl border overflow-hidden">
          <div class="bg-slate-900 text-white px-3.5 py-2 font-black flex items-center justify-between">
            <span>📋 表 1｜活動基本資料欄位表</span>
            <span class="text-[11px] text-amber-300 font-bold">承辦人可直接開放報名</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <tbody class="divide-y">
                <tr>
                  <th class="p-2.5 bg-slate-50 w-36 font-bold">活動名稱 *</th>
                  <td class="p-2" colspan="3"><input id="hcNameZh" required placeholder="例：2026 TUR 冬季 100K 超馬挑戰賽" class="w-full px-3 py-2 border rounded-lg font-bold" /></td>
                </tr>
                <tr>
                  <th class="p-2.5 bg-slate-50 font-bold">主辦單位</th>
                  <td class="p-2"><input id="hcOrganizer" value="${C.escapeHtml(u.displayName || 'TUR 台灣超馬協會')}" class="w-full px-2.5 py-1.5 border rounded-lg" /></td>
                  <th class="p-2.5 bg-slate-50 w-32 font-bold">活動地點</th>
                  <td class="p-2"><input id="hcLocation" placeholder="例：新北市淡水河濱公園" class="w-full px-2.5 py-1.5 border rounded-lg" /></td>
                </tr>
                <tr>
                  <th class="p-2.5 bg-slate-50 font-bold">起跑日期時間 *</th>
                  <td class="p-2"><input id="hcRaceStart" type="datetime-local" step="1" required value="${defaultStart}" class="w-full px-2.5 py-1.5 border border-amber-400 bg-amber-50/40 rounded-lg mono font-bold" /></td>
                  <th class="p-2.5 bg-slate-50 font-bold">報名截止時間</th>
                  <td class="p-2"><input id="hcRegEnd" type="datetime-local" step="1" value="${defaultRegEnd}" class="w-full px-2.5 py-1.5 border rounded-lg mono" /></td>
                </tr>
                <tr>
                  <th class="p-2.5 bg-slate-50 font-bold">賽制類型 *</th>
                  <td class="p-2">
                    <select id="hcRaceType" class="w-full px-2.5 py-1.5 border rounded-lg font-bold bg-white">
                      <option value="distance">🏃 一般距離賽（起點 → 檢查站 CP → 終點）</option>
                      <option value="lap_timed">🔁 計時繞圈賽（主會場拱門重複計圈）</option>
                    </select>
                  </td>
                  <th class="p-2.5 bg-slate-50 font-bold">單圈距離(km)</th>
                  <td class="p-2"><input id="hcLapKm" type="number" step="0.05" min="0.1" value="1.0" class="w-full px-2.5 py-1.5 border rounded-lg mono" placeholder="繞圈賽適用" /></td>
                </tr>
                <tr>
                  <th class="p-2.5 bg-slate-50 font-bold">收款方式</th>
                  <td class="p-2">
                    <select id="hcPayMode" class="w-full px-2.5 py-1.5 border rounded-lg font-bold bg-white">
                      <option value="MANUAL_ATM">🏦 銀行轉帳（人工核對後五碼）</option>
                      ${payuniOn ? '<option value="ONLINE_PAYUNi">⚡ 線上金流 PAYUNi（自動銷帳配號）</option>' : ''}
                    </select>
                  </td>
                  <th class="p-2.5 bg-slate-50 font-bold">開放狀態</th>
                  <td class="p-2">
                    <select id="hcStatus" class="w-full px-2.5 py-1.5 border border-emerald-400 bg-emerald-50 rounded-lg font-black text-emerald-900">
                      <option value="open" selected>🟢 立即開放報名（送出即上架）</option>
                      <option value="draft">📝 草稿籌備（暫不公開）</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <th class="p-2.5 bg-slate-50 font-bold">總名額上限</th>
                  <td class="p-2"><input id="hcMaxQuota" type="number" min="10" value="500" class="w-full px-2.5 py-1.5 border rounded-lg mono" /></td>
                  <th class="p-2.5 bg-slate-50 font-bold">早鳥價設定</th>
                  <td class="p-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <label class="inline-flex items-center gap-1 font-bold text-emerald-900 cursor-pointer">
                        <input id="hcEarlyBird" type="checkbox" checked class="accent-emerald-600" /><span>🐤 啟用</span>
                      </label>
                      <input id="hcEarlyBirdEnd" type="datetime-local" step="1" value="${defaultEbEnd}" class="flex-1 min-w-[170px] px-2 py-1 border rounded-lg mono" />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 表格 2：組別與報名費用表 -->
        <div class="rounded-xl border overflow-hidden">
          <div class="bg-sky-900 text-white px-3.5 py-2 font-black flex items-center justify-between">
            <span>🏷️ 表 2｜賽事組別與費用明細表</span>
            <button type="button" id="btnHcAddCat" class="px-2.5 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-[11px]">+ 新增組別列</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead class="bg-slate-100 text-[11px]">
                <tr>
                  <th class="p-2">組別名稱 *</th>
                  <th class="p-2 w-20">距離(km)</th>
                  <th class="p-2 w-20">限時(時)</th>
                  <th class="p-2 w-24">一般費(NT$)</th>
                  <th class="p-2 w-24">早鳥費(NT$)</th>
                  <th class="p-2 w-16">字首</th>
                  <th class="p-2 w-20">名額</th>
                  <th class="p-2 w-24 text-center">🏅 八百壯士</th>
                  <th class="p-2 w-12 text-center">刪</th>
                </tr>
              </thead>
              <tbody id="hcCatRows" class="divide-y"></tbody>
            </table>
          </div>
        </div>

        <!-- 表格 3：加購項目設定表 -->
        <div class="rounded-xl border overflow-hidden">
          <div class="bg-indigo-900 text-white px-3.5 py-2 font-black flex items-center justify-between">
            <span>🛍️ 表 3｜加購項目設定表（選填）</span>
            <label class="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-200 cursor-pointer">
              <input id="hcAddonNote" type="checkbox" class="accent-amber-400" />
              <span>📝 附「加購項目補充說明／備註」欄</span>
            </label>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead class="bg-slate-100 text-[11px]">
                <tr>
                  <th class="p-2 w-16 text-center">啟用</th>
                  <th class="p-2">加購項目名稱</th>
                  <th class="p-2 w-36">加購金額 (NT$)</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr>
                  <td class="p-2 text-center"><input id="hcAddonChip" type="checkbox" class="accent-indigo-600" /></td>
                  <td class="p-2 font-bold">晶片採購</td>
                  <td class="p-2"><input id="hcAddonChipPrice" type="number" min="0" value="300" class="w-full px-2 py-1 border rounded mono" /></td>
                </tr>
                <tr>
                  <td class="p-2 text-center"><input id="hcAddonLodging" type="checkbox" class="accent-indigo-600" /></td>
                  <td class="p-2 font-bold">住宿預訂價</td>
                  <td class="p-2"><input id="hcAddonLodgingPrice" type="number" min="0" value="1500" class="w-full px-2 py-1 border rounded mono" /></td>
                </tr>
                <tr>
                  <td class="p-2 text-center"><input id="hcAddonGear" type="checkbox" class="accent-indigo-600" /></td>
                  <td class="p-2 font-bold">運動用品加購價</td>
                  <td class="p-2"><input id="hcAddonGearPrice" type="number" min="0" value="680" class="w-full px-2 py-1 border rounded mono" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2 pt-2 border-t">
          <button type="submit" class="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm shadow">✅ 建立活動並儲存</button>
        </div>
      </form>`;

    const drawCatRows = () => {
      const tb = $('#hcCatRows');
      if (!tb) return;
      tb.innerHTML = hostCreateCats.map((c, idx) => `
        <tr>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="name" value="${C.escapeHtml(c.name)}" required class="w-full px-2 py-1 border rounded font-bold" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="distanceKm" type="number" step="0.1" value="${c.distanceKm}" class="w-full px-2 py-1 border rounded mono" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="timeLimitHours" type="number" step="0.5" value="${c.timeLimitHours}" class="w-full px-2 py-1 border rounded mono" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="fee" type="number" min="0" value="${c.fee}" class="w-full px-2 py-1 border rounded mono" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="earlyBirdFee" type="number" min="0" value="${c.earlyBirdFee}" class="w-full px-2 py-1 border rounded mono" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="bibPrefix" value="${C.escapeHtml(c.bibPrefix)}" maxlength="3" class="w-full px-2 py-1 border rounded mono uppercase" /></td>
          <td class="p-1.5"><input data-hc-cat="${idx}" data-hc-f="quota" type="number" min="1" value="${c.quota}" class="w-full px-2 py-1 border rounded mono" /></td>
          <td class="p-1.5 text-center"><input data-hc-cat="${idx}" data-hc-f="isWarrior800" type="checkbox" ${c.isWarrior800 ? 'checked' : ''} class="accent-rose-600" /></td>
          <td class="p-1.5 text-center">${hostCreateCats.length > 1 ? `<button type="button" data-hc-del-cat="${idx}" class="px-2 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">✕</button>` : '-'}</td>
        </tr>`).join('');
      $$('[data-hc-cat]').forEach((inp) => {
        inp.onchange = () => {
          const i = Number(inp.dataset.hcCat);
          const f = inp.dataset.hcF;
          if (!hostCreateCats[i]) return;
          if (f === 'isWarrior800') hostCreateCats[i][f] = inp.checked;
          else if (['distanceKm', 'timeLimitHours', 'fee', 'earlyBirdFee', 'quota'].includes(f)) hostCreateCats[i][f] = Number(inp.value || 0);
          else hostCreateCats[i][f] = inp.value.trim();
        };
      });
      $$('[data-hc-del-cat]').forEach((btn) => {
        btn.onclick = () => { hostCreateCats.splice(Number(btn.dataset.hcDelCat), 1); drawCatRows(); };
      });
    };
    drawCatRows();

    $('#btnHcAddCat').onclick = () => {
      const nextLetter = String.fromCharCode(65 + (hostCreateCats.length % 26));
      hostCreateCats.push({ name: '21K 體驗組', distanceKm: 21.1, timeLimitHours: 4, fee: 1200, earlyBirdFee: 1000, bibPrefix: nextLetter, quota: 200, isWarrior800: false });
      drawCatRows();
    };

    $('#hostCreateEventForm').onsubmit = async (e) => {
      e.preventDefault();
      const nameZh = $('#hcNameZh').value.trim();
      if (!nameZh) return toast('請輸入活動名稱', 'warn');
      const rawStart = ($('#hcRaceStart').value || '').trim();
      if (!rawStart) return toast('請設定起跑日期時間', 'warn');
      const raceStartNorm = rawStart.replace('T', ' ') + (rawStart.length === 16 ? ':00' : '');
      const rawRegEnd = ($('#hcRegEnd').value || '').trim();
      const regEndNorm = rawRegEnd ? rawRegEnd.replace('T', ' ') + (rawRegEnd.length === 16 ? ':00' : '') : '2026-12-31 23:59:59';
      const raceType = $('#hcRaceType').value === 'lap_timed' ? 'lap_timed' : 'distance';
      const isLap = raceType === 'lap_timed';
      const payMode = (C.PAYUNi_FEATURE_ENABLED && $('#hcPayMode').value === 'ONLINE_PAYUNi') ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
      const status = $('#hcStatus').value === 'draft' ? 'draft' : 'open';
      const ebOn = Boolean($('#hcEarlyBird').checked);
      const ebEndNorm = ebOn ? C.normalizeEarlyBirdEnd($('#hcEarlyBirdEnd').value || '') : '';
      if (ebOn && !ebEndNorm) return toast('啟用早鳥價時，請設定早鳥截止時間', 'warn');

      const newSchema = C.defaultFormSchema(payMode);
      newSchema.earlyBirdEnabled = ebOn;
      newSchema.earlyBirdEnd = ebEndNorm;
      newSchema.addons = [
        { code: 'chip_buy', name: '晶片採購', price: Math.max(0, Number($('#hcAddonChipPrice').value || 0)), enabled: Boolean($('#hcAddonChip').checked) },
        { code: 'lodging', name: '住宿預訂價', price: Math.max(0, Number($('#hcAddonLodgingPrice').value || 0)), enabled: Boolean($('#hcAddonLodging').checked) },
        { code: 'sport_gear', name: '運動用品加購價', price: Math.max(0, Number($('#hcAddonGearPrice').value || 0)), enabled: Boolean($('#hcAddonGear').checked) }
      ];
      newSchema.customFields = $('#hcAddonNote').checked ? [{ ...C.DEFAULT_ADDONS_NOTE_FIELD }] : [];

      const evId = `TUR-${Date.now().toString().slice(-6)}`;
      const lapDist = isLap ? Math.max(0.1, Number($('#hcLapKm').value || 1.0)) : 0;
      const ev = {
        eventId: evId,
        ownerUsername: u.username,
        nameZh,
        nameEn: C.zhToEnEventName(nameZh),
        organizerZh: $('#hcOrganizer').value.trim() || u.displayName || 'TUR 台灣超馬協會',
        organizerEn: 'TUR',
        location: $('#hcLocation').value.trim(),
        raceType,
        lapDistanceKm: lapDist,
        debounceSeconds: 15,
        status,
        regStart: C.formatDateTime(),
        regEnd: regEndNorm,
        raceStart: raceStartNorm,
        maxQuota: Math.max(10, Number($('#hcMaxQuota').value || 500)),
        bannerUrl: isLap ? 'dyn-track' : 'dyn-road',
        brochureText: '',
        formSchemaJson: JSON.stringify(newSchema),
        certConfigJson: JSON.stringify(C.defaultCertConfig())
      };

      const cats = hostCreateCats.map((c, idx) => {
        const baseFee = Math.max(0, Number(c.fee || 0));
        const rawEb = ebOn ? Math.max(0, Number(c.earlyBirdFee || 0)) : 0;
        const validEb = (rawEb > 0 && rawEb < baseFee) ? rawEb : 0;
        return {
          catId: `CAT-${evId}-${idx + 1}`,
          eventId: evId,
          name: c.name || `組別 ${idx + 1}`,
          distanceKm: isLap ? lapDist : Math.max(0.1, Number(c.distanceKm || 50)),
          timeLimitHours: Math.max(0.5, Number(c.timeLimitHours || 8)),
          fee: baseFee,
          earlyBirdFee: validEb,
          bibPrefix: String(c.bibPrefix || String.fromCharCode(65 + idx)).toUpperCase(),
          bibStartNum: '001',
          quota: Math.max(1, Number(c.quota || 200)),
          customRaceStart: '',
          isWarrior800: Boolean(c.isWarrior800)
        };
      });

      const maxDist = Math.max(...cats.map((c) => Number(c.distanceKm || 50)));
      const sts = isLap
        ? [
          { stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
          { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'LAP', name: '主會場繞圈拱門', distanceKm: lapDist, stationType: 'lap', orderIndex: 1 }
        ]
        : [
          { stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
          { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'CP1', name: 'CP1 折返檢查站', distanceKm: Number((maxDist / 2).toFixed(1)), stationType: 'checkpoint', orderIndex: 1 },
          { stationId: `ST-${evId}-2`, eventId: evId, stationCode: 'FINISH', name: '終點衝線拱門', distanceKm: maxDist, stationType: 'finish', orderIndex: 2 }
        ];

      State.events.push(ev);
      State.categories.push(...cats);
      State.stations.push(...sts);
      await C.TurDB.put('events', ev);
      await C.TurDB.bulkPut('categories', cats);
      await C.TurDB.bulkPut('stations', sts);
      await enqueueSync('saveEvent', { event: ev });
      for (const cat of cats) await enqueueSync('saveCategory', { category: cat });
      for (const st of sts) await enqueueSync('saveStation', { station: st });

      State.hostReconEventId = evId;
      State.z1EventId = evId;
      toast(`✅ 已建立活動「${nameZh}」（${cats.length} 組）${status === 'open' ? '並立即開放報名！' : '（草稿）'}`, 'success');
      if (status === 'open') {
        switchView('public-home');
      } else {
        State.hostSubTab = 'recon';
        renderHostOps();
      }
    };
  }

  function renderHostReconView(container, managed, isSuper) {
    if (!managed.length) {
      container.innerHTML = '<div class="p-8 text-center text-slate-400 border border-dashed rounded-xl">目前尚無進行中活動，請先切換至「１．建立活動」新增賽事。</div>';
      return;
    }
    if (!managed.some((e) => e.eventId === State.hostReconEventId)) {
      State.hostReconEventId = managed[0].eventId;
    }
    const activeEv = managed.find((e) => e.eventId === State.hostReconEventId);

    container.innerHTML = `
      <div class="space-y-3">
        <div class="font-black text-slate-800">步驟 1｜點選要核帳對帳的活動（${managed.length} 場）</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          ${managed.map((ev) => {
            const parts = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() !== 'CANCELLED');
            const unpaid = parts.filter((p) => ['UNPAID', 'PENDING_PAY'].includes(String(p.payStatus || '').toUpperCase())).length;
            const paid = parts.filter((p) => String(p.payStatus || '').toUpperCase() === 'PAID').length;
            const isSel = ev.eventId === State.hostReconEventId;
            return `
              <button type="button" data-host-pick-ev="${ev.eventId}" class="text-left p-3 rounded-xl border-2 transition ${isSel ? 'border-emerald-600 bg-emerald-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-400'}">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-black text-slate-900 truncate">${C.escapeHtml(ev.nameZh)}</span>
                  ${unpaid > 0 ? `<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-black shrink-0">待核 ${unpaid}</span>` : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold shrink-0">已核清</span>'}
                </div>
                <div class="text-[11px] text-slate-500 mono mt-1">報名 ${parts.length} ｜ 已繳 ${paid}${isSuper ? ` ｜ 承辦 ${C.escapeHtml(ev.ownerUsername || '-')}` : ''}</div>
              </button>`;
          }).join('')}
        </div>
        <div id="hostReconDetail" class="pt-2 border-t space-y-4"></div>
      </div>`;

    $$('[data-host-pick-ev]').forEach((b) => {
      b.onclick = () => {
        State.hostReconEventId = b.dataset.hostPickEv;
        renderHostReconView(container, managed, isSuper);
      };
    });

    if (activeEv && Z.renderZ1Recon) {
      Z.renderZ1Recon(AppBridge, activeEv, '#hostReconDetail');
    }
  }

  /* --------------------------------------------------------------------------
   * View A & B: Public Frontstage (YYYY年 MM月 Grouping + Dual-Track Checkout)
   * -------------------------------------------------------------------------- */
  function renderPublicHome() {
    const openEvents = State.events
      .filter((e) => e.status === 'open' || e.status === 'auto')
      .sort((a, b) => String(a.regStart || '').localeCompare(String(b.regStart || '')));
    const container = $('#publicEventGroups');
    if (!openEvents.length) {
      container.innerHTML = '<div class="bg-white p-10 rounded-2xl border text-center text-slate-400">目前暫無開放報名的賽事。</div>';
      return;
    }

    const grouped = new Map();
    openEvents.forEach((ev) => {
      const dtStr = String(ev.regStart || '2026-11-01').slice(0, 7);
      const [y, m] = dtStr.split('-');
      const label = `${y || '2026'}年 ${m || '11'}月`;
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(ev);
    });

    container.innerHTML = [...grouped.entries()].map(([monthLabel, evs]) => `
      <div class="space-y-3">
        <h2 class="font-black text-base text-slate-800 flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>${monthLabel}
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          ${evs.map((ev) => {
            const regCnt = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
            const quotaTxt = Number(ev.maxQuota) > 0 ? `${regCnt} / ${ev.maxQuota} 人` : `${regCnt} 人（不限額）`;
            const cats = State.categories.filter((c) => c.eventId === ev.eventId);
            const evPayMode = C.getEventPaymentMode(ev);
            const payBadge = evPayMode === 'ONLINE_PAYUNi'
              ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">💳 線上金流</span>'
              : '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold text-[10px]">🏦 銀行轉帳</span>';
            return `
              <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:shadow-md transition">
                <div class="h-32 p-4 flex flex-col justify-between text-white" style="${C.getBannerStyle(ev.bannerUrl)}">
                  <div class="flex justify-between items-start text-[11px]">
                    <div class="flex flex-wrap gap-1">
                      <span class="px-2 py-0.5 rounded-full bg-black/45 font-bold">${ev.raceType === 'lap_timed' ? '🔁 繞圈賽' : '🏃 距離賽'}</span>
                      ${C.isTestSuiteId(ev.eventId) ? '<span class="px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 font-black">🧪 測試</span>' : ''}
                    </div>
                    <span class="px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-black">報名中</span>
                  </div>
                  <div>
                    <div class="font-black text-base leading-snug drop-shadow">${C.escapeHtml(ev.nameZh)}</div>
                    <div class="text-[11px] opacity-90">${C.escapeHtml(ev.location || '')}</div>
                  </div>
                </div>
                <div class="p-4 flex-1 flex flex-col justify-between space-y-3 text-xs">
                  <div class="space-y-1.5">
                    <div class="flex justify-between items-center text-slate-600"><span>繳費方式</span>${payBadge}</div>
                    <div class="flex justify-between text-slate-600"><span>🏁 起跑</span><b class="mono text-indigo-800">${ev.raceStart ? ev.raceStart.slice(0, 16) : '待公告'}</b></div>
                    <div class="flex justify-between text-slate-600"><span>名額</span><b class="mono text-slate-900">${quotaTxt}</b></div>
                    <div class="flex flex-wrap gap-1 pt-1">
                      ${C.isEarlyBirdActive(ev) ? `<span class="w-full px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-900 font-black text-[11px]">🐤 早鳥優惠至 ${C.getEventEarlyBirdConfig(ev).endTime.slice(0, 16)}</span>` : ''}
                      ${cats.map((c) => {
                        const pr = C.getEffectiveCategoryPrice(ev, c);
                        return pr.isEarlyBird
                          ? `<span class="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-900 font-bold">${C.escapeHtml(c.name)} <b>$${pr.fee}</b> <span class="line-through text-slate-400 font-normal">$${pr.regularFee}</span></span>`
                          : `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">${C.escapeHtml(c.name)} $${pr.fee}</span>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <button data-open-reg="${ev.eventId}" data-reg-mode="solo" class="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black">🏃 個人報名</button>
                    <button data-open-reg="${ev.eventId}" data-reg-mode="group" class="py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black">👥 團體報名</button>
                  </div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`).join('');

    $$('[data-open-reg]').forEach((b) => {
      b.onclick = () => {
        State.regEventId = b.dataset.openReg;
        State.regMode = b.dataset.regMode === 'group' ? 'group' : 'solo';
        State.groupCart = [];
        rebuildIndices(State.regEventId);
        switchView('public-register');
      };
    });
  }

  function setRegMode(mode) {
    State.regMode = mode === 'group' ? 'group' : 'solo';
    const isGroup = State.regMode === 'group';

    $('#btnModeSolo').className = isGroup
      ? 'p-3.5 rounded-2xl border-2 border-slate-200 bg-white hover:border-slate-400 text-slate-800 text-left shadow-sm transition'
      : 'p-3.5 rounded-2xl border-2 border-slate-900 bg-slate-900 text-white text-left shadow transition';
    $('#btnModeSolo').innerHTML = `
      <div class="font-black text-sm sm:text-base flex items-center gap-1.5"><span>🏃 個人報名</span>${!isGroup ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-400 text-slate-950">目前</span>' : ''}</div>`;

    $('#btnModeGroup').className = isGroup
      ? 'p-3.5 rounded-2xl border-2 border-amber-500 bg-amber-500 text-slate-950 text-left shadow transition'
      : 'p-3.5 rounded-2xl border-2 border-slate-200 bg-white hover:border-amber-400 text-slate-800 text-left shadow-sm transition';
    $('#btnModeGroup').innerHTML = `
      <div class="font-black text-sm sm:text-base flex items-center gap-1.5"><span>👥 團體報名</span>${isGroup ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-900 text-amber-300">目前</span>' : ''}</div>
      <div class="text-[11px] ${isGroup ? 'text-slate-900/80' : 'text-slate-500'} mt-0.5">2～50 人・團長統一匯款與管理</div>`;

    $('#groupSettingsPanel').classList.toggle('hidden', !isGroup);
    $('#btnAddToGroup').classList.toggle('hidden', !isGroup);
    $('#btnSubmitSingle').classList.toggle('hidden', isGroup);
    $('#regRightCol').classList.toggle('hidden', !isGroup);
    $('#groupCartCard').classList.toggle('hidden', !isGroup);
    $('#regFormCard').classList.toggle('lg:col-span-3', !isGroup);
    $('#regFormCard').classList.toggle('lg:col-span-2', isGroup);

    if (!isGroup) {
      $('#regGroupName').value = '';
      $('#err-regGroupName').textContent = '';
      if ($('#regEmail')) {
        $('#regEmail').readOnly = false;
        $('#regEmail').classList.remove('bg-amber-50', 'text-slate-600');
      }
      if ($('#regEmailHint')) $('#regEmailHint').textContent = '';
    }
    updatePayMethodUI();
    renderGroupCart();
    validateRegForm();
  }

  function syncGroupRoleUI() {
    const isGroup = State.regMode === 'group';
    const banner = $('#groupRoleBanner');
    const emailEl = $('#regEmail');
    const emailHint = $('#regEmailHint');
    const addBtn = $('#btnAddToGroup');
    if (!isGroup) {
      if (emailEl) {
        emailEl.readOnly = false;
        emailEl.classList.remove('bg-amber-50', 'text-slate-600');
      }
      if (emailHint) emailHint.textContent = '';
      return;
    }
    const leader = State.groupCart[0] || null;
    if (!leader) {
      if (banner) {
        banner.className = 'p-2 rounded-lg bg-amber-200/80 border border-amber-400 text-xs font-black text-amber-950';
        banner.textContent = '👑 第 1 位（團長）— 統一收信、匯款與管理';
      }
      if (emailEl) {
        emailEl.readOnly = false;
        emailEl.classList.remove('bg-amber-50', 'text-slate-600');
      }
      if (emailHint) emailHint.textContent = '（團長信箱）';
      if (addBtn) addBtn.textContent = '👑 加入團長';
    } else {
      const nextIdx = State.groupCart.length + 1;
      if (banner) {
        banner.className = 'p-2 rounded-lg bg-sky-100 border border-sky-300 text-xs font-black text-sky-950';
        banner.textContent = `👥 第 ${nextIdx} 位（組員）— 沿用團長信箱 (${leader.email})`;
      }
      if (emailEl) {
        emailEl.value = leader.email || '';
        emailEl.readOnly = true;
        emailEl.classList.add('bg-amber-50', 'text-slate-600');
      }
      if (emailHint) emailHint.textContent = '（沿用團長）';
      if (addBtn) addBtn.textContent = `➕ 加入組員 (#${nextIdx})`;
    }
  }

  function renderPublicRegister() {
    const ev = State.events.find((e) => e.eventId === State.regEventId) || State.events[0];
    if (!ev) return;
    $('#regBannerHero').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
    $('#regEventTitle').textContent = ev.nameZh;
    $('#regEventMeta').textContent = [ev.nameEn || '', `🏁 起跑：${ev.raceStart || '待公告'}`, `主辦：${ev.organizerZh || 'TUR'}`].filter(Boolean).join(' · ');
    const brochureTxt = C.sanitizeBrochureText(ev.brochureText);
    if ($('#regBrochureBox')) $('#regBrochureBox').classList.toggle('hidden', !brochureTxt);
    $('#regBrochureContent').textContent = brochureTxt;

    // 明確顯示本活動屬於「一般距離賽」或「計時繞圈賽」與賽制計分說明
    const wf = C.getRaceTypeWorkflow(ev, State.stations, State.categories);
    const isLap = ev.raceType === 'lap_timed';
    const rtBox = $('#regRaceTypeBanner');
    if (rtBox) {
      rtBox.className = `rounded-2xl border-2 p-3 text-xs shadow-sm ${isLap ? 'bg-indigo-50 border-indigo-300 text-indigo-950' : 'bg-sky-50 border-sky-300 text-sky-950'}`;
      rtBox.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="px-2.5 py-0.5 rounded-full font-black ${isLap ? 'bg-indigo-700 text-white' : 'bg-sky-700 text-white'}">${wf.badge}</span>
          <span class="font-bold opacity-90">${C.escapeHtml(wf.shortRule)}</span>
        </div>`;
    }

    const cats = State.categories.filter((c) => c.eventId === ev.eventId);
    const prevCat = $('#regCatId').value;
    const ebActive = C.isEarlyBirdActive(ev);
    const ebCfg = C.getEventEarlyBirdConfig(ev);
    if (rtBox && ebActive) {
      rtBox.innerHTML += `<div class="mt-2 pt-2 border-t border-current/15 flex flex-wrap items-center justify-between gap-2 text-emerald-800 font-black"><span>🐤 早鳥優惠中</span><span class="mono">截止：${C.escapeHtml(ebCfg.endTime)}</span></div>`;
    }
    $('#regCatId').innerHTML = cats.map((c) => {
      const used = State.participants.filter((p) => p.eventId === ev.eventId && p.catId === c.catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
      const pr = C.getEffectiveCategoryPrice(ev, c);
      const priceTxt = pr.isEarlyBird ? `🐤 早鳥 NT$${pr.fee}（原價 NT$${pr.regularFee}）` : `NT$${pr.fee}`;
      return `<option value="${c.catId}">${C.escapeHtml(c.name)} — ${priceTxt} (剩 ${Math.max(0, Number(c.quota) - used)}/${c.quota})</option>`;
    }).join('');
    if (cats.some((c) => c.catId === prevCat)) $('#regCatId').value = prevCat;

    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const customFields = Array.isArray(schema.customFields) ? schema.customFields : [];
    const cfSec = $('#regCustomFieldsSection');
    const cfBox = $('#regCustomFieldsContainer');
    const grid = $('#regBasicFieldsGrid');
    if (cfSec) cfSec.classList.add('hidden');
    if (cfBox) cfBox.innerHTML = '';

    if (grid) {
      // 清除前次渲染之行內自訂欄位節點，保留原始預設欄位節點及其事件監聽
      grid.querySelectorAll('.reg-inline-cf-item').forEach((el) => el.remove());

      // 建立自訂欄位節點（與預設欄位共用同一網格，支援承辦人自由穿插與上下排序）
      const cfNodes = new Map();
      customFields.forEach((f) => {
        const reqMark = f.required ? ' <span class="text-rose-600 font-black">*</span>' : ' <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-bold">選填</span>';
        const ph = C.escapeHtml(f.placeholder || '');
        const kAttr = C.escapeHtml(f.key);
        let ctrl = '';
        if (f.type === 'textarea') {
          ctrl = `<textarea data-cf-key="${kAttr}" data-cf-type="textarea" rows="2" placeholder="${ph}" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-sm bg-white"></textarea>`;
        } else if (f.type === 'select') {
          ctrl = `<select data-cf-key="${kAttr}" data-cf-type="select" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-sm bg-white">
            <option value="">${ph || '請選擇'}</option>
            ${(f.options || []).map((opt) => `<option value="${C.escapeHtml(opt)}">${C.escapeHtml(opt)}</option>`).join('')}
          </select>`;
        } else if (f.type === 'radio') {
          ctrl = `<div class="flex flex-wrap gap-2 pt-1 text-xs">
            ${(f.options || []).map((opt) => `
              <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border cursor-pointer hover:border-indigo-400">
                <input type="radio" name="cf_radio_${kAttr}" value="${C.escapeHtml(opt)}" data-cf-key="${kAttr}" data-cf-type="radio" class="reg-cf-input" />
                <span>${C.escapeHtml(opt)}</span>
              </label>`).join('')}
          </div>`;
        } else if (f.type === 'checkbox') {
          ctrl = `<div class="flex flex-wrap gap-2 pt-1 text-xs">
            ${(f.options || []).map((opt) => `
              <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border cursor-pointer hover:border-indigo-400">
                <input type="checkbox" value="${C.escapeHtml(opt)}" data-cf-key="${kAttr}" data-cf-type="checkbox" class="reg-cf-input" />
                <span>${C.escapeHtml(opt)}</span>
              </label>`).join('')}
          </div>`;
        } else {
          const htmlType = ['number', 'date', 'url'].includes(f.type) ? f.type : 'text';
          ctrl = `<input type="${htmlType}" data-cf-key="${kAttr}" data-cf-type="${f.type}" placeholder="${ph}" autocomplete="off" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-sm bg-white" />`;
        }
        const wrap = document.createElement('div');
        const spanClass = (f.type === 'textarea' || f.type === 'radio' || f.type === 'checkbox') ? 'sm:col-span-2' : '';
        wrap.className = `reg-inline-cf-item ${spanClass}`.trim();
        wrap.dataset.regField = `cf:${f.key}`;
        wrap.innerHTML = `
          <label class="block text-xs font-semibold text-indigo-950 mb-1"><span class="reg-field-num"></span>${C.escapeHtml(f.label)}${reqMark}</label>
          ${ctrl}
          <p id="err-cf-${kAttr}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p>`;
        cfNodes.set(`cf:${f.key}`, wrap);
      });

      // 嚴格依承辦人設定之 fieldOrder 排序預設欄位與自訂欄位，並自動重新編號（2. 3. 4. ...）
      const ordered = C.getEffectiveRegFieldOrder(schema);
      ordered.forEach((item, idx) => {
        const node = item.isCustom
          ? cfNodes.get(item.id)
          : grid.querySelector(`:scope > [data-reg-field="${item.id}"]`);
        if (node) {
          const numEl = node.querySelector('.reg-field-num');
          if (numEl) numEl.textContent = `${idx + 2}. `;
          grid.appendChild(node);
        }
      });

      grid.querySelectorAll('.reg-cf-input').forEach((el) => {
        el.addEventListener('input', validateRegForm);
        el.addEventListener('change', validateRegForm);
      });
    }

    const enabledAddons = (schema.addons || []).filter((a) => a && a.enabled !== false);
    $('#regAddonsContainer').innerHTML = enabledAddons.map((a) => `
      <label class="flex items-center gap-2 p-2 bg-white border rounded-lg cursor-pointer hover:border-amber-400">
        <input type="checkbox" class="reg-addon" data-name="${C.escapeHtml(a.name)}" data-price="${a.price}" />
        <span>${C.escapeHtml(a.name)} <b>+$${a.price}</b></span>
      </label>`).join('') || '<span class="text-slate-400">本場無加購項目</span>';

    $('#bankAccountPreview').innerHTML = `銀行：(${getConfigVal('bankCode', '004')}) ${C.escapeHtml(getConfigVal('bankName', '台灣銀行'))}<br>帳號：<b>${C.escapeHtml(getConfigVal('bankAccount', '004-001-234567-8'))}</b><br>戶名：${C.escapeHtml(getConfigVal('bankAccountName', '台灣超馬協會'))}`;

    setRegMode(State.regMode);
  }

  function getSelectedPayMethod() {
    const ev = State.events.find((e) => e.eventId === State.regEventId);
    if (ev) return C.getEventPaymentMode(ev);
    return document.querySelector('input[name="payMethod"]:checked')?.value || 'MANUAL_ATM';
  }

  function updatePayMethodUI() {
    const method = getSelectedPayMethod();
    const isManual = method === 'MANUAL_ATM';
    const rManual = document.querySelector('input[name="payMethod"][value="MANUAL_ATM"]');
    const rPayuni = document.querySelector('input[name="payMethod"][value="ONLINE_PAYUNi"]');
    if (rManual) rManual.checked = isManual;
    if (rPayuni) rPayuni.checked = !isManual;

    const isGroup = State.regMode === 'group';
    $('#payCardManual').classList.toggle('hidden', !isManual);
    $('#payCardPayuni').classList.toggle('hidden', isManual);
    if ($('#regLast5Wrap')) $('#regLast5Wrap').classList.toggle('hidden', isGroup);
    if ($('#regLast5GroupNote')) $('#regLast5GroupNote').classList.toggle('hidden', !isGroup);
    if ($('#groupUnifiedLast5Wrap')) $('#groupUnifiedLast5Wrap').classList.toggle('hidden', !isManual);
    if ($('#regPayModeHeader')) {
      $('#regPayModeHeader').textContent = isManual ? '繳費方式：🏦 銀行轉帳' : '繳費方式：💳 線上金流';
    }
    $('#btnSubmitSingle').textContent = isManual ? '✅ 送出報名' : '💳 送出並線上付款';
  }

  function validateRegForm() {
    const evId = State.regEventId;
    const catId = $('#regCatId').value;
    const cat = State.categories.find((c) => c.catId === catId);
    const nat = $('#regNationality').value === 'OTHER' ? $('#regNationalityCustom').value.trim().toUpperCase() : $('#regNationality').value;
    const name = $('#regName').value.trim();
    const idCard = $('#regIdCard').value.trim().toUpperCase();
    const gender = $('#regGender').value;
    const birthday = $('#regBirthday').value;
    const age = C.calcAge(birthday);
    const phone = $('#regPhone').value.trim();
    const isGroupMode = State.regMode === 'group';
    const leaderInCart = isGroupMode ? (State.groupCart[0] || null) : null;
    const email = leaderInCart ? String(leaderInCart.email || '').trim() : $('#regEmail').value.trim();
    const diet = $('#regDiet').value;
    const emergName = $('#regEmergName').value.trim();
    const emergPhone = $('#regEmergPhone').value.trim();
    const last5 = isGroupMode ? String($('#groupUnifiedLast5')?.value || '').trim() : $('#regLast5').value.trim();
    const payMethod = getSelectedPayMethod();
    const consent = $('#regConsent').checked;

    const checks = {};
    const used = State.participants.filter((p) => p.eventId === evId && p.catId === catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length + State.groupCart.filter((g) => g.catId === catId).length;
    checks.cat = !cat ? '請選擇組別' : (used >= Number(cat.quota || 9999) ? '名額已滿' : '');
    checks.nat = /^[A-Z]{3}$/.test(nat) ? '' : '須為三碼國際國籍';
    checks.name = (name.length >= 2 && name.length <= 40 && !/[<>|]/.test(name)) ? '' : '姓名 2~40 字';

    let idErr = '';
    if (!idCard) idErr = '請輸入身分證/護照';
    else if (nat === 'TWN' && !C.verifyTaiwanIdChecksum(idCard)) idErr = '台灣身分證檢核碼錯誤';
    else if (nat !== 'TWN' && !/^[A-Z0-9]{6,15}$/.test(idCard)) idErr = '護照限 6~15 碼英數字';
    if (!idErr && State.participants.some((p) => p.eventId === evId && String(p.idCard).toUpperCase() === idCard && String(p.payStatus).toUpperCase() !== 'CANCELLED')) idErr = '本場已重複報名';
    if (!idErr && State.groupCart.some((g) => g.idCard === idCard)) idErr = '已在團報清單內';
    checks.idCard = idErr;

    let gErr = !gender ? '請選性別' : '';
    if (!gErr && nat === 'TWN' && /^[A-Z][1289]/.test(idCard)) {
      const exp = C.inferGenderFromId(idCard);
      if (gender !== exp) gErr = `與身分證第2碼不符，應為 ${exp}`;
    }
    checks.gender = gErr;

    $('#regAgeDisplay').textContent = age !== null ? `${age} 歲` : '-- 歲';
    checks.birthday = age === null ? '請選出生日期' : (age < 10 || age > 80 ? `年齡 ${age} 歲，須 10~80 歲` : '');
    checks.phone = /^09\d{8}$/.test(phone) ? '' : '須為 09 開頭 10 碼';
    checks.email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Email 格式錯誤';
    checks.diet = diet ? '' : '請選擇飲食習慣（必填）';
    checks.emergName = !emergName ? '請填緊急聯絡人' : (emergName === name ? '不可與本人同名' : '');
    checks.emergPhone = !/^0\d{8,9}$/.test(emergPhone) ? '電話格式錯誤' : (emergPhone === phone ? '不可同本人手機' : '');
    checks.last5 = (payMethod === 'ONLINE_PAYUNi' || isGroupMode || !last5 || /^\d{5}$/.test(last5)) ? '' : '末五碼限 5 位純數字';
    checks.consent = !consent ? '須勾選同意切結書' : (State.groupCart.length >= 50 ? '團報上限 50 人' : '');

    // 團體模式額外檢核：團體名稱必填
    const grpName = $('#regGroupName').value.trim();
    const grpErr = isGroupMode && grpName.length < 2 ? '團體報名請填寫團體名稱（至少 2 字）' : '';
    $('#err-regGroupName').textContent = grpErr;
    $('#regGroupName').classList.remove('input-valid', 'input-invalid');
    if (isGroupMode) $('#regGroupName').classList.add(grpErr ? 'input-invalid' : 'input-valid');

    const map = [
      ['#regCatId', 'cat', '#err-regCatId'], ['#regNationality', 'nat', '#err-regNationality'],
      ['#regName', 'name', '#err-regName'], ['#regIdCard', 'idCard', '#err-regIdCard'],
      ['#regGender', 'gender', '#err-regGender'], ['#regBirthday', 'birthday', '#err-regBirthday'],
      ['#regPhone', 'phone', '#err-regPhone'], ['#regEmail', 'email', '#err-regEmail'],
      ['#regDiet', 'diet', '#err-regDiet'],
      ['#regEmergName', 'emergName', '#err-regEmergName'], ['#regEmergPhone', 'emergPhone', '#err-regEmergPhone'],
      ['#regLast5', 'last5', '#err-regLast5']
    ];
    map.forEach(([iSel, k, eSel]) => {
      const el = $(iSel);
      $(eSel).textContent = checks[k];
      el.classList.remove('input-valid', 'input-invalid');
      el.classList.add(checks[k] ? 'input-invalid' : 'input-valid');
    });
    $('#err-regConsent').textContent = checks.consent;

    const evObj = State.events.find((e) => e.eventId === evId);
    const priceInfo = C.getEffectiveCategoryPrice(evObj, cat);
    const addons = $$('.reg-addon:checked').map((cb) => ({ name: cb.dataset.name, price: Number(cb.dataset.price) }));
    const totalAmount = priceInfo.fee + addons.reduce((s, a) => s + a.price, 0);
    $('#regSingleTotal').textContent = priceInfo.isEarlyBird
      ? `NT$ ${totalAmount.toLocaleString()} (🐤 早鳥省 $${(priceInfo.regularFee - priceInfo.fee).toLocaleString()})`
      : `NT$ ${totalAmount.toLocaleString()}`;

    // 承辦人自訂擴充欄位取值與即時防呆檢核
    const evSchema = C.parseJsonSafe(evObj?.formSchemaJson, C.defaultFormSchema());
    const customFieldDefs = Array.isArray(evSchema.customFields) ? evSchema.customFields : [];
    const customValues = {};
    let cfHasErr = false;
    customFieldDefs.forEach((f) => {
      let val = '';
      if (f.type === 'radio') {
        const checked = document.querySelector(`input[name="cf_radio_${f.key}"]:checked`);
        val = checked ? checked.value : '';
      } else if (f.type === 'checkbox') {
        val = Array.from(document.querySelectorAll(`.reg-cf-input[data-cf-key="${f.key}"]:checked`)).map((x) => x.value);
      } else {
        const inp = document.querySelector(`.reg-cf-input[data-cf-key="${f.key}"]`);
        val = inp ? inp.value.trim() : '';
      }
      customValues[f.key] = val;
      let err = '';
      if (f.required) {
        if (Array.isArray(val) ? val.length === 0 : !String(val).trim()) err = `請填寫「${f.label}」`;
      }
      if (!err && f.type === 'url' && val && !/^https?:\/\/.+/i.test(val)) {
        err = '請輸入 http:// 或 https:// 開頭之有效網址';
      }
      if (err) cfHasErr = true;
      const errEl = document.getElementById(`err-cf-${f.key}`);
      if (errEl) errEl.textContent = err;
    });
    checks.customFields = cfHasErr ? '尚有活動自訂必填欄位未完成' : '';

    const split = C.splitFullName(name);
    const rawRemark = $('#regRemark').value.trim();
    const finalRemark = priceInfo.isEarlyBird ? ['[早鳥價]', rawRemark].filter(Boolean).join(' ') : rawRemark;
    const isValid = Object.values(checks).every((e) => e === '') && !grpErr;
    return {
      isValid,
      runner: {
        participantId: `TUR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(10000 + Math.random() * 90000)}`,
        eventId: evId, catId, bibNumber: '', groupCode: '', groupName: isGroupMode ? grpName : '',
        groupRole: isGroupMode ? (State.groupCart.length === 0 ? 'leader' : 'member') : '',
        name, lastName: split.lastName, firstName: split.firstName, idCard, gender, birthday, age, nationality: nat,
        phone, email, city: String(customValues.address || '').trim(), emergencyName: emergName, emergencyPhone: emergPhone, diet, remark: finalRemark,
        totalAmount, addonsDetail: JSON.stringify(addons.map((a) => a.name)),
        customFieldsJson: JSON.stringify(customValues),
        payMethod, remittanceLast5: payMethod === 'MANUAL_ATM' ? last5 : '',
        merTradeNo: payMethod === 'ONLINE_PAYUNi' ? `PU${Date.now()}` : '',
        payStatus: payMethod === 'ONLINE_PAYUNi' ? 'PAID' : 'UNPAID',
        paymentType: payMethod === 'ONLINE_PAYUNi' ? $('#payuniTypeSelect').value : 'MANUAL',
        tradeNo: payMethod === 'ONLINE_PAYUNi' ? `TR${Math.floor(10000000 + Math.random() * 89999999)}` : '',
        payInfo: payMethod === 'ONLINE_PAYUNi' ? 'PAYUNi 即時模擬授權成功' : '',
        paidAt: payMethod === 'ONLINE_PAYUNi' ? C.formatDateTime() : '',
        chipUid: '', checkinStatus: 'pending', raceStatus: 'dns', penaltySeconds: 0, createdAt: C.formatDateTime()
      }
    };
  }

  function renderGroupCart() {
    $('#groupCountBadge').textContent = `${State.groupCart.length} / 50`;
    const box = $('#groupCartList');
    if (!State.groupCart.length) {
      box.innerHTML = '<p class="text-slate-400 italic py-3 text-center">尚無成員（第 1 位為團長，上限 50 人）</p>';
      $('#groupGrandTotal').textContent = 'NT$ 0';
      $('#btnSubmitGroup').textContent = '✅ 送出團報（至少 2 人）';
      $('#btnSubmitGroup').disabled = true;
      syncGroupRoleUI();
      return;
    }
    const leaderEmail = State.groupCart[0].email || '';
    State.groupCart.forEach((r, idx) => {
      r.groupRole = idx === 0 ? 'leader' : 'member';
      if (leaderEmail) r.email = leaderEmail;
    });
    box.innerHTML = State.groupCart.map((r, i) => `
      <div class="flex items-center justify-between p-2 rounded-lg border ${i === 0 ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-black ${i === 0 ? 'bg-amber-500 text-slate-950' : 'bg-slate-200 text-slate-700'}">${i === 0 ? '👑 團長' : `組員 #${i}`}</span>
            <b>${C.escapeHtml(r.name)}</b> <span class="text-slate-500">[${r.nationality}]</span> · <span class="mono font-bold">NT$${Number(r.totalAmount).toLocaleString()}</span>
          </div>
          ${i === 0 ? `<div class="text-[10px] text-amber-900 mt-0.5 truncate">✉️ 統一收信：${C.escapeHtml(r.email)}</div>` : ''}
        </div>
        <button data-rm-cart="${i}" class="text-rose-600 font-bold px-1.5 shrink-0" title="移除此成員">✕</button>
      </div>`).join('');
    const grandTotal = State.groupCart.reduce((s, r) => s + Number(r.totalAmount), 0);
    $('#groupGrandTotal').textContent = `NT$ ${grandTotal.toLocaleString()}`;
    const enough = State.groupCart.length >= 2;
    $('#btnSubmitGroup').textContent = enough
      ? `✅ 送出團報 (${State.groupCart.length} 人)`
      : '➕ 再加 1 位組員 (1/2)';
    $('#btnSubmitGroup').disabled = !enough;
    syncGroupRoleUI();
  }

  /* --------------------------------------------------------------------------
   * View B2: 多場活動聯合報名（先選同一承辦人 → 再選其名下同金流場次 → 合併繳費）
   * -------------------------------------------------------------------------- */
  function getEventOwnerKey(ev) {
    return String(ev?.ownerUsername || ev?.organizerZh || 'TUR').trim();
  }

  function getOpenMultiOrganizers() {
    const openEvs = State.events
      .filter((e) => e.status === 'open' || e.status === 'auto')
      .sort((a, b) => String(a.regStart || '').localeCompare(String(b.regStart || '')));
    const map = new Map();
    openEvs.forEach((ev) => {
      const key = getEventOwnerKey(ev);
      if (!map.has(key)) {
        const u = State.users.find((x) => x.username === key);
        map.set(key, {
          ownerKey: key,
          displayName: u?.displayName || ev.organizerZh || key,
          organizerZh: ev.organizerZh || u?.displayName || key,
          events: []
        });
      }
      map.get(key).events.push(ev);
    });
    return [...map.values()].sort((a, b) => b.events.length - a.events.length);
  }

  function getOpenEventsByOwnerAndPayMode(ownerKey) {
    const openEvs = State.events
      .filter((e) => (e.status === 'open' || e.status === 'auto') && getEventOwnerKey(e) === String(ownerKey || ''))
      .sort((a, b) => String(a.regStart || '').localeCompare(String(b.regStart || '')));
    return {
      MANUAL_ATM: openEvs.filter((e) => C.getEventPaymentMode(e) === 'MANUAL_ATM'),
      ONLINE_PAYUNi: openEvs.filter((e) => C.getEventPaymentMode(e) === 'ONLINE_PAYUNi')
    };
  }

  function renderPublicMultiRegister() {
    const organizers = getOpenMultiOrganizers();
    if (!organizers.length) {
      $('#multiPayModeBar').innerHTML = '<div class="text-sm text-slate-500 text-center py-4">目前暫無開放報名的賽事。</div>';
      $('#multiEventsList').innerHTML = '';
      renderMultiSummaryAndValidate();
      return;
    }

    if (!State.multiOwner || !organizers.some((o) => o.ownerKey === State.multiOwner)) {
      State.multiOwner = organizers[0].ownerKey;
    }
    const activeOrg = organizers.find((o) => o.ownerKey === State.multiOwner) || organizers[0];
    const byMode = getOpenEventsByOwnerAndPayMode(State.multiOwner);
    if (!C.PAYUNi_FEATURE_ENABLED) {
      State.multiPayMode = 'MANUAL_ATM';
    } else if (!State.multiPayMode || !(byMode[State.multiPayMode] || []).length) {
      State.multiPayMode = byMode.MANUAL_ATM.length >= byMode.ONLINE_PAYUNi.length ? 'MANUAL_ATM' : 'ONLINE_PAYUNi';
    }
    const mode = State.multiPayMode;
    const evs = byMode[mode] || [];
    const isPayuni = mode === 'ONLINE_PAYUNi';

    $('#multiPayModeBar').innerHTML = `
      <div class="space-y-3">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="font-black text-sm text-slate-900">👤 選擇承辦人（限同承辦人合併繳費）</div>
            <span class="px-2.5 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-900 font-bold text-xs">${organizers.length} 位</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
            ${organizers.map((o) => {
              const act = o.ownerKey === State.multiOwner;
              return `
                <button type="button" data-multi-owner="${C.escapeHtml(o.ownerKey)}" class="p-3 rounded-xl border-2 text-left transition ${act ? 'border-slate-900 bg-slate-900 text-white shadow' : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-indigo-400'}">
                  <div class="flex items-center justify-between gap-1">
                    <span class="font-black text-sm truncate">👤 ${C.escapeHtml(o.displayName)}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-black shrink-0 ${act ? 'bg-amber-400 text-slate-950' : 'bg-white border text-slate-700'}">${o.events.length} 場</span>
                  </div>
                  <div class="text-[11px] mt-1 ${act ? 'text-slate-300' : 'text-slate-500'}">${C.escapeHtml(o.organizerZh)}</div>
                </button>`;
            }).join('')}
          </div>
        </div>

        <div class="pt-2.5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div class="font-black text-xs sm:text-sm text-slate-900">💰 繳費方式</div>
          <div class="flex flex-wrap gap-2 text-xs">
            <button type="button" data-multi-mode="MANUAL_ATM" class="px-3.5 py-1.5 rounded-xl border-2 font-black transition ${!isPayuni ? 'border-amber-500 bg-amber-500 text-slate-950 shadow' : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-amber-300'}">🏦 銀行轉帳（${byMode.MANUAL_ATM.length} 場）</button>
            ${C.PAYUNi_FEATURE_ENABLED
              ? `<button type="button" data-multi-mode="ONLINE_PAYUNi" class="px-3.5 py-1.5 rounded-xl border-2 font-black transition ${isPayuni ? 'border-emerald-600 bg-emerald-600 text-white shadow' : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-emerald-400'}">💳 線上金流（${byMode.ONLINE_PAYUNi.length} 場）</button>`
              : `<button type="button" disabled class="px-3.5 py-1.5 rounded-xl border-2 border-slate-200 bg-slate-100 text-slate-400 font-bold opacity-60 cursor-not-allowed">💳 線上金流（未開通）</button>`}
          </div>
        </div>
      </div>`;
    $$('[data-multi-owner]').forEach((b) => {
      b.onclick = () => {
        State.multiOwner = b.dataset.multiOwner;
        const nextByMode = getOpenEventsByOwnerAndPayMode(State.multiOwner);
        State.multiPayMode = !C.PAYUNi_FEATURE_ENABLED
          ? 'MANUAL_ATM'
          : (nextByMode.MANUAL_ATM.length >= nextByMode.ONLINE_PAYUNi.length ? 'MANUAL_ATM' : 'ONLINE_PAYUNi');
        renderPublicMultiRegister();
      };
    });
    $$('[data-multi-mode]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.multiMode === 'ONLINE_PAYUNi' && !C.PAYUNi_FEATURE_ENABLED) return;
        State.multiPayMode = b.dataset.multiMode;
        renderPublicMultiRegister();
      };
    });

    // 付款區塊顯示切換
    $('#mLast5Wrap').classList.toggle('hidden', isPayuni);
    $('#mPayuniWrap').classList.toggle('hidden', !isPayuni);

    // 銀行匯款資訊卡
    const bankCode = getConfigVal('bankCode', '004');
    const bankName = getConfigVal('bankName', '台灣銀行');
    const bankAcc = getConfigVal('bankAccount', '123-456-789012');
    const bankHolder = getConfigVal('bankAccountName', '台灣超馬協會 TUR');
    $('#multiBankInfoBox').innerHTML = isPayuni
      ? `<div class="font-bold text-emerald-800">💳 ${C.escapeHtml(activeOrg.displayName)} — PAYUNi 合併一次結帳</div><div>送出後將產生統一金流單號，付款完成即秒級同步標記本承辦人所選場次為 PAID 並各自配號。</div>`
      : `<div class="font-bold text-slate-900">🏦 ${C.escapeHtml(activeOrg.displayName)} — 統一匯款帳戶（請合併匯入下方總金額）</div><div class="mono mt-0.5">(${C.escapeHtml(bankCode)}) ${C.escapeHtml(bankName)} · <b>${C.escapeHtml(bankAcc)}</b></div><div>戶名：${C.escapeHtml(bankHolder)}</div>`;

    // 渲染可勾選之活動與組別清單
    const listBox = $('#multiEventsList');
    if (!evs.length) {
      listBox.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">目前無開放中活動</div>`;
    } else {
      listBox.innerHTML = evs.map((ev) => {
        const cats = State.categories.filter((c) => c.eventId === ev.eventId);
        const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
        const addons = (Array.isArray(schema.addons) ? schema.addons : []).filter((a) => a && a.enabled !== false);
        const customFields = Array.isArray(schema.customFields) ? schema.customFields : [];
        if (!State.multiSelected[ev.eventId]) {
          State.multiSelected[ev.eventId] = {
            selected: false,
            catId: cats[0]?.catId || '',
            addons: [],
            customFields: {}
          };
        }
        const st = State.multiSelected[ev.eventId];
        if (!cats.some((c) => c.catId === st.catId) && cats[0]) st.catId = cats[0].catId;
        const pickedCat = cats.find((c) => c.catId === st.catId) || cats[0];
        const pickedPr = C.getEffectiveCategoryPrice(ev, pickedCat);
        const evAddonSum = (st.addons || []).reduce((s, nm) => {
          const def = addons.find((a) => a.name === nm);
          return s + (def ? Number(def.price || 0) : 0);
        }, 0);
        const evSub = pickedPr.fee + evAddonSum;
        const regCnt = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
        const evFull = Number(ev.maxQuota) > 0 && regCnt >= Number(ev.maxQuota);

        return `
          <div class="rounded-xl border-2 transition overflow-hidden ${st.selected ? 'border-emerald-500 bg-emerald-50/35 shadow-sm' : 'border-slate-200 bg-white'}">
            <div class="p-3.5 flex flex-wrap items-start justify-between gap-2.5">
              <label class="flex items-start gap-2.5 cursor-pointer flex-1 min-w-[220px]">
                <input type="checkbox" data-m-ev-toggle="${ev.eventId}" ${st.selected ? 'checked' : ''} ${evFull ? 'disabled' : ''} class="mt-1 w-4 h-4 accent-emerald-600" />
                <div>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-black text-sm text-slate-900">${C.escapeHtml(ev.nameZh)}</span>
                    ${C.isTestSuiteId(ev.eventId) ? '<span class="px-2 py-0.5 rounded-full bg-amber-300 text-slate-950 text-[10px] font-black">🧪 測試</span>' : ''}
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${ev.raceType === 'lap_timed' ? 'bg-indigo-100 text-indigo-800' : 'bg-sky-100 text-sky-800'}">${ev.raceType === 'lap_timed' ? '🔁 繞圈賽' : '🏃 距離賽'}</span>
                    ${evFull ? '<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[10px] font-bold">已額滿</span>' : ''}
                  </div>
                  <div class="text-[11px] text-slate-500 mt-0.5">🏁 起跑：${ev.raceStart ? ev.raceStart.slice(0, 16) : '待公告'} ｜ 主辦：${C.escapeHtml(ev.organizerZh || 'TUR')}</div>
                </div>
              </label>
              <div class="text-right shrink-0">
                <div class="text-[11px] text-slate-500">本場小計</div>
                <div class="font-black text-base mono ${st.selected ? 'text-emerald-700' : 'text-slate-400'}">NT$ ${evSub.toLocaleString()}</div>
              </div>
            </div>

            <div class="px-3.5 pb-3.5 pt-2 border-t ${st.selected ? 'border-emerald-200/80 bg-white/80' : 'border-slate-100 bg-slate-50/50'} space-y-2.5 text-xs">
              <div>
                <label class="font-bold text-slate-700 block mb-1">選擇報名組別</label>
                <select data-m-cat="${ev.eventId}" class="w-full px-2.5 py-2 border rounded-lg bg-white text-xs sm:text-sm font-semibold">
                  ${cats.map((c) => {
                    const used = State.participants.filter((p) => p.eventId === ev.eventId && p.catId === c.catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
                    const rem = Math.max(0, Number(c.quota) - used);
                    const wTag = C.isCategoryWarrior800(c) ? ' [🏅八百壯士組]' : '';
                    const cPr = C.getEffectiveCategoryPrice(ev, c);
                    const cPriceTxt = cPr.isEarlyBird ? `🐤早鳥 NT$${cPr.fee} (原$${cPr.regularFee})` : `NT$${cPr.fee}`;
                    return `<option value="${c.catId}" ${c.catId === st.catId ? 'selected' : ''}>${C.escapeHtml(c.name)}${wTag} — ${cPriceTxt}（剩 ${rem}/${c.quota}）</option>`;
                  }).join('')}
                </select>
              </div>

              ${st.selected && addons.length ? `
                <div>
                  <div class="font-bold text-slate-700 mb-1">本場可加購服務（選填）</div>
                  <div class="flex flex-wrap gap-2">
                    ${addons.map((a) => {
                      const chk = (st.addons || []).includes(a.name);
                      return `
                        <label class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border bg-white cursor-pointer hover:border-amber-400">
                          <input type="checkbox" data-m-addon-ev="${ev.eventId}" data-m-addon-name="${C.escapeHtml(a.name)}" ${chk ? 'checked' : ''} class="accent-amber-500" />
                          <span>${C.escapeHtml(a.name)} <b>+$${a.price}</b></span>
                        </label>`;
                    }).join('')}
                  </div>
                </div>` : ''}

              ${st.selected && customFields.length ? `
                <div class="p-2.5 rounded-lg bg-indigo-50/70 border border-indigo-200 space-y-2">
                  <div class="font-bold text-indigo-950">📝 本場專屬自訂欄位</div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    ${customFields.map((f) => {
                      const curVal = st.customFields?.[f.key] ?? '';
                      const reqMark = f.required ? ' <span class="text-rose-600 font-black">*</span>' : '';
                      const errId = `err-mcf-${ev.eventId}-${C.escapeHtml(f.key)}`;
                      if (f.type === 'select') {
                        return `<div><label class="font-bold text-[11px]">${C.escapeHtml(f.label)}${reqMark}</label><select data-m-cf-ev="${ev.eventId}" data-m-cf-key="${C.escapeHtml(f.key)}" class="w-full px-2 py-1.5 border rounded-lg bg-white mt-0.5"><option value="">請選擇</option>${(f.options || []).map((o) => `<option value="${C.escapeHtml(o)}" ${curVal === o ? 'selected' : ''}>${C.escapeHtml(o)}</option>`).join('')}</select><p id="${errId}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p></div>`;
                      }
                      if (f.type === 'radio') {
                        return `<div><label class="font-bold text-[11px] block">${C.escapeHtml(f.label)}${reqMark}</label><div class="flex flex-wrap gap-2 mt-1">${(f.options || []).map((o) => `<label class="inline-flex items-center gap-1"><input type="radio" name="mcf_${ev.eventId}_${f.key}" data-m-cf-ev="${ev.eventId}" data-m-cf-key="${C.escapeHtml(f.key)}" value="${C.escapeHtml(o)}" ${curVal === o ? 'checked' : ''} /><span>${C.escapeHtml(o)}</span></label>`).join('')}</div><p id="${errId}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p></div>`;
                      }
                      if (f.type === 'checkbox') {
                        const arrVal = Array.isArray(curVal) ? curVal : [];
                        return `<div><label class="font-bold text-[11px] block">${C.escapeHtml(f.label)}${reqMark}</label><div class="flex flex-wrap gap-2 mt-1">${(f.options || []).map((o) => `<label class="inline-flex items-center gap-1"><input type="checkbox" data-m-cf-ev="${ev.eventId}" data-m-cf-key="${C.escapeHtml(f.key)}" data-m-cf-multi="1" value="${C.escapeHtml(o)}" ${arrVal.includes(o) ? 'checked' : ''} /><span>${C.escapeHtml(o)}</span></label>`).join('')}</div><p id="${errId}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p></div>`;
                      }
                      const inpType = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : (f.type === 'url' ? 'url' : 'text'));
                      return `<div><label class="font-bold text-[11px]">${C.escapeHtml(f.label)}${reqMark}</label><input type="${inpType}" data-m-cf-ev="${ev.eventId}" data-m-cf-key="${C.escapeHtml(f.key)}" value="${C.escapeHtml(String(curVal || ''))}" placeholder="${C.escapeHtml(f.placeholder || '')}" autocomplete="off" class="w-full px-2 py-1.5 border rounded-lg bg-white mt-0.5" /><p id="${errId}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p></div>`;
                    }).join('')}
                  </div>
                </div>` : ''}
            </div>
          </div>`;
      }).join('');
    }

    // 綁定卡片互動
    $$('[data-m-ev-toggle]').forEach((cb) => {
      cb.onchange = () => {
        const eid = cb.dataset.mEvToggle;
        if (State.multiSelected[eid]) State.multiSelected[eid].selected = cb.checked;
        renderPublicMultiRegister();
      };
    });
    $$('[data-m-cat]').forEach((sel) => {
      sel.onchange = () => {
        const eid = sel.dataset.mCat;
        if (State.multiSelected[eid]) {
          State.multiSelected[eid].catId = sel.value;
          State.multiSelected[eid].selected = true;
        }
        renderPublicMultiRegister();
      };
    });
    $$('[data-m-addon-ev]').forEach((cb) => {
      cb.onchange = () => {
        const eid = cb.dataset.mAddonEv;
        const nm = cb.dataset.mAddonName;
        const st = State.multiSelected[eid];
        if (!st) return;
        st.addons = Array.isArray(st.addons) ? st.addons : [];
        if (cb.checked && !st.addons.includes(nm)) st.addons.push(nm);
        else if (!cb.checked) st.addons = st.addons.filter((x) => x !== nm);
        renderPublicMultiRegister();
      };
    });
    $$('[data-m-cf-ev]').forEach((inp) => {
      const syncCf = () => {
        const eid = inp.dataset.mCfEv;
        const k = inp.dataset.mCfKey;
        const st = State.multiSelected[eid];
        if (!st) return;
        st.customFields = st.customFields || {};
        if (inp.dataset.mCfMulti === '1') {
          st.customFields[k] = $$(`[data-m-cf-ev="${eid}"][data-m-cf-key="${k}"]:checked`).map((x) => x.value);
        } else {
          st.customFields[k] = inp.value;
        }
        renderMultiSummaryAndValidate();
      };
      inp.oninput = syncCf;
      inp.onchange = syncCf;
    });

    // 顯示最近一次合併報名收據（若有）
    const recBox = $('#multiReceiptBox');
    if (State.multiLastReceipt) {
      const rc = State.multiLastReceipt;
      recBox.classList.remove('hidden');
      recBox.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-300 pb-2">
          <div>
            <div class="font-black text-base text-emerald-950">🎉 多場活動聯合報名完成！</div>
            <div class="text-xs text-emerald-800 mt-0.5">
              ${rc.bundleCode ? `合併結帳單號：<b class="mono px-2 py-0.5 rounded bg-emerald-200 text-emerald-950">${rc.bundleCode}</b>` : `單場報名序號：<b class="mono">${rc.items[0]?.participantId || '-'}</b>`}
              ｜ 共 <b>${rc.items.length}</b> 場 ｜ 合併應繳總金額：<b class="mono text-base text-rose-700">NT$ ${rc.grandTotal.toLocaleString()}</b>
            </div>
          </div>
          <button type="button" id="btnCloseMultiReceipt" class="px-2.5 py-1 rounded-lg bg-white border border-emerald-300 text-xs font-bold text-emerald-900">收合收據</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          ${rc.items.map((it, i) => `
            <div class="p-2.5 rounded-xl bg-white border border-emerald-200 flex items-center justify-between gap-2">
              <div>
                <div class="font-bold text-slate-900">${i + 1}. ${C.escapeHtml(it.eventName)}</div>
                <div class="text-[11px] text-slate-500 mono">${C.escapeHtml(it.catName)} · 序號 ${it.participantId}${it.bibNumber ? ` · 號碼布 ${it.bibNumber}` : ''}</div>
              </div>
              <div class="text-right shrink-0">
                <div class="mono font-black text-emerald-700">NT$ ${it.amount.toLocaleString()}</div>
                <div class="text-[10px] font-bold ${it.payStatus === 'PAID' ? 'text-emerald-600' : 'text-amber-700'}">${it.payStatus}</div>
              </div>
            </div>`).join('')}
        </div>
        <div class="text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2 pt-1">
          <span>💡 請記下合併單號 <b class="mono">${rc.bundleCode || rc.items[0]?.participantId}</b>；匯款完成後可至「報名查詢與修改」一次補填全部場次的末五碼！</span>
          <button type="button" id="btnMultiGoLookup" class="px-3.5 py-1.5 rounded-lg bg-slate-900 text-white font-bold">🔍 前往查改／補填末五碼</button>
        </div>`;
      const clsBtn = document.getElementById('btnCloseMultiReceipt');
      if (clsBtn) clsBtn.onclick = () => { State.multiLastReceipt = null; recBox.classList.add('hidden'); };
      const goLk = document.getElementById('btnMultiGoLookup');
      if (goLk) goLk.onclick = () => {
        $('#lookupIdCard').value = rc.idCard || '';
        $('#lookupCred').value = rc.bundleCode || rc.items[0]?.participantId || '';
        switchView('public-lookup');
        $('#btnLookupVerify').click();
      };
    } else {
      recBox.classList.add('hidden');
    }

    renderMultiSummaryAndValidate();
  }

  function renderMultiSummaryAndValidate() {
    const byMode = getOpenEventsByOwnerAndPayMode(State.multiOwner);
    const mode = State.multiPayMode || 'MANUAL_ATM';
    const evs = byMode[mode] || [];
    const isPayuni = mode === 'ONLINE_PAYUNi';

    const picked = [];
    evs.forEach((ev) => {
      const st = State.multiSelected[ev.eventId];
      if (!st || !st.selected) return;
      const cats = State.categories.filter((c) => c.eventId === ev.eventId);
      const cat = cats.find((c) => c.catId === st.catId) || cats[0];
      if (!cat) return;
      const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
      const addonDefs = (Array.isArray(schema.addons) ? schema.addons : []).filter((a) => a && a.enabled !== false);
      const cfDefs = Array.isArray(schema.customFields) ? schema.customFields : [];
      const addonObjs = (st.addons || []).map((nm) => addonDefs.find((a) => a.name === nm)).filter(Boolean);
      const pr = C.getEffectiveCategoryPrice(ev, cat);
      const subtotal = pr.fee + addonObjs.reduce((s, a) => s + Number(a.price || 0), 0);
      picked.push({ ev, cat, priceInfo: pr, addonObjs, cfDefs, customFields: st.customFields || {}, subtotal });
    });

    const grandTotal = picked.reduce((s, x) => s + x.subtotal, 0);
    $('#multiGrandTotal').textContent = `NT$ ${grandTotal.toLocaleString()}`;

    const summaryEl = $('#multiCartSummary');
    if (!picked.length) {
      summaryEl.innerHTML = '<div class="p-4 rounded-xl bg-slate-50 border border-dashed text-center text-slate-400">尚未勾選活動，請於左側勾選 1 場以上活動與組別（勾選 2 場以上自動啟用合併單號）。</div>';
    } else {
      summaryEl.innerHTML = picked.map((it, i) => `
        <div class="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200 flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-bold text-slate-900 truncate">${i + 1}. ${C.escapeHtml(it.ev.nameZh)}</div>
            <div class="text-[11px] text-slate-600">${C.escapeHtml(it.cat.name)}${C.isCategoryWarrior800(it.cat) ? ' 🏅' : ''}</div>
            ${it.addonObjs.length ? `<div class="text-[10px] text-amber-800">+ ${it.addonObjs.map((a) => C.escapeHtml(a.name)).join('、')}</div>` : ''}
          </div>
          <div class="mono font-black text-emerald-700 shrink-0">NT$ ${it.subtotal.toLocaleString()}</div>
        </div>`).join('') +
        (picked.length >= 2
          ? `<div class="px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-950 font-bold text-[11px]">📦 已勾選 ${picked.length} 場：送出將產生 1 組統一合併單號（TURM-...），一次匯款記帳！</div>`
          : `<div class="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[11px]">💡 再多勾選 1 場同金流活動即可合併為 1 筆匯款！</div>`);
    }

    // 驗證選手基本欄位與跨場防重複
    const natSel = $('#mNationality').value;
    const nat = natSel === 'OTHER' ? $('#mNationalityCustom').value.trim().toUpperCase() : natSel;
    const name = $('#mName').value.trim();
    const idCard = $('#mIdCard').value.trim().toUpperCase();
    const gender = $('#mGender').value;
    const birthday = $('#mBirthday').value;
    const age = C.calcAge(birthday);
    $('#mAgeDisplay').textContent = age !== null ? `${age} 歲` : '-- 歲';
    const phone = $('#mPhone').value.trim();
    const email = $('#mEmail').value.trim();
    const city = '';
    const diet = $('#mDiet').value;
    const emergName = $('#mEmergName').value.trim();
    const emergPhone = $('#mEmergPhone').value.trim();
    const last5 = $('#mLast5').value.trim();
    const consent = $('#mConsent').checked;

    // 比照個人／團體報名：各欄位即時驗證、即時紅綠框與欄位下方紅字提示
    const checks = {};
    checks.nat = /^[A-Z]{3}$/.test(nat) ? '' : '須為三碼國際國籍';
    checks.name = (name.length >= 2 && name.length <= 40 && !/[<>|\d]/.test(name)) ? '' : '姓名 2~40 字且不可含數字';

    let idErr = '';
    if (!idCard) idErr = '請輸入身分證/護照';
    else if (nat === 'TWN' && !C.verifyTaiwanIdChecksum(idCard)) idErr = '台灣身分證檢核碼錯誤';
    else if (nat !== 'TWN' && !/^[A-Z0-9]{6,15}$/.test(idCard)) idErr = '護照限 6~15 碼英數字';

    let gErr = !gender ? '請選擇性別' : '';
    if (!gErr && nat === 'TWN' && /^[A-Z][1289]/.test(idCard)) {
      const exp = C.inferGenderFromId(idCard);
      if (gender !== exp) gErr = `與身分證第2碼不符，應為 ${exp}`;
    }
    checks.gender = gErr;

    checks.birthday = age === null ? '請選出生日期' : (age < 10 || age > 80 ? `年齡 ${age} 歲，須 10~80 歲` : '');
    checks.phone = /^09\d{8}$/.test(phone) ? '' : '須為 09 開頭 10 碼';
    checks.email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Email 格式錯誤';
    checks.diet = diet ? '' : '請選擇飲食習慣（必填）';
    checks.emergName = !emergName ? '請填緊急聯絡人' : (emergName === name ? '不可與本人同名' : '');
    checks.emergPhone = !/^0\d{8,9}$/.test(emergPhone) ? '電話格式錯誤' : (emergPhone === phone ? '不可同本人手機' : '');
    checks.last5 = (isPayuni || !last5 || /^\d{5}$/.test(last5)) ? '' : '末五碼限 5 位純數字';
    checks.consent = consent ? '' : '須勾選同意參賽切結書';

    const errs = [];
    if (!picked.length) errs.push('請至少勾選 1 場活動');

    // 跨場逐一檢查同一承辦人、重複報名、活動總名額、分組名額與自訂必填欄
    const pickedOwners = new Set(picked.map((x) => getEventOwnerKey(x.ev)));
    if (pickedOwners.size > 1) errs.push('僅限合併同一位承辦人舉辦之活動');
    const dupEvNames = [];
    picked.forEach((it) => {
      const dup = idCard && State.participants.some((p) => p.eventId === it.ev.eventId && String(p.idCard).toUpperCase() === idCard && String(p.payStatus).toUpperCase() !== 'CANCELLED');
      if (dup) {
        dupEvNames.push(it.ev.nameZh);
        errs.push(`身分證 ${C.maskIdCard(idCard)} 已報名「${it.ev.nameZh}」，請取消勾選該場`);
      }
      const usedEv = State.participants.filter((p) => p.eventId === it.ev.eventId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
      if (Number(it.ev.maxQuota) > 0 && usedEv >= Number(it.ev.maxQuota)) errs.push(`「${it.ev.nameZh}」活動總名額已滿`);
      const usedCat = State.participants.filter((p) => p.eventId === it.ev.eventId && p.catId === it.cat.catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
      if (Number(it.cat.quota) > 0 && usedCat >= Number(it.cat.quota)) errs.push(`「${it.ev.nameZh} - ${it.cat.name}」名額已滿`);
      it.cfDefs.forEach((f) => {
        const v = it.customFields[f.key];
        let cfErr = '';
        if (f.required && (Array.isArray(v) ? v.length === 0 : !String(v || '').trim())) {
          cfErr = `請填寫「${f.label}」`;
        }
        if (!cfErr && f.type === 'url' && v && !/^https?:\/\/.+/i.test(String(v).trim())) {
          cfErr = '請輸入 http:// 或 https:// 開頭之有效網址';
        }
        const cfErrEl = document.getElementById(`err-mcf-${it.ev.eventId}-${f.key}`);
        if (cfErrEl) cfErrEl.textContent = cfErr;
        const cfInp = document.querySelector(`[data-m-cf-ev="${it.ev.eventId}"][data-m-cf-key="${f.key}"]:not([type="radio"]):not([type="checkbox"])`);
        if (cfInp) {
          cfInp.classList.remove('input-valid', 'input-invalid');
          if (f.required || cfErr) cfInp.classList.add(cfErr ? 'input-invalid' : 'input-valid');
        }
        if (cfErr) errs.push(`「${it.ev.nameZh}」${cfErr}`);
      });
    });

    if (!idErr && dupEvNames.length) idErr = `已重複報名：${dupEvNames.join('、')}`;
    checks.idCard = idErr;

    // 立即於每個欄位呈現紅／綠框與紅字錯誤訊息
    const mFieldMap = [
      ['#mNationality', 'nat', '#err-mNationality'], ['#mName', 'name', '#err-mName'],
      ['#mIdCard', 'idCard', '#err-mIdCard'], ['#mGender', 'gender', '#err-mGender'],
      ['#mBirthday', 'birthday', '#err-mBirthday'], ['#mPhone', 'phone', '#err-mPhone'],
      ['#mEmail', 'email', '#err-mEmail'], ['#mDiet', 'diet', '#err-mDiet'],
      ['#mEmergName', 'emergName', '#err-mEmergName'], ['#mEmergPhone', 'emergPhone', '#err-mEmergPhone'],
      ['#mLast5', 'last5', '#err-mLast5']
    ];
    mFieldMap.forEach(([iSel, k, eSel]) => {
      const el = $(iSel);
      const errEl = $(eSel);
      if (errEl) errEl.textContent = checks[k] || '';
      if (el) {
        el.classList.remove('input-valid', 'input-invalid');
        el.classList.add(checks[k] ? 'input-invalid' : 'input-valid');
      }
      if (checks[k] && k !== 'idCard') errs.push(checks[k]);
      else if (checks[k] && k === 'idCard' && !dupEvNames.length) errs.push(checks[k]);
    });
    if ($('#err-mConsent')) $('#err-mConsent').textContent = checks.consent;
    if (checks.consent) errs.push(checks.consent);

    $('#multiValidationHint').innerHTML = errs.slice(0, 4).map((e) => `<div>• ${C.escapeHtml(e)}</div>`).join('') + (errs.length > 4 ? `<div>• 另有 ${errs.length - 4} 項待填（請見左側紅框欄位）</div>` : '');
    const btn = $('#btnSubmitMulti');
    btn.disabled = errs.length > 0;
    btn.textContent = picked.length >= 2
      ? (isPayuni ? `💳 一次合併付款（${picked.length} 場・NT$ ${grandTotal.toLocaleString()}）` : `✅ 送出多場聯合報名（${picked.length} 場・合併 NT$ ${grandTotal.toLocaleString()}）`)
      : (isPayuni ? `💳 送出報名並線上付款（NT$ ${grandTotal.toLocaleString()}）` : `✅ 送出報名（NT$ ${grandTotal.toLocaleString()}）`);

    return {
      isValid: errs.length === 0,
      errs,
      picked,
      grandTotal,
      payMethod: mode,
      profile: { nat, name, idCard, gender, birthday, age, phone, email, city, diet, emergName, emergPhone, remark: $('#mRemark').value.trim(), last5 }
    };
  }

  let multiSubmitting = false;
  async function commitMultiBundle() {
    if (multiSubmitting) return;
    const res = renderMultiSummaryAndValidate();
    if (!res.isValid) {
      toast(res.errs[0] || '尚有必填欄位未完成', 'error');
      return;
    }
    multiSubmitting = true;
    try {
      await _commitMultiBundleInner(res);
    } finally {
      multiSubmitting = false;
    }
  }

  async function _commitMultiBundleInner(res) {
    const { picked, grandTotal, payMethod, profile } = res;
    const isPayuni = payMethod === 'ONLINE_PAYUNi';
    const isBundle = picked.length >= 2;
    const bundleCode = isBundle ? C.generateBundleOrderCode() : (isPayuni ? `PU${Date.now()}` : '');
    const nowStr = C.formatDateTime();
    const split = C.splitFullName(profile.name);
    const created = [];
    const receiptItems = [];

    for (let i = 0; i < picked.length; i++) {
      const it = picked[i];
      let bibNumber = '';
      if (isPayuni) {
        const usedBibs = new Set(State.participants.filter((p) => p.eventId === it.ev.eventId && p.bibNumber).map((p) => String(p.bibNumber).toUpperCase()));
        const prefix = String(it.cat.bibPrefix || 'R').toUpperCase();
        const startStr = String(it.cat.bibStartNum || '001');
        const width = Math.max(3, startStr.length);
        let num = parseInt(startStr, 10) || 1;
        while (usedBibs.has(`${prefix}${String(num).padStart(width, '0')}`.toUpperCase())) num++;
        bibNumber = `${prefix}${String(num).padStart(width, '0')}`;
      }

      const bundleTag = isBundle ? `[合併單 ${bundleCode}｜共${picked.length}場 總額NT$${grandTotal}]` : '';
      const ebTag = it.priceInfo?.isEarlyBird ? '[早鳥價]' : '';
      const finalRemark = [bundleTag, ebTag, profile.remark].filter(Boolean).join(' ');
      const pid = `TUR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(10000 + Math.random() * 90000)}`;
      const rec = {
        participantId: pid,
        eventId: it.ev.eventId,
        catId: it.cat.catId,
        bibNumber,
        groupCode: '',
        groupName: '',
        name: profile.name,
        lastName: split.lastName,
        firstName: split.firstName,
        idCard: profile.idCard,
        gender: profile.gender,
        birthday: profile.birthday,
        age: profile.age,
        nationality: profile.nat,
        phone: profile.phone,
        email: profile.email,
        city: profile.city,
        emergencyName: profile.emergName,
        emergencyPhone: profile.emergPhone,
        diet: profile.diet,
        remark: finalRemark,
        totalAmount: it.subtotal,
        addonsDetail: JSON.stringify(it.addonObjs.map((a) => a.name)),
        customFieldsJson: JSON.stringify(it.customFields || {}),
        payMethod,
        remittanceLast5: isPayuni ? '' : profile.last5,
        merTradeNo: bundleCode,
        payStatus: isPayuni ? 'PAID' : 'UNPAID',
        paymentType: isPayuni ? ($('#mPayuniType')?.value || 'CREDIT') : 'MANUAL',
        tradeNo: isPayuni ? `TR${Math.floor(10000000 + Math.random() * 89999999)}` : '',
        payInfo: isPayuni ? 'PAYUNi 多場合併授權成功' : '',
        paidAt: isPayuni ? nowStr : '',
        chipUid: '',
        checkinStatus: 'pending',
        raceStatus: 'dns',
        penaltySeconds: 0,
        createdAt: nowStr
      };
      State.participants.push(rec);
      await C.TurDB.put('participants', rec);
      created.push(rec);
      receiptItems.push({
        participantId: pid,
        eventName: it.ev.nameZh,
        catName: it.cat.name,
        amount: it.subtotal,
        payStatus: rec.payStatus,
        bibNumber
      });
    }

    await enqueueSync('registerRunner', { runners: created });
    State.multiLastReceipt = {
      bundleCode: isBundle ? bundleCode : '',
      idCard: profile.idCard,
      grandTotal,
      items: receiptItems
    };
    // 取消原本勾選並清空切結書，避免重複提交
    Object.values(State.multiSelected).forEach((s) => { s.selected = false; });
    $('#mConsent').checked = false;
    rebuildIndices();
    renderPublicMultiRegister();
    toast(
      isBundle
        ? `🎉 多場聯合報名成功！合併單號 ${bundleCode}（共 ${created.length} 場・合計 NT$${grandTotal.toLocaleString()}）`
        : `✅ 報名成功！（NT$${grandTotal.toLocaleString()}）`,
      'success'
    );
  }

  let singleSubmitting = false;
  async function commitRunners(runners) {
    if (singleSubmitting) return;
    singleSubmitting = true;
    try {
      await _commitRunnersInner(runners);
    } finally {
      singleSubmitting = false;
    }
  }

  async function _commitRunnersInner(runners) {
    const evId = runners[0].eventId;
    const evObj = State.events.find((e) => e.eventId === evId);
    if (!evObj || (evObj.status !== 'open' && evObj.status !== 'auto')) {
      toast('🔒 階段 1 報名管制：本活動目前未開放報名（已截止或已結案）', 'error');
      return;
    }
    const curActiveCnt = State.participants.filter((p) => p.eventId === evId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
    if (Number(evObj.maxQuota) > 0 && curActiveCnt + runners.length > Number(evObj.maxQuota)) {
      toast(`🔒 階段 1 名額管制：本場總限額 ${evObj.maxQuota} 人，目前剩餘名額不足！`, 'error');
      return;
    }
    const batchByCat = new Map();
    for (const r of runners) {
      batchByCat.set(r.catId, (batchByCat.get(r.catId) || 0) + 1);
    }
    for (const [cid, addCnt] of batchByCat.entries()) {
      const catObj = State.categories.find((c) => c.catId === cid);
      const catQ = Number(catObj?.quota || 0);
      if (catQ > 0) {
        const usedCat = State.participants.filter((p) => p.eventId === evId && p.catId === cid && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
        if (usedCat + addCnt > catQ) {
          toast(`🔒 階段 1 分組名額管制：「${catObj?.name || cid}」限額 ${catQ} 人，剩餘名額不足！`, 'error');
          return;
        }
      }
    }

    const isGroup = State.regMode === 'group' || runners.length > 1 || Boolean(runners[0].groupName);
    const grpCode = isGroup ? `GRP26-${Math.floor(1000 + Math.random() * 8999)}` : '';
    const unifiedLast5 = isGroup
      ? String($('#groupUnifiedLast5')?.value || runners[0].remittanceLast5 || '').trim()
      : String(runners[0].remittanceLast5 || '').trim();
    const leaderEmail = String(runners[0].email || '').trim();
    const usedBibs = new Set(State.participants.filter((p) => p.eventId === evId && p.bibNumber).map((p) => String(p.bibNumber).toUpperCase()));
    const assignedBibs = [];

    runners.forEach((r, idx) => {
      if (grpCode) {
        r.groupCode = grpCode;
        r.groupRole = idx === 0 ? 'leader' : 'member';
        if (leaderEmail) r.email = leaderEmail;
        if (r.payMethod === 'MANUAL_ATM') r.remittanceLast5 = unifiedLast5;
      } else {
        r.groupRole = '';
      }
    });

    for (const r of runners) {
      // 若為 PAYUNi 秒級自動銷帳，於寫入雲端前直接配好號碼布，單次寫入到位
      if (r.payMethod === 'ONLINE_PAYUNi' && !r.bibNumber) {
        const cat = State.categories.find((c) => c.catId === r.catId);
        const prefix = String(cat?.bibPrefix || 'R').toUpperCase();
        const startStr = String(cat?.bibStartNum || '001');
        const width = Math.max(3, startStr.length);
        let num = parseInt(startStr, 10) || 1;
        let bib = `${prefix}${String(num).padStart(width, '0')}`;
        while (usedBibs.has(bib)) { num++; bib = `${prefix}${String(num).padStart(width, '0')}`; }
        usedBibs.add(bib);
        r.bibNumber = bib;
        assignedBibs.push(bib);
      }

      State.participants.push(r);
      await C.TurDB.put('participants', r);
    }
    rebuildIndices(evId);
    renderPublicRegister();

    // 放入佇列並立即等待寫入 Google 試算表，讓使用者立刻看到雲端同步成功或明確錯誤原因
    const item = { qid: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action: 'registerRunner', payload: { runners }, createdAt: Date.now() };
    State.syncQueue.push(item);
    await C.TurDB.put('syncQueue', item);
    updateQueueBadge();

    let cloudNote = '（本機已存，尚未設定 GAS 網址）';
    let toastType = 'success';
    if (State.gasUrl && navigator.onLine) {
      const syncRes = await syncPushNow(true);
      if (syncRes.ok) {
        cloudNote = '｜☁️ 已即時寫入 Google 試算表！';
      } else {
        cloudNote = `｜⚠️ 雲端寫入失敗（已暫存佇列）：${syncRes.error}`;
        toastType = 'warn';
      }
    } else if (State.gasUrl && !navigator.onLine) {
      cloudNote = '｜📴 離線暫存，連網後自動寫入雲端';
    }

    const grpGrandTotal = runners.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    if (assignedBibs.length) {
      toast(grpCode
        ? `⚡ 團報 ${grpCode}（👑 團長 ${runners[0].name}｜共 ${runners.length} 人）PAYUNi 配號成功｜✉️ 已統一寄發確認信給團長${cloudNote}`
        : `⚡ PAYUNi 銷帳配號成功 (${assignedBibs.join(', ')})｜✉️ 已自動寄發報名＋繳費入帳確認信${cloudNote}`, toastType);
    } else {
      toast(grpCode
        ? `👑 團報完成！團報碼 ${grpCode}（團長 ${runners[0].name}｜共 ${runners.length} 人｜統一匯款 NT$${grpGrandTotal.toLocaleString()}）｜✉️ 已僅寄發確認信給團長${cloudNote}`
        : `📝 報名成功！序號 ${runners[0].participantId}｜✉️ 已自動寄發報名確認信（含反向查改說明）${cloudNote}`, toastType);
    }
  }

  /* --------------------------------------------------------------------------
   * View D: 三、晶片計時（三步驟登錄 ＋ 晶片感應作業）
   * -------------------------------------------------------------------------- */
  function renderOpInlineStationGrid() {
    const evSel = $('#opInlineEventSelect');
    const grid = $('#opInlineStationGrid');
    if (!evSel || !grid) return;
    const evId = evSel.value;
    const evObj = State.events.find((e) => e.eventId === evId);
    const evOwner = evObj ? String(evObj.ownerUsername || '') : '';
    const stNameMap = new Map(
      State.stations.filter((s) => s.eventId === evId).map((s) => [String(s.stationCode || '').toUpperCase(), s.name])
    );
    const ops = State.users.filter((u) => {
      if (u.role !== 'operator' || !Number(u.enabled)) return false;
      if (u.allowedEventId === evId) return true;
      if (u.allowedEventId === 'ALL') return !u.parentOrganizer || u.parentOrganizer === evOwner;
      return false;
    });
    if (State.pickedOpUser && !ops.some((x) => x.username === State.pickedOpUser.username)) {
      State.pickedOpUser = null;
      if ($('#opInlineUser')) $('#opInlineUser').value = '';
      if ($('#opInlinePickedHint')) $('#opInlinePickedHint').textContent = '請點選本活動作業組別';
    }
    if (!ops.length) {
      grid.innerHTML = '<div class="col-span-full p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold text-center">本活動尚未設定作業組別帳號，請承辦人至「四、後台管理 → 賽事作業區 → 作業員」新增</div>';
      return;
    }
    grid.innerHTML = ops.map((op) => {
      const stCode = String(op.allowedStation || '').toUpperCase();
      const customStName = stCode === 'WRITER' ? '發卡寫入組' : (stNameMap.get(stCode) || '');
      const picked = State.pickedOpUser?.username === op.username;
      return `
        <button type="button" data-inline-pick-op="${C.escapeHtml(op.username)}" class="p-3 rounded-xl border-2 text-left transition ${picked ? 'border-emerald-600 bg-emerald-50 shadow-sm' : 'border-slate-200 hover:border-slate-400 bg-white'}">
          <div class="font-black text-xs mono text-slate-900">${C.escapeHtml(op.allowedStation)}</div>
          ${customStName ? `<div class="text-[11px] font-bold text-indigo-700 truncate">${C.escapeHtml(customStName)}</div>` : ''}
          <div class="text-[11px] text-slate-500 truncate">${C.escapeHtml(op.displayName)} (${C.escapeHtml(op.username)})</div>
        </button>`;
    }).join('');
    $$('[data-inline-pick-op]').forEach((b) => {
      b.onclick = () => {
        State.pickedOpUser = ops.find((x) => x.username === b.dataset.inlinePickOp) || null;
        if (State.pickedOpUser) {
          const stCode = String(State.pickedOpUser.allowedStation || '').toUpperCase();
          const stNm = stCode === 'WRITER' ? '發卡寫入組' : (stNameMap.get(stCode) || '');
          if ($('#opInlineUser')) $('#opInlineUser').value = State.pickedOpUser.username;
          if ($('#opInlinePickedHint')) $('#opInlinePickedHint').textContent = `已選組別：${State.pickedOpUser.allowedStation}${stNm ? ' ' + stNm : ''}（帳號 ${State.pickedOpUser.username}）`;
          if ($('#opInlinePass')) $('#opInlinePass').focus();
        }
        renderOpInlineStationGrid();
      };
    });
  }

  function renderOperatorStation() {
    const isOp = State.currentUser?.role === 'operator';
    const loginCard = $('#opInlineLoginCard');
    const dutyBox = $('#opDutyWorkspace');
    if (loginCard) loginCard.classList.toggle('hidden', isOp);
    if (dutyBox) dutyBox.classList.toggle('hidden', !isOp);
    updateNetworkBadge();

    if (!isOp) {
      const activeEvs = State.events.filter((e) => e.status !== 'finished');
      const sel = $('#opInlineEventSelect');
      if (sel) {
        const prev = sel.value;
        sel.innerHTML = activeEvs.map((e) => `<option value="${e.eventId}">${C.escapeHtml(e.nameZh)} (${e.raceType === 'lap_timed' ? '繞圈賽' : '距離賽'})</option>`).join('') || '<option value="">目前無進行中活動</option>';
        if (prev && activeEvs.some((e) => e.eventId === prev)) sel.value = prev;
      }
      renderOpInlineStationGrid();
      return;
    }

    const ev = State.events.find((e) => e.eventId === State.opEventId) || State.events[0];
    if (!ev) return;
    const stCode = State.opLockedStation;
    const sop = C.getStationSopInfo(ev, stCode, State.stations);
    const paid = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.bibNumber);
    const stLogs = State.timingLogs.filter((l) => l.eventId === ev.eventId && l.stationCode === stCode && l.isValid !== false);
    const passedBibSet = new Set(stLogs.map((l) => String(l.bibNumber).toUpperCase()));
    const passedCount = stCode === 'CHECKIN'
      ? paid.filter((p) => p.checkinStatus === 'checked_in').length
      : (stCode === 'WRITER' ? paid.filter((p) => Boolean(p.chipUid)).length : passedBibSet.size);
    const pct = paid.length ? Math.round((passedCount / paid.length) * 100) : 0;
    const needsGun = stCode !== 'WRITER' && stCode !== 'CHECKIN' && !ev.raceStart;

    $('#opStationTitle').textContent = stCode === 'WRITER' ? '📡 發卡與寫入 (WRITER)' : `⏱️ ${stCode} ${sop.stationName}`;
    $('#opEventSubtitle').textContent = `${sop.raceTypeLabel} · ${ev.nameZh} · ${State.currentUser.username}`;

    // 管制點進度與 SOP（預設收合，保留主畫面空間給刷卡/寫卡）
    const sopBox = $('#opStationSopBanner');
    if (sopBox) {
      sopBox.className = `rounded-2xl border-2 text-xs shadow-sm outdoor-card overflow-hidden ${needsGun ? 'bg-amber-50 border-amber-400' : (ev.status === 'finished' ? 'bg-rose-50 border-rose-400' : 'bg-white border-indigo-200')}`;
      sopBox.innerHTML = `
        <details>
          <summary class="px-4 py-2.5 cursor-pointer flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="acc-arrow inline-block text-slate-400">▶</span>
              <span class="px-2 py-0.5 rounded-full bg-slate-900 text-amber-400 font-black mono">${sop.code}</span>
              <span class="font-black text-slate-900">${C.escapeHtml(sop.roleLabel)}</span>
              ${needsGun ? '<span class="px-2 py-0.5 rounded-full bg-amber-500 text-slate-950 font-black">⏳ 未鳴槍</span>' : (ev.status === 'finished' ? '<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white font-black">🔒 已結案</span>' : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-black">🟢 執勤中</span>')}
            </div>
            <div class="mono font-bold text-slate-700">進度：<b>${passedCount}/${paid.length}</b> (${pct}%)</div>
          </summary>
          <div class="px-4 pb-3 pt-2 border-t space-y-2">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div class="p-2 rounded-lg bg-slate-50 border"><b>📡 作業：</b>${C.escapeHtml(sop.action)}</div>
              <div class="p-2 rounded-lg bg-amber-50/70 border border-amber-200"><b>🛡️ 防呆：</b>${C.escapeHtml(sop.guard)}</div>
              <div class="p-2 rounded-lg bg-sky-50/70 border border-sky-200"><b>🛠️ 補登：</b>${C.escapeHtml(sop.fallback)}</div>
            </div>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span class="font-bold text-slate-500">賽道：</span>
              ${sop.routeNodes.map((n, i) => `${i > 0 ? '<span class="text-slate-400">→</span>' : ''}<span class="px-2 py-0.5 rounded-lg mono font-bold ${n === stCode ? 'bg-amber-400 text-slate-950 ring-2 ring-amber-500' : 'bg-slate-100 text-slate-600'}">${n}</span>`).join('')}
            </div>
          </div>
        </details>`;
    }

    const isWriter = stCode === 'WRITER';
    $('#opWriterPanel').classList.toggle('hidden', !isWriter);
    $('#opTimingPanel').classList.toggle('hidden', isWriter);

    if (isWriter) {
      $('#nfcSupportBadge').textContent = 'NDEFReader' in window ? '🟢 支援 Web NFC' : '🟡 模擬演練模式';
      const u = State.currentUser;
      const availEvs = State.events.filter((e) => e.status !== 'finished' && (u.allowedEventId === 'ALL' || !u.allowedEventId || e.eventId === u.allowedEventId || e.eventId === State.opEventId));
      const listEvs = availEvs.length ? availEvs : State.events.filter((e) => e.status !== 'finished');
      const selEv = $('#writerEventSelect');
      if (selEv) {
        selEv.innerHTML = listEvs.map((e) => `<option value="${e.eventId}" ${e.eventId === ev.eventId ? 'selected' : ''}>${C.escapeHtml(e.nameZh)} (${e.raceType === 'lap_timed' ? '繞圈賽' : '距離賽'})</option>`).join('');
      }
      if ($('#writerRaceStartBadge')) {
        $('#writerRaceStartBadge').textContent = `🏁 起跑：${ev.raceStart || '尚未設定'}`;
      }
      const chippedCnt = paid.filter((p) => Boolean(p.chipUid)).length;
      const checkedCnt = paid.filter((p) => p.checkinStatus === 'checked_in').length;
      const chipPct = paid.length ? Math.round((chippedCnt / paid.length) * 100) : 0;
      const chkPct = paid.length ? Math.round((checkedCnt / paid.length) * 100) : 0;
      if ($('#writerStatsBar')) {
        $('#writerStatsBar').innerHTML = `
          <span class="px-2 py-1 rounded bg-slate-100 text-slate-800">已繳配號 ${paid.length} 人</span>
          <span class="px-2 py-1 rounded bg-sky-100 text-sky-900">已寫卡 ${chippedCnt} (${chipPct}%)</span>
          <span class="px-2 py-1 rounded bg-emerald-100 text-emerald-900">已報到 ${checkedCnt} (${chkPct}%)</span>`;
      }
      renderWriterList();
      renderWriterSelected();
    } else {
      $('#lockedStationCodeBadge').textContent = stCode;
      $('#opCooldownSec').value = ev.debounceSeconds || 15;
      renderOpFallbackPicker(ev, stCode, paid, passedBibSet, stLogs);
      $('#quickRunnerButtons').innerHTML = paid.map((p) => {
        const done = stCode === 'CHECKIN' ? p.checkinStatus === 'checked_in' : passedBibSet.has(String(p.bibNumber).toUpperCase());
        return `
          <button data-op-scan="${p.bibNumber}" class="px-2.5 py-1 rounded-lg border text-xs font-bold mono transition ${done ? 'bg-emerald-50 border-emerald-400 text-emerald-900 hover:bg-emerald-600 hover:text-white' : 'bg-white border-amber-300 hover:bg-slate-900 hover:text-white'}">
            ${done ? '✓ ' : ''}${p.bibNumber} ${C.escapeHtml(p.name)}
          </button>`;
      }).join('') || '<span class="text-xs text-amber-800">本場尚無已配號選手</span>';
      renderOpLogs();
    }
  }

  function renderOpFallbackPicker(ev, stCode, paid, passedBibSet, stLogs) {
    const sel = $('#opManualRunnerSelect');
    const searchEl = $('#opManualPickerSearch');
    const statsEl = $('#opFallbackStats');
    if (!sel) return;
    const catMap = new Map(State.categories.map((c) => [c.catId, c.name]));
    const q = (searchEl?.value || '').trim().toUpperCase();
    const filtered = paid.filter((p) => !q || `${p.bibNumber} ${p.name} ${catMap.get(p.catId) || ''}`.toUpperCase().includes(q));
    if (statsEl) statsEl.textContent = `本活動已配號 ${paid.length} 人｜符合 ${filtered.length} 人`;

    const prevVal = sel.value;
    sel.innerHTML = filtered.map((p) => {
      const bibU = String(p.bibNumber).toUpperCase();
      const lapCnt = stCode === 'LAP' ? stLogs.filter((l) => String(l.bibNumber).toUpperCase() === bibU).length : 0;
      const done = stCode === 'CHECKIN' ? p.checkinStatus === 'checked_in' : passedBibSet.has(bibU);
      const statusTxt = stCode === 'LAP' ? `(目前已 ${lapCnt} 圈)` : (done ? '[已過本站 ✓]' : '[尚未通過]');
      return `<option value="${C.escapeHtml(p.bibNumber)}">${p.bibNumber}｜${C.escapeHtml(p.name)}｜${C.escapeHtml(catMap.get(p.catId) || '')} ${statusTxt}</option>`;
    }).join('') || '<option value="">（無符合之本活動已配號選手）</option>';
    if (filtered.some((p) => p.bibNumber === prevVal)) sel.value = prevVal;
  }

  function renderWriterList() {
    const q = ($('#writerSearch').value || '').trim().toUpperCase();
    const flt = $('#writerFilter')?.value || 'all';
    const catMap = new Map(State.categories.map((c) => [c.catId, c.name]));
    const list = State.participants.filter((p) => {
      if (p.eventId !== State.opEventId) return false;
      if (String(p.payStatus).toUpperCase() !== 'PAID') return false;
      if (flt === 'no_chip' && p.chipUid) return false;
      if (flt === 'has_chip' && !p.chipUid) return false;
      if (flt === 'unchecked' && p.checkinStatus === 'checked_in') return false;
      if (flt === 'checked' && p.checkinStatus !== 'checked_in') return false;
      if (!q) return true;
      return `${p.name} ${p.idCard} ${p.bibNumber} ${p.chipUid || ''} ${catMap.get(p.catId) || ''}`.toUpperCase().includes(q);
    });
    $('#writerSearchList').innerHTML = list.map((p) => {
      const isPicked = p.participantId === State.selectedWriterPid;
      const isChecked = p.checkinStatus === 'checked_in';
      return `
      <div class="py-2.5 px-1.5 flex items-center justify-between gap-2 ${isPicked ? 'bg-indigo-50 rounded-lg' : ''}">
        <div class="min-w-0">
          <div class="font-bold flex flex-wrap items-center gap-1">
            <span class="mono">${p.bibNumber || '未配號'}</span>
            <span>${C.escapeHtml(p.name)}</span>
            <span class="px-1 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">${C.escapeHtml(catMap.get(p.catId) || '')}</span>
          </div>
          <div class="text-[10px] text-slate-500 mono mt-0.5 flex flex-wrap items-center gap-1.5">
            <span>${p.chipUid ? `✅ UID:${p.chipUid}` : '⏳ 未寫卡'}</span>
            <span class="px-1.5 py-0.5 rounded font-sans font-bold ${isChecked ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${isChecked ? '✅ 已報到' : '⏳ 未報到'}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button data-pick-writer="${p.participantId}" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-[11px]">帶入寫卡</button>
          <button data-writer-toggle-chk="${p.participantId}" class="px-2 py-1 rounded-lg font-bold text-[11px] ${isChecked ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-600 text-white'}">${isChecked ? '取消報到' : '✅ 報到'}</button>
        </div>
      </div>`;
    }).join('') || '<p class="text-slate-400 text-center py-6">此場次無符合條件之已繳費選手</p>';
  }

  function renderWriterSelected() {
    const p = State.idxById.get(State.selectedWriterPid);
    const box = $('#writerSelectedCard');
    if (!p || p.eventId !== State.opEventId) {
      box.className = 'p-3.5 rounded-xl bg-slate-50 border border-dashed text-sm text-slate-500';
      box.textContent = '請從左側場次名單點選選手「帶入寫卡」或直接按「✅ 報到」。';
      return;
    }
    const cat = State.categories.find((c) => c.catId === p.catId);
    const isChecked = p.checkinStatus === 'checked_in';
    box.className = 'p-3.5 rounded-xl bg-emerald-50 border-2 border-emerald-400 text-sm space-y-1';
    box.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="font-black text-slate-900">${p.bibNumber || '未配號'} · ${C.escapeHtml(p.name)} <span class="text-xs font-bold text-slate-600">(${C.escapeHtml(cat?.name || '')})</span></div>
        <span class="px-2 py-0.5 rounded-full text-xs font-black ${isChecked ? 'bg-emerald-600 text-white' : 'bg-amber-200 text-amber-950'}">${isChecked ? '✅ 已完成現場報到' : '⏳ 尚未報到'}</span>
      </div>
      <div class="text-xs mono text-slate-700">NDEF 字串：<b>${C.escapeHtml(p.name)}|${C.escapeHtml(C.maskIdCard(p.idCard))}</b> ｜ UID：<b>${p.chipUid || '尚未綁定'}</b></div>`;
  }

  async function setWriterRunnerCheckin(p, checked) {
    if (!p) return toast('請先從左側名單選取一位選手', 'warn');
    if (String(p.payStatus).toUpperCase() !== 'PAID') return toast('未繳費選手禁止辦理現場報到！', 'error');
    p.checkinStatus = checked ? 'checked_in' : 'pending';
    await C.TurDB.put('participants', p);
    await enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: p.checkinStatus });
    appendWriterLog(`${checked ? '✅ [報到管制] 已標記報到' : '↩️ [報到管制] 已改為未報到'}：${p.bibNumber} ${p.name}`);
    renderOperatorStation();
    toast(`${checked ? '✅ 已完成現場報到' : '↩️ 已取消報到'}：${p.bibNumber} ${p.name}`, checked ? 'success' : 'info');
  }

  function showChipInspectResult(p, rawUid, rawPayload) {
    const card = $('#writerInspectCard');
    if (!card) return;
    card.classList.remove('hidden');
    if (!p) {
      card.className = 'p-3.5 rounded-xl bg-rose-50 border-2 border-rose-400 text-xs space-y-1';
      card.innerHTML = `<div class="font-black text-rose-800">🔴 讀取結果：查無本場次對應選手（非本場晶片）</div><div class="mono text-rose-700">UID：${C.escapeHtml(rawUid || '-')} ｜ NDEF：${C.escapeHtml(C.maskNdefPayload(rawPayload) || '空')}</div>`;
      return;
    }
    const cat = State.categories.find((c) => c.catId === p.catId);
    const logs = State.timingLogs.filter((l) => l.eventId === State.opEventId && l.bibNumber === p.bibNumber && l.isValid !== false);
    const passedTxt = logs.length ? logs.map((l) => `${l.stationCode}(${String(l.sensedTime).slice(11)})`).join(' → ') : '尚無賽道感應紀錄';
    card.className = 'p-3.5 rounded-xl bg-sky-50 border-2 border-sky-400 text-xs space-y-1';
    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-black text-sky-950 text-sm">🔍 晶片讀取檢視：${p.bibNumber || '未配號'} ${C.escapeHtml(p.name)} (${C.escapeHtml(cat?.name || '-')})</span>
        <span class="px-2 py-0.5 rounded-full font-bold ${p.checkinStatus === 'checked_in' ? 'bg-emerald-600 text-white' : 'bg-amber-200 text-amber-950'}">${p.checkinStatus === 'checked_in' ? '✅ 已報到' : '⏳ 未報到'}</span>
      </div>
      <div class="mono text-slate-700">UID：<b>${C.escapeHtml(rawUid || p.chipUid || '-')}</b> ｜ NDEF：<b>${C.escapeHtml(C.maskNdefPayload(rawPayload || `${p.name}|${p.idCard}`))}</b> ｜ 繳費：<b>${p.payStatus}</b></div>
      <div class="text-slate-600">賽道紀錄：<span class="mono">${C.escapeHtml(passedTxt)}</span></div>`;
  }

  function appendWriterLog(msg) {
    const d = document.createElement('div');
    d.textContent = `[${C.formatDateTime().slice(11)}] ${msg}`;
    $('#writerLogBox').prepend(d);
  }

  async function runChipWrite(mode, sim = false) {
    const ev = State.events.find((e) => e.eventId === State.opEventId);
    if (mode !== 'inspect' && ev && ev.status === 'finished') {
      Feedback.error();
      return toast('🔒 階段 5 結案鎖定：本活動已結案，禁止寫入或異動晶片！', 'error');
    }
    const p = State.idxById.get(State.selectedWriterPid);
    const autoChk = Boolean($('#writerAutoCheckin')?.checked);
    if (mode !== 'legacy' && mode !== 'inspect' && !p) return toast('請先從左側場次名單帶入一位選手', 'warn');
    if (mode !== 'legacy' && mode !== 'inspect' && p && (String(p.payStatus).toUpperCase() !== 'PAID' || !p.bibNumber)) {
      Feedback.error();
      appendWriterLog(`🔴 [階段 2 繳費防呆攔截] ${p.name} 尚未繳費(PAID)或未配發號碼布，禁止發卡寫入晶片！`);
      return toast('🔒 階段 2 防呆管制：未繳費或未配號選手禁止寫入晶片！', 'error');
    }
    if (!sim && !('NDEFReader' in window)) return toast('請使用 Android Chrome 或點擊下方模擬按鈕', 'warn');

    const applyPostWrite = async (target, uidVal) => {
      if (uidVal) target.chipUid = uidVal;
      if (autoChk && target.checkinStatus !== 'checked_in') {
        target.checkinStatus = 'checked_in';
        const hasChkLog = State.timingLogs.some((l) => l.eventId === State.opEventId && l.bibNumber === target.bibNumber && l.stationCode === 'CHECKIN' && l.isValid !== false);
        if (!hasChkLog && target.bibNumber) {
          const chkLog = {
            logId: `LOG-${Date.now()}-${target.bibNumber}-CHECKIN`, eventId: State.opEventId, stationCode: 'CHECKIN',
            bibNumber: target.bibNumber, idCardHash: await C.sha256Hex(target.idCard || ''),
            sensedTime: C.formatDateTime(), lapCount: 0, operator: State.currentUser?.username || 'writer',
            source: 'write_auto', isValid: true, note: '發卡寫入同步報到'
          };
          State.timingLogs.push(chkLog);
          await C.TurDB.put('timingLogs', chkLog);
          await enqueueSync('addTimingLog', chkLog, false);
        }
      }
      await C.TurDB.put('participants', target);
      rebuildIndices(State.opEventId);
      await enqueueSync('updateParticipant', { participantId: target.participantId, chipUid: target.chipUid, checkinStatus: target.checkinStatus });
      renderOperatorStation();
    };

    if (mode === 'inspect') {
      if (sim) {
        const target = (p && p.eventId === State.opEventId) ? p : State.participants.find((x) => x.eventId === State.opEventId && x.chipUid) || State.participants.find((x) => x.eventId === State.opEventId && x.payStatus === 'PAID');
        if (!target) return toast('本場次尚無可模擬讀取之選手晶片', 'warn');
        State.selectedWriterPid = target.participantId;
        C.NFC.sound.beepSuccess();
        showChipInspectResult(target, target.chipUid || 'SIM-UID-READ', `${target.name}|${target.idCard}`);
        appendWriterLog(`🔍 [模擬讀取查看] ${target.bibNumber} ${target.name}｜UID=${target.chipUid || '未綁'}｜報到=${target.checkinStatus}`);
        renderWriterSelected(); renderWriterList();
        return;
      }
      try {
        appendWriterLog('🔍 請將晶片貼近手機背面感應區進行讀取查看…');
        const tag = await C.NFC.readSingleTag((step) => appendWriterLog(step));
        const idPart = String(tag.parsed?.idNumber || '').toUpperCase();
        const m = (idPart && State.idxByIdCard.get(idPart)) || (tag.nfcUid && State.idxByUid.get(tag.nfcUid));
        if (m) { C.NFC.sound.beepSuccess(); State.selectedWriterPid = m.participantId; renderWriterSelected(); renderWriterList(); }
        else C.NFC.sound.beepError();
        showChipInspectResult(m, tag.nfcUid, tag.raw);
        appendWriterLog(`🔍 [讀取查看] UID=${tag.nfcUid || '-'} NDEF="${C.maskNdefPayload(tag.raw)}" -> ${m ? `${m.bibNumber} ${m.name}` : '非本場卡片'}`);
      } catch (err) { C.NFC.sound.beepError(); appendWriterLog(`🔴 讀取失敗：${err.message}`); toast(err.message, 'error'); }
      return;
    }

    if (mode === 'verify') {
      if (!p) return toast('請先帶入選手再進行回讀驗證', 'warn');
      try {
        appendWriterLog(`✅ [回讀驗證] 請將剛寫入的晶片貼近背面（核對 ${p.name}）…`);
        const tag = await C.NFC.readSingleTag((step) => appendWriterLog(step));
        const rId = String(tag.parsed?.idNumber || '').toUpperCase();
        if (!rId || rId !== String(p.idCard || '').toUpperCase()) {
          throw new Error(`回讀不符！卡片內容「${C.maskNdefPayload(tag.raw) || '空'}」與 ${p.name} 不一致`);
        }
        await applyPostWrite(p, tag.nfcUid || p.chipUid || 'NDEF-VERIFIED');
        C.NFC.sound.beepWriteVerified();
        showChipInspectResult(p, tag.nfcUid || p.chipUid, tag.raw);
        appendWriterLog(`🟢 回讀驗證 100% 一致！UID=${tag.nfcUid || '標準 NDEF'}`);
        toast(`✅ 回讀驗證通過！UID=${tag.nfcUid || '-'}`, 'success');
      } catch (err) { C.NFC.sound.beepError(); appendWriterLog(`🔴 回讀驗證失敗：${err.message}`); toast(err.message, 'error'); }
      return;
    }

    if (mode === 'write') {
      const payload = `${p.name}|${p.idCard}`;
      if (sim) {
        const res = await C.NFC.mockWriteChip({ name: p.name, idNumber: p.idCard });
        await applyPostWrite(p, p.chipUid || res.nfcUid);
        appendWriterLog(`✅ [模擬寫入+回讀驗證通過] NDEF="${C.maskNdefPayload(payload)}" (${payload.length}B) UID=${p.chipUid}${autoChk ? '｜已同步報到' : ''}`);
        showChipInspectResult(p, p.chipUid, payload);
        return;
      }
      try {
        await C.NFC.writeChip({ name: p.name, idNumber: p.idCard }, { onStep: (step) => appendWriterLog(step) });
        await applyPostWrite(p, p.chipUid || 'NDEF-WRITTEN');
        appendWriterLog(`✅ NDEF 寫入完成："${C.maskNdefPayload(payload)}"！請按「✅ 回讀驗證」核對資料並擷取硬體 UID`);
        toast(`✅ 寫入完成！建議點「✅ 回讀驗證」確認卡片並擷取 UID`, 'success');
      } catch (err) { C.NFC.sound.beepError(); appendWriterLog(`🔴 寫入失敗：${err.message}`); toast(err.message, 'error'); }
    } else if (mode === 'uid') {
      if (sim) {
        const newUid = `MF:${Math.random().toString(16).slice(2, 4).toUpperCase()}:AA:11`;
        await applyPostWrite(p, newUid);
        C.NFC.sound.beepWriteVerified();
        appendWriterLog(`🔗 [模擬 UID 綁定] ${p.name} -> ${p.chipUid}${autoChk ? '｜已同步報到' : ''}`);
        showChipInspectResult(p, p.chipUid, `${p.name}|${p.idCard}`);
      } else {
        try {
          appendWriterLog('🔗 請貼近唯讀晶片讀取硬體 UID…');
          const tag = await C.NFC.readSingleTag((step) => appendWriterLog(step));
          if (!tag.nfcUid) throw new Error('此晶片未回傳硬體 UID');
          await applyPostWrite(p, tag.nfcUid);
          C.NFC.sound.beepWriteVerified();
          appendWriterLog(`🔗 UID 綁定成功：${tag.nfcUid}${autoChk ? '｜已同步報到' : ''}`);
          showChipInspectResult(p, tag.nfcUid, `${p.name}|${p.idCard}`);
        } catch (err) { C.NFC.sound.beepError(); appendWriterLog(`🔴 UID 綁定失敗：${err.message}`); toast(err.message, 'error'); }
      }
    } else if (mode === 'legacy') {
      const sample = State.participants.find((x) => x.eventId === State.opEventId && String(x.payStatus).toUpperCase() === 'PAID');
      if (sim && sample) {
        C.NFC.sound.beepSuccess();
        State.selectedWriterPid = sample.participantId;
        if (autoChk) await applyPostWrite(sample, sample.chipUid);
        renderWriterSelected();
        showChipInspectResult(sample, sample.chipUid || 'LEGACY-CARD', `${sample.name}|${sample.idCard}`);
        appendWriterLog(`♻️ [模擬舊晶片共用核准] 讀到 ${sample.name}|${C.maskIdCard(sample.idCard)} -> 本場已繳費 (${sample.bibNumber})${autoChk ? '｜已同步報到' : ''}`);
      } else if (!sim) {
        try {
          appendWriterLog('♻️ 請貼近跑者既有共用晶片進行核准…');
          const tag = await C.NFC.readSingleTag((step) => appendWriterLog(step));
          const idPart = String(tag.parsed?.idNumber || '').toUpperCase();
          const m = (idPart && State.idxByIdCard.get(idPart)) || (tag.nfcUid && State.idxByUid.get(tag.nfcUid));
          if (m) {
            C.NFC.sound.beepSuccess(); State.selectedWriterPid = m.participantId;
            if (autoChk) await applyPostWrite(m, m.chipUid || tag.nfcUid);
            showChipInspectResult(m, tag.nfcUid, tag.raw);
            appendWriterLog(`♻️ 舊卡核准：${m.name} (${m.bibNumber})${autoChk ? '｜已同步報到' : ''}`);
          } else { C.NFC.sound.beepError(); showChipInspectResult(null, tag.nfcUid, tag.raw); appendWriterLog(`🔴 非本場晶片攔截：${C.maskNdefPayload(tag.raw) || tag.nfcUid}`); }
        } catch (err) { C.NFC.sound.beepError(); appendWriterLog(`🔴 舊卡讀取失敗：${err.message}`); toast(err.message, 'error'); }
      }
    }
  }

  function renderOpLogs() {
    const logs = State.timingLogs.filter((l) => l.eventId === State.opEventId && l.stationCode === State.opLockedStation).reverse().slice(0, 40);
    $('#stationLogCount').textContent = `${logs.length} 筆`;
    $('#recentLogsList').innerHTML = logs.map((l) => `
      <div class="py-2 flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div><b class="mono">${l.bibNumber}</b> ${l.lapCount ? `第${l.lapCount}圈` : ''} ${l.source === 'manual_fallback' ? '<span class="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-bold">🛠️手動補登</span>' : ''} ${l.isValid === false ? '<span class="text-rose-600 font-bold">(超時)</span>' : ''}</div>
          ${l.note && l.source === 'manual_fallback' ? `<div class="text-[10px] text-slate-500 truncate">${C.escapeHtml(l.note)}</div>` : ''}
        </div>
        <span class="mono text-slate-500 shrink-0">${String(l.sensedTime).slice(11)}</span>
      </div>`).join('') || '<p class="text-slate-400 text-center py-6">尚無本站感應紀錄</p>';
  }

  async function handleOperatorSense(raw, source = 'manual', opts = {}) {
    const t0 = performance.now();
    const token = String(raw || '').trim().toUpperCase();
    const stCode = State.opLockedStation;
    const ev = State.events.find((e) => e.eventId === State.opEventId);
    if (!token || !ev) return;

    let p = token.includes('|') ? State.idxByIdCard.get(token.split('|')[1]?.trim()) : null;
    if (!p) p = State.idxByBib.get(token) || State.idxByUid.get(token) || State.idxByIdCard.get(token);

    const banner = $('#senseResultBanner');
    // 階段 5 防呆：已結案活動禁止任何感應寫入
    if (ev.status === 'finished') {
      Feedback.error();
      banner.className = 'p-5 rounded-xl bg-rose-100 border-2 border-rose-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-rose-700">🔒 階段 5 結案鎖定攔截</div><div class="text-xl font-black text-rose-900 mt-1">本活動已結案鎖定，禁止寫入站點感應！</div>`;
      return;
    }
    // 階段 3/4 防呆：尚未鳴槍開跑前，僅開放 CHECKIN 報到，攔截賽道計時站點避免產生異常負秒數
    if (stCode !== 'CHECKIN' && !ev.raceStart) {
      Feedback.error();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🔒 階段 3 開跑前防呆攔截 (${stCode})</div><div class="text-xl font-black text-amber-950 mt-1">賽事尚未鳴槍開跑！請先由承辦人於專區 1 鳴槍後再啟動計時感應</div>`;
      return;
    }
    if (!p || String(p.payStatus).toUpperCase() !== 'PAID' || !p.bibNumber) {
      Feedback.error();
      banner.className = 'p-5 rounded-xl bg-rose-100 border-2 border-rose-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-rose-700">🔴 階段 2 攔截：非本場選手、未繳費或尚未配號</div><div class="text-2xl font-black text-rose-900 mono mt-1">${C.escapeHtml(token)}</div>`;
      $('#lastSenseLatency').textContent = `${(performance.now() - t0).toFixed(1)} ms`;
      return;
    }

    const cooldownMs = Math.max(1, Number($('#opCooldownSec').value || 15)) * 1000;
    const key = `${stCode}::${p.bibNumber}`;
    const nowMs = Date.now();
    if (stCode === 'CHECKIN' && p.checkinStatus === 'checked_in') {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 重複報到：此選手已完成檢錄</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div>`;
      return;
    }
    if (stCode === 'FINISH' && p.raceStatus === 'finished') {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 階段 4 防重覆衝線：此選手已完賽，保留首次衝線成績</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div>`;
      return;
    }
    if (nowMs - (State.lastScanMap.get(key) || 0) < cooldownMs) {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 防連點冷卻保護中</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div>`;
      return;
    }
    State.lastScanMap.set(key, nowMs);

    let senseMs = nowMs;
    if (opts.customTime) {
      const ct = String(opts.customTime).trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ct)) {
        return toast('補登時間格式須為 YYYY-MM-DD HH:mm:ss（留空則自動帶入現在時間）', 'error');
      }
      const parsedCt = C.parseDateTime(ct);
      if (!parsedCt) return toast('無效的補登時間', 'error');
      if (stCode !== 'CHECKIN' && ev.raceStart) {
        const sDt = C.parseDateTime(ev.raceStart);
        if (sDt && parsedCt.getTime() < sDt.getTime()) {
          return toast(`🔒 防呆攔截：補登時間 (${ct}) 不可早於鳴槍起跑時間 (${ev.raceStart})！`, 'error');
        }
      }
      senseMs = parsedCt.getTime();
    }
    const nowStr = C.formatDateTime(new Date(senseMs));
    let lapCount = 0, isValid = true, note = '';
    const reasonPrefix = opts.reason ? `[手動補登：${opts.reason}] ` : '';

    if (stCode === 'CHECKIN') {
      p.checkinStatus = 'checked_in';
      await C.TurDB.put('participants', p);
      await enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: 'checked_in' });
      note = reasonPrefix + '報到檢錄完成（不計入成績與圈數）';
    } else if (stCode === 'LAP') {
      const cat = State.categories.find((c) => c.catId === p.catId);
      lapCount = State.timingLogs.filter((l) => l.eventId === ev.eventId && l.bibNumber === p.bibNumber && l.stationCode === 'LAP' && l.isValid !== false).length + 1;
      const startDt = C.parseDateTime(ev.raceStart);
      if (startDt && cat && Number(cat.timeLimitHours) > 0 && ((senseMs - startDt.getTime()) / 1000) > Number(cat.timeLimitHours) * 3600) {
        isValid = false;
        note = reasonPrefix + `⚠️ 超時圈（留存紀錄但不計有效里程）`;
      } else {
        note = reasonPrefix + `第 ${lapCount} 圈有效｜累計 ${(lapCount * Number(ev.lapDistanceKm || cat?.distanceKm || 1)).toFixed(1)} km`;
      }
      if (p.raceStatus === 'dns') {
        p.raceStatus = 'on_track';
        await C.TurDB.put('participants', p);
        await enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'on_track' });
      }
    } else if (stCode === 'FINISH') {
      p.raceStatus = 'finished';
      await C.TurDB.put('participants', p);
      await enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'finished' });
      const startDt = C.parseDateTime(ev.raceStart);
      const sec = startDt ? Math.round((senseMs - startDt.getTime()) / 1000) + Number(p.penaltySeconds || 0) : null;
      note = reasonPrefix + `🏁 衝線完賽！整數秒成績 ${C.formatDuration(sec)}`;
    } else {
      if (p.raceStatus === 'dns') {
        p.raceStatus = 'on_track';
        await C.TurDB.put('participants', p);
        await enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'on_track' });
      }
      note = reasonPrefix + `通過 ${stCode} 檢查站`;
    }

    const log = {
      logId: `LOG-${nowMs}-${p.bibNumber}-${stCode}`, eventId: ev.eventId, stationCode: stCode,
      bibNumber: p.bibNumber, idCardHash: await C.sha256Hex(p.idCard), sensedTime: nowStr,
      lapCount, operator: State.currentUser.username, source, isValid, note
    };
    State.timingLogs.push(log);
    await C.TurDB.put('timingLogs', log);
    await enqueueSync('addTimingLog', log, false);

    $('#lastSenseLatency').textContent = `${(performance.now() - t0).toFixed(1)} ms`;
    if (isValid) {
      Feedback.success();
      banner.className = 'p-5 rounded-xl bg-emerald-100 border-2 border-emerald-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-emerald-800">🟢 ${source === 'manual_fallback' ? '手動補登成功' : '感應成功'} (${stCode}) · ${nowStr.slice(11)}</div><div class="text-3xl font-black text-emerald-950 mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div><div class="text-sm font-bold text-emerald-800 mt-1">${C.escapeHtml(note)}</div>`;
    } else {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 超時無效圈已留存</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div><div class="text-sm font-bold text-rose-700 mt-1">${C.escapeHtml(note)}</div>`;
    }
    renderOperatorStation();
  }

  /* --------------------------------------------------------------------------
   * Zero-Trace Login Modal & 3-Step Operator Login
   * -------------------------------------------------------------------------- */
  function openLoginModal(defaultTab = 'super_admin') {
    // 強制清空所有帳密欄位（零紀錄安全防護）
    $('#loginUser').value = '';
    $('#loginPass').value = '';
    $('#opLoginPass').value = '';
    State.pickedOpUser = null;
    $('#opPickedAccountHint').textContent = '請先點選卡片';

    const activeEvs = State.events.filter((e) => e.status !== 'finished');
    $('#opLoginEventSelect').innerHTML = activeEvs.map((e) => `<option value="${e.eventId}">${C.escapeHtml(e.nameZh)}</option>`).join('');
    renderOpStationCards();
    if (defaultTab === 'organizer') $('#loginModeOrg')?.click();
    else if (defaultTab === 'operator') $('#loginModeOp')?.click();
    else $('#loginModeSuper')?.click();
    $('#loginModal').classList.remove('hidden');
  }

  function renderOpStationCards() {
    const evId = $('#opLoginEventSelect').value;
    const evObj = State.events.find((e) => e.eventId === evId);
    const evOwner = evObj ? String(evObj.ownerUsername || '') : '';
    const stNameMap = new Map(
      State.stations.filter((s) => s.eventId === evId).map((s) => [String(s.stationCode || '').toUpperCase(), s.name])
    );
    const ops = State.users.filter((u) => {
      if (u.role !== 'operator' || !Number(u.enabled)) return false;
      if (u.allowedEventId === evId) return true;
      if (u.allowedEventId === 'ALL') return !u.parentOrganizer || u.parentOrganizer === evOwner;
      return false;
    });
    if (State.pickedOpUser && !ops.some((x) => x.username === State.pickedOpUser.username)) {
      State.pickedOpUser = null;
      $('#opPickedAccountHint').textContent = '請先點選站點';
    }
    if (!ops.length) {
      $('#opStationCardGrid').innerHTML = '<div class="col-span-full p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold text-center">本活動尚未設定晶片作業員，請承辦人登入後點入活動至「5. 站點與作業員」建立站點帳密</div>';
      return;
    }
    $('#opStationCardGrid').innerHTML = ops.map((op) => {
      const stCode = String(op.allowedStation || '').toUpperCase();
      const customStName = stCode === 'WRITER' ? '發卡寫入站' : (stNameMap.get(stCode) || '');
      return `
        <button type="button" data-pick-op="${C.escapeHtml(op.username)}" class="p-2.5 rounded-xl border-2 text-left transition ${State.pickedOpUser?.username === op.username ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-400'}">
          <div class="font-black text-xs mono text-slate-900">${C.escapeHtml(op.allowedStation)}</div>
          ${customStName ? `<div class="text-[11px] font-bold text-indigo-700 truncate">${C.escapeHtml(customStName)}</div>` : ''}
          <div class="text-[11px] text-slate-500 truncate">${C.escapeHtml(op.displayName)}</div>
        </button>`;
    }).join('');
    $$('[data-pick-op]').forEach((b) => {
      b.onclick = () => {
        State.pickedOpUser = ops.find((x) => x.username === b.dataset.pickOp) || null;
        if (State.pickedOpUser) {
          const stCode = String(State.pickedOpUser.allowedStation || '').toUpperCase();
          const stNm = stCode === 'WRITER' ? '發卡寫入站' : (stNameMap.get(stCode) || '');
          $('#opPickedAccountHint').textContent = `已選：${State.pickedOpUser.username} (${State.pickedOpUser.allowedStation}${stNm ? ' ' + stNm : ''})`;
        }
        renderOpStationCards();
      };
    });
  }

  function applySessionLogin(user, opEventId = '') {
    State.currentUser = user;
    sessionStorage.setItem('TUR_V3_SESSION', JSON.stringify({ username: user.username, opEventId }));
    $('#loginModal').classList.add('hidden');
    if (user.role === 'operator') {
      State.opEventId = opEventId || user.allowedEventId;
      State.opLockedStation = user.allowedStation;
      rebuildIndices(State.opEventId);
      switchView('operator-station');
    } else if (user.role === 'organizer' || user.role === 'super_admin') {
      State.z1ViewMode = 'lobby';
      State.z1LobbyOwnerFilter = 'all';
      switchView('zone1');
    }
    toast(`✅ 歡迎登入：${user.displayName}`, 'success');
  }

  function logoutZeroTrace() {
    if (C.NFC?.isScanning) C.NFC.stopScanning();
    if (C.NFC?.cancelActiveOperation) C.NFC.cancelActiveOperation();
    sessionStorage.removeItem('TUR_V3_SESSION');
    State.currentUser = { username: 'public', displayName: '民眾 / 跑者', role: 'public', allowedStation: '' };
    State.opEventId = '';
    State.opLockedStation = '';
    State.nfcScanning = false;
    switchView('portal-home');
    toast('🚪 已安全登出並返回首頁', 'info');
  }

  /* --------------------------------------------------------------------------
   * Event Listeners Binding
   * -------------------------------------------------------------------------- */
  function bindEvents() {
    // 全站字體大小調整器
    const syncFontBtns = (mode) => {
      $$('[data-font-scale]').forEach((b) => {
        const act = b.dataset.fontScale === mode;
        b.className = `px-2 py-1 rounded text-[11px] font-bold transition ${act ? 'bg-amber-400 text-slate-950 font-black' : 'text-slate-300 hover:bg-slate-700'}`;
      });
    };
    syncFontBtns(C.applyFontScale(C.getSavedFontScale()));
    $$('[data-font-scale]').forEach((b) => {
      b.onclick = () => {
        const next = C.applyFontScale(b.dataset.fontScale);
        syncFontBtns(next);
        const label = (C.FONT_SCALE_MODES.find((m) => m.id === next) || {}).label || next;
        toast(`🔤 已切換畫面字體為「${label}」`, 'info');
      };
    });

    $('#btnOpenLogin').onclick = () => openLoginModal('super_admin');
    $('#btnCloseLogin').onclick = () => $('#loginModal').classList.add('hidden');
    $('#btnLogout').onclick = logoutZeroTrace;
    if ($('#btnSyncModeOffline')) $('#btnSyncModeOffline').onclick = () => setSyncMode('offline');
    if ($('#btnSyncModeCloud')) $('#btnSyncModeCloud').onclick = () => setSyncMode('cloud');
    if ($('#btnSyncBidirectional')) $('#btnSyncBidirectional').onclick = () => syncBidirectional(false);
    if ($('#btnSyncUpload')) $('#btnSyncUpload').onclick = () => syncPushNow(false);
    if ($('#btnSyncPull')) $('#btnSyncPull').onclick = () => syncBidirectional(false);

    if ($('#btnLogoHome')) $('#btnLogoHome').onclick = goPortalHome;
    if ($('#btnBackToPortalHome')) $('#btnBackToPortalHome').onclick = goPortalHome;

    if ($('#btnGoHostOpsFromHome')) $('#btnGoHostOpsFromHome').onclick = () => switchView('host-ops');
    if ($('#btnGoScoresFromHome')) $('#btnGoScoresFromHome').onclick = () => switchView('scores');

    // 三、晶片計時頁籤內建三步驟登錄表單
    if ($('#opInlineEventSelect')) $('#opInlineEventSelect').onchange = renderOpInlineStationGrid;
    if ($('#opInlineLoginForm')) {
      $('#opInlineLoginForm').onsubmit = (e) => {
        e.preventDefault();
        const selEvId = $('#opInlineEventSelect')?.value || '';
        if (!selEvId) return toast('請先選擇作業活動', 'warn');
        const typedUn = ($('#opInlineUser')?.value || '').trim();
        const pw = ($('#opInlinePass')?.value || '').trim();
        const targetOp = State.users.find((x) => x.role === 'operator' && Number(x.enabled) && x.username === (typedUn || State.pickedOpUser?.username));
        if (!targetOp) return toast('請選擇本活動作業組別或輸入正確作業員帳號', 'error');
        if (targetOp.allowedEventId !== 'ALL' && targetOp.allowedEventId !== selEvId) {
          return toast('🔒 此作業員帳號不屬於目前選擇的活動', 'error');
        }
        if (String(targetOp.passwordHash) !== pw) return toast('密碼錯誤，請重新輸入', 'error');
        $('#opInlinePass').value = '';
        applySessionLogin(targetOp, selEvId);
      };
    }

    const setLoginTab = (mode) => {
      const isSuper = mode === 'super_admin';
      const isOrg = mode === 'organizer';
      const isOp = mode === 'operator';
      if (isSuper || isOrg) State.loginAdminTab = mode;
      $('#adminLoginForm').classList.toggle('hidden', isOp);
      $('#opLoginForm').classList.toggle('hidden', !isOp);
      $('#loginModeSuper').className = `py-2 px-2 rounded-xl font-black transition ${isSuper ? 'bg-slate-900 text-amber-300 shadow' : 'bg-slate-100 text-slate-700 font-bold hover:bg-slate-200'}`;
      $('#loginModeOrg').className = `py-2 px-2 rounded-xl font-black transition ${isOrg ? 'bg-sky-600 text-white shadow' : 'bg-slate-100 text-slate-700 font-bold hover:bg-slate-200'}`;
      $('#loginModeOp').className = `py-2 px-2 rounded-xl font-black transition ${isOp ? 'bg-emerald-600 text-white shadow' : 'bg-slate-100 text-slate-700 font-bold hover:bg-slate-200'}`;
      const hint = $('#adminLoginRoleHint');
      const submitBtn = $('#btnAdminLoginSubmit');
      if (hint && submitBtn) {
        if (isSuper) {
          hint.className = 'p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 font-bold';
          hint.textContent = '🛡️ 最高權責管理員：檢視全平台所有活動細部，並於專區管制管理員與承辦人帳密';
          submitBtn.className = 'w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black text-sm';
          submitBtn.textContent = '🛡️ 登入最高管理員後台';
        } else if (isOrg) {
          hint.className = 'p-2.5 rounded-xl bg-sky-50 border border-sky-300 text-sky-950 font-bold';
          hint.textContent = '👤 活動承辦人：僅顯示本人名下活動，點入自行配置管制點站名與晶片作業員帳密';
          submitBtn.className = 'w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-black text-sm';
          submitBtn.textContent = '👤 登入承辦人活動專區';
        }
      }
    };
    $('#loginModeSuper').onclick = () => setLoginTab('super_admin');
    $('#loginModeOrg').onclick = () => setLoginTab('organizer');
    $('#loginModeOp').onclick = () => setLoginTab('operator');
    setLoginTab('super_admin');
    $('#opLoginEventSelect').onchange = renderOpStationCards;

    $('#adminLoginForm').onsubmit = (e) => {
      e.preventDefault();
      const un = $('#loginUser').value.trim();
      const pw = $('#loginPass').value.trim();
      const u = State.users.find((x) => x.username === un && String(x.passwordHash) === pw && Number(x.enabled) && (x.role === 'super_admin' || x.role === 'organizer'));
      if (!u) return toast('帳號或密碼錯誤，或帳號已停用', 'error');
      if (u.role !== State.loginAdminTab) {
        const expectedLabel = u.role === 'super_admin' ? '🛡️ 最高管理員' : '👤 活動承辦人';
        setLoginTab(u.role);
        return toast(`此帳號身分為「${expectedLabel}」，已為您自動切至對應分頁，請再按一次登入確認！`, 'warn');
      }
      applySessionLogin(u);
    };

    $('#opLoginForm').onsubmit = (e) => {
      e.preventDefault();
      if (!State.pickedOpUser) return toast('請先於步驟 2 點選執勤站點卡片', 'warn');
      const selEvId = $('#opLoginEventSelect').value;
      if (State.pickedOpUser.allowedEventId !== 'ALL' && State.pickedOpUser.allowedEventId !== selEvId) {
        return toast('🔒 此站點帳號不屬於目前選擇的活動，請重新點選', 'error');
      }
      const pw = $('#opLoginPass').value.trim();
      if (String(State.pickedOpUser.passwordHash) !== pw) return toast('站點密碼錯誤', 'error');
      applySessionLogin(State.pickedOpUser, selEvId);
    };

    // Public Navigation & Form
    $('#btnGoMultiFromHome').onclick = () => switchView('public-multi');
    $('#btnBackFromMulti').onclick = () => switchView('public-home');
    $('#mNationality').onchange = () => { $('#mNationalityCustom').classList.toggle('hidden', $('#mNationality').value !== 'OTHER'); renderMultiSummaryAndValidate(); };
    $('#mIdCard').addEventListener('input', () => {
      const id = $('#mIdCard').value.trim().toUpperCase();
      if ($('#mNationality').value === 'TWN' && !$('#mGender').value) {
        const g = C.inferGenderFromId(id); if (g) $('#mGender').value = g;
      }
      renderMultiSummaryAndValidate();
    });
    $('#multiRegForm').addEventListener('input', renderMultiSummaryAndValidate);
    $('#multiRegForm').addEventListener('change', renderMultiSummaryAndValidate);
    $('#btnSubmitMulti').onclick = () => commitMultiBundle();
    $('#btnGoLookupFromHome').onclick = () => switchView('public-lookup');
    $('#btnBackToHome').onclick = () => switchView('public-home');
    $('#btnModeSolo').onclick = () => setRegMode('solo');
    $('#btnModeGroup').onclick = () => setRegMode('group');
    $$('input[name="payMethod"]').forEach((r) => { r.onchange = () => { updatePayMethodUI(); validateRegForm(); }; });
    $('#regNationality').onchange = () => { $('#regNationalityCustom').classList.toggle('hidden', $('#regNationality').value !== 'OTHER'); validateRegForm(); };
    $('#regIdCard').addEventListener('input', () => {
      const id = $('#regIdCard').value.trim().toUpperCase();
      if ($('#regNationality').value === 'TWN' && !$('#regGender').value) {
        const g = C.inferGenderFromId(id); if (g) $('#regGender').value = g;
      }
      validateRegForm();
    });
    $('#regForm').addEventListener('input', validateRegForm);
    $('#regForm').addEventListener('change', validateRegForm);

    $('#btnAddToGroup').onclick = () => {
      const res = validateRegForm();
      if (!res.isValid) return toast('請先修正紅框錯誤', 'error');
      if (State.groupCart.length >= 50) return toast('團體報名上限 50 人', 'error');
      const isLeader = State.groupCart.length === 0;
      res.runner.groupRole = isLeader ? 'leader' : 'member';
      if (!isLeader && State.groupCart[0]?.email) res.runner.email = State.groupCart[0].email;
      State.groupCart.push(res.runner);
      renderGroupCart();
      $('#regName').value = ''; $('#regIdCard').value = ''; $('#regPhone').value = '';
      validateRegForm();
      toast(isLeader
        ? `👑 已加入團長「${res.runner.name}」（第 1 位），請繼續填寫組員資料`
        : `👥 已加入組員「${res.runner.name}」（目前共 ${State.groupCart.length}/50 人）`, 'success');
    };
    $('#groupCartList').onclick = (e) => {
      if (e.target.dataset.rmCart !== undefined) { State.groupCart.splice(Number(e.target.dataset.rmCart), 1); renderGroupCart(); validateRegForm(); }
    };
    $('#regForm').onsubmit = async (e) => {
      e.preventDefault();
      if (State.regMode === 'group') {
        $('#btnAddToGroup').click();
        return;
      }
      const res = validateRegForm();
      if (!res.isValid) return toast('尚有必填欄位未填寫或格式有誤，請檢查紅框提示', 'error');
      await commitRunners([res.runner]);
      $('#regName').value = ''; $('#regIdCard').value = ''; $('#regConsent').checked = false;
      validateRegForm();
    };
    $('#btnSubmitGroup').onclick = async () => {
      if (State.groupCart.length < 2) return toast('團體報名至少須 2 位成員（第 1 位團長 ＋ 至少 1 位組員），單人請改用個人報名', 'warn');
      const payMethod = getSelectedPayMethod();
      const uLast5 = String($('#groupUnifiedLast5')?.value || '').trim();
      if (payMethod === 'MANUAL_ATM' && uLast5 && !/^\d{5}$/.test(uLast5)) {
        return toast('整團統一匯款末五碼限 5 位純數字（亦可留空，匯款後由團長登入補填）', 'error');
      }
      await commitRunners([...State.groupCart]);
      State.groupCart = [];
      if ($('#groupUnifiedLast5')) $('#groupUnifiedLast5').value = '';
      renderGroupCart();
      validateRegForm();
    };

    // 雙因子反向查改 (/lookup) — 支援多場聯合報名＋團長整團統一管理（組員唯讀不可修改）＋已繳費嚴格鎖定費用項目
    const renderLookupEditor = (allMatches, activePid, authIdCard = '') => {
      const p = allMatches.find((x) => x.participantId === activePid) || allMatches[0];
      if (!p) return;
      const verifiedId = String(authIdCard || p.idCard || '').trim().toUpperCase();
      State.lookupSession = { pid: p.participantId, authIdCard: verifiedId, exp: Date.now() + 45 * 60 * 1000 };
      const ev = State.events.find((e) => e.eventId === p.eventId);
      const cats = State.categories.filter((c) => c.eventId === p.eventId);
      const schema = C.parseJsonSafe(ev?.formSchemaJson, C.defaultFormSchema());
      const curAddons = C.parseJsonSafe(p.addonsDetail, []);
      const addonDefs = (Array.isArray(schema.addons) ? schema.addons : []).filter((a) => a && (a.enabled !== false || (Array.isArray(curAddons) && curAddons.includes(a.name))));
      const cfDefs = Array.isArray(schema.customFields) ? schema.customFields : [];
      const curCf = C.parseJsonSafe(p.customFieldsJson, {});
      const paySt = String(p.payStatus || 'UNPAID').toUpperCase();
      const isPaid = paySt === 'PAID';
      const isCancelled = paySt === 'CANCELLED';
      const isEventClosed = String(ev?.status || '').toLowerCase() === 'closed';
      const isClosedLock = isCancelled || String(ev?.status || '').toLowerCase() === 'finished' || p.raceStatus === 'finished';

      // 團體報名團長／組員權限判定：僅團長可修改整團資料與統一匯款，組員僅可唯讀檢視！
      const hasGroup = Boolean(String(p.groupCode || '').trim());
      const groupMembers = hasGroup ? C.getGroupMembers(State.participants, p.groupCode, p.eventId) : [];
      const groupLeader = hasGroup ? C.getGroupLeader(State.participants, p.groupCode, p.eventId) : null;
      const isGroupLeaderLogin = Boolean(hasGroup && groupLeader && String(groupLeader.idCard || '').toUpperCase() === verifiedId);
      const isGroupMemberReadOnly = Boolean(hasGroup && !isGroupLeaderLogin);
      const isEditingOtherMember = Boolean(isGroupLeaderLogin && groupLeader && p.participantId !== groupLeader.participantId);
      const groupUnpaid = groupMembers.filter((m) => ['UNPAID', 'PENDING_PAY'].includes(String(m.payStatus || '').toUpperCase()));
      const groupGrandTotal = groupMembers.reduce((s, m) => s + Number(m.totalAmount || 0), 0);

      const editLocked = isClosedLock || isGroupMemberReadOnly;
      const feeLocked = isPaid || isClosedLock || isEventClosed || isGroupMemberReadOnly;
      const evPayMode = C.getEventPaymentMode(ev);
      const isPayuniEv = evPayMode === 'ONLINE_PAYUNi';

      // 若本筆屬多場合併單 (TURM-...)，整理同合併單之所有場次
      const bundleCode = C.isBundleOrderCode(p.merTradeNo) ? String(p.merTradeNo).toUpperCase() : '';
      const bundleSiblings = bundleCode
        ? allMatches.filter((x) => String(x.merTradeNo || '').toUpperCase() === bundleCode)
        : [];
      const bundleUnpaid = bundleSiblings.filter((x) => {
        const s = String(x.payStatus || '').toUpperCase();
        return s !== 'PAID' && s !== 'CANCELLED';
      });
      const bundleGrandTotal = bundleSiblings.reduce((s, x) => s + Number(x.totalAmount || 0), 0);

      // 自己名下報名場次（不含其他組員）
      const ownMatches = allMatches.filter((m) => String(m.idCard || '').toUpperCase() === verifiedId);

      $('#lookupTimerBadge').classList.remove('hidden');
      $('#lookupEditBox').classList.remove('hidden');
      $('#lookupEditBox').innerHTML = `
        ${ownMatches.length > 1 ? `
          <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <div class="font-black text-slate-800">📋 您名下共有 ${ownMatches.length} 場報名紀錄（點選切換查看或修改）：</div>
            <div class="flex flex-wrap gap-1.5">
              ${ownMatches.map((m) => {
                const mev = State.events.find((e) => e.eventId === m.eventId);
                const mst = String(m.payStatus || 'UNPAID').toUpperCase();
                const act = m.eventId === p.eventId && (m.participantId === p.participantId || (m.groupCode && m.groupCode === p.groupCode));
                return `<button type="button" data-lk-switch="${m.participantId}" class="px-3 py-1.5 rounded-lg border text-left transition ${act ? 'bg-slate-900 border-slate-900 text-white font-black' : 'bg-white border-slate-300 text-slate-700 hover:border-amber-400 font-bold'}">
                  ${C.escapeHtml(mev?.nameZh || m.eventId)} <span class="mono opacity-80">(${mst}${m.bibNumber ? `・${m.bibNumber}` : ''})</span>
                </button>`;
              }).join('')}
            </div>
          </div>` : ''}

        ${isGroupLeaderLogin ? `
          <div class="p-3.5 rounded-xl bg-amber-50 border-2 border-amber-400 space-y-2.5 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 pb-2">
              <div>
                <div class="font-black text-sm text-amber-950">👑 團長管理：${C.escapeHtml(p.groupName || '團報')} <span class="mono">(${C.escapeHtml(p.groupCode)})</span></div>
                <div class="text-[11px] text-amber-900 mt-0.5">共 <b>${groupMembers.length}</b> 人 ｜ 總額 <b class="mono text-rose-700">NT$ ${groupGrandTotal.toLocaleString()}</b></div>
              </div>
              <span class="px-2.5 py-1 rounded-full font-black ${groupUnpaid.length ? 'bg-rose-100 text-rose-800' : 'bg-emerald-600 text-white'}">${groupUnpaid.length ? `待對帳 (${groupUnpaid.length}/${groupMembers.length})` : '✅ 全團已繳'}</span>
            </div>
            ${groupUnpaid.length >= 1 && !isPayuniEv && !isEventClosed && !isClosedLock ? `
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-bold text-amber-950">🏦 整團末 5 碼：</span>
                <input id="lkGroupLast5" type="text" maxlength="5" value="${C.escapeHtml(groupLeader?.remittanceLast5 || '')}" placeholder="5 碼數字" class="px-3 py-1.5 border border-amber-400 rounded-lg mono bg-white w-40" />
                <button type="button" id="btnSaveGroupLast5" class="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-black shadow">💾 套用全團</button>
              </div>` : ''}
            <div class="flex flex-wrap gap-1.5">
              ${groupMembers.map((m, idx) => {
                const isLdr = groupLeader && m.participantId === groupLeader.participantId;
                const active = m.participantId === p.participantId;
                return `<button type="button" data-lk-switch="${m.participantId}" class="px-2.5 py-1.5 rounded-lg border transition ${active ? 'bg-slate-900 border-slate-900 text-white font-black' : 'bg-white border-amber-300 text-slate-800 hover:border-amber-500 font-bold'}">
                  ${isLdr ? '👑' : `#${idx}`} ${C.escapeHtml(m.name)} <span class="mono opacity-80">(${m.bibNumber || m.payStatus})</span>
                </button>`;
              }).join('')}
            </div>
          </div>` : ''}

        ${isGroupMemberReadOnly ? `
          <div class="p-3.5 rounded-xl bg-rose-50 border-2 border-rose-400 text-xs text-rose-950 space-y-1">
            <div class="font-black text-sm">🔒 組員唯讀（不可修改）</div>
            <div>如需異動資料或補填末 5 碼，請洽團長「<b>${C.escapeHtml(groupLeader?.name || '團長')}</b>」登入修改。</div>
          </div>` : ''}

        ${bundleSiblings.length >= 2 ? `
          <div class="p-3.5 rounded-xl bg-emerald-50 border-2 border-emerald-400 space-y-2 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="font-black text-emerald-950">📦 合併單 <span class="mono">${bundleCode}</span>（${bundleSiblings.length} 場・NT$ ${bundleGrandTotal.toLocaleString()}）</div>
              <span class="px-2 py-0.5 rounded-full font-bold ${bundleUnpaid.length ? 'bg-amber-200 text-amber-950' : 'bg-emerald-600 text-white'}">${bundleUnpaid.length ? `待對帳 ${bundleUnpaid.length} 場` : '✅ 已全數入帳'}</span>
            </div>
            ${bundleUnpaid.length >= 1 && !isPayuniEv ? `
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <input id="lkBundleLast5" type="text" maxlength="5" value="${C.escapeHtml(p.remittanceLast5 || '')}" placeholder="5 碼末五碼" class="px-3 py-1.5 border border-emerald-400 rounded-lg mono bg-white w-40" />
                <button type="button" id="btnSaveBundleLast5" class="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-black">💾 套用全單</button>
              </div>` : ''}
          </div>` : ''}

        ${!isGroupMemberReadOnly ? `
          <div class="p-3 rounded-xl text-xs font-bold ${isClosedLock ? 'bg-slate-200 border border-slate-400 text-slate-800' : (isPaid ? 'bg-amber-50 border-2 border-amber-400 text-amber-950' : 'bg-sky-50 border-2 border-sky-300 text-sky-950')}">
            ${isClosedLock
              ? `🔒 已${isCancelled ? '取消' : (ev?.status === 'finished' ? '結案鎖定' : '完賽')}，僅供查閱。`
              : (isPaid
                ? `🔒 已繳費：費用項目已鎖定，聯絡資料仍可修改。`
                : `✏️ 未繳費：可修改組別、加購與聯絡資料。`)}
          </div>` : ''}

        <!-- 區塊 1：費用項目 -->
        <div class="p-3.5 rounded-xl border ${feeLocked ? 'bg-slate-100/90 border-slate-300' : 'bg-amber-50/40 border-amber-200'} space-y-2.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-black text-slate-900">💰 費用項目（${C.escapeHtml(ev?.nameZh || p.eventId)}） ${feeLocked ? '<span class="ml-1 px-2 py-0.5 rounded-full bg-amber-200 text-amber-950 text-[10px]">🔒 已鎖定</span>' : '<span class="ml-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px]">✏️ 可修改</span>'}</span>
            <span class="mono font-black text-base text-amber-700" id="lkTotalDisplay">${hasGroup ? `小計 NT$ ${Number(p.totalAmount || 0).toLocaleString()}（全團 NT$ ${groupGrandTotal.toLocaleString()}）` : `NT$ ${Number(p.totalAmount || 0).toLocaleString()}`}</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div><label class="font-bold">序號 / 號碼布 / 狀態</label><input disabled value="${p.participantId}｜${p.bibNumber || '待配號'}｜${paySt}" class="w-full px-2.5 py-2 border rounded-lg bg-slate-200/70 mono mt-0.5" /></div>
            <div><label class="font-bold">報名組別 ${feeLocked ? '🔒' : ''}</label>
              <select id="lkCat" ${feeLocked ? 'disabled' : ''} class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${feeLocked ? 'bg-slate-200/70 cursor-not-allowed' : 'bg-white'}">
                ${cats.map((c) => {
                  const usedC = State.participants.filter((x) => x.eventId === p.eventId && x.catId === c.catId && x.participantId !== p.participantId && String(x.payStatus).toUpperCase() !== 'CANCELLED').length;
                  const cFull = Number(c.quota) > 0 && usedC >= Number(c.quota);
                  const pr = C.getEffectiveCategoryPrice(ev, c);
                  const pTxt = pr.isEarlyBird ? `🐤早鳥 NT$${pr.fee} / 原$${pr.regularFee}` : `NT$${pr.fee}`;
                  return `<option value="${c.catId}" data-fee="${pr.fee}" ${c.catId === p.catId ? 'selected' : ''}>${C.escapeHtml(c.name)} (${pTxt}${cFull && c.catId !== p.catId ? '・已額滿' : ''})</option>`;
                }).join('')}
              </select>
            </div>
            <div><label class="font-bold">${isPayuniEv ? '金流單號 / 付款別 🔒' : (hasGroup ? '整團統一匯款末五碼 🔒' : `匯款末五碼 ${feeLocked ? '🔒' : ''}`)}</label>
              ${isPayuniEv
                ? `<input id="lkLast5" disabled value="${C.escapeHtml(p.merTradeNo || p.paymentType || 'PAYUNi 線上金流')}" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 bg-slate-200/70 cursor-not-allowed" />`
                : (hasGroup
                  ? `<input id="lkLast5" disabled value="${C.escapeHtml(p.remittanceLast5 || '尚未填報（由團長統一填寫）')}" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 bg-slate-200/70 cursor-not-allowed" />`
                  : `<input id="lkLast5" ${feeLocked ? 'disabled' : ''} value="${C.escapeHtml(p.remittanceLast5 || '')}" maxlength="5" placeholder="5 碼純數字" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 ${feeLocked ? 'bg-slate-200/70 cursor-not-allowed' : 'bg-white'}" />`)}
            </div>
          </div>
          ${addonDefs.length ? `
            <div>
              <label class="font-bold block mb-1">加購服務 ${feeLocked ? '🔒（已鎖定）' : '（勾選即重算應繳金額）'}</label>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                ${addonDefs.map((a) => {
                  const chk = Array.isArray(curAddons) && curAddons.includes(a.name);
                  return `
                    <label class="flex items-center gap-2 p-2 rounded-lg border ${feeLocked ? 'bg-slate-200/60 opacity-75 cursor-not-allowed' : 'bg-white cursor-pointer hover:border-amber-400'}">
                      <input type="checkbox" class="lk-addon" data-name="${C.escapeHtml(a.name)}" data-price="${a.price}" ${chk ? 'checked' : ''} ${feeLocked ? 'disabled' : ''} />
                      <span>${C.escapeHtml(a.name)} <b>+$${a.price}</b></span>
                    </label>`;
                }).join('')}
              </div>
            </div>` : ''}
        </div>

        <!-- 區塊 2：聯絡資料 -->
        <div class="p-3.5 rounded-xl border bg-white space-y-2.5 text-xs">
          <div class="font-black text-slate-900">✏️ 聯絡資料（${C.escapeHtml(p.name)}）</div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div><label class="font-bold">手機</label><input id="lkPhone" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(p.phone || '')}" maxlength="10" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>
            <div><label class="font-bold">Email ${isEditingOtherMember ? '🔒' : ''}</label><input id="lkEmail" ${editLocked || isEditingOtherMember ? 'disabled' : ''} type="email" value="${C.escapeHtml(p.email || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${editLocked || isEditingOtherMember ? 'bg-slate-100' : ''}" /></div>
            <div><label class="font-bold">住址</label><input id="lkCity" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(p.city || '')}" autocomplete="off" class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>
            <div><label class="font-bold">緊急聯絡人</label><input id="lkEmergName" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(p.emergencyName || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>
            <div><label class="font-bold">緊急聯絡電話</label><input id="lkEmergPhone" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(p.emergencyPhone || '')}" maxlength="10" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>
            <div><label class="font-bold">飲食</label>
              <select id="lkDiet" ${editLocked ? 'disabled' : ''} class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}">
                <option value="葷" ${p.diet === '葷' ? 'selected' : ''}>葷食</option>
                <option value="素" ${p.diet === '素' ? 'selected' : ''}>素食</option>
              </select>
            </div>
            <div class="sm:col-span-3"><label class="font-bold">備註</label><input id="lkRemark" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(p.remark || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>
          </div>
          ${cfDefs.length ? `
            <div class="pt-2 border-t space-y-2">
              <div class="font-bold text-indigo-900">📝 其他欄位</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                ${cfDefs.map((f) => {
                  const v = curCf[f.key];
                  const strV = Array.isArray(v) ? v.join(', ') : String(v ?? '');
                  if (f.type === 'select') {
                    return `<div><label class="font-bold">${C.escapeHtml(f.label)}</label><select data-lk-cf="${C.escapeHtml(f.key)}" data-lk-cftype="select" ${editLocked ? 'disabled' : ''} class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}"><option value="">請選擇</option>${(f.options || []).map((o) => `<option value="${C.escapeHtml(o)}" ${strV === o ? 'selected' : ''}>${C.escapeHtml(o)}</option>`).join('')}</select></div>`;
                  }
                  return `<div><label class="font-bold">${C.escapeHtml(f.label)}</label><input data-lk-cf="${C.escapeHtml(f.key)}" data-lk-cftype="${f.type}" ${editLocked ? 'disabled' : ''} value="${C.escapeHtml(strV)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 ${editLocked ? 'bg-slate-100' : ''}" /></div>`;
                }).join('')}
              </div>
            </div>` : ''}
        </div>

        ${editLocked ? '' : `<button id="btnSaveLookup" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black shadow">💾 儲存修改</button>`}`;

      $$('[data-lk-switch]').forEach((b) => {
        b.onclick = () => renderLookupEditor(allMatches, b.dataset.lkSwitch, verifiedId);
      });

      const grpLast5Btn = document.getElementById('btnSaveGroupLast5');
      if (grpLast5Btn) {
        grpLast5Btn.onclick = async () => {
          const inp = document.getElementById('lkGroupLast5');
          const l5 = String(inp?.value || '').trim();
          if (!/^\d{5}$/.test(l5)) return toast('整團統一匯款末五碼限 5 位純數字', 'error');
          for (const item of groupUnpaid) {
            item.remittanceLast5 = l5;
            await C.TurDB.put('participants', item);
          }
          await enqueueSync('updateGroupLast5', { idCard: verifiedId, eventId: p.eventId, groupCode: p.groupCode, remittanceLast5: l5 });
          renderLookupEditor(allMatches, p.participantId, verifiedId);
          toast(`✅ 已由團長一次更新整團 ${p.groupCode}（共 ${groupUnpaid.length} 人）之統一匯款末五碼（${l5}）！`, 'success');
        };
      }

      const bundleBtn = document.getElementById('btnSaveBundleLast5');
      if (bundleBtn) {
        bundleBtn.onclick = async () => {
          const inp = document.getElementById('lkBundleLast5');
          const l5 = String(inp?.value || '').trim();
          if (!/^\d{5}$/.test(l5)) return toast('匯款末五碼限 5 位純數字', 'error');
          for (const item of bundleUnpaid) {
            item.remittanceLast5 = l5;
            await C.TurDB.put('participants', item);
          }
          await enqueueSync('updateBundleLast5', { idCard: verifiedId, bundleCode, remittanceLast5: l5 });
          renderLookupEditor(allMatches, p.participantId, verifiedId);
          toast(`✅ 已一次更新合併單 ${bundleCode} 全部 ${bundleUnpaid.length} 場之末五碼（${l5}）！`, 'success');
        };
      }

      const recalcLookupTotal = () => {
        if (feeLocked) return Number(p.totalAmount || 0);
        const selCatId = document.getElementById('lkCat').value;
        const nc = cats.find((c) => c.catId === selCatId);
        const curAddonsSorted = [...(Array.isArray(curAddons) ? curAddons : [])].sort().join('|');
        const nextAddonsSorted = $$('.lk-addon:checked').map((cb) => cb.dataset.name).sort().join('|');
        // 選項 A：若未更換組別且未改加購，保留原報名鎖定之早鳥價！若更換組別則依修改當下時間重算
        if (selCatId === p.catId && curAddonsSorted === nextAddonsSorted) {
          document.getElementById('lkTotalDisplay').textContent = hasGroup
            ? `本員小計：NT$ ${Number(p.totalAmount || 0).toLocaleString()}（整團 NT$ ${groupGrandTotal.toLocaleString()}）`
            : `本場應繳：NT$ ${Number(p.totalAmount || 0).toLocaleString()}`;
          return Number(p.totalAmount || 0);
        }
        const addonSum = $$('.lk-addon:checked').reduce((s, cb) => s + Number(cb.dataset.price || 0), 0);
        const pr = C.getEffectiveCategoryPrice(ev, nc);
        const total = pr.fee + addonSum;
        document.getElementById('lkTotalDisplay').textContent = hasGroup
          ? `本員小計：NT$ ${total.toLocaleString()}${pr.isEarlyBird ? ' (🐤 早鳥價)' : ''}`
          : `本場應繳：NT$ ${total.toLocaleString()}${pr.isEarlyBird ? ' (🐤 早鳥價)' : ''}`;
        return total;
      };
      if (!feeLocked) {
        document.getElementById('lkCat').onchange = recalcLookupTotal;
        $$('.lk-addon').forEach((cb) => { cb.onchange = recalcLookupTotal; });
      }

      const saveBtn = document.getElementById('btnSaveLookup');
      if (saveBtn) {
        saveBtn.onclick = async () => {
          if (isGroupMemberReadOnly) return toast('團體報名僅限團長登入修改資料', 'error');
          if (!State.lookupSession || Date.now() > State.lookupSession.exp) return toast('查改已逾 45 分鐘效期，請重新驗證', 'error');
          const phone = document.getElementById('lkPhone').value.trim();
          const email = isEditingOtherMember ? (groupLeader?.email || p.email) : document.getElementById('lkEmail').value.trim();
          const emergName = document.getElementById('lkEmergName').value.trim();
          const emergPhone = document.getElementById('lkEmergPhone').value.trim();
          if (!/^09\d{8}$/.test(phone)) return toast('手機號碼須為 09 開頭 10 碼', 'error');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return toast('Email 格式錯誤', 'error');
          if (emergName && emergName === p.name) return toast('緊急聯絡人不可與本人同名', 'error');
          if (emergPhone && emergPhone === phone) return toast('緊急聯絡電話不可與本人手機相同', 'error');

          const patch = {
            phone,
            email,
            city: document.getElementById('lkCity').value.trim(),
            emergencyName: emergName,
            emergencyPhone: emergPhone,
            diet: document.getElementById('lkDiet').value,
            remark: document.getElementById('lkRemark').value.trim()
          };
          if (cfDefs.length) {
            const nextCf = { ...curCf };
            $$('[data-lk-cf]').forEach((inp) => {
              const k = inp.dataset.lkCf;
              const t = inp.dataset.lkCftype;
              nextCf[k] = t === 'checkbox'
                ? inp.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
                : inp.value.trim();
            });
            patch.customFieldsJson = JSON.stringify(nextCf);
          }

          if (!feeLocked) {
            if (!hasGroup) {
              const l5 = document.getElementById('lkLast5').value.trim();
              if (l5 && !/^\d{5}$/.test(l5)) return toast('匯款末五碼限 5 位純數字', 'error');
              patch.remittanceLast5 = l5;
            }
            const nextCatId = document.getElementById('lkCat').value;
            if (nextCatId !== p.catId) {
              const targetCat = cats.find((c) => c.catId === nextCatId);
              const tq = Number(targetCat?.quota || 0);
              const usedTarget = State.participants.filter((x) => x.eventId === p.eventId && x.catId === nextCatId && x.participantId !== p.participantId && String(x.payStatus).toUpperCase() !== 'CANCELLED').length;
              if (tq > 0 && usedTarget >= tq) return toast(`分組「${targetCat?.name || nextCatId}」名額已滿 (${tq} 人)，無法更換！`, 'error');
              const nextPr = C.getEffectiveCategoryPrice(ev, targetCat);
              const cleanedRem = String(patch.remark || '').replace(/\[早鳥價\]\s*/g, '').trim();
              patch.remark = nextPr.isEarlyBird ? ['[早鳥價]', cleanedRem].filter(Boolean).join(' ') : cleanedRem;
            }
            const addons = $$('.lk-addon:checked').map((cb) => cb.dataset.name);
            patch.catId = nextCatId;
            patch.addonsDetail = JSON.stringify(addons);
            patch.totalAmount = recalcLookupTotal();
          }

          Object.assign(p, patch);
          await C.TurDB.put('participants', p);
          // 若團長修改了團長自己的 Email，同步更新全團成員之聯絡 Email
          if (isGroupLeaderLogin && !isEditingOtherMember && patch.email) {
            for (const m of groupMembers) {
              if (m.participantId !== p.participantId) {
                m.email = patch.email;
                await C.TurDB.put('participants', m);
              }
            }
          }
          await enqueueSync('updateSelfRegistration', { participantId: p.participantId, idCard: verifiedId, patch });
          renderLookupEditor(allMatches, p.participantId, verifiedId);
          toast(isPaid
            ? `✅ 已更新「${p.name}」聯絡資料（費用維持鎖定）｜✉️ 已寄出通知信${hasGroup ? '給團長' : ''}！`
            : `✅ 已更新「${p.name}」報名資料與金額｜✉️ 已寄出通知信${hasGroup ? '給團長' : ''}！`, 'success');
        };
      }
    };

    $('#btnLookupVerify').onclick = () => {
      const idCard = $('#lookupIdCard').value.trim().toUpperCase();
      const cred = $('#lookupCred').value.trim().toUpperCase();
      const matched = State.participants.find((x) => String(x.idCard).toUpperCase() === idCard && (
        String(x.participantId).toUpperCase() === cred ||
        String(x.email).toUpperCase() === cred ||
        String(x.merTradeNo || '').toUpperCase() === cred ||
        String(x.groupCode || '').toUpperCase() === cred
      ));
      if (!matched) return toast('查無報名資料，請確認身分證與序號／團報碼／合併單號／Email', 'error');
      const ownMatches = State.participants.filter((x) => String(x.idCard).toUpperCase() === idCard && String(x.payStatus || '').toUpperCase() !== 'CANCELLED');
      const allMap = new Map();
      (ownMatches.length ? ownMatches : [matched]).forEach((m) => {
        allMap.set(m.participantId, m);
        // 若驗證者為某團團長，一併載入該團全體組員供團長統一管理
        if (m.groupCode && C.getParticipantGroupRole(m, State.participants) === 'leader') {
          C.getGroupMembers(State.participants, m.groupCode, m.eventId).forEach((gm) => allMap.set(gm.participantId, gm));
        }
      });
      renderLookupEditor([...allMap.values()], matched.participantId, idCard);
    };

    // Zone 1 Controls
    $('#btnZ1BackToLobby').onclick = () => {
      if (C.NFC?.isScanning) C.NFC.stopScanning();
      State.z1ViewMode = 'lobby';
      Z.renderZone1(AppBridge);
    };
    $('#z1EventSelect').onchange = (e) => { State.z1EventId = e.target.value; State.z1ViewMode = 'detail'; Z.renderZone1(AppBridge); };
    $$('[data-z1tab]').forEach((b) => {
      b.onclick = () => {
        $$('[data-z1tab]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        $$('.z1-panel').forEach((p) => p.classList.add('hidden'));
        $(`#z1-${b.dataset.z1tab}`).classList.remove('hidden');
        if (Z.renderZone1Tab) Z.renderZone1Tab(AppBridge, b.dataset.z1tab);
      };
    });
    // 建立新活動 Modal（明確區分距離賽 vs 計時繞圈賽 ＋ 轉帳核對末五碼 vs 結合金流廠商）
    const setNewEventRaceType = (rt) => {
      const isLap = rt === 'lap_timed';
      $('#newEvRaceType').value = isLap ? 'lap_timed' : 'distance';
      $('#btnNewEvDistance').className = `p-3 rounded-xl border-2 text-left transition ${!isLap ? 'border-sky-600 bg-sky-50' : 'border-slate-200 bg-white hover:border-sky-400'}`;
      $('#btnNewEvLap').className = `p-3 rounded-xl border-2 text-left transition ${isLap ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-400'}`;
      $('#newEvDistanceFields').classList.toggle('hidden', isLap);
      $('#newEvLapFields').classList.toggle('hidden', !isLap);
    };
    const setNewEventPayMode = (pm) => {
      const isPayuni = Boolean(C.PAYUNi_FEATURE_ENABLED && pm === 'ONLINE_PAYUNi');
      $('#newEvPayMode').value = isPayuni ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
      $('#btnNewEvPayManual').className = `p-3 rounded-xl border-2 text-left transition ${!isPayuni ? 'border-amber-500 bg-amber-50' : 'border-slate-200 bg-white hover:border-amber-400'}`;
      if (!C.PAYUNi_FEATURE_ENABLED) {
        $('#btnNewEvPayPayuni').disabled = true;
        $('#btnNewEvPayPayuni').className = 'p-3 rounded-xl border-2 border-slate-200 bg-slate-100 text-slate-400 text-left opacity-60 cursor-not-allowed';
      } else {
        $('#btnNewEvPayPayuni').disabled = false;
        $('#btnNewEvPayPayuni').className = `p-3 rounded-xl border-2 text-left transition ${isPayuni ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200 bg-white hover:border-emerald-400'}`;
      }
    };
    $('#btnNewEvDistance').onclick = () => setNewEventRaceType('distance');
    $('#btnNewEvLap').onclick = () => setNewEventRaceType('lap_timed');
    $('#btnNewEvPayManual').onclick = () => setNewEventPayMode('MANUAL_ATM');
    $('#btnNewEvPayPayuni').onclick = () => {
      if (!C.PAYUNi_FEATURE_ENABLED) return toast('🔒 目前尚未開通線上金流，預設鎖定實體銀行轉帳', 'warn');
      setNewEventPayMode('ONLINE_PAYUNi');
    };
    $('#newEvEarlyBird').onchange = (e) => $('#newEvEarlyBirdFields').classList.toggle('hidden', !e.target.checked);
    $('#btnCloseNewEvent').onclick = () => $('#newEventModal').classList.add('hidden');
    $('#btnCancelNewEvent').onclick = () => $('#newEventModal').classList.add('hidden');
    $('#btnZ1NewEvent').onclick = () => {
      $('#newEvNameZh').value = '';
      $('#newEvCatWarrior800').checked = false;
      $('#newEvEarlyBird').checked = true;
      $('#newEvEarlyBirdFields').classList.remove('hidden');
      $('#newEvAddonChip').checked = false;
      $('#newEvAddonChipPrice').value = '';
      $('#newEvAddonLodging').checked = false;
      $('#newEvAddonLodgingPrice').value = '';
      $('#newEvAddonGear').checked = false;
      $('#newEvAddonGearPrice').value = '';
      $('#newEvAddonNote').checked = false;
      setNewEventRaceType('distance');
      setNewEventPayMode('MANUAL_ATM');
      $('#newEventModal').classList.remove('hidden');
      $('#newEvNameZh').focus();
    };
    $('#newEventForm').onsubmit = async (e) => {
      e.preventDefault();
      const nameZh = $('#newEvNameZh').value.trim();
      if (!nameZh) return toast('請輸入中文活動名稱', 'warn');
      const raceType = $('#newEvRaceType').value === 'lap_timed' ? 'lap_timed' : 'distance';
      const payMode = (C.PAYUNi_FEATURE_ENABLED && $('#newEvPayMode').value === 'ONLINE_PAYUNi') ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
      const rawStart = ($('#newEvRaceStart')?.value || '').trim();
      if (!rawStart) return toast('請設定活動起跑日期與時間', 'warn');
      const raceStartNorm = rawStart.replace('T', ' ') + (rawStart.length === 16 ? ':00' : '');
      const isLap = raceType === 'lap_timed';
      const ebOn = Boolean($('#newEvEarlyBird')?.checked);
      const ebEndNorm = ebOn ? C.normalizeEarlyBirdEnd($('#newEvEarlyBirdEnd')?.value || '') : '';
      if (ebOn && !ebEndNorm) return toast('啟用早鳥優惠價時，請設定早鳥截止日期與時間', 'warn');
      const newSchema = C.defaultFormSchema(payMode);
      newSchema.earlyBirdEnabled = ebOn;
      newSchema.earlyBirdEnd = ebEndNorm;
      newSchema.addons = [
        { code: 'chip_buy', name: '晶片採購', price: Math.max(0, Number($('#newEvAddonChipPrice')?.value || 0)), enabled: Boolean($('#newEvAddonChip')?.checked) },
        { code: 'lodging', name: '住宿預訂價', price: Math.max(0, Number($('#newEvAddonLodgingPrice')?.value || 0)), enabled: Boolean($('#newEvAddonLodging')?.checked) },
        { code: 'sport_gear', name: '運動用品加購價', price: Math.max(0, Number($('#newEvAddonGearPrice')?.value || 0)), enabled: Boolean($('#newEvAddonGear')?.checked) }
      ];
      newSchema.customFields = $('#newEvAddonNote')?.checked ? [{ ...C.DEFAULT_ADDONS_NOTE_FIELD }] : [];
      const evId = `TUR-${Date.now().toString().slice(-6)}`;
      const lapDist = isLap ? Math.max(0.1, Number($('#newEvLapKm').value || 1.0)) : 0;
      const ev = {
        eventId: evId, ownerUsername: State.currentUser.username, nameZh, nameEn: C.zhToEnEventName(nameZh),
        organizerZh: $('#newEvOrganizer').value.trim() || 'TUR 台灣超馬協會', organizerEn: 'TUR',
        location: '', raceType,
        lapDistanceKm: lapDist, debounceSeconds: 15, status: 'open',
        regStart: C.formatDateTime(), regEnd: '2026-12-31 23:59:59', raceStart: raceStartNorm, maxQuota: 500,
        bannerUrl: isLap ? 'dyn-track' : 'dyn-road',
        brochureText: '',
        formSchemaJson: JSON.stringify(newSchema), certConfigJson: JSON.stringify(C.defaultCertConfig())
      };
      const isW800Cat = Boolean($('#newEvCatWarrior800')?.checked);
      const baseFee = isLap ? 2200 : 1800;
      const rawEbFee = ebOn ? Math.max(0, Number($('#newEvEarlyBirdFee')?.value || 0)) : 0;
      const validEbFee = (rawEbFee > 0 && rawEbFee < baseFee) ? rawEbFee : 0;
      const cat = isLap
        ? { catId: `CAT-${evId}`, eventId: evId, name: $('#newEvLapCatName').value.trim() || '12H 繞圈組', distanceKm: lapDist, timeLimitHours: Number($('#newEvLapHrs').value || 12), fee: baseFee, earlyBirdFee: validEbFee, bibPrefix: 'L', bibStartNum: '001', quota: 300, customRaceStart: '', isWarrior800: isW800Cat }
        : { catId: `CAT-${evId}`, eventId: evId, name: $('#newEvDistCatName').value.trim() || '50K 超馬組', distanceKm: Number($('#newEvDistKm').value || 50), timeLimitHours: Number($('#newEvDistHrs').value || 8), fee: baseFee, earlyBirdFee: validEbFee, bibPrefix: 'A', bibStartNum: '001', quota: 300, customRaceStart: '', isWarrior800: isW800Cat };
      const distKm = Number(cat.distanceKm || 50);
      const sts = isLap
        ? [
          { stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
          { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'LAP', name: '主會場繞圈拱門', distanceKm: lapDist, stationType: 'lap', orderIndex: 1 }
        ]
        : [
          { stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
          { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'CP1', name: 'CP1 折返檢查站', distanceKm: Number((distKm / 2).toFixed(1)), stationType: 'checkpoint', orderIndex: 1 },
          { stationId: `ST-${evId}-2`, eventId: evId, stationCode: 'FINISH', name: '終點衝線拱門', distanceKm: distKm, stationType: 'finish', orderIndex: 2 }
        ];
      State.events.push(ev); State.categories.push(cat); State.stations.push(...sts);
      await C.TurDB.put('events', ev); await C.TurDB.put('categories', cat); await C.TurDB.bulkPut('stations', sts);
      await enqueueSync('saveEvent', { event: ev }); await enqueueSync('saveCategory', { category: cat });
      for (const st of sts) await enqueueSync('saveStation', { station: st });
      State.z1EventId = evId;
      State.z1ViewMode = 'detail';
      $('#newEventModal').classList.add('hidden');
      renderAll();
      toast(`✅ 已建立【${isLap ? '計時繞圈賽' : '一般距離賽'}】「${nameZh}」並配置標準站點與分組！`, 'success');
    };

    // Operator Workspace Controls
    $('#btnOutdoorToggle').onclick = () => document.body.classList.toggle('outdoor-mode');
    if ($('#writerEventSelect')) {
      $('#writerEventSelect').onchange = (e) => {
        State.opEventId = e.target.value;
        State.selectedWriterPid = null;
        if ($('#writerInspectCard')) $('#writerInspectCard').classList.add('hidden');
        rebuildIndices(State.opEventId);
        renderOperatorStation();
      };
    }
    C.bindFastInput($('#writerSearch'), renderWriterList, 120);
    if ($('#writerFilter')) $('#writerFilter').onchange = renderWriterList;
    $('#writerSearchList').onclick = (e) => {
      if (e.target.dataset.pickWriter) {
        State.selectedWriterPid = e.target.dataset.pickWriter;
        renderWriterSelected();
        renderWriterList();
      } else if (e.target.dataset.writerToggleChk) {
        const target = State.idxById.get(e.target.dataset.writerToggleChk);
        if (target) setWriterRunnerCheckin(target, target.checkinStatus !== 'checked_in');
      }
    };
    $('#btnWriterCheckin').onclick = () => setWriterRunnerCheckin(State.idxById.get(State.selectedWriterPid), true);
    $('#btnWriterUncheckin').onclick = () => setWriterRunnerCheckin(State.idxById.get(State.selectedWriterPid), false);
    $('#btnNfcWriteNtag').onclick = () => runChipWrite('write', false);
    if ($('#btnNfcVerifyWrite')) $('#btnNfcVerifyWrite').onclick = () => runChipWrite('verify', false);
    $('#btnNfcBindUid').onclick = () => runChipWrite('uid', false);
    $('#btnNfcReadLegacy').onclick = () => runChipWrite('legacy', false);
    $('#btnNfcReadInspect').onclick = () => runChipWrite('inspect', false);
    $('#btnSimWriteNtag').onclick = () => runChipWrite('write', true);
    $('#btnSimBindUid').onclick = () => runChipWrite('uid', true);
    $('#btnSimReadLegacy').onclick = () => runChipWrite('legacy', true);
    $('#btnSimReadInspect').onclick = () => runChipWrite('inspect', true);
    $('#btnSimInvalidCard').onclick = () => { Feedback.error(); showChipInspectResult(null, 'INVALID-CARD', 'UNKNOWN'); appendWriterLog('🔴 [模擬異常卡] 非本場晶片已攔截！'); };

    $('#manualScanForm').onsubmit = async (e) => {
      e.preventDefault();
      const inp = $('#manualScanInput');
      if (inp.value.trim()) { await handleOperatorSense(inp.value.trim(), 'manual'); inp.value = ''; inp.focus(); }
    };
    C.bindFastInput($('#opManualPickerSearch'), () => {
      const ev = State.events.find((e) => e.eventId === State.opEventId);
      if (!ev) return;
      const stCode = State.opLockedStation;
      const paid = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.bibNumber);
      const stLogs = State.timingLogs.filter((l) => l.eventId === ev.eventId && l.stationCode === stCode && l.isValid !== false);
      const passedBibSet = new Set(stLogs.map((l) => String(l.bibNumber).toUpperCase()));
      renderOpFallbackPicker(ev, stCode, paid, passedBibSet, stLogs);
    }, 120);
    $('#btnOpManualFallback').onclick = async () => {
      const bib = $('#opManualRunnerSelect').value;
      if (!bib) return toast('請先選擇本活動之已配號選手', 'warn');
      const reason = $('#opManualReason').value;
      const customTime = $('#opManualTime').value.trim();
      await handleOperatorSense(bib, 'manual_fallback', { reason, customTime });
      $('#opManualTime').value = '';
    };
    $('#quickRunnerButtons').onclick = (e) => { if (e.target.dataset.opScan) handleOperatorSense(e.target.dataset.opScan, 'sim'); };
    $('#btnSimUnknownScan').onclick = () => handleOperatorSense('INVALID-999', 'sim');
    $('#btnToggleNfcScan').onclick = async () => {
      if (C.NFC.isScanning || State.nfcScanning) {
        C.NFC.stopScanning();
        State.nfcScanning = false;
        $('#btnToggleNfcScan').textContent = '📡 啟動 NFC';
        return;
      }
      try {
        await C.NFC.startScanning(
          (tag) => {
            const tok = tag.idNumber ? `${tag.name}|${tag.idNumber}` : (tag.bib || tag.nfcUid);
            handleOperatorSense(tok, 'nfc');
          },
          (err) => toast(err.message, 'error')
        );
        State.nfcScanning = true;
        $('#btnToggleNfcScan').textContent = '🟢 NFC 感應中（點擊停止）';
        toast('📡 已啟動實體 NFC 感應', 'success');
      } catch (err) {
        State.nfcScanning = false;
        toast(err.message, 'warn');
      }
    };

    window.addEventListener('online', () => {
      updateNetworkBadge();
      if (isCloudSyncEnabled() && State.syncQueue.length > 0) syncPushNow(true);
    });
    window.addEventListener('offline', updateNetworkBadge);

    // 碼錶與 45 分鐘查改倒數
    setInterval(() => {
      const ev = State.events.find((e) => e.eventId === (State.opEventId || State.z1EventId));
      if (ev && ev.raceStart) {
        const dt = C.parseDateTime(ev.raceStart);
        if (dt) {
          const txt = C.formatDuration((Date.now() - dt.getTime()) / 1000);
          $('#opClockBox').textContent = txt;
          $('#topGunClock').textContent = `⏱ ${txt}`;
          $('#topGunClock').classList.remove('hidden');
        }
      }
      if (State.lookupSession) {
        const left = Math.max(0, Math.floor((State.lookupSession.exp - Date.now()) / 1000));
        $('#lookupTimerBadge').textContent = `剩餘 ${C.pad2(Math.floor(left / 60))}:${C.pad2(left % 60)}`;
        if (left === 0) { State.lookupSession = null; $('#lookupEditBox').classList.add('hidden'); }
      }
    }, 500);
  }

  const AppBridge = {
    State, toast, enqueueSync, syncPushNow, syncPullFromGas, syncBidirectional,
    syncPullOnlyFromCloud, syncForcePushAllToCloud, setSyncMode, buildConfigJsContent,
    updateNetworkBadge, autoAssignBibsForEvent, rebuildIndices, renderAll, switchView, openLoginModal
  };

  /* --------------------------------------------------------------------------
   * Bootstrap Init
   * -------------------------------------------------------------------------- */
  async function init() {
    await C.TurDB.open();
    const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users', 'globalConfig', 'syncQueue'];
    const loaded = await Promise.all(stores.map((s) => C.TurDB.getAll(s)));
    stores.forEach((s, i) => { State[s] = loaded[i]; });
    State.events = (State.events || []).map((e) => C.normalizeEventData({ ...e }));

    const oldSeedIds = new Set(['TUR-20260001', 'TUR-20260002', 'TUR-20260003', 'TUR-20260004', 'TUR-20260005', 'TUR-FIN-001', 'TUR-FIN-002', 'TUR-FIN-003', 'TUR-F24-001']);
    const isUntouchedOldSeed = State.events.length > 0 && State.participants.length <= 9 && State.participants.every((p) => oldSeedIds.has(p.participantId));
    const isCleanInitialized = localStorage.getItem('TUR_CLEAN_RESET') === '1' ||
      (State.globalConfig || []).some((g) => g.configKey === 'platformInitialized' && String(g.configValue) === '1');

    if (isCleanInitialized) {
      // 已主動清空重建：維持乾淨 0 場狀態，絕不自動回填舊示範資料，僅保底確保基礎管理帳號存在
      if (!State.users.length) {
        State.users = C.buildCleanBaseUsers();
        await C.TurDB.clearAndFill('users', State.users);
      }
    } else if (!State.events.length || isUntouchedOldSeed) {
      const baseSeed = C.buildFull5EventsSeed();
      const { merged } = C.mergeTestSuiteIntoState(baseSeed);
      const fullInit = { ...baseSeed, ...merged };
      for (const k of Object.keys(fullInit)) {
        State[k] = fullInit[k];
        await C.TurDB.clearAndFill(k, fullInit[k]);
      }
    }

    // 僅允許同一分頁 sessionStorage 還原工作階段（關閉分頁即自動登出）
    try {
      const savedSess = JSON.parse(sessionStorage.getItem('TUR_V3_SESSION') || 'null');
      if (savedSess && savedSess.username) {
        const u = State.users.find((x) => x.username === savedSess.username && Number(x.enabled));
        if (u) {
          State.currentUser = u;
          if (u.role === 'operator') {
            State.opEventId = savedSess.opEventId || u.allowedEventId;
            State.opLockedStation = u.allowedStation;
            State.activeView = 'operator-station';
          } else {
            State.activeView = 'zone1';
          }
        }
      }
    } catch (_) {}

    const applyHashRoute = () => {
      const h = String(location.hash || '').replace(/^#/, '').toLowerCase();
      if (h === 'lookup') State.activeView = 'public-lookup';
      else if (h === 'scores' || h.startsWith('scores/')) {
        const sub = h.split('/')[1] || 'live';
        State.scoreSubTab = ['live', 'history', 'warriors', 'cert'].includes(sub) ? sub : 'live';
        State.activeView = 'scores';
      } else if (h === 'timing') State.activeView = 'operator-station';
      else if (h === 'host') State.activeView = 'host-ops';
    };
    applyHashRoute();
    window.addEventListener('hashchange', () => { applyHashRoute(); switchView(State.activeView); });

    rebuildIndices();
    bindEvents();
    updatePayMethodUI();
    switchView(State.activeView);

    // 註冊 PWA Service Worker（僅在 http/https 下啟用，不干擾本機 file:// 開啟）
    if ('serviceWorker' in navigator && /^https?:/i.test(location.protocol)) {
      navigator.serviceWorker.register('./sw.js?v=6.1').catch(() => {});
    }

    // 僅在 🌐 雲端連線模式且連網已綁定 GAS 時，背景自動同步雲端最新資料（單機離線模式絕不自動請求）
    if (isCloudSyncEnabled()) {
      syncBidirectional(true);
    }
  }

  init().catch((err) => { console.error(err); alert('系統初始化失敗：' + err.message); });
})(window);
