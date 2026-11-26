/**
 * ============================================================================
 * TUR v3.0 Governance Zones Module (專區 1 ~ 專區 5 + 報表/DUV/動態證書/直通控制台)
 * ============================================================================
 */
(function (global) {
  'use strict';

  const C = global.TurCore;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
    downloadBlob(filename, new Blob([text], { type: mime }));
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function maskName(n) {
    const s = String(n || '');
    if (s.length <= 1) return s;
    if (s.length === 2) return s[0] + '○';
    return s[0] + '○'.repeat(s.length - 2) + s[s.length - 1];
  }

  function maskId(id) {
    const s = String(id || '');
    if (s.length <= 4) return '****';
    return s.slice(0, 3) + '****' + s.slice(-3);
  }

  /* --------------------------------------------------------------------------
   * Role-Scoped Event Access Helpers (嚴格權責隔離)
   * -------------------------------------------------------------------------- */
  function getManagedEvents(App, includeFinished = false) {
    const u = App.State.currentUser;
    if (!u || u.role === 'public' || u.role === 'operator') return [];
    return App.State.events.filter((ev) => {
      const ownerOk = u.role === 'super_admin' || ev.ownerUsername === u.username;
      const statusOk = includeFinished ? ev.status === 'finished' : ev.status !== 'finished';
      return ownerOk && statusOk;
    });
  }

  /* --------------------------------------------------------------------------
   * Official 3-Sheet Excel (.xlsx), Chip CSV, DUV & 800-Warriors Export
   * -------------------------------------------------------------------------- */
  function export3SheetExcel(App, ev, masked = false) {
    const rows = C.computeLeaderboard({
      event: ev,
      categories: App.State.categories,
      stations: App.State.stations,
      participants: App.State.participants,
      timingLogs: App.State.timingLogs
    });

    const summaryData = rows.map((r) => {
      const p = r.participant;
      const base = {
        總名次: r.overallRank,
        組名次: r.catRank,
        號碼布: p.bibNumber,
        姓名: masked ? maskName(p.name) : p.name,
        性別: p.gender,
        國籍: p.nationality || 'TWN',
        組別: r.category.name,
        狀態: r.status,
        有效圈數: r.lapCount,
        '有效距離(km)': r.totalDistanceKm,
        '罰時(秒)': p.penaltySeconds || 0,
        總成績: C.formatDuration(r.elapsedSec),
        平均配速: r.avgPace,
        八百壯士: r.isWarrior800 ? '是' : ''
      };
      if (!masked) {
        base['身分證/護照'] = p.idCard;
        base['生日'] = p.birthday;
        base['手機'] = p.phone;
        base['Email'] = p.email;
      }
      return base;
    });

    const splitData = [];
    rows.forEach((r) => {
      (r.splitDetails || []).forEach((sp) => {
        splitData.push({
          號碼布: r.participant.bibNumber,
          姓名: masked ? maskName(r.participant.name) : r.participant.name,
          站點: sp.code,
          站名: sp.name,
          通過時間: sp.time,
          累計時間: C.formatDuration(sp.cumSec),
          區段均速: sp.segPace
        });
      });
    });

    const rosterData = App.State.participants
      .filter((p) => p.eventId === ev.eventId)
      .map((p) => ({
        報名序號: p.participantId,
        團報代碼: p.groupCode || '',
        號碼布: p.bibNumber || '',
        姓名: masked ? maskName(p.name) : p.name,
        身分證: masked ? maskId(p.idCard) : p.idCard,
        國籍: p.nationality || 'TWN',
        付款管道: p.payMethod,
        繳費狀態: p.payStatus,
        應繳金額: p.totalAmount,
        晶片UID: p.chipUid || ''
      }));

    if (global.XLSX) {
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(summaryData.length ? summaryData : [{ 提示: '尚無成績' }]), '總成績');
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(splitData.length ? splitData : [{ 提示: '尚無感應明細' }]), '各站與逐圈明細');
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(rosterData.length ? rosterData : [{ 提示: '尚無名冊' }]), '選手名冊');
      global.XLSX.writeFile(wb, `${ev.nameZh}_${masked ? '隱碼公開版' : '完整存檔版'}.xlsx`);
      App.toast(`📊 已匯出 3 工作表 Excel（${masked ? '隱碼公開版' : '完整存檔版'}）`, 'success');
    } else {
      const headers = Object.keys(summaryData[0] || { 號碼布: '' });
      const csv = '\uFEFF' + [headers.join(','), ...summaryData.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
      downloadText(`${ev.eventId}_${masked ? '隱碼公開版' : '完整存檔版'}.csv`, csv, 'text/csv;charset=utf-8');
    }
  }

  function export800WarriorsExcel(App, ev) {
    const rows = C.computeLeaderboard({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    }).filter((r) => r.isWarrior800);

    if (rows.length === 0) {
      return App.toast('本場尚無達 100K+ 八百壯士資格之完賽選手', 'warn');
    }
    const data = rows.map((r, i) => ({
      榮譽序號: i + 1,
      號碼布: r.participant.bibNumber,
      姓名: r.participant.name,
      性別: r.participant.gender,
      國籍: r.participant.nationality || 'TWN',
      組別: r.category.name,
      '有效里程(km)': r.totalDistanceKm,
      完賽時間: C.formatDuration(r.elapsedSec),
      總名次: r.overallRank
    }));

    if (global.XLSX) {
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(data), '八百壯士100K+');
      global.XLSX.writeFile(wb, `${ev.nameZh}_800壯士超馬.xlsx`);
      App.toast(`🏅 已獨立匯出 ${rows.length} 位八百壯士名單！`, 'success');
    } else {
      const hs = Object.keys(data[0]);
      const csv = '\uFEFF' + [hs.join(','), ...data.map((r) => hs.map((h) => csvCell(r[h])).join(','))].join('\r\n');
      downloadText(`${ev.nameZh}_800壯士超馬.csv`, csv, 'text/csv;charset=utf-8');
    }
  }

  function exportChipCsv(App, ev) {
    const parts = App.State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID');
    const catMap = new Map(App.State.categories.map((c) => [c.catId, c.name]));
    const headers = ['bibNumber', 'name', 'idCard', 'gender', 'birthday', 'nationality', 'category', 'chipUid', 'ndefPayload'];
    const lines = [headers.join(',')];
    parts.forEach((p) => {
      lines.push([
        p.bibNumber || '', p.name, p.idCard, p.gender, p.birthday, p.nationality || 'TWN',
        catMap.get(p.catId) || p.catId, p.chipUid || '', `${p.name}|${p.idCard}`
      ].map(csvCell).join(','));
    });
    downloadText(`${ev.eventId}_晶片專用名單.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    App.toast(`📡 已匯出晶片專用 CSV（${parts.length} 位已繳費選手）`, 'success');
  }

  function buildDuvText(App, ev, delimiter = '\t') {
    const rows = C.computeLeaderboard({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    });
    const dateStr = (ev.raceStart || C.formatDateTime()).slice(0, 10);
    const fmt = ev.raceType === 'lap_timed' ? 'Timed Race (Lap Ultra)' : 'Distance Race';
    const join = (arr) => delimiter === ',' ? arr.map(csvCell).join(',') : arr.map((v) => String(v ?? '').replace(/\t|\r|\n/g, ' ')).join('\t');

    const lines = [
      join(['Event Name', 'Date', 'Race Format', 'Organizer', 'Country', 'Event ID']),
      join([ev.nameEn || ev.nameZh, dateStr, fmt, ev.organizerEn || ev.organizerZh || 'TUR', 'TWN', ev.eventId]),
      join(['Rank', 'Bib', 'Last Name', 'First Name', 'Gender', 'DOB', 'Nationality', 'Category', 'Performance', 'Distance (km)', 'Status'])
    ];

    rows.forEach((r) => {
      const p = r.participant;
      const split = (p.lastName || p.firstName) ? { lastName: p.lastName, firstName: p.firstName } : C.splitFullName(p.name);
      const gender = p.gender || C.inferGenderFromId(p.idCard) || 'M';
      const perf = ev.raceType === 'lap_timed'
        ? `${r.totalDistanceKm.toFixed(3)} km (${C.formatDuration(r.elapsedSec)})`
        : C.formatDuration(r.elapsedSec);
      lines.push(join([
        r.overallRank, p.bibNumber, split.lastName, split.firstName, gender,
        p.birthday || '', p.nationality || 'TWN', r.category.name, perf,
        r.totalDistanceKm.toFixed(3), String(r.status || 'dns').toUpperCase()
      ]));
    });
    return lines.join('\r\n');
  }

  /* --------------------------------------------------------------------------
   * 專區 1：🏃 進行中活動管理（5 分頁）
   * -------------------------------------------------------------------------- */
  function renderZone1(App) {
    const managed = getManagedEvents(App, false);
    const sel = $('#z1EventSelect');
    if (!managed.length) {
      sel.innerHTML = '<option value="">（目前無進行中活動，請建立新活動或至專區 2 解鎖）</option>';
      $$('.z1-panel').forEach((p) => { p.innerHTML = '<div class="bg-white p-8 rounded-xl border text-center text-slate-400 text-sm">您名下目前沒有進行中的活動。請點擊上方「+ 建立新活動」。</div>'; });
      return;
    }
    if (!managed.some((e) => e.eventId === App.State.z1EventId)) {
      App.State.z1EventId = managed[0].eventId;
    }
    sel.innerHTML = managed.map((e) => `<option value="${e.eventId}" ${e.eventId === App.State.z1EventId ? 'selected' : ''}>${C.escapeHtml(e.nameZh)} (${e.ownerUsername})</option>`).join('');
    const ev = managed.find((e) => e.eventId === App.State.z1EventId);

    renderZ1Setup(App, ev);
    renderZ1Recon(App, ev);
    renderZ1Gun(App, ev);
    renderZ1Score(App, ev);
    renderZ1Ops(App, ev);
  }

  function renderZ1Setup(App, ev) {
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const box = $('#z1-setup');

    box.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- 活動基本設定 -->
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-3 text-xs">
          <h3 class="font-black text-sm border-b pb-2">⚙️ 活動基本參數與橫幅（輸入中文自動產生英文賽名）</h3>
          <div class="grid grid-cols-2 gap-2.5">
            <div class="col-span-2">
              <label class="font-bold">中文活動名稱</label>
              <input id="z1NameZh" value="${C.escapeHtml(ev.nameZh)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div class="col-span-2">
              <label class="font-bold">英文活動名稱（DUV 送審用，可自訂微調）</label>
              <input id="z1NameEn" value="${C.escapeHtml(ev.nameEn)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div>
              <label class="font-bold">賽制類型</label>
              <select id="z1RaceType" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5">
                <option value="distance" ${ev.raceType === 'distance' ? 'selected' : ''}>一般距離賽 (distance)</option>
                <option value="lap_timed" ${ev.raceType === 'lap_timed' ? 'selected' : ''}>繞圈計時賽 (lap_timed)</option>
              </select>
            </div>
            <div>
              <label class="font-bold">活動狀態</label>
              <select id="z1Status" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5">
                ${['open', 'draft', 'closed', 'auto'].map((st) => `<option value="${st}" ${ev.status === st ? 'selected' : ''}>${st}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="font-bold">繞圈單圈里程 (km)</label>
              <input id="z1LapDist" type="number" step="0.1" value="${ev.lapDistanceKm || 0}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 mono" />
            </div>
            <div>
              <label class="font-bold">總名額上限 (0=不限)</label>
              <input id="z1MaxQuota" type="number" value="${ev.maxQuota || 0}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 mono" />
            </div>
            <div>
              <label class="font-bold">主辦單位 (中文)</label>
              <input id="z1OrgZh" value="${C.escapeHtml(ev.organizerZh || '')}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div>
              <label class="font-bold">活動地點</label>
              <input id="z1Loc" value="${C.escapeHtml(ev.location || '')}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
          </div>

          <!-- 10 款精選橫幅與 5MB 自訂上傳 -->
          <div class="space-y-1.5 pt-2 border-t">
            <label class="font-bold block">活動橫幅（10 款精選或上傳自訂圖片 ≤ 5MB）</label>
            <div class="h-20 rounded-xl flex items-end p-3 text-white font-black text-sm shadow-inner" id="z1BannerPreview" style="${C.getBannerStyle(ev.bannerUrl)}">${C.escapeHtml(ev.nameZh)}</div>
            <div class="grid grid-cols-5 gap-1">
              ${C.CURATED_BANNERS.map((b) => `<button type="button" data-pick-banner="${b.id}" class="h-6 rounded border ${ev.bannerUrl === b.id ? 'ring-2 ring-amber-400' : ''}" style="background:${b.css};" title="${b.name}"></button>`).join('')}
            </div>
            <input id="z1BannerUpload" type="file" accept="image/*" class="text-[11px]" />
          </div>
          <button id="btnZ1SaveEvent" class="w-full py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black">💾 儲存活動設定</button>
        </div>

        <!-- 分組設定 + 動態加購項目 -->
        <div class="space-y-4 text-xs">
          <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
            <div class="flex items-center justify-between border-b pb-2">
              <h3 class="font-black text-sm">🏷️ 分組里程 / 限時 / 配號前綴</h3>
              <button id="btnZ1AddCat" class="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold">+ 新增分組</button>
            </div>
            <div class="space-y-1.5">
              ${cats.map((c) => `
                <div class="p-2 rounded-lg bg-slate-50 border flex items-center justify-between">
                  <div><b>${C.escapeHtml(c.name)}</b> · ${c.distanceKm}km / ${c.timeLimitHours}H · NT$${c.fee} · 前綴 <code>${c.bibPrefix}${c.bibStartNum}</code> · 限額 ${c.quota}</div>
                  <button data-del-cat="${c.catId}" class="text-rose-600 font-bold px-1.5">刪</button>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
            <div class="flex items-center justify-between border-b pb-2">
              <h3 class="font-black text-sm">🛍️ 動態加購服務管理（承辦人可自由增修刪）</h3>
              <button id="btnZ1AddAddon" class="px-2.5 py-1 rounded-lg bg-amber-500 text-slate-950 font-bold">+ 新增加購項</button>
            </div>
            <div class="space-y-1.5">
              ${(schema.addons || []).map((a, idx) => `
                <div class="p-2 rounded-lg bg-slate-50 border flex items-center justify-between">
                  <span><b>${C.escapeHtml(a.name)}</b> — +NT$${a.price}</span>
                  <button data-del-addon="${idx}" class="text-rose-600 font-bold px-1.5">移除</button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>`;

    $('#z1NameZh').oninput = (e) => { $('#z1NameEn').value = C.zhToEnEventName(e.target.value); };
    $$('[data-pick-banner]').forEach((b) => {
      b.onclick = () => {
        ev.bannerUrl = b.dataset.pickBanner;
        $('#z1BannerPreview').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
      };
    });
    $('#z1BannerUpload').onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return App.toast('橫幅圖片上限為 5MB！', 'error');
      const reader = new FileReader();
      reader.onload = () => {
        ev.bannerUrl = reader.result;
        $('#z1BannerPreview').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
      };
      reader.readAsDataURL(f);
    };
    $('#btnZ1SaveEvent').onclick = async () => {
      ev.nameZh = $('#z1NameZh').value.trim() || ev.nameZh;
      ev.nameEn = $('#z1NameEn').value.trim() || C.zhToEnEventName(ev.nameZh);
      ev.raceType = $('#z1RaceType').value;
      ev.status = $('#z1Status').value;
      ev.lapDistanceKm = Number($('#z1LapDist').value || 0);
      ev.maxQuota = Number($('#z1MaxQuota').value || 0);
      ev.organizerZh = $('#z1OrgZh').value.trim();
      ev.location = $('#z1Loc').value.trim();
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.renderAll();
      App.toast('✅ 活動設定已儲存並排入同步', 'success');
    };
    $('#btnZ1AddCat').onclick = async () => {
      const name = prompt('分組名稱（如 21K 半馬組）：');
      if (!name) return;
      const dist = Number(prompt('距離 (km，繞圈賽請填單圈公里數)：', '21.1') || 21.1);
      const hrs = Number(prompt('限時 (小時)：', '4') || 4);
      const fee = Number(prompt('報名費 (NT$)：', '1200') || 1200);
      const prefix = (prompt('號碼布前綴 (如 B)：', 'B') || 'B').toUpperCase();
      const cat = { catId: `CAT-${Date.now().toString().slice(-5)}`, eventId: ev.eventId, name, distanceKm: dist, timeLimitHours: hrs, fee, bibPrefix: prefix, bibStartNum: '001', quota: 300, customRaceStart: '' };
      App.State.categories.push(cat);
      await C.TurDB.put('categories', cat);
      await App.enqueueSync('saveCategory', { category: cat });
      renderZone1(App);
      App.toast('已新增分組', 'success');
    };
    $$('[data-del-cat]').forEach((b) => {
      b.onclick = async () => {
        App.State.categories = App.State.categories.filter((c) => c.catId !== b.dataset.delCat);
        await C.TurDB.remove('categories', b.dataset.delCat);
        renderZone1(App);
      };
    });
    $('#btnZ1AddAddon').onclick = async () => {
      const name = prompt('加購項目名稱（如 賽事機能襪）：');
      if (!name) return;
      const price = Number(prompt('加購金額 (NT$)：', '250') || 250);
      schema.addons.push({ code: 'addon_' + Date.now(), name, price });
      ev.formSchemaJson = JSON.stringify(schema);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      renderZone1(App);
    };
    $$('[data-del-addon]').forEach((b) => {
      b.onclick = async () => {
        schema.addons.splice(Number(b.dataset.delAddon), 1);
        ev.formSchemaJson = JSON.stringify(schema);
        await C.TurDB.put('events', ev);
        await App.enqueueSync('saveEvent', { event: ev });
        renderZone1(App);
      };
    });
  }

  function renderZ1Recon(App, ev) {
    const parts = App.State.participants.filter((p) => p.eventId === ev.eventId);
    const catMap = new Map(App.State.categories.map((c) => [c.catId, c.name]));
    const unpaid = parts.filter((p) => String(p.payStatus).toUpperCase() === 'UNPAID' || String(p.payStatus).toUpperCase() === 'PENDING_PAY');
    const paid = parts.filter((p) => String(p.payStatus).toUpperCase() === 'PAID');
    const groupsUnpaid = [...new Set(unpaid.map((p) => p.groupCode).filter(Boolean))];

    const sorted = [...parts].sort((a, b) => {
      const rank = (s) => (s === 'UNPAID' || s === 'PENDING_PAY') ? 0 : (s === 'PAID' ? 1 : 2);
      const ra = rank(String(a.payStatus).toUpperCase()), rb = rank(String(b.payStatus).toUpperCase());
      if (ra !== rb) return ra - rb;
      return String(a.bibNumber || 'ZZZ').localeCompare(String(b.bibNumber || 'ZZZ'));
    });

    const box = $('#z1-recon');
    box.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="bg-white p-3 rounded-xl border"><div class="text-slate-500">本場報名總數</div><div class="text-2xl font-black mono">${parts.length}</div></div>
        <div class="bg-rose-50 p-3 rounded-xl border border-rose-200"><div class="text-rose-700 font-bold">待對帳未繳 (紅底置頂)</div><div class="text-2xl font-black mono text-rose-700">${unpaid.length}</div></div>
        <div class="bg-emerald-50 p-3 rounded-xl border border-emerald-200"><div class="text-emerald-700 font-bold">已繳費 (PAID)</div><div class="text-2xl font-black mono text-emerald-700">${paid.length}</div></div>
        <div class="bg-sky-50 p-3 rounded-xl border border-sky-200"><div class="text-sky-700 font-bold">已配發號碼布</div><div class="text-2xl font-black mono text-sky-700">${parts.filter((p) => p.bibNumber).length}</div></div>
      </div>

      <div class="bg-white p-3 rounded-xl border shadow-sm flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap gap-1.5">
          <button id="btnZ1BatchPaid" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold">✅ 勾選批次入帳</button>
          ${groupsUnpaid.map((gc) => `<button data-group-paid="${gc}" class="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-black">👥 整團入帳 ${gc}</button>`).join('')}
          <button id="btnZ1AutoBib" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold">🏷️ 依組別自動配號 (Bib)</button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button id="btnZ1ExportXlsx" class="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold">📊 匯出 Excel (.xlsx)</button>
          <button id="btnZ1ExportChipCsv" class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold">📡 匯出晶片 CSV</button>
          <button id="btnZ1ToggleExtCsv" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold border">📥 外部 CSV / 文字匯入</button>
        </div>
      </div>

      <!-- 外部賽事備援：CSV 匯入或貼上文字批次匯入 -->
      <div id="z1ExtImportBox" class="hidden bg-amber-50 p-4 rounded-xl border-2 border-amber-300 space-y-2 text-xs">
        <div class="font-black text-amber-950">📥 外部選手 CSV / 貼上文字批次匯入（支援未透過本系統報名之外場賽事）</div>
        <p class="text-amber-900">格式：每行一筆，欄位以逗號或 Tab 分隔：<code>姓名,身分證,性別(M/F),國籍(TWN),號碼布(選填),晶片UID(選填)</code>（直接設為已繳費 PAID）</p>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="z1ExtCsvFile" type="file" accept=".csv,.txt" class="text-xs" />
        </div>
        <textarea id="z1ExtCsvText" rows="4" placeholder="林大為,A123456789,M,TWN,A088,&#10;陳小美,F223456786,F,TWN,A089," class="w-full p-2 border rounded-lg mono text-xs bg-white"></textarea>
        <button id="btnZ1RunExtImport" class="px-4 py-2 rounded-lg bg-amber-500 text-slate-950 font-black">✅ 執行批次匯入至本場活動</button>
      </div>

      <div class="bg-white rounded-xl border shadow-sm overflow-x-auto">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-100 border-b">
            <tr>
              <th class="p-2"><input type="checkbox" id="z1CheckAll" /></th>
              <th class="p-2">狀態 / 管道</th><th class="p-2">號碼布</th><th class="p-2">姓名 / 國籍 / 團報碼</th>
              <th class="p-2">組別</th><th class="p-2">金額</th><th class="p-2">末五碼 / 金流單號</th><th class="p-2">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            ${sorted.map((p) => {
              const st = String(p.payStatus).toUpperCase();
              const isUn = st === 'UNPAID' || st === 'PENDING_PAY';
              return `
                <tr class="${isUn ? 'bg-rose-50/90' : ''}">
                  <td class="p-2"><input type="checkbox" class="z1-cb" value="${p.participantId}" ${isUn ? '' : 'disabled'} /></td>
                  <td class="p-2 whitespace-nowrap">
                    <span class="px-2 py-0.5 rounded-full font-bold ${isUn ? 'bg-rose-600 text-white' : 'bg-emerald-100 text-emerald-800'}">${st}</span>
                    <div class="text-[10px] text-slate-500 mt-0.5">${p.payMethod || 'MANUAL_ATM'}</div>
                  </td>
                  <td class="p-2 mono font-black">${p.bibNumber || '<span class="text-slate-400 font-normal">未配</span>'}</td>
                  <td class="p-2">
                    <div class="font-bold">${C.escapeHtml(p.name)} <span class="px-1 rounded bg-sky-100 text-sky-800 text-[10px]">${p.nationality || 'TWN'}</span></div>
                    <div class="text-[10px] text-slate-500 mono">${p.idCard} ${p.groupCode ? `· <b class="text-amber-700">${p.groupCode}</b>` : ''}</div>
                  </td>
                  <td class="p-2">${C.escapeHtml(catMap.get(p.catId) || p.catId)}</td>
                  <td class="p-2 mono font-bold">NT$${Number(p.totalAmount).toLocaleString()}</td>
                  <td class="p-2 mono text-[11px]">${p.remittanceLast5 || p.merTradeNo || '-'}</td>
                  <td class="p-2">
                    ${isUn ? `<button data-mark-paid="${p.participantId}" class="px-2 py-1 rounded bg-emerald-600 text-white font-bold">確認入帳</button>` : '<span class="text-emerald-700 font-bold">✓</span>'}
                  </td>
                </tr>`;
            }).join('') || '<tr><td colspan="8" class="p-6 text-center text-slate-400">尚無報名資料</td></tr>'}
          </tbody>
        </table>
      </div>`;

    $('#z1CheckAll').onchange = (e) => $$('.z1-cb:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
    $$('[data-mark-paid]').forEach((b) => {
      b.onclick = () => markParticipantsPaid(App, [b.dataset.markPaid]);
    });
    $('#btnZ1BatchPaid').onclick = () => {
      const ids = $$('.z1-cb:checked').map((c) => c.value);
      if (!ids.length) return App.toast('請先勾選未繳費選手', 'warn');
      markParticipantsPaid(App, ids);
    };
    $$('[data-group-paid]').forEach((b) => {
      b.onclick = () => {
        const gc = b.dataset.groupPaid;
        const ids = parts.filter((p) => p.groupCode === gc && String(p.payStatus).toUpperCase() !== 'PAID').map((p) => p.participantId);
        markParticipantsPaid(App, ids, `整團 ${gc} 共 ${ids.length} 人`);
      };
    });
    $('#btnZ1AutoBib').onclick = () => App.autoAssignBibsForEvent(ev.eventId);
    $('#btnZ1ExportXlsx').onclick = () => export3SheetExcel(App, ev, false);
    $('#btnZ1ExportChipCsv').onclick = () => exportChipCsv(App, ev);
    $('#btnZ1ToggleExtCsv').onclick = () => $('#z1ExtImportBox').classList.toggle('hidden');
    $('#z1ExtCsvFile').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (f) $('#z1ExtCsvText').value = await f.text();
    };
    $('#btnZ1RunExtImport').onclick = async () => {
      const raw = $('#z1ExtCsvText').value.trim();
      if (!raw) return App.toast('請貼入或選擇外部 CSV 內容', 'warn');
      const defaultCat = App.State.categories.find((c) => c.eventId === ev.eventId);
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const added = [];
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(/,|\t/).map((s) => s.trim());
        if (!cols[0] || /姓名|name/i.test(cols[0])) continue;
        const split = C.splitFullName(cols[0]);
        const idCard = String(cols[1] || `EXT${Date.now().toString().slice(-6)}${i}`).toUpperCase();
        const rec = {
          participantId: `EXT-${Date.now().toString().slice(-6)}-${i}`,
          eventId: ev.eventId, catId: defaultCat?.catId || '', bibNumber: (cols[4] || '').toUpperCase(),
          groupCode: '', groupName: '外部匯入', name: cols[0], lastName: split.lastName, firstName: split.firstName,
          idCard, gender: (cols[2] || C.inferGenderFromId(idCard) || 'M').toUpperCase(),
          birthday: '1990-01-01', age: 36, nationality: (cols[3] || 'TWN').toUpperCase(),
          phone: '', email: '', city: '', emergencyName: '', emergencyPhone: '', diet: '葷', remark: '外部 CSV 匯入',
          totalAmount: Number(defaultCat?.fee || 0), addonsDetail: '[]', payMethod: 'MANUAL_ATM', remittanceLast5: '',
          merTradeNo: '', payStatus: 'PAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: C.formatDateTime(),
          chipUid: (cols[5] || '').toUpperCase(), checkinStatus: 'pending', raceStatus: 'dns', penaltySeconds: 0, createdAt: C.formatDateTime()
        };
        App.State.participants.push(rec);
        await C.TurDB.put('participants', rec);
        added.push(rec);
      }
      if (added.length) await App.enqueueSync('registerRunner', { runners: added });
      App.rebuildIndices();
      App.renderAll();
      App.toast(`📥 成功匯入 ${added.length} 位外部選手！`, 'success');
    };
  }

  async function markParticipantsPaid(App, ids, label = '') {
    const now = C.formatDateTime();
    for (const pid of ids) {
      const p = App.State.participants.find((x) => x.participantId === pid);
      if (p) {
        p.payStatus = 'PAID';
        p.paidAt = now;
        await C.TurDB.put('participants', p);
        await App.enqueueSync('updateParticipant', { participantId: pid, payStatus: 'PAID', paidAt: now });
      }
    }
    App.rebuildIndices();
    App.renderAll();
    App.toast(`✅ 已確認入帳（${label || ids.length + ' 筆'}）並排入自動寄信通知！`, 'success');
  }

  function renderZ1Gun(App, ev) {
    const sts = App.State.stations.filter((s) => s.eventId === ev.eventId).sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const box = $('#z1-gun');
    box.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div class="bg-slate-900 text-white p-5 rounded-2xl space-y-3 shadow">
          <div class="text-amber-400 font-bold">🔫 統一鳴槍與跨夜完整日期防呆（YYYY-MM-DD HH:mm:ss）</div>
          <div class="text-3xl font-black mono text-amber-300" id="z1GunDisplay">${ev.raceStart || '尚未鳴槍'}</div>
          <div class="flex flex-wrap gap-2">
            <button id="btnZ1GunNow" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 font-black text-sm shadow">🔫 立即鳴槍開跑</button>
          </div>
          <div class="pt-2 border-t border-slate-700 flex gap-2">
            <input id="z1CustomGunTime" value="${ev.raceStart || C.formatDateTime()}" placeholder="YYYY-MM-DD HH:mm:ss" class="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 mono text-white" />
            <button id="btnZ1ApplyGunTime" class="px-3 py-2 rounded-lg bg-amber-400 text-slate-950 font-black">套用指定時間</button>
          </div>
        </div>

        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
          <div class="flex items-center justify-between border-b pb-2">
            <h3 class="font-black text-sm">📍 賽道感應站點配置</h3>
            <button id="btnZ1AddStation" class="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold">+ 新增站點</button>
          </div>
          <div class="space-y-1.5">
            ${sts.map((s) => `
              <div class="p-2 rounded-lg bg-slate-50 border flex items-center justify-between">
                <span><b class="mono">${s.stationCode}</b> · ${C.escapeHtml(s.name)} (${s.distanceKm} km / ${s.stationType})</span>
                <button data-del-st="${s.stationId}" class="text-rose-600 font-bold">刪</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>`;

    const applyGun = async (timeStr) => {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeStr)) {
        return App.toast('起跑時間強制包含完整日期與整數秒：YYYY-MM-DD HH:mm:ss', 'error');
      }
      ev.raceStart = timeStr;
      await C.TurDB.put('events', ev);
      for (const p of App.State.participants) {
        if (p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.raceStatus === 'dns') {
          p.raceStatus = 'on_track';
          await C.TurDB.put('participants', p);
        }
      }
      await App.enqueueSync('triggerGunStart', { eventId: ev.eventId, raceStart: timeStr });
      App.renderAll();
      App.toast(`🔫 鳴槍時間已寫入：${timeStr}`, 'success');
    };
    $('#btnZ1GunNow').onclick = () => applyGun(C.formatDateTime());
    $('#btnZ1ApplyGunTime').onclick = () => applyGun($('#z1CustomGunTime').value.trim());
    $('#btnZ1AddStation').onclick = async () => {
      const code = (prompt('站點代碼（如 CP3 / FINISH / LAP）：', 'CP3') || '').trim().toUpperCase();
      if (!code) return;
      const name = prompt('站點名稱：', `${code} 檢查站`) || code;
      const km = Number(prompt('累計距離 (km)：', '40') || 0);
      const st = { stationId: `ST-${Date.now().toString().slice(-5)}`, eventId: ev.eventId, stationCode: code, name, distanceKm: km, stationType: code === 'FINISH' ? 'finish' : (code === 'LAP' ? 'lap' : 'checkpoint'), orderIndex: sts.length };
      App.State.stations.push(st);
      await C.TurDB.put('stations', st);
      await App.enqueueSync('saveStation', { station: st });
      renderZone1(App);
    };
    $$('[data-del-st]').forEach((b) => {
      b.onclick = async () => {
        App.State.stations = App.State.stations.filter((s) => s.stationId !== b.dataset.delSt);
        await C.TurDB.remove('stations', b.dataset.delSt);
        renderZone1(App);
      };
    });
  }

  function renderZ1Score(App, ev) {
    const rows = C.computeLeaderboard({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    });
    const logs = App.State.timingLogs.filter((l) => l.eventId === ev.eventId).reverse();
    const sts = App.State.stations.filter((s) => s.eventId === ev.eventId);

    const box = $('#z1-score');
    box.innerHTML = `
      <div class="bg-amber-50 border-2 border-amber-300 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div class="font-black text-amber-950">🔒 階段 5 結案鎖定防誤改</div>
          <div class="text-amber-900">確認所有手機已完成上傳並核對完畢後，點右側結案鎖定；活動將移至「專區 2：已結案專區」核發報表、DUV 與動態證書。</div>
        </div>
        <button id="btnZ1LockFinish" class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black shadow">🔒 設為已結束 (finished) 並鎖定結案</button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <!-- 選手成績與罰時微調 -->
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2">
          <h3 class="font-black text-sm">⚖️ 即時排名 / 狀態 / 罰時微調（整數秒）</h3>
          <div class="max-h-96 overflow-y-auto">
            <table class="w-full text-left">
              <thead class="bg-slate-100 sticky top-0">
                <tr><th class="p-1.5">名次</th><th class="p-1.5">號碼布/姓名</th><th class="p-1.5">成績/里程</th><th class="p-1.5">狀態</th><th class="p-1.5">罰時(s)</th><th class="p-1.5">存</th></tr>
              </thead>
              <tbody class="divide-y">
                ${rows.map((r) => `
                  <tr>
                    <td class="p-1.5 font-black mono text-amber-600">${r.overallRank}</td>
                    <td class="p-1.5"><b>${r.participant.bibNumber}</b> ${C.escapeHtml(r.participant.name)}</td>
                    <td class="p-1.5 mono">${C.formatDuration(r.elapsedSec)}<div class="text-[10px] text-emerald-700">${r.totalDistanceKm} km ${r.lapCount ? `(${r.lapCount}圈)` : ''}</div></td>
                    <td class="p-1.5">
                      <select data-z1-st="${r.participant.participantId}" class="border rounded px-1 py-0.5">
                        ${['dns', 'on_track', 'finished', 'dnf'].map((s) => `<option value="${s}" ${r.participant.raceStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                    </td>
                    <td class="p-1.5"><input data-z1-pen="${r.participant.participantId}" type="number" value="${r.participant.penaltySeconds || 0}" class="w-14 border rounded px-1 py-0.5 mono" /></td>
                    <td class="p-1.5"><button data-z1-save-p="${r.participant.participantId}" class="px-2 py-0.5 rounded bg-slate-900 text-white font-bold">套用</button></td>
                  </tr>`).join('') || '<tr><td colspan="6" class="p-4 text-center text-slate-400">尚無排號選手</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <!-- 逐圈/各站補登與刪除 -->
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
          <h3 class="font-black text-sm">🛠️ 補登漏卡 / 逐圈明細作廢還原</h3>
          <form id="z1AddLogForm" class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 bg-slate-50 p-2 rounded-lg border">
            <input id="z1LogBib" placeholder="號碼布" required class="px-2 py-1 border rounded uppercase mono" />
            <select id="z1LogSt" class="px-2 py-1 border rounded">${sts.map((s) => `<option value="${s.stationCode}">${s.stationCode}</option>`).join('')}</select>
            <input id="z1LogTime" value="${C.formatDateTime()}" required class="px-2 py-1 border rounded mono" />
            <button type="submit" class="px-2 py-1 rounded bg-slate-900 text-white font-bold">+ 補登</button>
          </form>
          <div class="max-h-72 overflow-y-auto">
            <table class="w-full text-left">
              <thead class="bg-slate-100 sticky top-0"><tr><th class="p-1.5">號碼布</th><th class="p-1.5">站點</th><th class="p-1.5">時間</th><th class="p-1.5">狀態</th></tr></thead>
              <tbody class="divide-y">
                ${logs.map((l) => `
                  <tr class="${l.isValid === false ? 'bg-rose-50 text-slate-400 line-through' : ''}">
                    <td class="p-1.5 mono font-bold">${l.bibNumber}</td>
                    <td class="p-1.5 mono">${l.stationCode}${l.lapCount ? `#${l.lapCount}` : ''}</td>
                    <td class="p-1.5 mono">${l.sensedTime}</td>
                    <td class="p-1.5"><button data-z1-toggle-log="${l.logId}" class="px-2 py-0.5 rounded font-bold ${l.isValid === false ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-700'}">${l.isValid === false ? '還原' : '作廢'}</button></td>
                  </tr>`).join('') || '<tr><td colspan="4" class="p-4 text-center text-slate-400">尚無感應紀錄</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;

    $('#btnZ1LockFinish').onclick = async () => {
      if (!confirm(`確定將「${ev.nameZh}」結案鎖定並移轉至專區 2（已結案專區）？`)) return;
      ev.status = 'finished';
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.State.z2EventId = ev.eventId;
      App.switchView('zone2');
      App.toast('🔒 活動已結案鎖定並移轉至專區 2！', 'success');
    };

    $$('[data-z1-save-p]').forEach((b) => {
      b.onclick = async () => {
        const pid = b.dataset.z1SaveP;
        const p = App.State.participants.find((x) => x.participantId === pid);
        if (!p) return;
        p.raceStatus = $(`[data-z1-st="${pid}"]`).value;
        p.penaltySeconds = Math.round(Number($(`[data-z1-pen="${pid}"]`).value || 0));
        await C.TurDB.put('participants', p);
        await App.enqueueSync('updateParticipant', { participantId: pid, raceStatus: p.raceStatus, penaltySeconds: p.penaltySeconds });
        renderZ1Score(App, ev);
        App.toast(`已更新 ${p.bibNumber} 成績參數`, 'success');
      };
    });

    $('#z1AddLogForm').onsubmit = async (e) => {
      e.preventDefault();
      const bib = $('#z1LogBib').value.trim().toUpperCase();
      const st = $('#z1LogSt').value;
      const tm = $('#z1LogTime').value.trim();
      const log = {
        logId: `ADJ-${Date.now()}-${bib}`, eventId: ev.eventId, stationCode: st, bibNumber: bib,
        idCardHash: '', sensedTime: tm, lapCount: st === 'LAP' ? (App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.bibNumber === bib && l.stationCode === 'LAP' && l.isValid !== false).length + 1) : 0,
        operator: App.State.currentUser.username, source: 'manual', isValid: true, note: '後台補登'
      };
      App.State.timingLogs.push(log);
      await C.TurDB.put('timingLogs', log);
      await App.enqueueSync('adjustTimingLog', { log });
      renderZ1Score(App, ev);
      App.toast(`已補登 ${bib} @ ${st}`, 'success');
    };

    $$('[data-z1-toggle-log]').forEach((b) => {
      b.onclick = async () => {
        const l = App.State.timingLogs.find((x) => x.logId === b.dataset.z1ToggleLog);
        if (!l) return;
        l.isValid = l.isValid === false ? true : false;
        await C.TurDB.put('timingLogs', l);
        await App.enqueueSync('adjustTimingLog', { log: l });
        renderZ1Score(App, ev);
      };
    });
  }

  function renderZ1Ops(App, ev) {
    const u = App.State.currentUser;
    const myOps = App.State.users.filter((x) => x.role === 'operator' && (u.role === 'super_admin' || x.parentOrganizer === u.username || x.allowedEventId === ev.eventId));
    const sts = App.State.stations.filter((s) => s.eventId === ev.eventId);
    const box = $('#z1-ops');

    box.innerHTML = `
      <div class="bg-white p-4 rounded-xl border shadow-sm space-y-3 text-xs">
        <h3 class="font-black text-sm">👷 核發本活動現場作業員帳號（嚴格隔離，僅限本人名下活動）</h3>
        <form id="z1NewOpForm" autocomplete="off" class="grid grid-cols-2 sm:grid-cols-5 gap-2 bg-slate-50 p-3 rounded-xl border">
          <input id="opNewUser" required placeholder="作業員帳號 (如 cp2_01)" class="px-2.5 py-1.5 border rounded-lg" />
          <input id="opNewPass" required type="password" autocomplete="new-password" placeholder="站點密碼" class="px-2.5 py-1.5 border rounded-lg" />
          <input id="opNewName" required placeholder="顯示名稱" class="px-2.5 py-1.5 border rounded-lg" />
          <select id="opNewStation" class="px-2.5 py-1.5 border rounded-lg">
            <option value="WRITER">WRITER (晶片寫入發卡組)</option>
            ${sts.map((s) => `<option value="${s.stationCode}">${s.stationCode} (${C.escapeHtml(s.name)})</option>`).join('')}
          </select>
          <button type="submit" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold">+ 核發帳號</button>
        </form>
        <table class="w-full text-left">
          <thead class="bg-slate-100"><tr><th class="p-2">帳號</th><th class="p-2">名稱</th><th class="p-2">鎖定活動</th><th class="p-2">鎖定站點</th><th class="p-2">狀態</th></tr></thead>
          <tbody class="divide-y">
            ${myOps.map((op) => `
              <tr>
                <td class="p-2 mono font-bold">${op.username}</td>
                <td class="p-2">${C.escapeHtml(op.displayName)}</td>
                <td class="p-2 mono">${op.allowedEventId}</td>
                <td class="p-2"><span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-bold mono">${op.allowedStation}</span></td>
                <td class="p-2"><button data-toggle-op="${op.username}" class="px-2 py-0.5 rounded font-bold ${Number(op.enabled) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'}">${Number(op.enabled) ? '啟用中' : '已停用'}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $('#z1NewOpForm').onsubmit = async (e) => {
      e.preventDefault();
      const un = $('#opNewUser').value.trim();
      if (App.State.users.some((x) => x.username === un)) return App.toast('帳號已存在', 'error');
      const userObj = {
        username: un, passwordHash: $('#opNewPass').value.trim(), displayName: $('#opNewName').value.trim(),
        role: 'operator', parentOrganizer: u.username, allowedEventId: ev.eventId,
        allowedStation: $('#opNewStation').value, enabled: 1
      };
      App.State.users.push(userObj);
      await C.TurDB.put('users', userObj);
      await App.enqueueSync('saveUser', { user: userObj });
      renderZ1Ops(App, ev);
      App.toast(`已核發作業員帳號 ${un}`, 'success');
    };
    $$('[data-toggle-op]').forEach((b) => {
      b.onclick = async () => {
        const target = App.State.users.find((x) => x.username === b.dataset.toggleOp);
        if (!target) return;
        target.enabled = Number(target.enabled) ? 0 : 1;
        await C.TurDB.put('users', target);
        await App.enqueueSync('saveUser', { user: target });
        renderZ1Ops(App, ev);
      };
    });
  }

  /* --------------------------------------------------------------------------
   * 專區 2：📦 已結案專區（鎖定防誤改、3表Excel、DUV、承辦人動態證書 + 批次ZIP/PDF）
   * -------------------------------------------------------------------------- */
  let z2CustomBgImg = null;

  function renderZone2(App) {
    const finished = getManagedEvents(App, true);
    const box = $('#view-zone2');
    if (!finished.length) {
      box.innerHTML = '<div class="bg-white p-8 rounded-2xl border text-center text-slate-400 text-sm">目前尚無已結案活動。請於「專區 1 → 分頁 4」將賽事結案鎖定後即可在此核發正式報表、DUV 與完賽證書。</div>';
      return;
    }
    if (!finished.some((e) => e.eventId === App.State.z2EventId)) App.State.z2EventId = finished[0].eventId;
    const ev = finished.find((e) => e.eventId === App.State.z2EventId);
    const rows = C.computeLeaderboard({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    });
    const cfg = C.parseJsonSafe(ev.certConfigJson, C.defaultCertConfig());
    const warriorsCount = rows.filter((r) => r.isWarrior800).length;

    const toggles = [
      ['showEventName', '活動名稱'], ['showRunnerName', '選手姓名'], ['showBib', '參賽編號 Bib'],
      ['showCategory', '參賽組別'], ['showPrimaryResult', '主要成績'], ['showSecondaryResult', '次要成績'],
      ['showDate', '活動日期'], ['showOverallRank', '總名次 Overall'], ['showCatRank', '分組名次 Cat'],
      ['showPace', '平均配速 Pace'], ['showSplitAnalysis', '感應點區段均速分析'], ['showOfficialStamp', '大會鋼印章戳'],
      ['allowPublicPhotoQuote', '開放前台照片(3框)與40字感言'], ['enableWarrior800', '啟用八百壯士 100K+ 榮譽標註']
    ];

    box.innerHTML = `
      <div class="bg-white p-4 rounded-xl border shadow-sm flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-800 font-black">🔒 結案成績鎖定中</span>
          <select id="z2EventSelect" class="px-3 py-1.5 border rounded-lg font-bold text-sm">
            ${finished.map((e) => `<option value="${e.eventId}" ${e.eventId === ev.eventId ? 'selected' : ''}>${C.escapeHtml(e.nameZh)}</option>`).join('')}
          </select>
        </div>
        <button id="btnZ2Reopen" class="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold">🔓 重新開啟解鎖（退回專區 1）</button>
      </div>

      <!-- 報表與 DUV 送審 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2">
          <h3 class="font-black text-sm">📊 3 工作表正式 Excel (.xlsx)</h3>
          <p class="text-slate-500">含總成績、各站/逐圈明細、選手名冊三工作表。</p>
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ2XlsxFull" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold">⬇️ 完整存檔版</button>
            <button id="btnZ2XlsxMask" class="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold">⬇️ 身分證隱碼公開版</button>
          </div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-emerald-200 shadow-sm space-y-2">
          <h3 class="font-black text-sm text-emerald-900">🌍 DUV 國際超馬協會送審檔</h3>
          <p class="text-slate-500">3 列表頭＋11 欄明細，自動拆複姓/英文名與性別。</p>
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ2DuvPrev" class="px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-900 font-bold">👁️ 預覽</button>
            <button id="btnZ2DuvTxt" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold">⬇️ .txt</button>
            <button id="btnZ2DuvCsv" class="px-3 py-1.5 rounded-lg bg-teal-600 text-white font-bold">⬇️ .csv</button>
          </div>
        </div>
        <div class="bg-gradient-to-br from-rose-50 to-amber-50 p-4 rounded-xl border border-rose-200 shadow-sm space-y-2">
          <h3 class="font-black text-sm text-rose-900">🏅 八百壯士 100K+ 智慧分流</h3>
          <p class="text-rose-800">本場符合 100K+ 完賽資格共 <b class="text-base mono">${warriorsCount}</b> 位。</p>
          <button id="btnZ2ExportW800" class="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold">⬇️ 獨立匯出 _800壯士超馬.xlsx</button>
        </div>
      </div>

      <div id="z2DuvBox" class="hidden bg-slate-950 text-emerald-300 p-4 rounded-xl space-y-2">
        <div class="flex justify-between text-xs text-white font-bold"><span>DUV 格式即時預覽</span><button id="btnZ2DuvClose">✕</button></div>
        <pre id="z2DuvPre" class="mono text-[11px] overflow-x-auto max-h-56"></pre>
      </div>

      <!-- 承辦人客製化動態完賽證書與批次出圖引擎 -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <div>
            <h3 class="font-black text-base">🏆 承辦人客製化完賽證書引擎（設定同步前台 public.html）</h3>
            <p class="text-xs text-slate-500">官方 6×6 公版（橫/直式）或自訂底圖拖曳套印，100% 離線批次匯出全組 .zip / 多頁 .pdf。</p>
          </div>
          <div class="flex flex-wrap gap-2 text-xs">
            <button id="btnZ2SaveCertCfg" class="px-3.5 py-2 rounded-xl bg-slate-900 text-white font-black">💾 儲存證書設定至活動</button>
            <button id="btnZ2BatchZip" class="px-3.5 py-2 rounded-xl bg-emerald-600 text-white font-black">📦 離線批次匯出全組 .zip</button>
            <button id="btnZ2BatchPdf" class="px-3.5 py-2 rounded-xl bg-amber-500 text-slate-950 font-black">📄 匯出全組多頁 .pdf</button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 text-xs">
          <div class="lg:col-span-5 space-y-3">
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="font-bold block mb-1">證書引擎模式</label>
                <select id="certEngineSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  <option value="official" ${cfg.engine === 'official' ? 'selected' : ''}>官方 6×6 中英公版</option>
                  <option value="custom" ${cfg.engine === 'custom' ? 'selected' : ''}>自訂底圖套印（畫布可拖曳）</option>
                </select>
              </div>
              <div>
                <label class="font-bold block mb-1">A4 紙張方向</label>
                <select id="certOrientSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  <option value="landscape" ${cfg.orientation === 'landscape' ? 'selected' : ''}>A4 橫式 (1600×1131)</option>
                  <option value="portrait" ${cfg.orientation === 'portrait' ? 'selected' : ''}>A4 直式 (1131×1600)</option>
                </select>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="font-bold block mb-1">6 款官方風格</label>
                <select id="certLayoutSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  ${C.CERT_LAYOUTS.map((l) => `<option value="${l.id}" ${cfg.layoutId === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="font-bold block mb-1">6 款官方配色</label>
                <select id="certPaletteSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  ${C.CERT_PALETTES.map((p) => `<option value="${p.id}" ${cfg.paletteId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                </select>
              </div>
            </div>

            <div id="certCustomBgBox" class="${cfg.engine === 'custom' ? '' : 'hidden'} p-2.5 rounded-xl bg-indigo-50 border border-indigo-200 space-y-2">
              <div class="font-bold text-indigo-900">🖼️ 上傳自訂證書底圖（上傳後可直接在右側畫布拖曳文字位置）</div>
              <input id="certCustomBgFile" type="file" accept="image/*" class="text-[11px]" />
              <div class="flex gap-2 items-center">
                <label>字色</label><input id="certCustomColor" type="color" value="${cfg.customTextPos?.color || '#ffffff'}" />
                <label>對齊</label>
                <select id="certCustomAlign" class="border rounded px-1.5 py-0.5">
                  <option value="center">置中</option><option value="left">靠左</option><option value="right">靠右</option>
                </select>
              </div>
            </div>

            <div class="p-3 rounded-xl bg-slate-50 border space-y-1.5">
              <div class="font-black text-slate-800">🎛️ 承辦人自由勾選顯示開關（14 項全模組化）</div>
              <div class="grid grid-cols-2 gap-1.5">
                ${toggles.map(([k, lbl]) => `
                  <label class="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" class="cert-toggle" data-ckey="${k}" ${cfg[k] ? 'checked' : ''} />
                    <span>${lbl}</span>
                  </label>`).join('')}
              </div>
            </div>

            <div>
              <label class="font-bold block mb-1">預覽選手切換</label>
              <select id="certPreviewRunner" class="w-full px-2.5 py-1.5 border rounded-lg">
                ${rows.map((r, i) => `<option value="${i}">#${r.overallRank} ${r.participant.bibNumber} ${C.escapeHtml(r.participant.name)} (${r.totalDistanceKm}km)</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="lg:col-span-7 bg-slate-950 p-3 rounded-xl flex items-center justify-center">
            <canvas id="z2CertCanvas" class="max-w-full max-h-[540px] w-auto h-auto rounded-lg shadow-2xl cursor-move"></canvas>
          </div>
        </div>
      </div>`;

    const redraw = () => {
      const idx = Number($('#certPreviewRunner')?.value || 0);
      const targetRow = rows[idx] || rows[0];
      C.renderCertificateCanvas($('#z2CertCanvas'), targetRow, cfg, {
        customBgImg: z2CustomBgImg,
        showPhotoPlaceholder: true,
        quote: '突破極限，感謝每一站熱情的志工！'
      });
    };

    if (cfg.customBgDataUrl && !z2CustomBgImg) {
      const im = new Image();
      im.onload = () => { z2CustomBgImg = im; redraw(); };
      im.src = cfg.customBgDataUrl;
    }
    redraw();

    $('#z2EventSelect').onchange = (e) => { App.State.z2EventId = e.target.value; z2CustomBgImg = null; renderZone2(App); };
    $('#btnZ2Reopen').onclick = async () => {
      if (!confirm('確定解鎖並將此活動退回「專區 1：進行中活動」？')) return;
      ev.status = 'closed';
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.State.z1EventId = ev.eventId;
      App.switchView('zone1');
      App.toast('🔓 活動已解鎖並退回專區 1', 'info');
    };
    $('#btnZ2XlsxFull').onclick = () => export3SheetExcel(App, ev, false);
    $('#btnZ2XlsxMask').onclick = () => export3SheetExcel(App, ev, true);
    $('#btnZ2ExportW800').onclick = () => export800WarriorsExcel(App, ev);
    $('#btnZ2DuvPrev').onclick = () => { $('#z2DuvPre').textContent = buildDuvText(App, ev, '\t'); $('#z2DuvBox').classList.remove('hidden'); };
    $('#btnZ2DuvClose').onclick = () => $('#z2DuvBox').classList.add('hidden');
    $('#btnZ2DuvTxt').onclick = () => downloadText(`${ev.eventId}_DUV.txt`, buildDuvText(App, ev, '\t'));
    $('#btnZ2DuvCsv').onclick = () => downloadText(`${ev.eventId}_DUV.csv`, '\uFEFF' + buildDuvText(App, ev, ','), 'text/csv;charset=utf-8');

    $('#certEngineSel').onchange = (e) => { cfg.engine = e.target.value; $('#certCustomBgBox').classList.toggle('hidden', cfg.engine !== 'custom'); redraw(); };
    $('#certOrientSel').onchange = (e) => { cfg.orientation = e.target.value; redraw(); };
    $('#certLayoutSel').onchange = (e) => { cfg.layoutId = e.target.value; redraw(); };
    $('#certPaletteSel').onchange = (e) => { cfg.paletteId = e.target.value; redraw(); };
    $('#certPreviewRunner').onchange = redraw;
    $$('.cert-toggle').forEach((cb) => { cb.onchange = () => { cfg[cb.dataset.ckey] = cb.checked; redraw(); }; });
    $('#certCustomColor').oninput = (e) => { cfg.customTextPos.color = e.target.value; redraw(); };
    $('#certCustomAlign').onchange = (e) => { cfg.customTextPos.align = e.target.value; redraw(); };
    $('#certCustomBgFile').onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        cfg.customBgDataUrl = r.result;
        const im = new Image();
        im.onload = () => { z2CustomBgImg = im; redraw(); };
        im.src = r.result;
      };
      r.readAsDataURL(f);
    };

    // 自訂底圖拖曳調整文字中心位置
    const cv = $('#z2CertCanvas');
    let dragText = false;
    cv.onpointerdown = () => { if (cfg.engine === 'custom') dragText = true; };
    cv.onpointerup = () => { dragText = false; };
    cv.onpointermove = (e) => {
      if (!dragText || cfg.engine !== 'custom') return;
      const rect = cv.getBoundingClientRect();
      const nx = Math.max(0.1, Math.min(0.9, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0.15, Math.min(0.8, (e.clientY - rect.top) / rect.height));
      cfg.customTextPos.nameX = nx; cfg.customTextPos.nameY = ny;
      cfg.customTextPos.bibX = nx; cfg.customTextPos.bibY = ny + 0.08;
      cfg.customTextPos.resultX = nx; cfg.customTextPos.resultY = ny + 0.19;
      redraw();
    };

    $('#btnZ2SaveCertCfg').onclick = async () => {
      ev.certConfigJson = JSON.stringify(cfg);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.toast('✅ 證書欄位開關與版型已儲存，前台 public.html 同步生效！', 'success');
    };

    $('#btnZ2BatchZip').onclick = async () => {
      if (!global.JSZip) return App.toast('JSZip 未載入', 'error');
      const zip = new global.JSZip();
      const tmp = document.createElement('canvas');
      for (const r of rows) {
        C.renderCertificateCanvas(tmp, r, cfg, { customBgImg: z2CustomBgImg });
        const b64 = tmp.toDataURL('image/png').split(',')[1];
        zip.file(`${r.participant.bibNumber}_${r.participant.name}.png`, b64, { base64: true });
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${ev.nameZh}_全組證書.zip`, blob);
      App.toast(`📦 離線批次匯出完成！共 ${rows.length} 張證書 (.zip)`, 'success');
    };

    $('#btnZ2BatchPdf').onclick = () => {
      if (!global.jspdf?.jsPDF) return App.toast('jsPDF 未載入', 'error');
      const orient = cfg.orientation === 'portrait' ? 'portrait' : 'landscape';
      const pdf = new global.jspdf.jsPDF({ orientation: orient, unit: 'mm', format: 'a4' });
      const tmp = document.createElement('canvas');
      const pw = orient === 'portrait' ? 210 : 297;
      const ph = orient === 'portrait' ? 297 : 210;
      rows.forEach((r, i) => {
        if (i > 0) pdf.addPage();
        C.renderCertificateCanvas(tmp, r, cfg, { customBgImg: z2CustomBgImg });
        pdf.addImage(tmp.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph);
      });
      pdf.save(`${ev.nameZh}_全組證書.pdf`);
      App.toast(`📄 已匯出多頁合併版 PDF（${rows.length} 頁）`, 'success');
    };
  }

  /* --------------------------------------------------------------------------
   * 專區 3：👥 全平台帳號管理 (Super Admin ONLY)
   * -------------------------------------------------------------------------- */
  function renderZone3(App) {
    const box = $('#view-zone3');
    if (App.State.currentUser?.role !== 'super_admin') {
      box.innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：專區 3 僅限最高管理員（Super Admin）存取。</div>';
      return;
    }

    box.innerHTML = `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-4 text-xs">
        <div class="border-b pb-2">
          <h2 class="font-black text-base">👥 專區 3：全平台帳號核發與權責管控（最高管理員專用）</h2>
          <p class="text-slate-500">無公開註冊；所有活動承辦人（organizer）與站點作業員（operator）皆由上級核發管理。</p>
        </div>
        <form id="z3NewUserForm" autocomplete="off" class="grid grid-cols-2 sm:grid-cols-6 gap-2 bg-slate-50 p-3 rounded-xl border">
          <input id="z3User" required placeholder="帳號" class="px-2.5 py-1.5 border rounded-lg" />
          <input id="z3Pass" required type="password" autocomplete="new-password" placeholder="密碼" class="px-2.5 py-1.5 border rounded-lg" />
          <input id="z3Name" required placeholder="顯示姓名" class="px-2.5 py-1.5 border rounded-lg" />
          <select id="z3Role" class="px-2.5 py-1.5 border rounded-lg">
            <option value="organizer">活動承辦人 (organizer)</option>
            <option value="operator">現場作業員 (operator)</option>
            <option value="super_admin">最高管理員 (super_admin)</option>
          </select>
          <select id="z3Station" class="px-2.5 py-1.5 border rounded-lg">
            <option value="ALL">ALL (管理員/承辦人)</option>
            <option value="WRITER">WRITER (晶片寫入)</option>
            <option value="CHECKIN">CHECKIN (報到檢錄)</option>
            <option value="CP1">CP1</option><option value="CP2">CP2</option>
            <option value="FINISH">FINISH</option><option value="LAP">LAP</option>
          </select>
          <button type="submit" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-black">+ 核發帳號</button>
        </form>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-100"><tr><th class="p-2">帳號</th><th class="p-2">顯示名稱</th><th class="p-2">角色</th><th class="p-2">歸屬承辦人</th><th class="p-2">鎖定站點</th><th class="p-2">啟用</th></tr></thead>
            <tbody class="divide-y">
              ${App.State.users.map((u) => `
                <tr>
                  <td class="p-2 mono font-bold">${u.username}</td>
                  <td class="p-2">${C.escapeHtml(u.displayName)}</td>
                  <td class="p-2"><span class="px-2 py-0.5 rounded font-bold ${u.role === 'super_admin' ? 'bg-rose-100 text-rose-800' : (u.role === 'organizer' ? 'bg-amber-100 text-amber-900' : 'bg-sky-100 text-sky-800')}">${u.role}</span></td>
                  <td class="p-2 mono">${u.parentOrganizer || '-'}</td>
                  <td class="p-2 mono">${u.allowedStation || 'ALL'}</td>
                  <td class="p-2"><button data-z3-toggle="${u.username}" class="px-2 py-0.5 rounded font-bold ${Number(u.enabled) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'}">${Number(u.enabled) ? '啟用' : '停用'}</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#z3NewUserForm').onsubmit = async (e) => {
      e.preventDefault();
      const un = $('#z3User').value.trim();
      if (App.State.users.some((x) => x.username === un)) return App.toast('此帳號已存在', 'error');
      const obj = {
        username: un, passwordHash: $('#z3Pass').value.trim(), displayName: $('#z3Name').value.trim(),
        role: $('#z3Role').value, parentOrganizer: '', allowedEventId: 'ALL',
        allowedStation: $('#z3Station').value, enabled: 1
      };
      App.State.users.push(obj);
      await C.TurDB.put('users', obj);
      await App.enqueueSync('saveUser', { user: obj });
      renderZone3(App);
      App.toast(`✅ 已核發帳號 ${un}`, 'success');
    };
    $$('[data-z3-toggle]').forEach((b) => {
      b.onclick = async () => {
        const u = App.State.users.find((x) => x.username === b.dataset.z3Toggle);
        if (!u || u.username === App.State.currentUser.username) return;
        u.enabled = Number(u.enabled) ? 0 : 1;
        await C.TurDB.put('users', u);
        await App.enqueueSync('saveUser', { user: u });
        renderZone3(App);
      };
    });
  }

  /* --------------------------------------------------------------------------
   * 專區 4：📚 歷屆成績智慧清洗（金框預覽 + 28複姓 + SHA-256 + 八百壯士英雄榜）
   * -------------------------------------------------------------------------- */
  let pendingHistoryPreview = [];

  function renderZone4(App) {
    const box = $('#view-zone4');
    if (App.State.currentUser?.role !== 'super_admin') {
      box.innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：專區 4 僅限最高管理員存取。</div>';
      return;
    }
    const warriors = App.State.historyResults.filter((h) => h.isWarrior800);

    box.innerHTML = `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <div class="border-b pb-2">
          <h2 class="font-black text-base">📚 專區 4：歷屆成績智慧清洗匯入（28 組中文複姓合併 ＋ SHA-256 歸併 ＋ 八百壯士 100K+ 自動分流）</h2>
          <p class="text-slate-500">採用「先金框預覽審查、確認後寫入」機制；支援檔名偵測、姓與名拆格合併與 100km+ 自動標記。</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input id="hisEventDate" value="2025-11-15" placeholder="賽事日期 YYYY-MM-DD" class="px-2.5 py-1.5 border rounded-lg mono" />
          <input id="hisEventName" value="2025 TUR 冬季八百壯士 100K 邀請賽" placeholder="賽事名稱" class="px-2.5 py-1.5 border rounded-lg sm:col-span-2" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input id="hisFileInput" type="file" accept=".csv,.txt" />
          <button id="btnHisSample" class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 font-bold">✨ 載入含複姓與100K+清洗範例</button>
        </div>
        <textarea id="hisRawInput" rows="4" placeholder="貼上歷屆 CSV/TSV（如：組別,號碼布,姓,名,身分證,成績,距離km）" class="w-full p-2.5 border rounded-lg mono bg-slate-50"></textarea>
        <button id="btnHisAnalyze" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black">🔍 執行智慧清洗並產生金框預覽</button>

        <!-- 金框預覽審查區 -->
        <div id="hisGoldenBox" class="${pendingHistoryPreview.length ? '' : 'hidden'} p-4 rounded-2xl border-4 border-amber-400 bg-amber-50/70 space-y-3">
          <div class="flex items-center justify-between">
            <span class="font-black text-amber-950 text-sm">🛡️ 金框預覽審查（共 ${pendingHistoryPreview.length} 筆，尚未寫入資料庫）</span>
            <button id="btnHisConfirmCommit" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black shadow">✅ 確認審查無誤並寫入 HistoryResults</button>
          </div>
          <div class="overflow-x-auto max-h-60">
            <table class="w-full text-left bg-white rounded-lg overflow-hidden">
              <thead class="bg-amber-200/70"><tr><th class="p-2">合併姓名</th><th class="p-2">組別/號碼布</th><th class="p-2">成績</th><th class="p-2">距離</th><th class="p-2">SHA-256 歸併碼</th><th class="p-2">八百壯士</th></tr></thead>
              <tbody class="divide-y">
                ${pendingHistoryPreview.map((r) => `
                  <tr>
                    <td class="p-2 font-bold">${C.escapeHtml(r.name)}</td>
                    <td class="p-2">${C.escapeHtml(r.categoryName)} / <span class="mono">${r.bibNumber}</span></td>
                    <td class="p-2 mono">${r.finishTime}</td>
                    <td class="p-2 mono font-bold">${r.distanceKm} km</td>
                    <td class="p-2 mono text-[10px] text-slate-500">${String(r.idCardHash).slice(0, 14)}...</td>
                    <td class="p-2">${r.isWarrior800 ? '<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold">🏅 100K+ 壯士</span>' : '-'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 八百壯士英雄榜 + 歷屆資料庫總覽 -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-2 text-xs">
        <h3 class="font-black text-sm text-rose-900">🏅 八百壯士 100K+ 英雄榜（累計 ${warriors.length} 筆紀錄 / 全歷屆 ${App.State.historyResults.length} 筆）</h3>
        <div class="overflow-x-auto max-h-72">
          <table class="w-full text-left">
            <thead class="bg-slate-900 text-white"><tr><th class="p-2">日期</th><th class="p-2">賽事名稱</th><th class="p-2">姓名</th><th class="p-2">組別</th><th class="p-2">距離</th><th class="p-2">成績</th><th class="p-2">標註</th></tr></thead>
            <tbody class="divide-y">
              ${App.State.historyResults.map((h) => `
                <tr class="${h.isWarrior800 ? 'bg-amber-50/60' : ''}">
                  <td class="p-2 mono">${h.eventDate}</td>
                  <td class="p-2 font-semibold">${C.escapeHtml(h.eventName)}</td>
                  <td class="p-2 font-black">${C.escapeHtml(h.name)}</td>
                  <td class="p-2">${C.escapeHtml(h.categoryName)}</td>
                  <td class="p-2 mono font-bold">${h.distanceKm} km</td>
                  <td class="p-2 mono">${h.finishTime}</td>
                  <td class="p-2">${h.isWarrior800 ? '<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold">八百壯士</span>' : '-'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#hisFileInput').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const dateMatch = f.name.match(/(20\d{2}[-_]?\d{2}[-_]?\d{2})/);
      if (dateMatch) $('#hisEventDate').value = dateMatch[1].replace(/_/g, '-');
      $('#hisEventName').value = f.name.replace(/\.(csv|txt)$/i, '');
      $('#hisRawInput').value = await f.text();
    };

    $('#btnHisSample').onclick = () => {
      $('#hisRawInput').value = [
        '組別,號碼布,姓,名,身分證,成績,距離',
        '100K八百壯士組,W001,諸葛,亮,A123456789,09:48:12,100',
        '24H繞圈組,T012,Smith,John,US88776655,23:50:00,132.4',
        '50K挑戰組,B023,上官,婉兒,F223456786,05:12:40,50'
      ].join('\n');
    };

    $('#btnHisAnalyze').onclick = async () => {
      const raw = $('#hisRawInput').value.trim();
      if (!raw) return App.toast('請先貼上或上傳歷屆成績文字', 'warn');
      const evDate = $('#hisEventDate').value.trim() || C.formatDateTime().slice(0, 10);
      const evName = $('#hisEventName').value.trim() || '歷屆賽事';
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(/,|\t/).map((s) => s.trim());
        if (i === 0 && /組別|姓名|bib|name/i.test(lines[i])) continue;
        const cat = cols[0] || '超馬組';
        const bib = cols[1] || `H${i}`;
        const mergedName = C.mergeNameParts(cols[2], cols[3]);
        const idCard = cols[4] || `${mergedName}-${bib}`;
        const finishTime = (cols[5] || '00:00:00').split('.')[0];
        const dist = Number(cols[6] || 0);
        const hash = await C.sha256Hex(idCard);
        out.push({
          historyId: `HIS-${Date.now()}-${i}`,
          eventDate: evDate, eventName: evName, categoryName: cat, bibNumber: bib,
          name: mergedName, idCardHash: hash, finishTime, distanceKm: dist,
          lapCount: 0, overallRank: i + 1, catRank: 1, status: 'FINISHED',
          isWarrior800: C.isWarrior800Eligible(evName, cat, dist), remark: '智慧清洗匯入'
        });
      }
      pendingHistoryPreview = out;
      renderZone4(App);
      App.toast(`已解析 ${out.length} 筆，請審查金框內容後按確認寫入`, 'info');
    };

    if ($('#btnHisConfirmCommit')) {
      $('#btnHisConfirmCommit').onclick = async () => {
        if (!pendingHistoryPreview.length) return;
        for (const r of pendingHistoryPreview) {
          App.State.historyResults.push(r);
          await C.TurDB.put('historyResults', r);
        }
        await App.enqueueSync('batchImportHistory', { rows: pendingHistoryPreview });
        const cnt = pendingHistoryPreview.length;
        pendingHistoryPreview = [];
        renderZone4(App);
        App.toast(`✅ 已正式寫入 ${cnt} 筆歷屆成績並同步雲端！`, 'success');
      };
    }
  }

  /* --------------------------------------------------------------------------
   * 專區 5：🗄️ 資料庫與系統設定（Organizer 精簡同步 vs Super Admin 直通控制台）
   * -------------------------------------------------------------------------- */
  let directSheetName = 'GlobalConfig';

  function renderZone5(App) {
    const isSuper = App.State.currentUser?.role === 'super_admin';
    const box = $('#view-zone5');

    const storeMap = {
      GlobalConfig: { arr: App.State.globalConfig, store: 'globalConfig', cols: ['configKey', 'configValue', 'description'] },
      Events: { arr: App.State.events, store: 'events', cols: ['eventId', 'ownerUsername', 'nameZh', 'raceType', 'status', 'raceStart', 'maxQuota'] },
      Categories: { arr: App.State.categories, store: 'categories', cols: ['catId', 'eventId', 'name', 'distanceKm', 'timeLimitHours', 'fee', 'bibPrefix', 'quota'] },
      Stations: { arr: App.State.stations, store: 'stations', cols: ['stationId', 'eventId', 'stationCode', 'name', 'distanceKm', 'stationType'] },
      Participants: { arr: App.State.participants, store: 'participants', cols: ['participantId', 'eventId', 'bibNumber', 'name', 'nationality', 'payMethod', 'payStatus', 'totalAmount', 'chipUid'] },
      Users: { arr: App.State.users, store: 'users', cols: ['username', 'displayName', 'role', 'parentOrganizer', 'allowedStation', 'enabled'] }
    };
    const activeTbl = storeMap[directSheetName] || storeMap.GlobalConfig;

    box.innerHTML = `
      <!-- 共用區：本機 IndexedDB 總覽與雲端 GAS 雙向同步 -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <h2 class="font-black text-base">🗄️ 專區 5：本機離線資料庫與 Google 試算表雙向同步</h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mono">
          <div class="p-2.5 rounded-xl bg-slate-50 border">Events: <b>${App.State.events.length}</b></div>
          <div class="p-2.5 rounded-xl bg-slate-50 border">Participants: <b>${App.State.participants.length}</b></div>
          <div class="p-2.5 rounded-xl bg-slate-50 border">TimingLogs: <b>${App.State.timingLogs.length}</b></div>
          <div class="p-2.5 rounded-xl bg-amber-50 border border-amber-200">待上傳佇列: <b>${App.State.syncQueue.length}</b></div>
        </div>
        <div class="flex flex-wrap gap-2 items-end pt-1">
          <div class="flex-1 min-w-[260px]">
            <label class="font-bold block mb-1">Google Apps Script Web App URL (/exec)</label>
            <input id="z5GasUrl" value="${C.escapeHtml(App.State.gasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full px-3 py-2 border rounded-lg mono" />
          </div>
          <button id="btnZ5TestGas" class="px-3.5 py-2 rounded-lg bg-sky-600 text-white font-bold">測試並儲存連線</button>
          <button id="btnZ5Pull" class="px-3.5 py-2 rounded-lg bg-slate-900 text-white font-bold">🔄 立即雙向拉取</button>
          <button id="btnZ5Push" class="px-3.5 py-2 rounded-lg bg-emerald-600 text-white font-bold">☁️ 批次上傳 (${App.State.syncQueue.length})</button>
        </div>
      </div>

      ${isSuper ? `
        <!-- 最高管理員專用：直通 Google 試算表後端控制台 (Direct Cloud CRUD) -->
        <div class="bg-white p-4 rounded-2xl border-2 border-indigo-400 shadow-sm space-y-3 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
            <div>
              <div class="text-[11px] font-black text-indigo-600">🛡️ SUPER ADMIN DIRECT BACKEND SYNC</div>
              <h3 class="font-black text-base">最高管理直通 Google 後端資料庫控制台（免進試算表直接修改）</h3>
            </div>
            <div class="flex flex-wrap gap-1.5">
              ${Object.keys(storeMap).map((sn) => `<button data-pick-sheet="${sn}" class="px-2.5 py-1.5 rounded-lg font-bold ${directSheetName === sn ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'}">${sn}</button>`).join('')}
            </div>
          </div>

          <div class="overflow-x-auto max-h-80 border rounded-xl">
            <table class="w-full text-left">
              <thead class="bg-slate-900 text-white sticky top-0">
                <tr>${activeTbl.cols.map((c) => `<th class="p-2 mono">${c}</th>`).join('')}</tr>
              </thead>
              <tbody class="divide-y">
                ${activeTbl.arr.map((row, rIdx) => `
                  <tr>
                    ${activeTbl.cols.map((col, cIdx) => `
                      <td class="p-1.5">
                        <input data-grid-r="${rIdx}" data-grid-c="${col}" value="${C.escapeHtml(row[col] ?? '')}" ${cIdx === 0 ? 'readonly class="w-full px-1.5 py-1 bg-slate-100 rounded mono text-[11px]"' : 'class="w-full px-1.5 py-1 border rounded mono text-[11px] focus:border-indigo-500"'} />
                      </td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="flex justify-end">
            <button id="btnZ5DirectBatchSave" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black shadow">💾 儲存並更新雲端 Google 試算表 (BatchUpdate)</button>
          </div>
        </div>

        <!-- 最高管理員專用：全機 .json 備份、合併/覆蓋還原、5場測試資料、CLEAR 清空 -->
        <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
          <h3 class="font-black text-sm">💾 全機 .json 封存備份、雙模式還原與安全重置（最高管理員專用）</h3>
          <div class="flex flex-wrap gap-2 items-center">
            <button id="btnZ5DownloadJson" class="px-3.5 py-2 rounded-lg bg-slate-900 text-white font-bold">⬇️ 下載完整備份 (.json)</button>
            <label class="px-3.5 py-2 rounded-lg bg-emerald-100 text-emerald-900 font-bold cursor-pointer">
              ➕ 合併還原（去重累加）<input id="z5RestoreMerge" type="file" accept=".json" class="hidden" />
            </label>
            <label class="px-3.5 py-2 rounded-lg bg-amber-100 text-amber-900 font-bold cursor-pointer">
              ♻️ 覆蓋還原（整機回溯）<input id="z5RestoreOverwrite" type="file" accept=".json" class="hidden" />
            </label>
            <button id="btnZ5Seed5" class="px-3.5 py-2 rounded-lg bg-indigo-600 text-white font-bold">⚡ 載入全情境測試資料（5 場活動）</button>
            <button id="btnZ5ClearAll" class="px-3.5 py-2 rounded-lg bg-rose-600 text-white font-bold">🗑️ 清空全平台資料</button>
          </div>
        </div>
      ` : `
        <div class="bg-slate-100 p-4 rounded-xl text-xs text-slate-600">
          ℹ️ 您目前為「活動承辦人」角色，僅顯示本機總覽與雙向同步；直通後端表格編輯與全機重置功能已自動隱藏保護。
        </div>
      `}`;

    $('#z5GasUrl').onchange = (e) => {
      const url = e.target.value.trim();
      App.State.gasUrl = url;
      localStorage.setItem('TUR_GAS_URL', url);
      App.updateNetworkBadge();
    };
    $('#btnZ5TestGas').onclick = async () => {
      const url = $('#z5GasUrl').value.trim();
      try {
        const res = await C.gasGet(url, { action: 'health' });
        if (!res.ok) throw new Error(res.error);
        App.State.gasUrl = url;
        localStorage.setItem('TUR_GAS_URL', url);
        App.updateNetworkBadge();
        App.toast(`✅ GAS v3.0 連線成功並已儲存！(${res.serverTime})`, 'success');
      } catch (err) {
        App.toast(`連線失敗：${err.message}`, 'error');
      }
    };
    $('#btnZ5Pull').onclick = () => App.syncPullFromGas();
    $('#btnZ5Push').onclick = () => App.syncPushNow(false);

    if (isSuper) {
      $$('[data-pick-sheet]').forEach((b) => { b.onclick = () => { directSheetName = b.dataset.pickSheet; renderZone5(App); }; });

      $('#btnZ5DirectBatchSave').onclick = async () => {
        $$('[data-grid-r]').forEach((inp) => {
          const r = Number(inp.dataset.gridR);
          const col = inp.dataset.gridC;
          if (activeTbl.arr[r]) activeTbl.arr[r][col] = inp.value;
        });
        await C.TurDB.clearAndFill(activeTbl.store, activeTbl.arr);
        if (App.State.gasUrl && navigator.onLine) {
          try {
            const res = await C.gasPost(App.State.gasUrl, {
              action: 'adminBatchUpdateSheet', sheetName: directSheetName, rows: activeTbl.arr, mode: 'replace'
            });
            if (!res.ok) throw new Error(res.error);
            App.toast(`🚀 雲端直通 BatchUpdate 成功！已更新 ${directSheetName} 共 ${res.updatedRows} 列`, 'success');
          } catch (err) {
            await App.enqueueSync('adminBatchUpdateSheet', { sheetName: directSheetName, rows: activeTbl.arr, mode: 'replace' });
            App.toast(`本機已更新；雲端暫時失敗已排入佇列：${err.message}`, 'warn');
          }
        } else {
          await App.enqueueSync('adminBatchUpdateSheet', { sheetName: directSheetName, rows: activeTbl.arr, mode: 'replace' });
          App.toast(`💾 本機 ${directSheetName} 已更新（${activeTbl.arr.length} 列），連網設定 GAS 後自動 BatchUpdate 至雲端`, 'success');
        }
        App.rebuildIndices();
        App.renderAll();
      };

      $('#btnZ5DownloadJson').onclick = () => {
        const dump = {
          version: 'v3.0', exportedAt: C.formatDateTime(),
          events: App.State.events, categories: App.State.categories, stations: App.State.stations,
          participants: App.State.participants, timingLogs: App.State.timingLogs,
          historyResults: App.State.historyResults, users: App.State.users, globalConfig: App.State.globalConfig
        };
        downloadText(`TUR_v3_FullBackup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2), 'application/json');
        App.toast('💾 已下載全機完整封存備份 (.json)', 'success');
      };

      const handleRestore = async (file, mode) => {
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users', 'globalConfig'];
          for (const st of stores) {
            if (!Array.isArray(data[st])) continue;
            if (mode === 'overwrite') {
              App.State[st] = data[st];
              await C.TurDB.clearAndFill(st, data[st]);
            } else {
              const kf = C.TurDB.KEY_PATHS[st];
              const map = new Map(App.State[st].map((x) => [String(x[kf]), x]));
              data[st].forEach((x) => { if (x[kf]) map.set(String(x[kf]), x); });
              App.State[st] = [...map.values()];
              await C.TurDB.clearAndFill(st, App.State[st]);
            }
          }
          App.rebuildIndices();
          App.renderAll();
          App.toast(`✅ 已完成「${mode === 'merge' ? '合併還原（去重累加）' : '覆蓋還原（整機回溯）'}」`, 'success');
        } catch (err) {
          App.toast(`還原失敗：${err.message}`, 'error');
        }
      };

      $('#z5RestoreMerge').onchange = (e) => handleRestore(e.target.files?.[0], 'merge');
      $('#z5RestoreOverwrite').onchange = (e) => handleRestore(e.target.files?.[0], 'overwrite');

      $('#btnZ5Seed5').onclick = async () => {
        if (!confirm('載入全情境 5 場測試活動資料（將覆蓋本機快取）？')) return;
        const seed = C.buildFull5EventsSeed();
        for (const k of Object.keys(seed)) {
          App.State[k] = seed[k];
          await C.TurDB.clearAndFill(k, seed[k]);
        }
        App.rebuildIndices();
        App.renderAll();
        App.toast('⚡ 已載入 5 場全情境測試資料（含距離賽、12H、100K 八百壯士、2 場已結案）', 'success');
      };

      $('#btnZ5ClearAll').onclick = async () => {
        const confirmWord = prompt('⚠️ 高風險操作！將清空全平台活動、選手、感應與歷屆資料（保留目前管理員帳號）。\n請輸入大寫 CLEAR 以確認執行：');
        if (confirmWord !== 'CLEAR') return App.toast('輸入不符，已取消清空操作', 'info');
        for (const st of ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'syncQueue']) {
          App.State[st] = [];
          await C.TurDB.clear(st);
        }
        App.rebuildIndices();
        App.renderAll();
        App.toast('🗑️ 已安全清空全平台賽事資料', 'warn');
      };
    }
  }

  global.TurZones = { renderZone1, renderZone2, renderZone3, renderZone4, renderZone5 };
})(window);
