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
                  <div class="space-y-1">
                    <div class="flex justify-between text-slate-600"><span>已報名 / 限額</span><b class="mono text-slate-900">${quotaTxt}</b></div>
                    <div class="flex flex-wrap gap-1 pt-1">
                      ${cats.map((c) => `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">${C.escapeHtml(c.name)} $${c.fee}</span>`).join('')}
                    </div>
                  </div>
                  <button data-open-reg="${ev.eventId}" class="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black">📝 立即報名（支援團報 / 雙軌金流）</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`).join('');

    $$('[data-open-reg]').forEach((b) => {
      b.onclick = () => {
        State.regEventId = b.dataset.openReg;
        State.groupCart = [];
        rebuildIndices(State.regEventId);
        switchView('public-register');
      };
    });
  }

  function renderPublicRegister() {
    const ev = State.events.find((e) => e.eventId === State.regEventId) || State.events[0];
    if (!ev) return;
    $('#regEventTitle').textContent = ev.nameZh;
    $('#regEventMeta').textContent = `${ev.nameEn || ''} · ${ev.location || ''} · 主辦：${ev.organizerZh || 'TUR'}`;

    const cats = State.categories.filter((c) => c.eventId === ev.eventId);
    const prevCat = $('#regCatId').value;
    $('#regCatId').innerHTML = cats.map((c) => {
      const used = State.participants.filter((p) => p.eventId === ev.eventId && p.catId === c.catId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
      return `<option value="${c.catId}">${C.escapeHtml(c.name)} — NT$${c.fee} (剩 ${Math.max(0, Number(c.quota) - used)}/${c.quota})</option>`;
    }).join('');
    if (cats.some((c) => c.catId === prevCat)) $('#regCatId').value = prevCat;

    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    $('#regAddonsContainer').innerHTML = (schema.addons || []).map((a) => `
      <label class="flex items-center gap-2 p-2 bg-white border rounded-lg cursor-pointer hover:border-amber-400">
        <input type="checkbox" class="reg-addon" data-name="${C.escapeHtml(a.name)}" data-price="${a.price}" />
        <span>${C.escapeHtml(a.name)} <b>+$${a.price}</b></span>
      </label>`).join('') || '<span class="text-slate-400">本場無加購項目</span>';

    $('#bankAccountPreview').innerHTML = `銀行：(${getConfigVal('bankCode', '004')}) ${C.escapeHtml(getConfigVal('bankName', '台灣銀行'))}<br>帳號：<b>${C.escapeHtml(getConfigVal('bankAccount', '004-001-234567-8'))}</b><br>戶名：${C.escapeHtml(getConfigVal('bankAccountName', '台灣超馬協會'))}`;

    renderGroupCart();
    validateRegForm();
  }

  function getSelectedPayMethod() {
    return document.querySelector('input[name="payMethod"]:checked')?.value || 'MANUAL_ATM';
  }

  function updatePayMethodUI() {
    const method = getSelectedPayMethod();
    const isManual = method === 'MANUAL_ATM';
    $('#payCardManual').className = `p-3 rounded-xl border-2 cursor-pointer block ${isManual ? 'border-amber-500 bg-amber-50/70' : 'border-slate-200 bg-white'}`;
    $('#payCardPayuni').className = `p-3 rounded-xl border-2 cursor-pointer block ${!isManual ? 'border-emerald-500 bg-emerald-50/70' : 'border-slate-200 bg-white'}`;
    $('#btnSubmitSingle').textContent = isManual ? '📝 確認送出報名資料（稍後轉帳）' : '🔒 前往統一金流線上付款（秒級自動配號）';
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

    const labels = [
      ['1. 組別名額', 'cat'], ['2. 國籍三碼', 'nat'], ['3. 姓名格式', 'name'], ['4. 身分證防重', 'idCard'],
      ['5. 性別聯動', 'gender'], ['6. 10~80歲', 'birthday'], ['7. 手機09開頭', 'phone'], ['8. Email', 'email'],
      ['9. 居住縣市', 'city'], ['10. 飲食', 'diet'], ['11. 緊急不同名', 'emergName'], ['12. 緊急不同號', 'emergPhone'],
      ['13. 末五碼', 'last5'], ['14. 切結/上限', 'consent']
    ];
    $('#validationSummaryList').innerHTML = labels.map(([lbl, k]) => {
      const ok = !checks[k];
      return `<div class="px-2 py-1 rounded border ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}">${ok ? '✓' : '✕'} ${lbl}</div>`;
    }).join('');

    const split = C.splitFullName(name);
    const isValid = Object.values(checks).every((e) => e === '');
    return {
      isValid,
      runner: {
        participantId: `TUR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(10000 + Math.random() * 90000)}`,
        eventId: evId, catId, bibNumber: '', groupCode: '', groupName: $('#regGroupName').value.trim(),
        name, lastName: split.lastName, firstName: split.firstName, idCard, gender, birthday, age, nationality: nat,
        phone, email, city, emergencyName: emergName, emergencyPhone: emergPhone, diet, remark: $('#regRemark').value.trim(),
        totalAmount, addonsDetail: JSON.stringify(addons.map((a) => a.name)),
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
    $('#groupGrandTotal').textContent = `NT$ ${State.groupCart.reduce((s, r) => s + Number(r.totalAmount), 0).toLocaleString()}`;
    $('#btnSubmitGroup').disabled = false;
  }

  async function commitRunners(runners) {
    const isGroup = runners.length > 1 || Boolean(runners[0].groupName);
    const grpCode = isGroup ? `GRP26-${Math.floor(1000 + Math.random() * 8999)}` : '';
    const sharedLast5 = runners[0].remittanceLast5;
    const evId = runners[0].eventId;
    const usedBibs = new Set(State.participants.filter((p) => p.eventId === evId && p.bibNumber).map((p) => String(p.bibNumber).toUpperCase()));
    const assignedBibs = [];

    for (const r of runners) {
      if (grpCode) r.groupCode = grpCode;
      if (r.payMethod === 'MANUAL_ATM' && !r.remittanceLast5 && sharedLast5) r.remittanceLast5 = sharedLast5;

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
      toast(`⚡ PAYUNi 銷帳配號成功 (${assignedBibs.join(', ')})${cloudNote}`, toastType);
    } else {
      toast(`📝 報名成功！序號 ${runners[0].participantId}${grpCode ? `｜團報 ${grpCode}` : ''}${cloudNote}`, toastType);
    }
  }

  /* --------------------------------------------------------------------------
   * View D: Operator Locked Station Workspace (WRITER / CHECKIN / CP / FINISH / LAP)
   * -------------------------------------------------------------------------- */
  function renderOperatorStation() {
    const ev = State.events.find((e) => e.eventId === State.opEventId) || State.events[0];
    if (!ev) return;
    const stCode = State.opLockedStation;
    $('#opStationTitle').textContent = stCode === 'WRITER' ? '📡 晶片寫入與發卡專區（WRITER 鎖定）' : `⏱️ ${stCode} 站點感應控制台（單站嚴格鎖定）`;
    $('#opEventSubtitle').textContent = `${ev.nameZh} · 執勤帳號：${State.currentUser.username}`;

    const isWriter = stCode === 'WRITER';
    $('#opWriterPanel').classList.toggle('hidden', !isWriter);
    $('#opTimingPanel').classList.toggle('hidden', isWriter);

    if (isWriter) {
      $('#nfcSupportBadge').textContent = 'NDEFReader' in window ? '🟢 支援 Web NFC' : '🟡 模擬演練模式';
      renderWriterList();
      renderWriterSelected();
    } else {
      $('#lockedStationCodeBadge').textContent = stCode;
      $('#opCooldownSec').value = ev.debounceSeconds || 15;
      const paid = State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.bibNumber);
      $('#quickRunnerButtons').innerHTML = paid.map((p) => `
        <button data-op-scan="${p.bibNumber}" class="px-2.5 py-1 rounded-lg bg-white hover:bg-slate-900 hover:text-white border border-amber-300 text-xs font-bold mono">
          ${p.bibNumber} ${C.escapeHtml(p.name)}
        </button>`).join('') || '<span class="text-xs text-amber-800">本場尚無已配號選手</span>';
      renderOpLogs();
    }
  }

  function renderWriterList() {
    const q = ($('#writerSearch').value || '').trim().toUpperCase();
    const list = State.participants.filter((p) => p.eventId === State.opEventId && (!q || `${p.name} ${p.idCard} ${p.bibNumber}`.toUpperCase().includes(q)));
    $('#writerSearchList').innerHTML = list.map((p) => `
      <div class="py-2 flex items-center justify-between gap-2">
        <div>
          <div class="font-bold">${p.bibNumber || '未配號'} · ${C.escapeHtml(p.name)} [${p.nationality || 'TWN'}]</div>
          <div class="text-[11px] text-slate-500 mono">${p.idCard} · UID:${p.chipUid || '未綁'}</div>
        </div>
        <button data-pick-writer="${p.participantId}" class="px-2.5 py-1 rounded-lg bg-slate-900 text-white font-bold">帶入寫卡</button>
      </div>`).join('') || '<p class="text-slate-400 text-center py-4">查無選手</p>';
  }

  function renderWriterSelected() {
    const p = State.idxById.get(State.selectedWriterPid);
    const box = $('#writerSelectedCard');
    if (!p) { box.textContent = '請從左側點選選手「帶入寫卡」。'; return; }
    box.className = 'p-3.5 rounded-xl bg-emerald-50 border-2 border-emerald-400 text-sm';
    box.innerHTML = `<div class="font-black text-slate-900">${p.bibNumber || '未配號'} · ${C.escapeHtml(p.name)}</div><div class="text-xs mono text-slate-600 mt-1">NDEF 字串：<b>${C.escapeHtml(p.name)}|${p.idCard}</b> · UID：<b>${p.chipUid || '未綁定'}</b></div>`;
  }

  function appendWriterLog(msg) {
    const d = document.createElement('div');
    d.textContent = `[${C.formatDateTime().slice(11)}] ${msg}`;
    $('#writerLogBox').prepend(d);
  }

  async function runChipWrite(mode, sim = false) {
    const p = State.idxById.get(State.selectedWriterPid);
    if (mode !== 'legacy' && !p) return toast('請先帶入一位選手', 'warn');
    if (!sim && !('NDEFReader' in window)) return toast('請使用 Android Chrome 或點擊下方模擬按鈕', 'warn');

    if (mode === 'write') {
      const payload = `${p.name}|${p.idCard}`;
      if (sim) {
        p.chipUid = p.chipUid || `04:${Math.random().toString(16).slice(2, 4).toUpperCase()}:9F:22`;
        await C.TurDB.put('participants', p);
        rebuildIndices(State.opEventId);
        await enqueueSync('updateParticipant', { participantId: p.participantId, chipUid: p.chipUid });
        Feedback.writeOk();
        appendWriterLog(`✅ [模擬寫入+回讀驗證通過] NDEF="${payload}" (${payload.length}B) UID=${p.chipUid}`);
        renderWriterSelected(); renderWriterList();
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
          if (uid) p.chipUid = uid;
          await C.TurDB.put('participants', p);
          rebuildIndices(State.opEventId);
          await enqueueSync('updateParticipant', { participantId: p.participantId, chipUid: p.chipUid });
          appendWriterLog(`🟢 回讀驗證通過！UID=${uid}`);
          renderWriterSelected(); ndef.onreading = null;
        };
      } catch (err) { Feedback.error(); appendWriterLog(`🔴 寫入失敗：${err.message}`); }
    } else if (mode === 'uid') {
      if (sim) {
        p.chipUid = `MF:${Math.random().toString(16).slice(2, 4).toUpperCase()}:AA:11`;
        await C.TurDB.put('participants', p);
        rebuildIndices(State.opEventId);
        await enqueueSync('updateParticipant', { participantId: p.participantId, chipUid: p.chipUid });
        Feedback.writeOk();
        appendWriterLog(`🔗 [模擬 UID 綁定] ${p.name} -> ${p.chipUid}`);
        renderWriterSelected(); renderWriterList();
      } else {
        const ndef = new NDEFReader();
        await ndef.scan();
        ndef.onreading = async (e) => {
          p.chipUid = String(e.serialNumber || '').toUpperCase();
          await C.TurDB.put('participants', p);
          rebuildIndices(State.opEventId);
          await enqueueSync('updateParticipant', { participantId: p.participantId, chipUid: p.chipUid });
          Feedback.writeOk(); appendWriterLog(`🔗 UID 綁定成功：${p.chipUid}`);
          renderWriterSelected(); ndef.onreading = null;
        };
      }
    } else if (mode === 'legacy') {
      const sample = State.participants.find((x) => x.eventId === State.opEventId && String(x.payStatus).toUpperCase() === 'PAID');
      if (sim && sample) {
        Feedback.success();
        State.selectedWriterPid = sample.participantId;
        renderWriterSelected();
        appendWriterLog(`♻️ [模擬舊晶片共用核准] 讀到 ${sample.name}|${sample.idCard} -> 本場已繳費 (${sample.bibNumber})，免重發卡！`);
      } else if (!sim) {
        const ndef = new NDEFReader();
        await ndef.scan();
        ndef.onreading = (e) => {
          const uid = String(e.serialNumber || '').toUpperCase();
          const dec = new TextDecoder(); let txt = '';
          for (const rec of e.message.records) if (rec.recordType === 'text') txt = dec.decode(rec.data);
          const idPart = txt.includes('|') ? txt.split('|')[1].trim().toUpperCase() : '';
          const m = (idPart && State.idxByIdCard.get(idPart)) || State.idxByUid.get(uid);
          if (m) { Feedback.success(); State.selectedWriterPid = m.participantId; renderWriterSelected(); appendWriterLog(`♻️ 舊卡核准：${m.name} (${m.bibNumber})`); }
          else { Feedback.error(); appendWriterLog(`🔴 非本場晶片攔截：${txt || uid}`); }
          ndef.onreading = null;
        };
      }
    }
  }

  function renderOpLogs() {
    const logs = State.timingLogs.filter((l) => l.eventId === State.opEventId && l.stationCode === State.opLockedStation).reverse().slice(0, 40);
    $('#stationLogCount').textContent = `${logs.length} 筆`;
    $('#recentLogsList').innerHTML = logs.map((l) => `
      <div class="py-2 flex justify-between">
        <span><b class="mono">${l.bibNumber}</b> ${l.lapCount ? `第${l.lapCount}圈` : ''} ${l.isValid === false ? '(超時)' : ''}</span>
        <span class="mono text-slate-500">${String(l.sensedTime).slice(11)}</span>
      </div>`).join('') || '<p class="text-slate-400 text-center py-6">尚無本站感應紀錄</p>';
  }

  async function handleOperatorSense(raw, source = 'manual') {
    const t0 = performance.now();
    const token = String(raw || '').trim().toUpperCase();
    const stCode = State.opLockedStation;
    const ev = State.events.find((e) => e.eventId === State.opEventId);
    if (!token || !ev) return;

    let p = token.includes('|') ? State.idxByIdCard.get(token.split('|')[1]?.trim()) : null;
    if (!p) p = State.idxByBib.get(token) || State.idxByUid.get(token) || State.idxByIdCard.get(token);

    const banner = $('#senseResultBanner');
    if (!p || String(p.payStatus).toUpperCase() !== 'PAID' || !p.bibNumber) {
      Feedback.error();
      banner.className = 'p-5 rounded-xl bg-rose-100 border-2 border-rose-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-rose-700">🔴 攔截：非本場選手或尚未配號</div><div class="text-2xl font-black text-rose-900 mono mt-1">${C.escapeHtml(token)}</div>`;
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
    if (nowMs - (State.lastScanMap.get(key) || 0) < cooldownMs) {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 防連點冷卻保護中</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div>`;
      return;
    }
    State.lastScanMap.set(key, nowMs);

    const nowStr = C.formatDateTime(new Date(nowMs));
    let lapCount = 0, isValid = true, note = '';

    if (stCode === 'CHECKIN') {
      p.checkinStatus = 'checked_in';
      await C.TurDB.put('participants', p);
      await enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: 'checked_in' });
      note = '報到檢錄完成（不計入成績與圈數）';
    } else if (stCode === 'LAP') {
      const cat = State.categories.find((c) => c.catId === p.catId);
      lapCount = State.timingLogs.filter((l) => l.eventId === ev.eventId && l.bibNumber === p.bibNumber && l.stationCode === 'LAP' && l.isValid !== false).length + 1;
      const startDt = C.parseDateTime(ev.raceStart);
      if (startDt && cat && Number(cat.timeLimitHours) > 0 && ((nowMs - startDt.getTime()) / 1000) > Number(cat.timeLimitHours) * 3600) {
        isValid = false;
        note = `⚠️ 超時圈（留存紀錄但不計有效里程）`;
      } else {
        note = `第 ${lapCount} 圈有效｜累計 ${(lapCount * Number(ev.lapDistanceKm || cat?.distanceKm || 1)).toFixed(1)} km`;
      }
      if (p.raceStatus === 'dns') { p.raceStatus = 'on_track'; await C.TurDB.put('participants', p); }
    } else if (stCode === 'FINISH') {
      p.raceStatus = 'finished';
      await C.TurDB.put('participants', p);
      await enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'finished' });
      const startDt = C.parseDateTime(ev.raceStart);
      const sec = startDt ? Math.round((nowMs - startDt.getTime()) / 1000) + Number(p.penaltySeconds || 0) : null;
      note = `🏁 衝線完賽！整數秒成績 ${C.formatDuration(sec)}`;
    } else {
      if (p.raceStatus === 'dns') { p.raceStatus = 'on_track'; await C.TurDB.put('participants', p); }
      note = `通過 ${stCode} 檢查站`;
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
      banner.innerHTML = `<div class="text-xs font-bold text-emerald-800">🟢 感應成功 (${stCode}) · ${nowStr.slice(11)}</div><div class="text-3xl font-black text-emerald-950 mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div><div class="text-sm font-bold text-emerald-800 mt-1">${C.escapeHtml(note)}</div>`;
    } else {
      Feedback.warn();
      banner.className = 'p-5 rounded-xl bg-amber-100 border-2 border-amber-500 text-center';
      banner.innerHTML = `<div class="text-xs font-bold text-amber-800">🟡 超時無效圈已留存</div><div class="text-2xl font-black mono mt-1">${p.bibNumber} ${C.escapeHtml(p.name)}</div><div class="text-sm font-bold text-rose-700 mt-1">${C.escapeHtml(note)}</div>`;
    }
    renderOpLogs();
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

    // 雙因子反向查改 (/lookup)
    $('#btnLookupVerify').onclick = () => {
      const idCard = $('#lookupIdCard').value.trim().toUpperCase();
      const cred = $('#lookupCred').value.trim().toUpperCase();
      const p = State.participants.find((x) => String(x.idCard).toUpperCase() === idCard && (String(x.participantId).toUpperCase() === cred || String(x.email).toUpperCase() === cred));
      if (!p) return toast('查無報名資料，請確認身分證與序號/Email', 'error');
      State.lookupSession = { pid: p.participantId, exp: Date.now() + 45 * 60 * 1000 };
      const isPaid = String(p.payStatus).toUpperCase() === 'PAID';
      const cats = State.categories.filter((c) => c.eventId === p.eventId);
      $('#lookupTimerBadge').classList.remove('hidden');
      $('#lookupEditBox').classList.remove('hidden');
      $('#lookupEditBox').innerHTML = `
        <div class="p-3 rounded-xl text-xs font-bold ${isPaid ? 'bg-amber-50 border border-amber-300 text-amber-900' : 'bg-sky-50 border border-sky-200 text-sky-900'}">
          ${isPaid ? '🔒 本筆已繳費 (PAID)：組別與加購金額已鎖定，僅開放修改電話、Email、飲食與備註。' : '✏️ 待繳費 (UNPAID)：可修改組別重算金額與補填匯款末五碼。'}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div><label class="font-bold">序號 / 號碼布</label><input disabled value="${p.participantId} (${p.bibNumber || '待配號'})" class="w-full px-2.5 py-2 border rounded bg-slate-100 mono" /></div>
          <div><label class="font-bold">組別 ${isPaid ? '🔒' : ''}</label>
            <select id="lkCat" ${isPaid ? 'disabled' : ''} class="w-full px-2.5 py-2 border rounded">${cats.map((c) => `<option value="${c.catId}" ${c.catId === p.catId ? 'selected' : ''}>${C.escapeHtml(c.name)} ($${c.fee})</option>`).join('')}</select>
          </div>
          <div><label class="font-bold">末五碼 ${isPaid ? '🔒' : ''}</label><input id="lkLast5" ${isPaid ? 'disabled' : ''} value="${C.escapeHtml(p.remittanceLast5 || '')}" maxlength="5" class="w-full px-2.5 py-2 border rounded mono" /></div>
          <div><label class="font-bold">手機</label><input id="lkPhone" value="${C.escapeHtml(p.phone)}" class="w-full px-2.5 py-2 border rounded mono" /></div>
          <div><label class="font-bold">飲食</label><select id="lkDiet" class="w-full px-2.5 py-2 border rounded"><option value="葷" ${p.diet === '葷' ? 'selected' : ''}>葷食</option><option value="素" ${p.diet === '素' ? 'selected' : ''}>素食</option></select></div>
          <div><label class="font-bold">備註</label><input id="lkRemark" value="${C.escapeHtml(p.remark || '')}" class="w-full px-2.5 py-2 border rounded" /></div>
        </div>
        <button id="btnSaveLookup" class="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold">💾 儲存修改</button>`;
      $('#btnSaveLookup').onclick = async () => {
        if (!State.lookupSession || Date.now() > State.lookupSession.exp) return toast('查改已逾 45 分鐘效期', 'error');
        p.phone = $('#lkPhone').value.trim(); p.diet = $('#lkDiet').value; p.remark = $('#lkRemark').value.trim();
        if (!isPaid) {
          p.catId = $('#lkCat').value; p.remittanceLast5 = $('#lkLast5').value.trim();
          const nc = State.categories.find((c) => c.catId === p.catId); if (nc) p.totalAmount = Number(nc.fee);
        }
        await C.TurDB.put('participants', p);
        await enqueueSync('updateSelfRegistration', { participantId: p.participantId, idCard: p.idCard, patch: p });
        toast('✅ 報名資料已更新！', 'success');
      };
    };

    // Zone 1 Controls
    $('#z1EventSelect').onchange = (e) => { State.z1EventId = e.target.value; Z.renderZone1(AppBridge); };
    $$('[data-z1tab]').forEach((b) => {
      b.onclick = () => {
        $$('[data-z1tab]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        $$('.z1-panel').forEach((p) => p.classList.add('hidden'));
        $(`#z1-${b.dataset.z1tab}`).classList.remove('hidden');
      };
    });
    $('#btnZ1NewEvent').onclick = async () => {
      const nameZh = prompt('請輸入新活動中文名稱：', '2026 TUR 冬季超級馬拉松');
      if (!nameZh) return;
      const raceType = confirm('確定 = 一般距離賽 (distance)｜取消 = 繞圈計時賽 (lap_timed)') ? 'distance' : 'lap_timed';
      const evId = `TUR-${Date.now().toString().slice(-6)}`;
      const ev = {
        eventId: evId, ownerUsername: State.currentUser.username, nameZh, nameEn: C.zhToEnEventName(nameZh),
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR', location: '台灣', raceType,
        lapDistanceKm: raceType === 'lap_timed' ? 1.0 : 0, debounceSeconds: 15, status: 'open',
        regStart: C.formatDateTime(), regEnd: '2026-12-31 23:59:59', raceStart: '', maxQuota: 500,
        bannerUrl: 'banner-1', formSchemaJson: JSON.stringify(C.defaultFormSchema()), certConfigJson: JSON.stringify(C.defaultCertConfig())
      };
      const cat = { catId: `CAT-${evId}`, eventId: evId, name: raceType === 'lap_timed' ? '12H 繞圈組' : '50K 超馬組', distanceKm: raceType === 'lap_timed' ? 1.0 : 50, timeLimitHours: raceType === 'lap_timed' ? 12 : 8, fee: 1800, bibPrefix: 'A', bibStartNum: '001', quota: 300, customRaceStart: '' };
      const sts = raceType === 'lap_timed'
        ? [{ stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 }, { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'LAP', name: '繞圈門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 }]
        : [{ stationId: `ST-${evId}-0`, eventId: evId, stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 }, { stationId: `ST-${evId}-1`, eventId: evId, stationCode: 'CP1', name: 'CP1', distanceKm: 25, stationType: 'checkpoint', orderIndex: 1 }, { stationId: `ST-${evId}-2`, eventId: evId, stationCode: 'FINISH', name: '終點', distanceKm: 50, stationType: 'finish', orderIndex: 2 }];
      State.events.push(ev); State.categories.push(cat); State.stations.push(...sts);
      await C.TurDB.put('events', ev); await C.TurDB.put('categories', cat); await C.TurDB.bulkPut('stations', sts);
      await enqueueSync('saveEvent', { event: ev }); await enqueueSync('saveCategory', { category: cat });
      State.z1EventId = evId;
      renderAll();
      toast(`已建立活動「${nameZh}」（歸屬：${ev.ownerUsername}）`, 'success');
    };

    // Operator Workspace Controls
    $('#btnOutdoorToggle').onclick = () => document.body.classList.toggle('outdoor-mode');
    $('#writerSearch').oninput = renderWriterList;
    $('#writerSearchList').onclick = (e) => { if (e.target.dataset.pickWriter) { State.selectedWriterPid = e.target.dataset.pickWriter; renderWriterSelected(); } };
    $('#btnNfcWriteNtag').onclick = () => runChipWrite('write', false);
    $('#btnNfcBindUid').onclick = () => runChipWrite('uid', false);
    $('#btnNfcReadLegacy').onclick = () => runChipWrite('legacy', false);
    $('#btnSimWriteNtag').onclick = () => runChipWrite('write', true);
    $('#btnSimBindUid').onclick = () => runChipWrite('uid', true);
    $('#btnSimReadLegacy').onclick = () => runChipWrite('legacy', true);
    $('#btnSimInvalidCard').onclick = () => { Feedback.error(); appendWriterLog('🔴 [模擬異常卡] 非本場晶片已攔截！'); };

    $('#manualScanForm').onsubmit = async (e) => {
      e.preventDefault();
      const inp = $('#manualScanInput');
      if (inp.value.trim()) { await handleOperatorSense(inp.value.trim(), 'manual'); inp.value = ''; inp.focus(); }
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

    if (!State.events.length) {
      const seed = C.buildFull5EventsSeed();
      for (const k of Object.keys(seed)) {
        State[k] = seed[k];
        await C.TurDB.bulkPut(k, seed[k]);
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
