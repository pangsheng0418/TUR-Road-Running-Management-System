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
  const State = {
    events: [], categories: [], stations: [], participants: [], timingLogs: [],
    historyResults: [], users: [], globalConfig: [], syncQueue: [],
    gasUrl: localStorage.getItem('TUR_GAS_URL') || C.DEFAULT_GAS_URL || '',
    currentUser: { username: 'public', displayName: '民眾 / 跑者', role: 'public', allowedStation: '' },
    activeView: 'public-home',
    regEventId: '',
    regMode: 'solo', // 'solo' | 'group'
    z1EventId: '',
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
   * Sync Engine (連網即時自動同步 + 刷卡 8 秒批次節流 + 斷網離線佇列)
   * -------------------------------------------------------------------------- */
  let syncInFlight = false;
  let syncAgainAfter = false;
  let batchTimer = null;

  async function enqueueSync(action, payload, immediate = true) {
    const item = { qid: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action, payload, createdAt: Date.now() };
    State.syncQueue.push(item);
    await C.TurDB.put('syncQueue', item);
    updateQueueBadge();

    if (!State.gasUrl || !navigator.onLine) return;

    // 賽道高頻刷卡採 8 秒背景批次合併上傳（不阻塞 <10ms 感應）；報名/對帳/設定則立即寫入雲端
    if (action === 'addTimingLog' && !immediate) {
      if (!batchTimer) {
        batchTimer = setTimeout(() => {
          batchTimer = null;
          syncPushNow(true);
        }, 8000);
      }
    } else {
      syncPushNow(true);
    }
  }

  function updateQueueBadge() {
    $('#pendingQueueCount').textContent = State.syncQueue.length;
  }

  function updateNetworkBadge() {
    const b = $('#netBadge');
    if (navigator.onLine) {
      b.textContent = State.gasUrl ? '● 雲端即時同步' : '● 本機模式';
      b.className = 'whitespace-nowrap text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    } else {
      b.textContent = '● 離線作業中';
      b.className = 'whitespace-nowrap text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40';
    }
  }

  async function syncPushNow(silent = false) {
    if (!State.syncQueue.length) { if (!silent) toast('本機無待上傳紀錄，雲端已同步', 'info'); return { ok: true, uploaded: 0 }; }
    if (!State.gasUrl) { if (!silent) toast(`本機已保存 ${State.syncQueue.length} 筆待同步資料（請於專區 5 設定 GAS URL）`, 'warn'); return { ok: false, error: '尚未設定 GAS URL' }; }
    if (!navigator.onLine) { if (!silent) toast('目前離線中，連網後將自動批次上傳', 'warn'); return { ok: false, error: '目前為離線狀態' }; }

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
      // 3. 最後批次寫入高頻感應紀錄
      if (logItems.length) {
        const res = await C.gasPost(State.gasUrl, { action: 'batchUploadLogs', timingLogs: logItems });
        if (!res || !res.ok) throw new Error((res && res.error) || '批次上傳感應紀錄失敗');
        for (const id of logQids) { await C.TurDB.remove('syncQueue', id); State.syncQueue = State.syncQueue.filter((x) => x.qid !== id); }
        uploaded += logItems.length;
      }
      updateQueueBadge();
      if (!silent) toast(`☁️ 雲端同步完成！共寫入 ${uploaded} 筆至 Google 試算表`, 'success');
    } catch (err) {
      lastError = err.message || String(err);
      updateQueueBadge();
      if (!silent) toast(`上傳失敗：${lastError}`, 'error');
      else console.warn('[TUR AutoSync error]', lastError);
    } finally {
      syncInFlight = false;
      if (syncAgainAfter && State.syncQueue.length > 0) {
        syncAgainAfter = false;
        setTimeout(() => syncPushNow(true), 600);
      }
    }
    return lastError ? { ok: false, error: lastError, uploaded } : { ok: true, uploaded };
  }

  async function syncPullFromGas(silent = false) {
    if (!State.gasUrl) { if (!silent) toast('尚未設定 GAS Web App URL，請先於專區 5 貼上網址', 'warn'); return; }
    if (!navigator.onLine) return;
    try {
      // 若本機尚有未上傳的離線異動，先自動推播再拉取，避免覆蓋剛寫入的資料
      if (State.syncQueue.length > 0) await syncPushNow(true);
      const res = await C.gasGet(State.gasUrl, { action: 'getBootstrapData' });
      if (!res || !res.ok) throw new Error(res?.error || '拉取失敗');
      const d = res.data || {};
      const keys = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users', 'globalConfig'];
      for (const k of keys) {
        if (Array.isArray(d[k]) && (k !== 'users' || d[k].length)) {
          State[k] = d[k];
          await C.TurDB.clearAndFill(k, d[k]);
        }
      }
      rebuildIndices();
      renderAll();
      if (!silent) toast(`🔄 雙向同步成功！已載入 ${State.events.length} 場賽事、${State.participants.length} 位選手`, 'success');
    } catch (err) {
      if (!silent) toast(`拉取失敗：${err.message}`, 'error');
      else console.warn('[TUR AutoPull skipped]', err.message);
    }
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
   * RBAC Navigation & View Switcher (Strict 4-Tier Isolation)
   * -------------------------------------------------------------------------- */
  function renderNavAndHeader() {
    const u = State.currentUser;
    const isStaff = u.role !== 'public';
    $('#btnOpenLogin').classList.toggle('hidden', isStaff);
    $('#btnLogout').classList.toggle('hidden', !isStaff);
    $('#btnSyncUpload').classList.toggle('hidden', !isStaff);
    $('#btnSyncPull').classList.toggle('hidden', !isStaff);

    const roleLabels = {
      public: '🏃 民眾 / 跑者前台',
      operator: `📡 現場作業員：${u.displayName} [${State.opLockedStation}]`,
      organizer: `👤 活動承辦人：${u.displayName} (${u.username})`,
      super_admin: `🛡️ 最高管理員：${u.displayName}`
    };
    $('#roleStatusBadge').textContent = roleLabels[u.role] || roleLabels.public;

    const nav = $('#mainNavInner');
    let pills = [];
    if (u.role === 'public') {
      pills = [
        ['public-home', '🏠 開放報名賽事'],
        ['public-lookup', '🔍 雙因子報名查詢與修改 (/lookup)']
      ];
    } else if (u.role === 'operator') {
      pills = [['operator-station', `🔒 執勤站點：${State.opLockedStation}`]];
    } else if (u.role === 'organizer') {
      pills = [
        ['zone1', '專區 1：🏃 進行中活動（僅本人名下）'],
        ['zone2', '專區 2：📦 已結案・報表・動態證書'],
        ['zone5', '專區 5：🗄️ 同步狀態（精簡）'],
        ['public-home', '🌐 預覽報名首頁']
      ];
    } else if (u.role === 'super_admin') {
      pills = [
        ['zone1', '專區 1：🏃 進行中活動'],
        ['zone2', '專區 2：📦 已結案・證書'],
        ['zone3', '專區 3：👥 帳號管理'],
        ['zone4', '專區 4：📚 歷屆與八百壯士'],
        ['zone5', '專區 5：🗄️ 直通控制台'],
        ['public-home', '🌐 報名首頁']
      ];
    }

    nav.innerHTML = pills.map(([vid, label]) => `
      <button data-nav-view="${vid}" class="nav-pill ${State.activeView === vid ? 'active' : 'hover:bg-slate-100'} px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold whitespace-nowrap transition">${label}</button>
    `).join('');

    $$('[data-nav-view]').forEach((b) => { b.onclick = () => switchView(b.dataset.navView); });
    updateQueueBadge();
    updateNetworkBadge();
  }

  function switchView(viewId) {
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
    if (v === 'public-home') renderPublicHome();
    else if (v === 'public-register') renderPublicRegister();
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
              ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">💳 結合金流廠商 (PAYUNi)</span>'
              : '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold text-[10px]">🏦 轉帳核對末五碼</span>';
            return `
              <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:shadow-md transition">
                <div class="h-32 p-4 flex flex-col justify-between text-white" style="${C.getBannerStyle(ev.bannerUrl)}">
                  <div class="flex justify-between items-start text-[11px]">
                    <span class="px-2 py-0.5 rounded-full bg-black/45 font-bold">${ev.raceType === 'lap_timed' ? '🔁 繞圈計時賽' : '🏃 距離挑戰賽'}</span>
                    <span class="px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-black">開放報名中</span>
                  </div>
                  <div>
                    <div class="font-black text-base leading-snug drop-shadow">${C.escapeHtml(ev.nameZh)}</div>
                    <div class="text-[11px] opacity-90">${C.escapeHtml(ev.location || '')}</div>
                  </div>
                </div>
                <div class="p-4 flex-1 flex flex-col justify-between space-y-3 text-xs">
                  <div class="space-y-1.5">
                    <div class="flex justify-between items-center text-slate-600"><span>繳費管制方式</span>${payBadge}</div>
                    <div class="flex justify-between text-slate-600"><span>🏁 起跑時間</span><b class="mono text-indigo-800">${ev.raceStart ? ev.raceStart.slice(0, 16) : '待公告'}</b></div>
                    <div class="flex justify-between text-slate-600"><span>已報名 / 限額</span><b class="mono text-slate-900">${quotaTxt}</b></div>
                    <div class="flex flex-wrap gap-1 pt-1">
                      ${cats.map((c) => `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">${C.escapeHtml(c.name)} $${c.fee}</span>`).join('')}
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
      <div class="font-black text-sm sm:text-base flex items-center gap-1.5"><span>🏃 個人報名</span>${!isGroup ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-400 text-slate-950">目前模式</span>' : ''}</div>
      <div class="text-[11px] ${!isGroup ? 'opacity-85' : 'text-slate-500'} mt-0.5">單人填表直接送出，不顯示團報欄位，避免填錯。</div>`;

    $('#btnModeGroup').className = isGroup
      ? 'p-3.5 rounded-2xl border-2 border-amber-500 bg-amber-500 text-slate-950 text-left shadow transition'
      : 'p-3.5 rounded-2xl border-2 border-slate-200 bg-white hover:border-amber-400 text-slate-800 text-left shadow-sm transition';
    $('#btnModeGroup').innerHTML = `
      <div class="font-black text-sm sm:text-base flex items-center gap-1.5"><span>👥 團體報名（2～50 人）</span>${isGroup ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-900 text-amber-300">目前模式</span>' : ''}</div>
      <div class="text-[11px] ${isGroup ? 'text-slate-900/80' : 'text-slate-500'} mt-0.5">自動配發 GRP26 團報碼，支援整團統一匯款或各自匯款。</div>`;

    $('#groupSettingsPanel').classList.toggle('hidden', !isGroup);
    $('#btnAddToGroup').classList.toggle('hidden', !isGroup);
    $('#btnSubmitSingle').classList.toggle('hidden', isGroup);
    $('#soloGuideCard').classList.toggle('hidden', isGroup);
    $('#groupCartCard').classList.toggle('hidden', !isGroup);

    if (!isGroup) {
      $('#regGroupName').value = '';
      $('#err-regGroupName').textContent = '';
    }
    updatePayMethodUI();
    renderGroupCart();
    validateRegForm();
  }

  function renderPublicRegister() {
    const ev = State.events.find((e) => e.eventId === State.regEventId) || State.events[0];
    if (!ev) return;
    $('#regBannerHero').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
    $('#regEventTitle').textContent = ev.nameZh;
    $('#regEventMeta').textContent = `${ev.nameEn || ''} · ${ev.location || ''} · 🏁 起跑：${ev.raceStart || '待公告'} · 主辦：${ev.organizerZh || 'TUR'}`;
    $('#regBrochureContent').textContent = (ev.brochureText || '').trim() || C.DEFAULT_BROCHURE_TEMPLATE;

    // 明確顯示本活動屬於「一般距離賽」或「計時繞圈賽」與賽制計分說明
    const wf = C.getRaceTypeWorkflow(ev, State.stations, State.categories);
    const isLap = ev.raceType === 'lap_timed';
    const rtBox = $('#regRaceTypeBanner');
    if (rtBox) {
      rtBox.className = `rounded-2xl border-2 p-3.5 text-xs shadow-sm ${isLap ? 'bg-indigo-50 border-indigo-300 text-indigo-950' : 'bg-sky-50 border-sky-300 text-sky-950'}`;
      rtBox.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full font-black ${isLap ? 'bg-indigo-700 text-white' : 'bg-sky-700 text-white'}">${wf.badge}</span>
            <span class="font-black">本場賽事賽制與計時方式</span>
          </div>
          <span class="font-bold opacity-90">${C.escapeHtml(wf.shortRule)}</span>
        </div>`;
    }

    const cats = State.categories.filter((c) => c.eventId === ev.eventId);
    const prevCat = $('#regCatId').value;
    $('#regCatId').innerHTML = cats.map((c) => {
      const used = State.participants.filter((p) => p.eventId === ev.eventId && p.catId === c.catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
      return `<option value="${c.catId}">${C.escapeHtml(c.name)} — NT$${c.fee} (剩 ${Math.max(0, Number(c.quota) - used)}/${c.quota})</option>`;
    }).join('');
    if (cats.some((c) => c.catId === prevCat)) $('#regCatId').value = prevCat;

    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const customFields = Array.isArray(schema.customFields) ? schema.customFields : [];
    const cfSec = $('#regCustomFieldsSection');
    const cfBox = $('#regCustomFieldsContainer');
    if (cfSec && cfBox) {
      if (!customFields.length) {
        cfSec.classList.add('hidden');
        cfBox.innerHTML = '';
      } else {
        cfSec.classList.remove('hidden');
        cfBox.innerHTML = customFields.map((f) => {
          const reqMark = f.required ? ' <span class="text-rose-600">*</span>' : '';
          const ph = C.escapeHtml(f.placeholder || '');
          const kAttr = C.escapeHtml(f.key);
          let ctrl = '';
          if (f.type === 'textarea') {
            ctrl = `<textarea data-cf-key="${kAttr}" data-cf-type="textarea" rows="2" placeholder="${ph}" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-xs bg-white"></textarea>`;
          } else if (f.type === 'select') {
            ctrl = `<select data-cf-key="${kAttr}" data-cf-type="select" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-xs bg-white">
              <option value="">${ph || '請選擇'}</option>
              ${(f.options || []).map((opt) => `<option value="${C.escapeHtml(opt)}">${C.escapeHtml(opt)}</option>`).join('')}
            </select>`;
          } else if (f.type === 'radio') {
            ctrl = `<div class="flex flex-wrap gap-2 pt-1">
              ${(f.options || []).map((opt, idx) => `
                <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border cursor-pointer hover:border-indigo-400">
                  <input type="radio" name="cf_radio_${kAttr}" value="${C.escapeHtml(opt)}" data-cf-key="${kAttr}" data-cf-type="radio" class="reg-cf-input" ${idx === 0 && !f.required ? '' : ''} />
                  <span>${C.escapeHtml(opt)}</span>
                </label>`).join('')}
            </div>`;
          } else if (f.type === 'checkbox') {
            ctrl = `<div class="flex flex-wrap gap-2 pt-1">
              ${(f.options || []).map((opt) => `
                <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border cursor-pointer hover:border-indigo-400">
                  <input type="checkbox" value="${C.escapeHtml(opt)}" data-cf-key="${kAttr}" data-cf-type="checkbox" class="reg-cf-input" />
                  <span>${C.escapeHtml(opt)}</span>
                </label>`).join('')}
            </div>`;
          } else {
            const htmlType = ['number', 'date', 'url'].includes(f.type) ? f.type : 'text';
            ctrl = `<input type="${htmlType}" data-cf-key="${kAttr}" data-cf-type="${f.type}" placeholder="${ph}" class="reg-cf-input w-full px-3 py-2 border rounded-lg text-xs bg-white" />`;
          }
          const spanClass = (f.type === 'textarea' || f.type === 'radio' || f.type === 'checkbox') ? 'sm:col-span-2' : '';
          return `
            <div class="${spanClass}">
              <label class="block text-xs font-bold text-slate-700 mb-1">${C.escapeHtml(f.label)}${reqMark}</label>
              ${ctrl}
              <p id="err-cf-${kAttr}" class="text-[11px] text-rose-600 mt-0.5 min-h-[14px]"></p>
            </div>`;
        }).join('');
        $$('.reg-cf-input').forEach((el) => {
          el.addEventListener('input', validateRegForm);
          el.addEventListener('change', validateRegForm);
        });
      }
    }

    $('#regAddonsContainer').innerHTML = (schema.addons || []).map((a) => `
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

    $('#payCardManual').classList.toggle('hidden', !isManual);
    $('#payCardPayuni').classList.toggle('hidden', isManual);
    if ($('#regGroupPayModeWrap')) $('#regGroupPayModeWrap').classList.toggle('hidden', !isManual);
    if ($('#regPayModeHeader')) {
      $('#regPayModeHeader').textContent = isManual
        ? '14. 本活動指定繳費方式：🏦 實體銀行轉帳（核對帳號末五碼）'
        : '14. 本活動指定繳費方式：💳 結合金流廠商（PAYUNi 線上自動銷帳）';
    }
    if ($('#regPayModeBadge')) {
      $('#regPayModeBadge').textContent = isManual ? '🔒 轉帳核對末五碼管制' : '🔒 金流廠商自動銷帳管制';
      $('#regPayModeBadge').className = `text-[10px] px-2 py-0.5 rounded-full font-bold ${isManual ? 'bg-amber-200 text-amber-950' : 'bg-emerald-600 text-white'}`;
    }
    $('#btnSubmitSingle').textContent = isManual ? '📝 確認送出個人報名（轉帳核對末五碼）' : '🔒 前往統一金流 PAYUNi 線上付款（秒級配號）';
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
    const email = $('#regEmail').value.trim();
    const city = $('#regCity').value;
    const diet = $('#regDiet').value;
    const emergName = $('#regEmergName').value.trim();
    const emergPhone = $('#regEmergPhone').value.trim();
    const last5 = $('#regLast5').value.trim();
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
    checks.city = city ? '' : '請選縣市';
    checks.diet = diet ? '' : '請選飲食';
    checks.emergName = !emergName ? '請填緊急聯絡人' : (emergName === name ? '不可與本人同名' : '');
    checks.emergPhone = !/^0\d{8,9}$/.test(emergPhone) ? '電話格式錯誤' : (emergPhone === phone ? '不可同本人手機' : '');
    checks.last5 = (payMethod === 'ONLINE_PAYUNi' || !last5 || /^\d{5}$/.test(last5)) ? '' : '末五碼限 5 位純數字';
    checks.consent = !consent ? '須勾選同意切結書' : (State.groupCart.length >= 50 ? '團報上限 50 人' : '');

    // 團體模式額外檢核：團體名稱必填
    const isGroupMode = State.regMode === 'group';
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
      ['#regCity', 'city', '#err-regCity'], ['#regDiet', 'diet', '#err-regDiet'],
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

    const addons = $$('.reg-addon:checked').map((cb) => ({ name: cb.dataset.name, price: Number(cb.dataset.price) }));
    const totalAmount = (cat ? Number(cat.fee) : 0) + addons.reduce((s, a) => s + a.price, 0);
    $('#regSingleTotal').textContent = `NT$ ${totalAmount.toLocaleString()}`;

    // 承辦人自訂擴充欄位取值與即時防呆檢核
    const evObj = State.events.find((e) => e.eventId === evId);
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

    const labels = [
      ['1. 組別名額', 'cat'], ['2. 國籍三碼', 'nat'], ['3. 姓名格式', 'name'], ['4. 身分證防重', 'idCard'],
      ['5. 性別聯動', 'gender'], ['6. 10~80歲', 'birthday'], ['7. 手機09開頭', 'phone'], ['8. Email', 'email'],
      ['9. 居住縣市', 'city'], ['10. 飲食', 'diet'], ['11. 緊急不同名', 'emergName'], ['12. 緊急不同號', 'emergPhone'],
      [payMethod === 'ONLINE_PAYUNi' ? '13. 金流廠商結帳' : '13. 匯款末五碼', 'last5'], ['14. 切結/上限', 'consent']
    ];
    if (customFieldDefs.length) labels.push(['15. 活動自訂欄位', 'customFields']);
    $('#validationSummaryList').innerHTML = labels.map(([lbl, k]) => {
      const ok = !checks[k];
      return `<div class="px-2 py-1 rounded border ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}">${ok ? '✓' : '✕'} ${lbl}</div>`;
    }).join('');

    const split = C.splitFullName(name);
    const isValid = Object.values(checks).every((e) => e === '') && !grpErr;
    return {
      isValid,
      runner: {
        participantId: `TUR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(10000 + Math.random() * 90000)}`,
        eventId: evId, catId, bibNumber: '', groupCode: '', groupName: isGroupMode ? grpName : '',
        name, lastName: split.lastName, firstName: split.firstName, idCard, gender, birthday, age, nationality: nat,
        phone, email, city, emergencyName: emergName, emergencyPhone: emergPhone, diet, remark: $('#regRemark').value.trim(),
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
      box.innerHTML = '<p class="text-slate-400 italic py-3 text-center">尚無團報成員（最多 50 人）</p>';
      $('#groupGrandTotal').textContent = 'NT$ 0';
      $('#btnSubmitGroup').disabled = true;
      return;
    }
    box.innerHTML = State.groupCart.map((r, i) => `
      <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 border">
        <div><b>${i + 1}. ${C.escapeHtml(r.name)}</b> [${r.nationality}] · NT$${r.totalAmount}</div>
        <button data-rm-cart="${i}" class="text-rose-600 font-bold px-1.5">✕</button>
      </div>`).join('');
    const grandTotal = State.groupCart.reduce((s, r) => s + Number(r.totalAmount), 0);
    $('#groupGrandTotal').textContent = `NT$ ${grandTotal.toLocaleString()}`;
    $('#btnSubmitGroup').textContent = `✅ 送出整批團報 (${State.groupCart.length} 人)`;
    $('#btnSubmitGroup').disabled = false;
  }

  async function commitRunners(runners) {
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

    const isGroup = State.regMode === 'group' || runners.length > 1 || Boolean(runners[0].groupName);
    const grpCode = isGroup ? `GRP26-${Math.floor(1000 + Math.random() * 8999)}` : '';
    const isSharedPay = $('#regGroupPayMode')?.value === 'shared';
    const sharedLast5 = runners[0].remittanceLast5;
    const usedBibs = new Set(State.participants.filter((p) => p.eventId === evId && p.bibNumber).map((p) => String(p.bibNumber).toUpperCase()));
    const assignedBibs = [];

    for (const r of runners) {
      if (grpCode) r.groupCode = grpCode;
      if (r.payMethod === 'MANUAL_ATM' && isSharedPay && sharedLast5) r.remittanceLast5 = sharedLast5;

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

    if (assignedBibs.length) {
      toast(`⚡ PAYUNi 銷帳配號成功 (${assignedBibs.join(', ')})｜✉️ 已自動寄發報名＋繳費入帳確認信${cloudNote}`, toastType);
    } else {
      toast(`📝 報名成功！序號 ${runners[0].participantId}${grpCode ? `｜團報 ${grpCode}` : ''}｜✉️ 已自動寄發報名確認信（含反向查改說明）${cloudNote}`, toastType);
    }
  }

  /* --------------------------------------------------------------------------
   * View D: Operator Locked Station Workspace (WRITER / CHECKIN / CP / FINISH / LAP)
   * -------------------------------------------------------------------------- */
  function renderOperatorStation() {
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

    $('#opStationTitle').textContent = stCode === 'WRITER' ? '📡 晶片寫入與發卡專區（WRITER 鎖定）' : `⏱️ ${stCode} ${sop.stationName} — 管制點控制台`;
    $('#opEventSubtitle').textContent = `${sop.raceTypeLabel} · ${ev.nameZh} · 執勤帳號：${State.currentUser.username}`;

    // 渲染管制點專屬 SOP 與晶片處置指引卡
    const sopBox = $('#opStationSopBanner');
    if (sopBox) {
      sopBox.className = `rounded-2xl border-2 p-4 text-xs space-y-2.5 shadow-sm outdoor-card ${needsGun ? 'bg-amber-50 border-amber-400' : (ev.status === 'finished' ? 'bg-rose-50 border-rose-400' : 'bg-white border-indigo-200')}`;
      sopBox.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full bg-slate-900 text-amber-400 font-black mono">${sop.code}</span>
            <span class="font-black text-sm text-slate-900">${C.escapeHtml(sop.roleLabel)}</span>
            <span class="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-900 font-bold">${sop.raceTypeLabel}</span>
            ${needsGun ? '<span class="px-2 py-0.5 rounded-full bg-amber-500 text-slate-950 font-black">⏳ 尚未鳴槍（目前鎖定計時）</span>' : (ev.status === 'finished' ? '<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white font-black">🔒 活動已結案鎖定</span>' : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-black">🟢 管制站執勤中</span>')}
          </div>
          <div class="mono font-bold text-slate-700">本站進度：<b>${passedCount} / ${paid.length} 人</b> (${pct}%)</div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div class="p-2.5 rounded-xl bg-slate-50 border"><b class="text-slate-800">📡 本站晶片管制作為：</b><div class="mt-0.5 text-slate-600 leading-relaxed">${C.escapeHtml(sop.action)}</div></div>
          <div class="p-2.5 rounded-xl bg-amber-50/70 border border-amber-200"><b class="text-amber-900">🛡️ 系統自動防呆攔截：</b><div class="mt-0.5 text-amber-900/90 leading-relaxed">${C.escapeHtml(sop.guard)}</div></div>
          <div class="p-2.5 rounded-xl bg-sky-50/70 border border-sky-200"><b class="text-sky-900">🛠️ 晶片無法感應處置：</b><div class="mt-0.5 text-sky-900/90 leading-relaxed">${C.escapeHtml(sop.fallback)}</div></div>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 text-[11px] pt-1">
          <span class="font-bold text-slate-500">賽道管制鏈：</span>
          ${sop.routeNodes.map((n, i) => `${i > 0 ? '<span class="text-slate-400">→</span>' : ''}<span class="px-2 py-0.5 rounded-lg mono font-bold ${n === stCode ? 'bg-amber-400 text-slate-950 ring-2 ring-amber-500' : 'bg-slate-100 text-slate-600'}">${n}</span>`).join('')}
        </div>`;
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
      <div class="text-xs mono text-slate-700">NDEF 字串：<b>${C.escapeHtml(p.name)}|${p.idCard}</b> ｜ UID：<b>${p.chipUid || '尚未綁定'}</b></div>`;
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
      card.innerHTML = `<div class="font-black text-rose-800">🔴 讀取結果：查無本場次對應選手（非本場晶片）</div><div class="mono text-rose-700">UID：${C.escapeHtml(rawUid || '-')} ｜ NDEF：${C.escapeHtml(rawPayload || '空')}</div>`;
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
      <div class="mono text-slate-700">UID：<b>${C.escapeHtml(rawUid || p.chipUid || '-')}</b> ｜ NDEF：<b>${C.escapeHtml(rawPayload || `${p.name}|${p.idCard}`)}</b> ｜ 繳費：<b>${p.payStatus}</b></div>
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
      if (autoChk) target.checkinStatus = 'checked_in';
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
        Feedback.success();
        showChipInspectResult(target, target.chipUid || 'SIM-UID-READ', `${target.name}|${target.idCard}`);
        appendWriterLog(`🔍 [模擬讀取查看] ${target.bibNumber} ${target.name}｜UID=${target.chipUid || '未綁'}｜報到=${target.checkinStatus}`);
        renderWriterSelected(); renderWriterList();
        return;
      }
      try {
        const ndef = new NDEFReader();
        await ndef.scan();
        appendWriterLog('🔍 請將晶片貼近感應區進行讀取查看...');
        ndef.onreading = (e) => {
          const uid = String(e.serialNumber || '').toUpperCase();
          const dec = new TextDecoder(); let txt = '';
          for (const rec of e.message.records) if (rec.recordType === 'text') txt = dec.decode(rec.data);
          const idPart = txt.includes('|') ? txt.split('|')[1].trim().toUpperCase() : '';
          const m = (idPart && State.idxByIdCard.get(idPart)) || State.idxByUid.get(uid);
          if (m) { Feedback.success(); State.selectedWriterPid = m.participantId; renderWriterSelected(); renderWriterList(); }
          else Feedback.error();
          showChipInspectResult(m, uid, txt);
          appendWriterLog(`🔍 [讀取查看] UID=${uid} NDEF="${txt}" -> ${m ? `${m.bibNumber} ${m.name}` : '非本場卡片'}`);
          ndef.onreading = null;
        };
      } catch (err) { Feedback.error(); appendWriterLog(`🔴 讀取失敗：${err.message}`); }
      return;
    }

    if (mode === 'write') {
      const payload = `${p.name}|${p.idCard}`;
      if (sim) {
        const newUid = p.chipUid || `04:${Math.random().toString(16).slice(2, 4).toUpperCase()}:9F:22`;
        await applyPostWrite(p, newUid);
        Feedback.writeOk();
        appendWriterLog(`✅ [模擬寫入+回讀驗證通過] NDEF="${payload}" (${payload.length}B) UID=${p.chipUid}${autoChk ? '｜已同步報到' : ''}`);
        showChipInspectResult(p, p.chipUid, payload);
        return;
      }
      try {
        const ndef = new NDEFReader();
        await ndef.write({ records: [{ recordType: 'text', data: payload }] });
        Feedback.writeOk();
        appendWriterLog(`✅ NDEF 寫入完成："${payload}"，啟動回讀驗證...`);
        await ndef.scan();
        ndef.onreading = async (e) => {
          const uid = String(e.serialNumber || '').toUpperCase();
          await applyPostWrite(p, uid);
          appendWriterLog(`🟢 回讀驗證通過！UID=${uid}${autoChk ? '｜已同步報到' : ''}`);
          showChipInspectResult(p, uid, payload);
          ndef.onreading = null;
        };
      } catch (err) { Feedback.error(); appendWriterLog(`🔴 寫入失敗：${err.message}`); }
    } else if (mode === 'uid') {
      if (sim) {
        const newUid = `MF:${Math.random().toString(16).slice(2, 4).toUpperCase()}:AA:11`;
        await applyPostWrite(p, newUid);
        Feedback.writeOk();
        appendWriterLog(`🔗 [模擬 UID 綁定] ${p.name} -> ${p.chipUid}${autoChk ? '｜已同步報到' : ''}`);
        showChipInspectResult(p, p.chipUid, `${p.name}|${p.idCard}`);
      } else {
        const ndef = new NDEFReader();
        await ndef.scan();
        ndef.onreading = async (e) => {
          const uid = String(e.serialNumber || '').toUpperCase();
          await applyPostWrite(p, uid);
          Feedback.writeOk(); appendWriterLog(`🔗 UID 綁定成功：${uid}${autoChk ? '｜已同步報到' : ''}`);
          showChipInspectResult(p, uid, `${p.name}|${p.idCard}`);
          ndef.onreading = null;
        };
      }
    } else if (mode === 'legacy') {
      const sample = State.participants.find((x) => x.eventId === State.opEventId && String(x.payStatus).toUpperCase() === 'PAID');
      if (sim && sample) {
        Feedback.success();
        State.selectedWriterPid = sample.participantId;
        if (autoChk) await applyPostWrite(sample, sample.chipUid);
        renderWriterSelected();
        showChipInspectResult(sample, sample.chipUid || 'LEGACY-CARD', `${sample.name}|${sample.idCard}`);
        appendWriterLog(`♻️ [模擬舊晶片共用核准] 讀到 ${sample.name}|${sample.idCard} -> 本場已繳費 (${sample.bibNumber})${autoChk ? '｜已同步報到' : ''}`);
      } else if (!sim) {
        const ndef = new NDEFReader();
        await ndef.scan();
        ndef.onreading = async (e) => {
          const uid = String(e.serialNumber || '').toUpperCase();
          const dec = new TextDecoder(); let txt = '';
          for (const rec of e.message.records) if (rec.recordType === 'text') txt = dec.decode(rec.data);
          const idPart = txt.includes('|') ? txt.split('|')[1].trim().toUpperCase() : '';
          const m = (idPart && State.idxByIdCard.get(idPart)) || State.idxByUid.get(uid);
          if (m) {
            Feedback.success(); State.selectedWriterPid = m.participantId;
            if (autoChk) await applyPostWrite(m, m.chipUid || uid);
            showChipInspectResult(m, uid, txt);
            appendWriterLog(`♻️ 舊卡核准：${m.name} (${m.bibNumber})${autoChk ? '｜已同步報到' : ''}`);
          } else { Feedback.error(); showChipInspectResult(null, uid, txt); appendWriterLog(`🔴 非本場晶片攔截：${txt || uid}`); }
          ndef.onreading = null;
        };
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
      if (p.raceStatus === 'dns') { p.raceStatus = 'on_track'; await C.TurDB.put('participants', p); }
    } else if (stCode === 'FINISH') {
      p.raceStatus = 'finished';
      await C.TurDB.put('participants', p);
      await enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'finished' });
      const startDt = C.parseDateTime(ev.raceStart);
      const sec = startDt ? Math.round((senseMs - startDt.getTime()) / 1000) + Number(p.penaltySeconds || 0) : null;
      note = reasonPrefix + `🏁 衝線完賽！整數秒成績 ${C.formatDuration(sec)}`;
    } else {
      if (p.raceStatus === 'dns') { p.raceStatus = 'on_track'; await C.TurDB.put('participants', p); }
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
  function openLoginModal() {
    // 強制清空所有帳密欄位（零紀錄安全防護）
    $('#loginUser').value = '';
    $('#loginPass').value = '';
    $('#opLoginPass').value = '';
    State.pickedOpUser = null;
    $('#opPickedAccountHint').textContent = '請先點選卡片';

    const activeEvs = State.events.filter((e) => e.status !== 'finished');
    $('#opLoginEventSelect').innerHTML = activeEvs.map((e) => `<option value="${e.eventId}">${C.escapeHtml(e.nameZh)}</option>`).join('');
    renderOpStationCards();
    $('#loginModal').classList.remove('hidden');
  }

  function renderOpStationCards() {
    const evId = $('#opLoginEventSelect').value;
    const ops = State.users.filter((u) => u.role === 'operator' && Number(u.enabled) && (u.allowedEventId === evId || u.allowedEventId === 'ALL'));
    const cards = ops.length ? ops : State.users.filter((u) => u.role === 'operator' && Number(u.enabled));
    $('#opStationCardGrid').innerHTML = cards.map((op) => `
      <button type="button" data-pick-op="${op.username}" class="p-2.5 rounded-xl border-2 text-left transition ${State.pickedOpUser?.username === op.username ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-400'}">
        <div class="font-black text-xs mono text-slate-900">${op.allowedStation}</div>
        <div class="text-[11px] text-slate-600">${C.escapeHtml(op.displayName)}</div>
      </button>`).join('');
    $$('[data-pick-op]').forEach((b) => {
      b.onclick = () => {
        State.pickedOpUser = State.users.find((x) => x.username === b.dataset.pickOp);
        $('#opPickedAccountHint').textContent = `已選：${State.pickedOpUser.username} (${State.pickedOpUser.allowedStation})`;
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
      switchView('zone1');
    }
    toast(`✅ 歡迎登入：${user.displayName}`, 'success');
  }

  function logoutZeroTrace() {
    sessionStorage.removeItem('TUR_V3_SESSION');
    State.currentUser = { username: 'public', displayName: '民眾 / 跑者', role: 'public', allowedStation: '' };
    State.opEventId = '';
    State.opLockedStation = '';
    State.nfcScanning = false;
    switchView('public-home');
    toast('🚪 已安全登出並清除本機工作階段憑證', 'info');
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

    $('#btnOpenLogin').onclick = openLoginModal;
    $('#btnCloseLogin').onclick = () => $('#loginModal').classList.add('hidden');
    $('#btnLogout').onclick = logoutZeroTrace;
    $('#btnSyncUpload').onclick = () => syncPushNow(false);
    $('#btnSyncPull').onclick = () => syncPullFromGas();

    $('#loginModeAdmin').onclick = () => {
      $('#adminLoginForm').classList.remove('hidden'); $('#opLoginForm').classList.add('hidden');
      $('#loginModeAdmin').className = 'flex-1 py-2 rounded-xl bg-slate-900 text-white font-bold';
      $('#loginModeOp').className = 'flex-1 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold';
    };
    $('#loginModeOp').onclick = () => {
      $('#opLoginForm').classList.remove('hidden'); $('#adminLoginForm').classList.add('hidden');
      $('#loginModeOp').className = 'flex-1 py-2 rounded-xl bg-slate-900 text-white font-bold';
      $('#loginModeAdmin').className = 'flex-1 py-2 rounded-xl bg-slate-100 text-slate-700 font-bold';
    };
    $('#opLoginEventSelect').onchange = renderOpStationCards;

    $('#adminLoginForm').onsubmit = (e) => {
      e.preventDefault();
      const un = $('#loginUser').value.trim();
      const pw = $('#loginPass').value.trim();
      const u = State.users.find((x) => x.username === un && String(x.passwordHash) === pw && Number(x.enabled) && (x.role === 'super_admin' || x.role === 'organizer'));
      if (!u) return toast('帳號或密碼錯誤，或帳號已停用', 'error');
      applySessionLogin(u);
    };

    $('#opLoginForm').onsubmit = (e) => {
      e.preventDefault();
      if (!State.pickedOpUser) return toast('請先於步驟 2 點選執勤站點卡片', 'warn');
      const pw = $('#opLoginPass').value.trim();
      if (String(State.pickedOpUser.passwordHash) !== pw) return toast('站點密碼錯誤', 'error');
      applySessionLogin(State.pickedOpUser, $('#opLoginEventSelect').value);
    };

    // Public Navigation & Form
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

    $('#btnFillSampleRunner').onclick = () => {
      const L = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
      const li = Math.floor(Math.random() * L.length);
      const gc = Math.random() > 0.5 ? 1 : 2;
      const body = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10));
      const n = li + 10, w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      const d = [Math.floor(n / 10), n % 10, gc, ...body];
      const chk = (10 - (d.reduce((a, x, i) => a + x * w[i], 0) % 10)) % 10;
      if (State.regMode === 'group' && !$('#regGroupName').value.trim()) {
        $('#regGroupName').value = 'TUR 範例跑團';
      }
      $('#regNationality').value = 'TWN'; $('#regNationalityCustom').classList.add('hidden');
      $('#regName').value = gc === 1 ? '歐陽浩宇' : '上官靜怡';
      $('#regIdCard').value = `${L[li]}${gc}${body.join('')}${chk}`;
      $('#regGender').value = gc === 1 ? 'M' : 'F';
      $('#regBirthday').value = '1990-08-18';
      $('#regPhone').value = '0912' + String(Math.floor(100000 + Math.random() * 899999));
      $('#regEmail').value = `runner${Math.floor(100 + Math.random() * 899)}@tur.tw`;
      $('#regCity').value = '台北市'; $('#regDiet').value = '葷';
      $('#regEmergName').value = '緊急家屬'; $('#regEmergPhone').value = '0987654321';
      $('#regLast5').value = String(Math.floor(10000 + Math.random() * 89999));
      $('#regConsent').checked = true;
      validateRegForm();
    };

    $('#btnAddToGroup').onclick = () => {
      const res = validateRegForm();
      if (!res.isValid) return toast('請先修正紅框錯誤', 'error');
      if (State.groupCart.length >= 50) return toast('團體報名上限 50 人', 'error');
      State.groupCart.push(res.runner);
      renderGroupCart();
      $('#regName').value = ''; $('#regIdCard').value = ''; $('#regPhone').value = '';
      validateRegForm();
      toast(`已加入團報清單 (${State.groupCart.length}/50)`, 'success');
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
      if (!res.isValid) return toast('尚有欄位未通過 14 項防呆檢核', 'error');
      await commitRunners([res.runner]);
      $('#regName').value = ''; $('#regIdCard').value = ''; $('#regConsent').checked = false;
      validateRegForm();
    };
    $('#btnSubmitGroup').onclick = async () => {
      if (!State.groupCart.length) return;
      await commitRunners([...State.groupCart]);
      State.groupCart = []; renderGroupCart();
    };

    // 雙因子反向查改 (/lookup) — 已繳費嚴格鎖定費用相關項目（組別/加購/金額/末五碼），結案/完賽全面唯讀
    $('#btnLookupVerify').onclick = () => {
      const idCard = $('#lookupIdCard').value.trim().toUpperCase();
      const cred = $('#lookupCred').value.trim().toUpperCase();
      const p = State.participants.find((x) => String(x.idCard).toUpperCase() === idCard && (String(x.participantId).toUpperCase() === cred || String(x.email).toUpperCase() === cred));
      if (!p) return toast('查無報名資料，請確認身分證與序號/Email', 'error');
      State.lookupSession = { pid: p.participantId, exp: Date.now() + 45 * 60 * 1000 };
      const ev = State.events.find((e) => e.eventId === p.eventId);
      const cats = State.categories.filter((c) => c.eventId === p.eventId);
      const schema = C.parseJsonSafe(ev?.formSchemaJson, C.defaultFormSchema());
      const addonDefs = Array.isArray(schema.addons) ? schema.addons : [];
      const cfDefs = Array.isArray(schema.customFields) ? schema.customFields : [];
      const curAddons = C.parseJsonSafe(p.addonsDetail, []);
      const curCf = C.parseJsonSafe(p.customFieldsJson, {});
      const paySt = String(p.payStatus || 'UNPAID').toUpperCase();
      const isPaid = paySt === 'PAID';
      const isCancelled = paySt === 'CANCELLED';
      const isClosedLock = isCancelled || ev?.status === 'finished' || p.raceStatus === 'finished';
      const feeLocked = isPaid || isClosedLock;
      const evPayMode = C.getEventPaymentMode(ev);
      const isPayuniEv = evPayMode === 'ONLINE_PAYUNi';

      $('#lookupTimerBadge').classList.remove('hidden');
      $('#lookupEditBox').classList.remove('hidden');
      $('#lookupEditBox').innerHTML = `
        <div class="p-3.5 rounded-xl text-xs font-bold ${isClosedLock ? 'bg-slate-200 border border-slate-400 text-slate-800' : (isPaid ? 'bg-amber-50 border-2 border-amber-400 text-amber-950' : 'bg-sky-50 border-2 border-sky-300 text-sky-950')}">
          ${isClosedLock
            ? `🔒 此筆報名已${isCancelled ? '取消' : (ev?.status === 'finished' ? '隨活動結案鎖定' : '完賽寫入正式成績')}，僅供查閱不可再修改。`
            : (isPaid
              ? '🔒 已繳費入帳 (PAID) 費用防呆鎖定：組別、加購服務、應繳金額與匯款末五碼已全面鎖定不可變更；您仍可自由修改聯絡電話、Email、居住縣市、緊急聯絡人、飲食、備註與活動自訂欄位！'
              : '✏️ 尚未繳費 (UNPAID)：可自由反向修改「組別、加購服務（即時重算應繳金額）、匯款末五碼」以及所有基本聯絡與活動自訂欄位。')}
        </div>

        <!-- 區塊 1：費用相關項目（已繳費嚴格鎖定） -->
        <div class="p-3.5 rounded-xl border ${feeLocked ? 'bg-slate-100/90 border-slate-300' : 'bg-amber-50/40 border-amber-200'} space-y-2.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-black text-slate-900">💰 費用相關項目 ${feeLocked ? '<span class="ml-1 px-2 py-0.5 rounded-full bg-amber-200 text-amber-950 text-[10px]">🔒 已繳費/鎖定不可修改</span>' : '<span class="ml-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px]">✏️ 未繳費可調整重算</span>'}</span>
            <span class="mono font-black text-base text-amber-700" id="lkTotalDisplay">應繳總額：NT$ ${Number(p.totalAmount || 0).toLocaleString()}</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div><label class="font-bold">序號 / 號碼布 / 狀態</label><input disabled value="${p.participantId}｜${p.bibNumber || '待配號'}｜${paySt}" class="w-full px-2.5 py-2 border rounded-lg bg-slate-200/70 mono mt-0.5" /></div>
            <div><label class="font-bold">報名組別 ${feeLocked ? '🔒' : ''}</label>
              <select id="lkCat" ${feeLocked ? 'disabled' : ''} class="w-full px-2.5 py-2 border rounded-lg mt-0.5 ${feeLocked ? 'bg-slate-200/70 cursor-not-allowed' : 'bg-white'}">
                ${cats.map((c) => `<option value="${c.catId}" data-fee="${c.fee}" ${c.catId === p.catId ? 'selected' : ''}>${C.escapeHtml(c.name)} (NT$${c.fee})</option>`).join('')}
              </select>
            </div>
            <div><label class="font-bold">${isPayuniEv ? '金流單號 / 付款別 🔒' : `匯款末五碼 ${feeLocked ? '🔒' : ''}`}</label>
              ${isPayuniEv
                ? `<input id="lkLast5" disabled value="${C.escapeHtml(p.merTradeNo || p.paymentType || 'PAYUNi 線上金流')}" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 bg-slate-200/70 cursor-not-allowed" />`
                : `<input id="lkLast5" ${feeLocked ? 'disabled' : ''} value="${C.escapeHtml(p.remittanceLast5 || '')}" maxlength="5" placeholder="5 碼純數字" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5 ${feeLocked ? 'bg-slate-200/70 cursor-not-allowed' : 'bg-white'}" />`}
            </div>
          </div>
          ${addonDefs.length ? `
            <div>
              <label class="font-bold block mb-1">加購服務 ${feeLocked ? '🔒（已繳費鎖定）' : '（勾選即重算應繳金額）'}</label>
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

        <!-- 區塊 2：基本聯絡與非費用欄位（賽前皆可自由修改） -->
        <div class="p-3.5 rounded-xl border bg-white space-y-2.5 text-xs">
          <div class="font-black text-slate-900">✏️ 個人聯絡、緊急聯絡人與非費用設定</div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div><label class="font-bold">手機號碼 (09 開頭 10 碼)</label><input id="lkPhone" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(p.phone || '')}" maxlength="10" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5" /></div>
            <div><label class="font-bold">電子信箱 Email</label><input id="lkEmail" ${isClosedLock ? 'disabled' : ''} type="email" value="${C.escapeHtml(p.email || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5" /></div>
            <div><label class="font-bold">居住縣市</label><input id="lkCity" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(p.city || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5" /></div>
            <div><label class="font-bold">緊急聯絡人姓名</label><input id="lkEmergName" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(p.emergencyName || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5" /></div>
            <div><label class="font-bold">緊急聯絡人電話</label><input id="lkEmergPhone" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(p.emergencyPhone || '')}" maxlength="10" class="w-full px-2.5 py-2 border rounded-lg mono mt-0.5" /></div>
            <div><label class="font-bold">飲食習慣</label>
              <select id="lkDiet" ${isClosedLock ? 'disabled' : ''} class="w-full px-2.5 py-2 border rounded-lg mt-0.5">
                <option value="葷" ${p.diet === '葷' ? 'selected' : ''}>葷食</option>
                <option value="素" ${p.diet === '素' ? 'selected' : ''}>素食</option>
              </select>
            </div>
            <div class="sm:col-span-3"><label class="font-bold">備註 / 特殊需求</label><input id="lkRemark" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(p.remark || '')}" class="w-full px-2.5 py-2 border rounded-lg mt-0.5" /></div>
          </div>
          ${cfDefs.length ? `
            <div class="pt-2 border-t space-y-2">
              <div class="font-bold text-indigo-900">📝 活動自訂擴充欄位（非費用欄位，可自由修改）</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                ${cfDefs.map((f) => {
                  const v = curCf[f.key];
                  const strV = Array.isArray(v) ? v.join(', ') : String(v ?? '');
                  if (f.type === 'select') {
                    return `<div><label class="font-bold">${C.escapeHtml(f.label)}</label><select data-lk-cf="${C.escapeHtml(f.key)}" data-lk-cftype="select" ${isClosedLock ? 'disabled' : ''} class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5"><option value="">請選擇</option>${(f.options || []).map((o) => `<option value="${C.escapeHtml(o)}" ${strV === o ? 'selected' : ''}>${C.escapeHtml(o)}</option>`).join('')}</select></div>`;
                  }
                  return `<div><label class="font-bold">${C.escapeHtml(f.label)}</label><input data-lk-cf="${C.escapeHtml(f.key)}" data-lk-cftype="${f.type}" ${isClosedLock ? 'disabled' : ''} value="${C.escapeHtml(strV)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" /></div>`;
                }).join('')}
              </div>
            </div>` : ''}
        </div>

        ${isClosedLock ? '' : '<button id="btnSaveLookup" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black shadow">💾 儲存修改並寄送異動通知信</button>'}`;

      const recalcLookupTotal = () => {
        if (feeLocked) return Number(p.totalAmount || 0);
        const nc = cats.find((c) => c.catId === $('#lkCat').value);
        const addonSum = $$('.lk-addon:checked').reduce((s, cb) => s + Number(cb.dataset.price || 0), 0);
        const total = (nc ? Number(nc.fee) : 0) + addonSum;
        $('#lkTotalDisplay').textContent = `應繳總額：NT$ ${total.toLocaleString()}`;
        return total;
      };
      if (!feeLocked) {
        $('#lkCat').onchange = recalcLookupTotal;
        $$('.lk-addon').forEach((cb) => { cb.onchange = recalcLookupTotal; });
      }

      if ($('#btnSaveLookup')) {
        $('#btnSaveLookup').onclick = async () => {
          if (!State.lookupSession || Date.now() > State.lookupSession.exp) return toast('查改已逾 45 分鐘效期，請重新驗證', 'error');
          const phone = $('#lkPhone').value.trim();
          const email = $('#lkEmail').value.trim();
          const emergName = $('#lkEmergName').value.trim();
          const emergPhone = $('#lkEmergPhone').value.trim();
          if (!/^09\d{8}$/.test(phone)) return toast('手機號碼須為 09 開頭 10 碼', 'error');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return toast('Email 格式錯誤', 'error');
          if (emergName && emergName === p.name) return toast('緊急聯絡人不可與本人同名', 'error');
          if (emergPhone && emergPhone === phone) return toast('緊急聯絡電話不可與本人手機相同', 'error');

          const patch = {
            phone,
            email,
            city: $('#lkCity').value.trim(),
            emergencyName: emergName,
            emergencyPhone: emergPhone,
            diet: $('#lkDiet').value,
            remark: $('#lkRemark').value.trim()
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

          // 嚴格把關：僅未繳費 (UNPAID) 才允許寫入費用相關欄位
          if (!feeLocked) {
            const l5 = $('#lkLast5').value.trim();
            if (l5 && !/^\d{5}$/.test(l5)) return toast('匯款末五碼限 5 位純數字', 'error');
            const addons = $$('.lk-addon:checked').map((cb) => cb.dataset.name);
            patch.catId = $('#lkCat').value;
            patch.addonsDetail = JSON.stringify(addons);
            patch.totalAmount = recalcLookupTotal();
            patch.remittanceLast5 = l5;
          }

          Object.assign(p, patch);
          await C.TurDB.put('participants', p);
          await enqueueSync('updateSelfRegistration', { participantId: p.participantId, idCard: p.idCard, patch });
          toast(isPaid ? '✅ 非費用聯絡資料已更新（費用選項維持鎖定）｜✉️ 已觸發異動確認信！' : '✅ 報名資料與應繳金額已更新｜✉️ 已觸發異動確認信！', 'success');
        };
      }
    };

    // Zone 1 Controls
    $('#z1EventSelect').onchange = (e) => { State.z1EventId = e.target.value; Z.renderZone1(AppBridge); };
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
      const isPayuni = pm === 'ONLINE_PAYUNi';
      $('#newEvPayMode').value = isPayuni ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
      $('#btnNewEvPayManual').className = `p-3 rounded-xl border-2 text-left transition ${!isPayuni ? 'border-amber-500 bg-amber-50' : 'border-slate-200 bg-white hover:border-amber-400'}`;
      $('#btnNewEvPayPayuni').className = `p-3 rounded-xl border-2 text-left transition ${isPayuni ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200 bg-white hover:border-emerald-400'}`;
    };
    $('#btnNewEvDistance').onclick = () => setNewEventRaceType('distance');
    $('#btnNewEvLap').onclick = () => setNewEventRaceType('lap_timed');
    $('#btnNewEvPayManual').onclick = () => setNewEventPayMode('MANUAL_ATM');
    $('#btnNewEvPayPayuni').onclick = () => setNewEventPayMode('ONLINE_PAYUNi');
    $('#btnCloseNewEvent').onclick = () => $('#newEventModal').classList.add('hidden');
    $('#btnCancelNewEvent').onclick = () => $('#newEventModal').classList.add('hidden');
    $('#btnZ1NewEvent').onclick = () => {
      $('#newEvNameZh').value = '';
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
      const payMode = $('#newEvPayMode').value === 'ONLINE_PAYUNi' ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
      const rawStart = ($('#newEvRaceStart')?.value || '').trim();
      if (!rawStart) return toast('請設定活動起跑日期與時間', 'warn');
      const raceStartNorm = rawStart.replace('T', ' ') + (rawStart.length === 16 ? ':00' : '');
      const isLap = raceType === 'lap_timed';
      const evId = `TUR-${Date.now().toString().slice(-6)}`;
      const lapDist = isLap ? Math.max(0.1, Number($('#newEvLapKm').value || 1.0)) : 0;
      const ev = {
        eventId: evId, ownerUsername: State.currentUser.username, nameZh, nameEn: C.zhToEnEventName(nameZh),
        organizerZh: $('#newEvOrganizer').value.trim() || 'TUR 台灣超馬協會', organizerEn: 'TUR',
        location: $('#newEvLocation').value.trim() || '台灣', raceType,
        lapDistanceKm: lapDist, debounceSeconds: 15, status: 'open',
        regStart: C.formatDateTime(), regEnd: '2026-12-31 23:59:59', raceStart: raceStartNorm, maxQuota: 500,
        bannerUrl: isLap ? 'dyn-track' : 'dyn-road',
        brochureText: isLap
          ? `【計時繞圈賽制】單圈 ${lapDist} km，於限時內通過主拱門累計有效圈數與總里程；逾限時圈次留存紀錄不計入有效里程。\n${C.DEFAULT_BROCHURE_TEMPLATE}`
          : C.DEFAULT_BROCHURE_TEMPLATE,
        formSchemaJson: JSON.stringify(C.defaultFormSchema(payMode)), certConfigJson: JSON.stringify(C.defaultCertConfig())
      };
      const cat = isLap
        ? { catId: `CAT-${evId}`, eventId: evId, name: $('#newEvLapCatName').value.trim() || '12H 繞圈組', distanceKm: lapDist, timeLimitHours: Number($('#newEvLapHrs').value || 12), fee: 2200, bibPrefix: 'L', bibStartNum: '001', quota: 300, customRaceStart: '' }
        : { catId: `CAT-${evId}`, eventId: evId, name: $('#newEvDistCatName').value.trim() || '50K 超馬組', distanceKm: Number($('#newEvDistKm').value || 50), timeLimitHours: Number($('#newEvDistHrs').value || 8), fee: 1800, bibPrefix: 'A', bibStartNum: '001', quota: 300, customRaceStart: '' };
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
      State.z1EventId = evId;
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
      if (!('NDEFReader' in window)) return toast('請使用 Android Chrome 啟動實體 NFC（電腦請用下方模擬按鈕）', 'warn');
      if (State.nfcScanning) { State.nfcScanning = false; $('#btnToggleNfcScan').textContent = '📡 啟動 NFC 感應'; return; }
      try {
        const ndef = new NDEFReader(); await ndef.scan(); State.nfcScanning = true;
        $('#btnToggleNfcScan').textContent = '🟢 NFC 感應中（點擊停止）';
        ndef.onreading = (e) => {
          if (!State.nfcScanning) return;
          const uid = String(e.serialNumber || '').toUpperCase();
          const dec = new TextDecoder(); let txt = '';
          for (const rec of e.message.records) if (rec.recordType === 'text') txt = dec.decode(rec.data);
          handleOperatorSense(txt || uid, 'nfc');
        };
      } catch (err) { toast(`NFC 失敗：${err.message}`, 'error'); }
    };

    window.addEventListener('online', () => { updateNetworkBadge(); syncPushNow(true); });
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

  const AppBridge = { State, toast, enqueueSync, syncPushNow, syncPullFromGas, updateNetworkBadge, autoAssignBibsForEvent, rebuildIndices, renderAll, switchView };

  /* --------------------------------------------------------------------------
   * Bootstrap Init
   * -------------------------------------------------------------------------- */
  async function init() {
    await C.TurDB.open();
    const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users', 'globalConfig', 'syncQueue'];
    const loaded = await Promise.all(stores.map((s) => C.TurDB.getAll(s)));
    stores.forEach((s, i) => { State[s] = loaded[i]; });

    const oldSeedIds = new Set(['TUR-20260001', 'TUR-20260002', 'TUR-20260003', 'TUR-20260004', 'TUR-20260005', 'TUR-FIN-001', 'TUR-FIN-002', 'TUR-FIN-003', 'TUR-F24-001']);
    const isUntouchedOldSeed = State.events.length > 0 && State.participants.length <= 9 && State.participants.every((p) => oldSeedIds.has(p.participantId));
    if (!State.events.length || isUntouchedOldSeed) {
      const seed = C.buildFull5EventsSeed();
      for (const k of Object.keys(seed)) {
        State[k] = seed[k];
        await C.TurDB.clearAndFill(k, seed[k]);
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

    if (location.hash === '#lookup') State.activeView = 'public-lookup';
    rebuildIndices();
    bindEvents();
    updatePayMethodUI();
    switchView(State.activeView);

    // 連網且已綁定 GAS 時，背景自動同步雲端最新 Google 試算表資料（不影響開頁秒開速度）
    if (State.gasUrl && navigator.onLine) {
      syncPullFromGas(true);
    }
  }

  init().catch((err) => { console.error(err); alert('系統初始化失敗：' + err.message); });
})(window);
