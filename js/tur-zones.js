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
    return C.maskIdCard(id);
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

  async function exportPaidRoster(App, ev, format = 'xlsx') {
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    const catById = new Map(cats.map((c) => [c.catId, c]));
    const evSchema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const customFieldDefs = Array.isArray(evSchema.customFields) ? evSchema.customFields : [];
    const paidParts = App.State.participants
      .filter((p) => p.eventId === ev.eventId && String(p.payStatus || '').toUpperCase() === 'PAID')
      .sort((a, b) => String(a.bibNumber || 'ZZZ').localeCompare(String(b.bibNumber || 'ZZZ')) || String(a.participantId).localeCompare(String(b.participantId)));

    if (!paidParts.length) {
      return App.toast('本場活動尚無「已完成報名繳費 (PAID)」選手可匯出', 'warn');
    }

    const rows = paidParts.map((p, idx) => {
      const cat = catById.get(p.catId) || {};
      const cfVals = C.parseJsonSafe(p.customFieldsJson, {});
      const obj = {
        序號: idx + 1,
        報名序號: p.participantId || '',
        號碼布: p.bibNumber || '',
        組別: cat.name || p.catId || '',
        是否八百壯士組: C.isCategoryWarrior800(cat) ? '是' : '否',
        姓名: p.name || '',
        '身分證/護照': p.idCard || '',
        性別: p.gender || '',
        出生年月日: p.birthday || '',
        年齡: p.age || '',
        國籍: p.nationality || 'TWN',
        手機: p.phone || '',
        Email: p.email || '',
        通訊住址: p.city || '',
        飲食: p.diet || '',
        緊急聯絡人: p.emergencyName || '',
        緊急聯絡電話: p.emergencyPhone || '',
        團報代碼: p.groupCode || '',
        跑團名稱: p.groupName || '',
        實繳金額: Number(p.totalAmount || 0),
        繳費管道: p.payMethod || '',
        入帳時間: p.paidAt || '',
        末五碼或單號: p.remittanceLast5 || p.merTradeNo || '',
        備註: p.remark || ''
      };
      customFieldDefs.forEach((f) => {
        const val = cfVals[f.key];
        obj[`[自訂] ${f.label}`] = Array.isArray(val) ? val.join('、') : (val ?? '');
      });
      return obj;
    });

    if (format === 'xlsx') {
      await C.ensureExternalLib('xlsx');
      if (global.XLSX) {
        const wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(rows), '已完成報名繳費名單');
        global.XLSX.writeFile(wb, `${ev.nameZh}_已完成報名繳費名單_${paidParts.length}人.xlsx`);
        return App.toast(`📋 已匯出已完成報名繳費名單 Excel（共 ${paidParts.length} 人）`, 'success');
      }
    }
    const headers = Object.keys(rows[0]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
    downloadText(`${ev.eventId}_已完成報名繳費名單_${paidParts.length}人.csv`, csv, 'text/csv;charset=utf-8');
    App.toast(`📄 已匯出已完成報名繳費名單 CSV（共 ${paidParts.length} 人）`, 'success');
  }

  /* --------------------------------------------------------------------------
   * Official 3-Sheet Excel (.xlsx), Chip CSV, DUV & 800-Warriors Export
   * -------------------------------------------------------------------------- */
  async function export3SheetExcel(App, ev, masked = false) {
    await C.ensureExternalLib('xlsx');
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

    const evSchema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const customFieldDefs = Array.isArray(evSchema.customFields) ? evSchema.customFields : [];
    const rosterData = App.State.participants
      .filter((p) => p.eventId === ev.eventId)
      .map((p) => {
        const cfVals = C.parseJsonSafe(p.customFieldsJson, {});
        const rowObj = {
          報名序號: p.participantId,
          團報代碼: p.groupCode || '',
          號碼布: p.bibNumber || '',
          姓名: masked ? maskName(p.name) : p.name,
          身分證: masked ? maskId(p.idCard) : p.idCard,
          國籍: p.nationality || 'TWN',
          付款管道: p.payMethod,
          繳費狀態: p.payStatus,
          報到狀態: p.checkinStatus === 'checked_in' ? '已報到' : '未報到',
          出賽狀態: p.raceStatus || 'dns',
          應繳金額: p.totalAmount,
          晶片UID: p.chipUid || ''
        };
        customFieldDefs.forEach((f) => {
          const val = cfVals[f.key];
          rowObj[`[自訂] ${f.label}`] = Array.isArray(val) ? val.join('、') : (val ?? '');
        });
        return rowObj;
      });

    if (global.XLSX) {
      const an = C.computeEventProgressAnalytics({
        event: ev, categories: App.State.categories, stations: App.State.stations,
        participants: App.State.participants, timingLogs: App.State.timingLogs
      });
      const S = an.summary;
      const finOfReg = S.activeTotal > 0 ? Math.round((S.finished / S.activeTotal) * 100) : 0;
      const chkOfReg = S.activeTotal > 0 ? Math.round((S.checkedIn / S.activeTotal) * 100) : 0;
      const dnfRate = S.checkedIn > 0 ? Math.round((S.dnf / S.checkedIn) * 100) : 0;
      const statsSheetData = [
        { 指標項目: '活動名稱', 數值: ev.nameZh, 比例與說明: `起跑時間：${ev.raceStart || '-'}` },
        { 指標項目: '總報名人數（含取消）', 數值: S.total, 比例與說明: `有效報名 ${S.activeTotal} 人｜已取消 ${S.cancelled} 人` },
        { 指標項目: '已繳費人數 (PAID)', 數值: S.paid, 比例與說明: `繳費率 ${S.payRate}%（佔有效報名）` },
        { 指標項目: '實際報到人數', 數值: S.checkedIn, 比例與說明: `報到率 ${S.checkinRate}%（佔已繳費）｜${chkOfReg}%（佔有效報名）` },
        { 指標項目: '完賽人數 (FINISHED)', 數值: S.finished, 比例與說明: `完賽率 ${S.finishRate}%（佔已報到）｜${finOfReg}%（佔有效報名）` },
        { 指標項目: '未完賽 (DNF)', 數值: S.dnf, 比例與說明: `DNF 率 ${dnfRate}%（佔已報到）` },
        { 指標項目: '八百壯士 100K+ 達標人數', 數值: S.warriors800, 比例與說明: `全場累計有效距離 ${S.totalKmAll} km` },
        ...an.byCategory.map((c) => ({
          指標項目: `[分組] ${c.name}`,
          數值: `報名 ${c.active} / 報到 ${c.checkedIn} / 完賽 ${c.finished}`,
          比例與說明: `報到率 ${c.paid > 0 ? Math.round((c.checkedIn / c.paid) * 100) : 0}%｜完賽率(報到) ${c.finishRate}%｜完賽率(報名) ${c.active > 0 ? Math.round((c.finished / c.active) * 100) : 0}%`
        }))
      ];
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(statsSheetData), '活動統計與比例總覽');
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(summaryData.length ? summaryData : [{ 提示: '尚無成績' }]), '總成績');
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(splitData.length ? splitData : [{ 提示: '尚無感應明細' }]), '各站與逐圈明細');
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(rosterData.length ? rosterData : [{ 提示: '尚無名冊' }]), '選手名冊');
      global.XLSX.writeFile(wb, `${ev.nameZh}_${masked ? '隱碼公開版' : '完整存檔版'}.xlsx`);
      App.toast(`📊 已匯出含統計總覽 Excel（${masked ? '隱碼公開版' : '完整存檔版'}）`, 'success');
    } else {
      const headers = Object.keys(summaryData[0] || { 號碼布: '' });
      const csv = '\uFEFF' + [headers.join(','), ...summaryData.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
      downloadText(`${ev.eventId}_${masked ? '隱碼公開版' : '完整存檔版'}.csv`, csv, 'text/csv;charset=utf-8');
    }
  }

  async function export800WarriorsExcel(App, ev) {
    await C.ensureExternalLib('xlsx');
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
   * 共用完賽統計總覽元件（報名人數 / 報到人數 / 完賽人數及各比例資料）
   * -------------------------------------------------------------------------- */
  function buildEventRatioStatsHtml(App, ev, title = '📊 本活動完賽統計與各階段比例總覽') {
    const an = C.computeEventProgressAnalytics({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    });
    const S = an.summary;
    const chkOfReg = S.activeTotal > 0 ? Math.round((S.checkedIn / S.activeTotal) * 100) : 0;
    const finOfReg = S.activeTotal > 0 ? Math.round((S.finished / S.activeTotal) * 100) : 0;
    const dnfOfChk = S.checkedIn > 0 ? Math.round((S.dnf / S.checkedIn) * 100) : 0;

    return `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <h3 class="font-black text-sm text-slate-900">${C.escapeHtml(title)}</h3>
          <span class="mono text-[11px] text-slate-500">起跑時間：<b>${ev.raceStart || '尚未設定'}</b> ｜ 全場累計距離：<b>${S.totalKmAll.toLocaleString()} km</b></span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          <div class="p-3 rounded-xl bg-slate-50 border">
            <div class="text-slate-500 font-bold">📋 有效報名</div>
            <div class="text-2xl font-black mono text-slate-900 mt-0.5">${S.activeTotal}</div>
            <div class="text-[10px] text-slate-500">總報名 ${S.total}｜取消 ${S.cancelled}</div>
          </div>
          <div class="p-3 rounded-xl bg-amber-50 border border-amber-200">
            <div class="text-amber-800 font-bold">💳 已繳費</div>
            <div class="text-2xl font-black mono text-amber-900 mt-0.5">${S.paid} <span class="text-xs">(${S.payRate}%)</span></div>
            <div class="text-[10px] text-amber-800">繳費率</div>
          </div>
          <div class="p-3 rounded-xl bg-indigo-50 border border-indigo-200">
            <div class="text-indigo-800 font-bold">✅ 已報到</div>
            <div class="text-2xl font-black mono text-indigo-900 mt-0.5">${S.checkedIn} <span class="text-xs">(${S.checkinRate}%)</span></div>
            <div class="text-[10px] text-indigo-800">佔已繳 ${S.checkinRate}%｜佔報名 ${chkOfReg}%</div>
          </div>
          <div class="p-3 rounded-xl bg-emerald-50 border border-emerald-200">
            <div class="text-emerald-800 font-bold">🏁 已完賽</div>
            <div class="text-2xl font-black mono text-emerald-800 mt-0.5">${S.finished} <span class="text-xs">(${S.finishRate}%)</span></div>
            <div class="text-[10px] text-emerald-800">佔報到 ${S.finishRate}%｜佔報名 ${finOfReg}%</div>
          </div>
          <div class="p-3 rounded-xl bg-rose-50 border border-rose-200">
            <div class="text-rose-800 font-bold">🛑 退賽 DNF</div>
            <div class="text-2xl font-black mono text-rose-800 mt-0.5">${S.dnf} <span class="text-xs">(${dnfOfChk}%)</span></div>
            <div class="text-[10px] text-rose-700">★百K ${S.warriors800} 人</div>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-[11px] text-left">
            <thead class="bg-slate-100 text-slate-700">
              <tr>
                <th class="p-2">分組名稱</th>
                <th class="p-2 text-right">報名人數</th>
                <th class="p-2 text-right">已繳費</th>
                <th class="p-2 text-right">報到人數</th>
                <th class="p-2 text-right">報到率(佔已繳)</th>
                <th class="p-2 text-right">完賽人數</th>
                <th class="p-2 text-right">完賽率(佔報到)</th>
                <th class="p-2 text-right">完賽率(佔報名)</th>
              </tr>
            </thead>
            <tbody class="divide-y mono">
              ${an.byCategory.map((c) => {
                const cChkRate = c.paid > 0 ? Math.round((c.checkedIn / c.paid) * 100) : 0;
                const cFinReg = c.active > 0 ? Math.round((c.finished / c.active) * 100) : 0;
                return `
                  <tr>
                    <td class="p-2 font-sans font-bold text-slate-900">${C.escapeHtml(c.name)}</td>
                    <td class="p-2 text-right">${c.active}</td>
                    <td class="p-2 text-right text-amber-800">${c.paid}</td>
                    <td class="p-2 text-right text-indigo-800 font-bold">${c.checkedIn}</td>
                    <td class="p-2 text-right text-indigo-700">${cChkRate}%</td>
                    <td class="p-2 text-right text-emerald-700 font-black">${c.finished}</td>
                    <td class="p-2 text-right font-bold text-emerald-700">${c.finishRate}%</td>
                    <td class="p-2 text-right text-slate-600">${cFinReg}%</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  /* --------------------------------------------------------------------------
   * 專區 1：🏃 進行中活動管理（5 分頁按需渲染 Lazy Render，操作零延遲）
   * -------------------------------------------------------------------------- */
  let z1DirtyTabs = new Set(['setup', 'recon', 'chip', 'score', 'ops']);
  let z1RenderedEventId = '';

  function getActiveZ1Tab() {
    const activeBtn = document.querySelector('[data-z1tab].active');
    return activeBtn ? activeBtn.dataset.z1tab : 'setup';
  }

  function renderZone1Tab(App, tabName, force = false) {
    const managed = getManagedEvents(App, false);
    const ev = managed.find((e) => e.eventId === App.State.z1EventId);
    if (!ev) return;
    if (tabName === 'gun') { tabName = 'chip'; App.State.z1ChipSub = 'start'; }
    if (tabName !== 'chip' && C.NFC?.isScanning) C.NFC.stopScanning();
    if (!force && z1RenderedEventId === ev.eventId && !z1DirtyTabs.has(tabName)) return;
    if (tabName === 'setup') renderZ1Setup(App, ev);
    else if (tabName === 'recon') renderZ1Recon(App, ev);
    else if (tabName === 'chip') renderZ1ChipControl(App, ev);
    else if (tabName === 'score') renderZ1Score(App, ev);
    else if (tabName === 'ops') renderZ1Ops(App, ev);
    z1RenderedEventId = ev.eventId;
    z1DirtyTabs.delete(tabName);
  }

  function renderZone1(App) {
    const u = App.State.currentUser;
    if (!u || (u.role !== 'super_admin' && u.role !== 'organizer')) {
      $$('.z1-panel').forEach((p) => { p.innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：僅限最高權責管理員與承辦人存取。</div>'; });
      return;
    }
    const isSuper = u.role === 'super_admin';
    const managed = getManagedEvents(App, false);
    const sel = $('#z1EventSelect');
    const badge = $('#z1RoleScopeBadge');
    if (badge) {
      badge.className = `px-2 py-0.5 rounded-full text-[11px] font-bold ${isSuper ? 'bg-rose-100 text-rose-800' : 'bg-sky-100 text-sky-800'}`;
      badge.textContent = isSuper ? `🛡️ 全平台 ${managed.length} 場` : `👤 本人承辦 ${managed.length} 場`;
    }
    if (!managed.length) {
      sel.innerHTML = '<option value="">（目前無進行中活動，請建立新活動或至已結案解鎖）</option>';
      $$('.z1-panel').forEach((p) => { p.innerHTML = '<div class="bg-white p-8 rounded-xl border text-center text-slate-400 text-sm">您名下目前沒有進行中的活動。請點擊上方「+ 新活動」。</div>'; });
      return;
    }
    if (!managed.some((e) => e.eventId === App.State.z1EventId)) {
      App.State.z1EventId = managed[0].eventId;
    }
    sel.innerHTML = managed.map((e) => `<option value="${e.eventId}" ${e.eventId === App.State.z1EventId ? 'selected' : ''}>${C.isTestSuiteId(e.eventId) ? '🧪 ' : ''}${C.escapeHtml(e.nameZh)}${isSuper ? `（承辦：${C.escapeHtml(e.ownerUsername || '-')}）` : ''}</option>`).join('');
    const ev = managed.find((e) => e.eventId === App.State.z1EventId);

    z1DirtyTabs = new Set(['setup', 'recon', 'chip', 'score', 'ops']);
    z1RenderedEventId = ev.eventId;
    renderZ1StageGateBar(App, ev);
    renderZone1Tab(App, getActiveZ1Tab(), true);
  }

  function renderZ1StageGateBar(App, ev) {
    const bar = $('#z1StageGateBar');
    if (!bar || !ev) return;
    const g = C.evaluateEventStageGates({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs,
      syncQueue: App.State.syncQueue, hasCloudGas: Boolean(App.State.gasUrl)
    });
    const stStyles = {
      pass: { box: 'bg-emerald-50 border-emerald-300 text-emerald-900', tag: 'bg-emerald-600 text-white', txt: '通過 ✓' },
      active: { box: 'bg-sky-50 border-sky-400 text-sky-950 ring-1 ring-sky-300', tag: 'bg-sky-600 text-white', txt: '進行中' },
      ready: { box: 'bg-indigo-50 border-indigo-300 text-indigo-950', tag: 'bg-indigo-600 text-white', txt: '就緒' },
      warn: { box: 'bg-amber-50 border-amber-300 text-amber-950', tag: 'bg-amber-500 text-slate-950', txt: '待確認' },
      block: { box: 'bg-rose-50 border-rose-300 text-rose-950', tag: 'bg-rose-600 text-white', txt: '管制攔截' },
      locked: { box: 'bg-slate-100 border-slate-200 text-slate-500', tag: 'bg-slate-400 text-white', txt: '待前階段' }
    };
    bar.innerHTML = `
      <div class="bg-white px-3.5 py-2.5 rounded-xl border shadow-sm space-y-2 text-xs">
        <div class="font-black text-slate-800">🛡️ 賽事進度（階段 ${g.currentStage} / 5）</div>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
          ${g.stages.map((s) => {
            const st = stStyles[s.status] || stStyles.locked;
            return `
              <button type="button" data-jump-z1tab="${s.tab}" data-jump-z1sub="${s.subTab || ''}" class="text-left px-2.5 py-2 rounded-xl border transition hover:shadow ${st.box}">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-black text-xs">${s.title}</span>
                  <span class="px-1.5 py-0.5 rounded-full text-[10px] font-black ${st.tag}">${st.txt}</span>
                </div>
                <div class="text-[11px] opacity-85 mt-0.5 mono truncate">${C.escapeHtml(s.detail)}</div>
              </button>`;
          }).join('')}
        </div>
      </div>`;
    $$('[data-jump-z1tab]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.jumpZ1sub) App.State.z1ChipSub = b.dataset.jumpZ1sub;
        const targetBtn = document.querySelector(`[data-z1tab="${b.dataset.jumpZ1tab}"]`);
        if (targetBtn) {
          targetBtn.click();
          if (b.dataset.jumpZ1tab === 'chip') renderZone1Tab(App, 'chip', true);
        }
      };
    });
  }

  function renderZ1Setup(App, ev) {
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const wf = C.getRaceTypeWorkflow(ev, App.State.stations, App.State.categories);
    const isLap = ev.raceType === 'lap_timed';
    const payMode = C.getEventPaymentMode(ev);
    const activeRegCount = App.State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() !== 'CANCELLED').length;
    const payLocked = activeRegCount > 0 || ev.status === 'closed' || ev.status === 'finished';
    const box = $('#z1-setup');

    box.innerHTML = `
      <!-- 🧭 依賽制類型專屬作業流程檢視（預設收合，點一下展開，畫面清爽） -->
      <details id="z1RaceWorkflowGuide" class="rounded-xl border text-xs shadow-sm ${isLap ? 'bg-indigo-50/70 border-indigo-200' : 'bg-sky-50/70 border-sky-200'}">
        <summary class="px-4 py-2.5 cursor-pointer flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="acc-arrow inline-block text-slate-500">▶</span>
            <span class="px-2.5 py-0.5 rounded-full font-black ${isLap ? 'bg-indigo-700 text-white' : 'bg-sky-700 text-white'}">${wf.badge}</span>
            <span class="font-bold text-slate-800">檢視 5 步賽制流程</span>
          </div>
          <span class="text-xs font-semibold ${isLap ? 'text-indigo-900' : 'text-sky-900'}">${C.escapeHtml(wf.shortRule)}</span>
        </summary>
        <div class="px-4 pb-3.5 pt-1 grid grid-cols-1 sm:grid-cols-5 gap-2 border-t border-black/5">
          ${wf.steps.map((st) => `
            <div class="p-2.5 rounded-lg bg-white border ${st.ok ? 'border-emerald-300' : 'border-amber-300'}">
              <div class="flex items-center justify-between font-black text-xs">
                <span>${st.no}. ${C.escapeHtml(st.title)}</span>
                <span class="${st.ok ? 'text-emerald-600' : 'text-amber-600'}">${st.ok ? '✓' : '!'}</span>
              </div>
              <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">${C.escapeHtml(st.desc)}</div>
            </div>`).join('')}
        </div>
      </details>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- 活動基本設定 -->
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-3 text-xs">
          <h3 class="font-black text-sm border-b pb-2">⚙️ 基本設定</h3>
          <div class="grid grid-cols-2 gap-2.5">
            <div class="col-span-2">
              <label class="font-bold">活動名稱</label>
              <input id="z1NameZh" value="${C.escapeHtml(ev.nameZh)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div class="col-span-2">
              <label class="font-bold">英文名稱（DUV 用）</label>
              <input id="z1NameEn" value="${C.escapeHtml(ev.nameEn)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div class="col-span-2 space-y-1">
              <label class="font-bold block">賽制類型</label>
              <input type="hidden" id="z1RaceType" value="${ev.raceType}" />
              <div class="grid grid-cols-2 gap-2">
                <button type="button" data-z1-racetype="distance" class="p-2.5 rounded-xl border-2 text-left transition ${!isLap ? 'border-sky-600 bg-sky-50 text-sky-950' : 'border-slate-200 bg-white text-slate-600'}">
                  <div class="font-black">🏃 距離賽</div>
                  <div class="text-[10px] opacity-80 mt-0.5">固定里程・比完賽時間</div>
                </button>
                <button type="button" data-z1-racetype="lap_timed" class="p-2.5 rounded-xl border-2 text-left transition ${isLap ? 'border-indigo-600 bg-indigo-50 text-indigo-950' : 'border-slate-200 bg-white text-slate-600'}">
                  <div class="font-black">🔁 繞圈賽</div>
                  <div class="text-[10px] opacity-80 mt-0.5">固定限時・比累計里程</div>
                </button>
              </div>
            </div>
            <div class="col-span-2 space-y-1.5 pt-1 border-t">
              <div class="flex flex-wrap items-center justify-between gap-1">
                <label class="font-bold">💰 繳費方式</label>
                ${payLocked
                  ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-950 font-black text-[10px]">🔒 已鎖定（已有 ${activeRegCount} 人報名）</span>`
                  : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">可變更</span>'}
              </div>
              <input type="hidden" id="z1PayMode" value="${payMode}" />
              <div class="grid grid-cols-2 gap-2">
                ${(C.PAYMENT_MODES || []).map((pm) => {
                  const isPayuniDisabled = pm.id === 'ONLINE_PAYUNi' && !C.PAYUNi_FEATURE_ENABLED;
                  const sel = payMode === pm.id;
                  const disabledBtn = payLocked || isPayuniDisabled;
                  const actCls = pm.id === 'ONLINE_PAYUNi' ? 'border-emerald-600 bg-emerald-50 text-emerald-950' : 'border-amber-500 bg-amber-50 text-amber-950';
                  return `
                    <button type="button" data-z1-paymode="${pm.id}" ${disabledBtn ? 'disabled' : ''} class="p-2.5 rounded-xl border-2 text-left transition ${isPayuniDisabled && !sel ? 'border-slate-200 bg-slate-100 text-slate-400 opacity-60 cursor-not-allowed' : (sel ? actCls : 'border-slate-200 bg-white text-slate-500')} ${disabledBtn ? 'cursor-not-allowed' : 'hover:shadow-sm'}">
                      <div class="font-black">${pm.short}${sel ? ' ✓' : ''}${isPayuniDisabled ? ' <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">未開通</span>' : ''}</div>
                      <div class="text-[10px] opacity-85 mt-0.5">${isPayuniDisabled ? '尚未串接金流' : C.escapeHtml(pm.desc)}</div>
                    </button>`;
                }).join('')}
              </div>
            </div>
            <div class="col-span-2 p-2.5 rounded-xl bg-amber-50 border border-amber-300">
              <label class="font-black text-amber-950 block">🏁 起跑時間 *</label>
              <input id="z1RaceStart" value="${C.escapeHtml(ev.raceStart || '')}" placeholder="YYYY-MM-DD HH:mm:ss" class="w-full px-2.5 py-1.5 border border-amber-400 rounded-lg mt-1 bg-white mono font-bold" />
            </div>
            ${(() => {
              const ebCfg = C.getEventEarlyBirdConfig(ev);
              const ebAct = C.isEarlyBirdActive(ev);
              return `
                <div class="col-span-2 p-2.5 rounded-xl bg-emerald-50 border border-emerald-300 space-y-1.5">
                  <div class="flex flex-wrap items-center justify-between gap-1">
                    <label class="inline-flex items-center gap-1.5 font-black text-emerald-950 cursor-pointer">
                      <input id="z1EarlyBirdEnabled" type="checkbox" ${ebCfg.enabled ? 'checked' : ''} class="accent-emerald-600" />
                      <span>🐤 啟用早鳥價</span>
                    </label>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-black ${!ebCfg.enabled ? 'bg-slate-200 text-slate-600' : (ebAct ? 'bg-emerald-600 text-white' : 'bg-amber-200 text-amber-950')}">${!ebCfg.enabled ? '未啟用' : (ebAct ? '🟢 進行中' : '⏰ 已截止')}</span>
                  </div>
                  <input id="z1EarlyBirdEnd" value="${C.escapeHtml(ebCfg.endTime || '')}" placeholder="截止時間 YYYY-MM-DD HH:mm:ss" class="w-full px-2.5 py-1.5 border border-emerald-400 rounded-lg bg-white mono font-bold" />
                </div>`;
            })()}
            <div>
              <label class="font-bold">狀態</label>
              <select id="z1Status" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5">
                ${['open', 'draft', 'closed', 'auto'].map((st) => `<option value="${st}" ${ev.status === st ? 'selected' : ''}>${st}</option>`).join('')}
              </select>
            </div>
            <div id="z1LapDistWrap" class="${isLap ? '' : 'opacity-45'}">
              <label class="font-bold">${isLap ? '單圈里程 (km) *' : '單圈里程（免填）'}</label>
              <input id="z1LapDist" type="number" step="0.05" value="${ev.lapDistanceKm || 0}" ${isLap ? '' : 'disabled'} class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 mono ${isLap ? 'bg-indigo-50/50 border-indigo-300' : 'bg-slate-100'}" />
            </div>
            <div>
              <label class="font-bold">總名額 (0=不限)</label>
              <input id="z1MaxQuota" type="number" value="${ev.maxQuota || 0}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 mono" />
            </div>
            <div>
              <label class="font-bold">主辦單位</label>
              <input id="z1OrgZh" value="${C.escapeHtml(ev.organizerZh || '')}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div>
              <label class="font-bold">🎖️ 賽事總監</label>
              <input id="z1Director" value="${C.escapeHtml(C.parseJsonSafe(ev.certConfigJson, C.defaultCertConfig()).raceDirectorName || '')}" placeholder="例：林政宏" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
            </div>
            <div>
              <label class="font-bold">👤 負責承辦人</label>
              ${App.State.currentUser?.role === 'super_admin'
                ? `<select id="z1OwnerUser" class="w-full px-2.5 py-1.5 border border-rose-300 bg-rose-50/40 rounded-lg mt-0.5 font-bold">
                    ${App.State.users.filter((x) => x.role === 'organizer' || x.role === 'super_admin').map((x) => `<option value="${C.escapeHtml(x.username)}" ${x.username === ev.ownerUsername ? 'selected' : ''}>${C.escapeHtml(x.displayName)} (${C.escapeHtml(x.username)})</option>`).join('')}
                  </select>`
                : `<input disabled value="${C.escapeHtml(ev.ownerUsername || '')}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 bg-slate-100 mono text-slate-600" />`}
            </div>
          </div>

          <div class="space-y-1.5 pt-2 border-t">
            <label class="font-bold block">📜 活動簡章（選填）</label>
            <textarea id="z1Brochure" rows="3" placeholder="留空則前台不顯示" class="w-full px-2.5 py-2 border rounded-lg text-xs leading-relaxed">${C.escapeHtml(C.sanitizeBrochureText(ev.brochureText))}</textarea>
          </div>

          <div class="space-y-2 pt-2 border-t">
            <label class="font-bold block">🎨 活動橫幅</label>
            <div class="h-20 rounded-xl flex items-end p-3 text-white font-black text-sm shadow-inner" id="z1BannerPreview" style="${C.getBannerStyle(ev.bannerUrl)}">${C.escapeHtml(ev.nameZh)}</div>
            <details class="rounded-xl bg-slate-50 border p-2.5">
              <summary class="cursor-pointer font-bold text-slate-700 flex items-center justify-between">
                <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-slate-400">▶</span><span>更換橫幅</span></span>
                <span class="text-[11px] text-sky-700">展開</span>
              </summary>
              <div class="mt-2.5 space-y-2">
                <div class="text-[11px] font-bold text-amber-800">⚡ 動感插畫</div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  ${C.CURATED_BANNERS.filter((b) => b.isDynamic).map((b) => `
                    <button type="button" data-pick-banner="${b.id}" class="h-12 rounded-lg border text-white font-bold text-[11px] flex items-end p-1.5 shadow-sm transition ${ev.bannerUrl === b.id ? 'ring-2 ring-amber-400 scale-[1.01]' : 'opacity-90 hover:opacity-100'}" style="${C.getBannerStyle(b.id)}">
                      <span class="bg-black/45 px-1.5 py-0.5 rounded">${b.name}</span>
                    </button>`).join('')}
                </div>
                <div class="text-[11px] font-bold text-slate-600">🎨 經典漸層</div>
                <div class="grid grid-cols-5 gap-1">
                  ${C.CURATED_BANNERS.filter((b) => !b.isDynamic).map((b) => `<button type="button" data-pick-banner="${b.id}" class="h-6 rounded border ${ev.bannerUrl === b.id ? 'ring-2 ring-amber-400' : ''}" style="background:${b.css};" title="${b.name}"></button>`).join('')}
                </div>
                <input id="z1BannerUpload" type="file" accept="image/*" class="text-[11px] w-full" />
              </div>
            </details>
          </div>
          <button id="btnZ1SaveEvent" class="w-full py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black">💾 儲存設定</button>
        </div>

        <!-- 分組設定 + 加購項目 -->
        <div class="space-y-4 text-xs">
          <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
            <div class="flex items-center justify-between border-b pb-2">
              <h3 class="font-black text-sm">🏷️ 分組設定</h3>
              <button type="button" id="btnZ1AddCat" class="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold shrink-0">+ 新增分組</button>
            </div>

            <div id="z1CatEditorBox" class="hidden p-3 rounded-xl bg-sky-50/80 border-2 border-sky-300 space-y-2.5">
              <div class="flex items-center justify-between border-b border-sky-200 pb-1.5">
                <div id="z1CatEditorTitle" class="font-black text-sky-950">➕ 新增分組</div>
                <button type="button" id="btnZ1CancelCatEdit" class="text-xs text-slate-500 hover:text-slate-800 font-bold">✕ 關閉</button>
              </div>
              <input type="hidden" id="z1CatEditId" value="" />
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div class="col-span-2">
                  <label class="font-bold text-[11px]">組別名稱 <span class="text-rose-600">*</span></label>
                  <input id="z1CatName" type="text" value="" placeholder="例：50K 超馬組" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">距離 (km) <span class="text-rose-600">*</span></label>
                  <input id="z1CatDist" type="number" step="0.1" min="0" value="" placeholder="50" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">限時 (時) <span class="text-rose-600">*</span></label>
                  <input id="z1CatHrs" type="number" step="0.5" min="0.5" value="" placeholder="8" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">報名費 <span class="text-rose-600">*</span></label>
                  <input id="z1CatFee" type="number" min="0" value="" placeholder="1800" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">早鳥價</label>
                  <input id="z1CatEarlyFee" type="number" min="0" value="" placeholder="選填" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">配號前綴 <span class="text-rose-600">*</span></label>
                  <input id="z1CatPrefix" type="text" maxlength="4" value="" placeholder="A" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono uppercase" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">起始號</label>
                  <input id="z1CatStartNum" type="text" maxlength="5" value="" placeholder="001" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div>
                  <label class="font-bold text-[11px]">限額</label>
                  <input id="z1CatQuota" type="number" min="1" value="" placeholder="300" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
                </div>
                <div class="col-span-2 sm:col-span-3 flex items-end pb-1">
                  <label class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-amber-300 cursor-pointer font-bold text-amber-950 hover:bg-amber-50">
                    <input id="z1CatW800" type="checkbox" class="accent-amber-600" />
                    <span>🏅 八百壯士組</span>
                  </label>
                </div>
              </div>
              <div class="flex justify-end gap-2 pt-1">
                <button type="button" id="btnZ1SaveCat" class="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black shadow">💾 儲存</button>
              </div>
            </div>

            <div class="space-y-1.5">
              ${cats.map((c) => {
                const isW800 = C.isCategoryWarrior800(c);
                const pr = C.getEffectiveCategoryPrice(ev, c);
                const ebTag = Number(c.earlyBirdFee || 0) > 0
                  ? (pr.isEarlyBird
                    ? `<span class="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-600 text-white font-black text-[10px]">🐤 早鳥中 NT$${c.earlyBirdFee}</span>`
                    : `<span class="ml-1 px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 font-bold text-[10px]">🐤 早鳥價 NT$${c.earlyBirdFee}</span>`)
                  : '';
                return `
                <div class="p-2 rounded-lg ${isW800 ? 'bg-amber-50/80 border-amber-300' : 'bg-slate-50 border-slate-200'} border flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <b>${C.escapeHtml(c.name)}</b>
                    ${isW800 ? '<span class="ml-1 px-1.5 py-0.5 rounded-full bg-amber-500 text-slate-950 font-black text-[10px]">🏅 八百壯士</span>' : ''}
                    ${ebTag}
                    <span class="text-slate-600"> · ${c.distanceKm}km / ${c.timeLimitHours}H · 一般 NT$${c.fee} · 前綴 <code>${c.bibPrefix}${c.bibStartNum}</code> · 限額 ${c.quota}</span>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <label class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border bg-white border-amber-300 text-[11px] font-bold text-amber-950 cursor-pointer hover:bg-amber-50" title="勾選歸類為八百壯士組">
                      <input type="checkbox" data-toggle-cat-w800="${c.catId}" ${isW800 ? 'checked' : ''} class="accent-amber-600" />
                      <span>🏅 八百壯士</span>
                    </label>
                    <button type="button" data-edit-cat="${c.catId}" class="px-2 py-0.5 rounded-lg font-bold text-[11px] border bg-sky-50 border-sky-300 text-sky-900 hover:bg-sky-100">✏️ 修改</button>
                    <button type="button" data-del-cat="${c.catId}" class="text-rose-600 font-bold px-1.5">刪</button>
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>

          <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
              <h3 class="font-black text-sm">🛍️ 加購服務</h3>
              <div class="flex gap-1.5 shrink-0">
                <button type="button" id="btnZ1ResetTurAddons" class="px-2 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold text-[11px]">↺ 預設 3 項</button>
                <button type="button" id="btnZ1AddAddon" class="px-2.5 py-1 rounded-lg bg-amber-500 text-slate-950 font-bold">+ 新增</button>
              </div>
            </div>
            <div class="space-y-1.5">
              ${(schema.addons || []).map((a, idx) => {
                const isOn = a.enabled !== false;
                return `
                <div class="p-2 rounded-lg border flex flex-wrap items-center justify-between gap-2 ${isOn ? 'bg-slate-50 border-slate-200' : 'bg-slate-100/70 border-slate-200 opacity-65'}">
                  <label class="inline-flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" data-toggle-addon="${idx}" ${isOn ? 'checked' : ''} class="accent-amber-600" />
                    <span class="${isOn ? '' : 'line-through text-slate-500'}"><b>${C.escapeHtml(a.name)}</b> +NT$${Number(a.price || 0).toLocaleString()}</span>
                  </label>
                  <div class="flex items-center gap-1.5">
                    <button type="button" data-edit-addon="${idx}" class="px-2 py-0.5 rounded bg-white border border-slate-300 hover:bg-amber-50 text-slate-700 font-bold text-[11px]">✏️ 修改</button>
                    <button type="button" data-del-addon="${idx}" class="text-rose-600 font-bold px-1.5">刪</button>
                  </div>
                </div>`;
              }).join('') || '<div class="text-slate-400 text-center py-3">尚無加購項目</div>'}
            </div>
          </div>

          <!-- 報名表欄位順序 -->
          <div class="bg-white p-4 rounded-xl border-2 border-indigo-200 shadow-sm space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
              <h3 class="font-black text-sm text-indigo-950">↕️ 欄位順序</h3>
              <button type="button" id="btnZ1ResetFieldOrder" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] shrink-0">↺ 重設順序</button>
            </div>

            <div class="space-y-1.5">
              <div class="p-2 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-between text-[11px] text-slate-600">
                <div><b>1. 報名組別</b> <span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold">必填</span></div>
                <span class="text-[10px] text-slate-400 font-bold">固定首位</span>
              </div>
              ${(() => {
                const orderedFields = C.getEffectiveRegFieldOrder(schema);
                return orderedFields.map((item, idx) => {
                  const typeObj = item.isCustom ? (C.CUSTOM_FIELD_TYPES || []).find((t) => t.id === item.cfDef?.type) : null;
                  return `
                    <div class="p-2 rounded-lg border flex items-center justify-between gap-2 ${item.isCustom ? 'bg-indigo-50/70 border-indigo-200' : 'bg-white border-slate-200'}">
                      <div class="min-w-0">
                        <div class="font-bold text-slate-900">
                          ${idx + 2}. ${C.escapeHtml(item.label)}
                          ${item.isCustom
                            ? `<span class="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[10px] font-bold">自訂 · ${C.escapeHtml(typeObj ? typeObj.label : item.cfDef?.type)}</span>`
                            : '<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">預設欄位</span>'}
                          ${item.required
                            ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold">必填</span>'
                            : '<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px]">選填</span>'}
                        </div>
                        ${item.isCustom && Array.isArray(item.cfDef?.options) && item.cfDef.options.length ? `<div class="text-[10px] text-slate-500 truncate mt-0.5">選項：${C.escapeHtml(item.cfDef.options.join(' / '))}</div>` : ''}
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <button type="button" data-move-reg-field="${idx}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} class="px-1.5 py-0.5 rounded bg-white border hover:bg-slate-100 disabled:opacity-35" title="上移">↑</button>
                        <button type="button" data-move-reg-field="${idx}" data-dir="1" ${idx === orderedFields.length - 1 ? 'disabled' : ''} class="px-1.5 py-0.5 rounded bg-white border hover:bg-slate-100 disabled:opacity-35" title="下移">↓</button>
                        ${item.isCustom ? `
                          <button type="button" data-toggle-req-cf="${item.cfIndex}" class="px-1.5 py-0.5 rounded bg-white border hover:bg-amber-50 text-[10px] font-bold">${item.required ? '改選填' : '改必填'}</button>
                          <button type="button" data-del-cf="${item.cfIndex}" class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 font-bold">刪</button>
                        ` : ''}
                      </div>
                    </div>`;
                }).join('');
              })()}
            </div>

            <!-- 自訂欄位 -->
            <div class="pt-3 border-t space-y-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h4 class="font-black text-xs sm:text-sm text-indigo-950">📝 新增自訂欄位</h4>
                <div class="flex flex-wrap gap-1.5">
                  ${(C.CUSTOM_FIELD_PRESETS || []).map((pr, idx) => `
                    <button type="button" data-preset-cf="${idx}" class="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-bold text-[11px] border border-indigo-200">+ ${C.escapeHtml(pr.label)}</button>
                  `).join('')}
                </div>
              </div>

              <div class="p-3 rounded-xl bg-slate-50 border space-y-2">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label class="font-bold text-[11px]">欄位名稱 *</label>
                    <input id="z1CfLabel" type="text" placeholder="例：紀念衣尺寸" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5" />
                  </div>
                  <div>
                    <label class="font-bold text-[11px]">類型</label>
                    <select id="z1CfType" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5">
                      ${(C.CUSTOM_FIELD_TYPES || []).map((t) => `<option value="${t.id}">${C.escapeHtml(t.label)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div id="z1CfOptionsRow" class="hidden">
                  <label class="font-bold text-[11px]">選項（逗號分隔）*</label>
                  <input id="z1CfOptions" type="text" placeholder="S, M, L, XL" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5" />
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                  <div class="sm:col-span-2">
                    <label class="font-bold text-[11px]">提示文字</label>
                    <input id="z1CfPlaceholder" type="text" placeholder="選填" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5" />
                  </div>
                  <label class="flex items-center gap-1.5 py-1.5 font-bold cursor-pointer">
                    <input id="z1CfReq" type="checkbox" /> 必填
                  </label>
                </div>
                <button type="button" id="btnZ1AddCustomField" class="w-full py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-black">+ 加入欄位</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    $('#z1NameZh').oninput = (e) => { $('#z1NameEn').value = C.zhToEnEventName(e.target.value); };
    $$('[data-z1-racetype]').forEach((b) => {
      b.onclick = () => {
        ev.raceType = b.dataset.z1Racetype;
        if (ev.raceType === 'lap_timed' && !Number(ev.lapDistanceKm)) ev.lapDistanceKm = 1.0;
        if (ev.raceType === 'distance') ev.lapDistanceKm = 0;
        renderZ1Setup(App, ev);
      };
    });
    $$('[data-z1-paymode]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.z1Paymode === 'ONLINE_PAYUNi' && !C.PAYUNi_FEATURE_ENABLED) {
          return App.toast('🔒 目前尚未開通線上金流，一律預設使用「實體銀行轉帳（核對末五碼）」', 'warn');
        }
        if (payLocked) return App.toast('🔒 本活動已有選手報名，金流模式已鎖定至報名結束，不可中途切換！', 'warn');
        schema.paymentMode = b.dataset.z1Paymode === 'ONLINE_PAYUNi' ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
        ev.formSchemaJson = JSON.stringify(schema);
        await C.TurDB.put('events', ev);
        await App.enqueueSync('saveEvent', { event: ev });
        renderZ1Setup(App, ev);
        renderZ1Recon(App, ev);
        App.toast(`💰 本活動金流作業模式已設為「${schema.paymentMode === 'ONLINE_PAYUNi' ? '結合金流廠商 PAYUNi' : '轉帳核對末五碼'}」`, 'success');
      };
    });
    $$('[data-pick-banner]').forEach((b) => {
      b.onclick = () => {
        ev.bannerUrl = b.dataset.pickBanner;
        $('#z1BannerPreview').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
        $$('[data-pick-banner]').forEach((x) => x.classList.remove('ring-2', 'ring-amber-400'));
        b.classList.add('ring-2', 'ring-amber-400');
      };
    });
    $('#z1BannerUpload').onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return App.toast('橫幅圖片上限為 5MB！', 'error');
      const reader = new FileReader();
      reader.onload = async () => {
        const compressed = await C.compressCustomBgImage(reader.result, 1000, 38000);
        ev.bannerUrl = compressed;
        $('#z1BannerPreview').setAttribute('style', C.getBannerStyle(ev.bannerUrl));
        App.toast(`🖼️ 橫幅已自動壓縮最佳化（${Math.round(compressed.length / 1024)} KB），不超過試算表儲存上限`, 'info');
      };
      reader.readAsDataURL(f);
    };
    $('#btnZ1SaveEvent').onclick = async () => {
      const rs = ($('#z1RaceStart')?.value || '').trim();
      if (rs && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rs)) {
        return App.toast('起跑時間格式須為 YYYY-MM-DD HH:mm:ss（含完整日期與整數秒）', 'error');
      }
      const ebOn = Boolean($('#z1EarlyBirdEnabled')?.checked);
      const ebEndNorm = C.normalizeEarlyBirdEnd($('#z1EarlyBirdEnd')?.value || '');
      if (ebOn && (!ebEndNorm || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ebEndNorm))) {
        return App.toast('啟用早鳥價時，請填寫正確之早鳥截止日期（YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss）', 'error');
      }
      schema.earlyBirdEnabled = ebOn;
      schema.earlyBirdEnd = ebEndNorm;
      ev.formSchemaJson = JSON.stringify(schema);
      ev.nameZh = $('#z1NameZh').value.trim() || ev.nameZh;
      ev.nameEn = $('#z1NameEn').value.trim() || C.zhToEnEventName(ev.nameZh);
      ev.raceType = $('#z1RaceType').value;
      ev.status = $('#z1Status').value;
      ev.raceStart = rs;
      ev.lapDistanceKm = Number($('#z1LapDist').value || 0);
      ev.maxQuota = Number($('#z1MaxQuota').value || 0);
      ev.organizerZh = $('#z1OrgZh').value.trim();
      if (App.State.currentUser?.role === 'super_admin' && $('#z1OwnerUser')?.value) {
        ev.ownerUsername = $('#z1OwnerUser').value.trim();
      }
      ev.brochureText = $('#z1Brochure').value.trim();
      const certCfg = C.parseJsonSafe(ev.certConfigJson, C.defaultCertConfig());
      certCfg.raceDirectorName = ($('#z1Director')?.value || '').trim();
      ev.certConfigJson = JSON.stringify(certCfg);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.renderAll();
      App.toast('✅ 活動設定、早鳥時段、起跑時間、橫幅與簡章已儲存並同步雲端', 'success');
    };
    const resetCatEditor = () => {
      $('#z1CatEditId').value = '';
      $('#z1CatName').value = '';
      $('#z1CatDist').value = '';
      $('#z1CatHrs').value = '';
      $('#z1CatFee').value = '';
      $('#z1CatEarlyFee').value = '';
      $('#z1CatPrefix').value = '';
      $('#z1CatStartNum').value = '';
      $('#z1CatQuota').value = '';
      $('#z1CatW800').checked = false;
      $('#z1CatEditorTitle').textContent = '➕ 新增分組（所有欄位預設空白，八百壯士有需要再打勾）';
      $('#btnZ1SaveCat').textContent = '💾 新增並儲存分組';
    };
    $('#btnZ1AddCat').onclick = () => {
      resetCatEditor();
      $('#z1CatEditorBox').classList.remove('hidden');
      $('#z1CatName').focus();
    };
    $('#btnZ1CancelCatEdit').onclick = () => {
      resetCatEditor();
      $('#z1CatEditorBox').classList.add('hidden');
    };
    $$('[data-edit-cat]').forEach((b) => {
      b.onclick = () => {
        const cat = App.State.categories.find((c) => c.catId === b.dataset.editCat);
        if (!cat) return;
        $('#z1CatEditId').value = cat.catId;
        $('#z1CatName').value = cat.name || '';
        $('#z1CatDist').value = cat.distanceKm !== undefined ? String(cat.distanceKm) : '';
        $('#z1CatHrs').value = cat.timeLimitHours !== undefined ? String(cat.timeLimitHours) : '';
        $('#z1CatFee').value = cat.fee !== undefined ? String(cat.fee) : '';
        $('#z1CatEarlyFee').value = Number(cat.earlyBirdFee || 0) > 0 ? String(cat.earlyBirdFee) : '';
        $('#z1CatPrefix').value = cat.bibPrefix || '';
        $('#z1CatStartNum').value = cat.bibStartNum || '';
        $('#z1CatQuota').value = cat.quota !== undefined ? String(cat.quota) : '';
        $('#z1CatW800').checked = C.isCategoryWarrior800(cat);
        $('#z1CatEditorTitle').textContent = `✏️ 修改分組：${cat.name}`;
        $('#btnZ1SaveCat').textContent = '💾 儲存分組修改';
        $('#z1CatEditorBox').classList.remove('hidden');
        $('#z1CatName').focus();
      };
    });
    $('#btnZ1SaveCat').onclick = async () => {
      const editId = $('#z1CatEditId').value.trim();
      const name = $('#z1CatName').value.trim();
      const distRaw = $('#z1CatDist').value.trim();
      const hrsRaw = $('#z1CatHrs').value.trim();
      const feeRaw = $('#z1CatFee').value.trim();
      const ebRaw = $('#z1CatEarlyFee').value.trim();
      const prefix = $('#z1CatPrefix').value.trim().toUpperCase();
      const startNum = $('#z1CatStartNum').value.trim() || '001';
      const quotaRaw = $('#z1CatQuota').value.trim();
      const isWarrior800 = Boolean($('#z1CatW800').checked);

      if (!name) return App.toast('請填寫分組名稱', 'error');
      if (!distRaw || isNaN(Number(distRaw)) || Number(distRaw) <= 0) return App.toast('請填寫正確之距離 (km)', 'error');
      if (!hrsRaw || isNaN(Number(hrsRaw)) || Number(hrsRaw) <= 0) return App.toast('請填寫正確之限時 (小時)', 'error');
      if (feeRaw === '' || isNaN(Number(feeRaw)) || Number(feeRaw) < 0) return App.toast('請填寫正確之一般報名費 (NT$)', 'error');
      if (!prefix) return App.toast('請填寫號碼布前綴（如 A、B）', 'error');

      const fee = Number(feeRaw);
      const earlyBirdFee = ebRaw === '' ? 0 : Math.max(0, Number(ebRaw));
      if (earlyBirdFee > 0 && earlyBirdFee >= fee) {
        return App.toast(`早鳥優惠價 (${earlyBirdFee}) 必須低於一般報名費 (${fee})！`, 'error');
      }
      const quota = quotaRaw === '' ? 300 : Math.max(1, Number(quotaRaw));

      if (editId) {
        const cat = App.State.categories.find((c) => c.catId === editId);
        if (!cat) return App.toast('找不到要修改的分組', 'error');
        cat.name = name;
        cat.distanceKm = Number(distRaw);
        cat.timeLimitHours = Number(hrsRaw);
        cat.fee = fee;
        cat.earlyBirdFee = earlyBirdFee;
        cat.bibPrefix = prefix;
        cat.bibStartNum = startNum;
        cat.quota = quota;
        cat.isWarrior800 = isWarrior800;
        await C.TurDB.put('categories', cat);
        await App.enqueueSync('saveCategory', { category: cat });
        resetCatEditor();
        renderZone1(App);
        App.toast(`✅ 已更新分組「${name}」${earlyBirdFee ? `（🐤 早鳥 NT$${earlyBirdFee}）` : ''}${isWarrior800 ? '（🏅 八百壯士）' : ''}`, 'success');
      } else {
        const cat = {
          catId: `CAT-${Date.now().toString().slice(-5)}`,
          eventId: ev.eventId,
          name,
          distanceKm: Number(distRaw),
          timeLimitHours: Number(hrsRaw),
          fee,
          earlyBirdFee,
          bibPrefix: prefix,
          bibStartNum: startNum,
          quota,
          customRaceStart: '',
          isWarrior800
        };
        App.State.categories.push(cat);
        await C.TurDB.put('categories', cat);
        await App.enqueueSync('saveCategory', { category: cat });
        resetCatEditor();
        renderZone1(App);
        App.toast(`✅ 已新增分組「${name}」${earlyBirdFee ? `（🐤 早鳥 NT$${earlyBirdFee}）` : ''}${isWarrior800 ? '（🏅 八百壯士）' : ''}`, 'success');
      }
    };
    $$('[data-toggle-cat-w800]').forEach((cb) => {
      cb.onchange = async () => {
        const cat = App.State.categories.find((c) => c.catId === cb.dataset.toggleCatW800);
        if (!cat) return;
        cat.isWarrior800 = Boolean(cb.checked);
        await C.TurDB.put('categories', cat);
        await App.enqueueSync('saveCategory', { category: cat });
        renderZone1(App);
        App.toast(cat.isWarrior800 ? `🏅 已勾選「${cat.name}」歸類為八百壯士組` : `已取消「${cat.name}」的八百壯士勾選`, 'info');
      };
    });
    $$('[data-del-cat]').forEach((b) => {
      b.onclick = async () => {
        const cid = b.dataset.delCat;
        const evCats = App.State.categories.filter((c) => c.eventId === ev.eventId);
        if (evCats.length <= 1) {
          return App.toast('🔒 防呆攔截：活動至少須保留 1 個報名分組，不可全部刪除！', 'error');
        }
        const inUseCnt = App.State.participants.filter((p) => p.eventId === ev.eventId && p.catId === cid && String(p.payStatus || '').toUpperCase() !== 'CANCELLED').length;
        if (inUseCnt > 0) {
          return App.toast(`🔒 防呆攔截：此分組已有 ${inUseCnt} 位報名選手，禁止刪除以免造成資料錯亂！`, 'error');
        }
        const target = evCats.find((c) => c.catId === cid);
        if (!confirm(`確定要刪除分組「${target?.name || cid}」並同步雲端嗎？`)) return;
        App.State.categories = App.State.categories.filter((c) => c.catId !== cid);
        await C.TurDB.remove('categories', cid);
        await App.enqueueSync('deleteCategory', { catId: cid });
        renderZone1(App);
        App.toast(`🗑️ 已安全刪除分組「${target?.name || cid}」並同步雲端`, 'info');
      };
    });
    $('#btnZ1ResetTurAddons').onclick = async () => {
      if (!Array.isArray(schema.addons)) schema.addons = [];
      let added = 0;
      (C.DEFAULT_TUR_ADDONS || []).forEach((def) => {
        if (!schema.addons.some((x) => x.code === def.code || x.name === def.name)) {
          schema.addons.push({ ...def });
          added++;
        }
      });
      if (!Array.isArray(schema.customFields)) schema.customFields = [];
      if (C.DEFAULT_ADDONS_NOTE_FIELD && !schema.customFields.some((f) => f.key === C.DEFAULT_ADDONS_NOTE_FIELD.key)) {
        schema.customFields.unshift({ ...C.DEFAULT_ADDONS_NOTE_FIELD });
      }
      ev.formSchemaJson = JSON.stringify(schema);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      renderZone1(App);
      App.toast(added ? `✅ 已補齊 ${added} 項 TUR 預設加購與備註欄位` : '✅ 本活動已具備完整 TUR 預設加購項目與備註欄位', 'success');
    };
    $('#btnZ1AddAddon').onclick = async () => {
      const name = prompt('加購項目名稱（如 賽事機能襪、接駁專車）：');
      if (!name) return;
      const price = Math.max(0, Number(prompt('加購金額 (NT$)：', '250') || 250));
      if (!Array.isArray(schema.addons)) schema.addons = [];
      schema.addons.push({ code: 'addon_' + Date.now(), name: name.trim(), price, enabled: true });
      ev.formSchemaJson = JSON.stringify(schema);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      renderZone1(App);
      App.toast(`✅ 已新增加購項「${name.trim()}」(+NT$${price})`, 'success');
    };
    $$('[data-toggle-addon]').forEach((cb) => {
      cb.onchange = async () => {
        const a = schema.addons?.[Number(cb.dataset.toggleAddon)];
        if (!a) return;
        a.enabled = cb.checked;
        ev.formSchemaJson = JSON.stringify(schema);
        await C.TurDB.put('events', ev);
        await App.enqueueSync('saveEvent', { event: ev });
        renderZone1(App);
        App.toast(`${a.enabled ? '✅ 已啟用' : '⏸️ 已暫停'}加購項「${a.name}」`, 'info');
      };
    });
    $$('[data-edit-addon]').forEach((b) => {
      b.onclick = async () => {
        const a = schema.addons?.[Number(b.dataset.editAddon)];
        if (!a) return;
        const nm = prompt('修改加購項目名稱：', a.name);
        if (nm === null || !nm.trim()) return;
        const prStr = prompt(`修改「${nm.trim()}」加購金額 (NT$)：`, String(a.price ?? 0));
        if (prStr === null) return;
        a.name = nm.trim();
        a.price = Math.max(0, Number(prStr || 0));
        ev.formSchemaJson = JSON.stringify(schema);
        await C.TurDB.put('events', ev);
        await App.enqueueSync('saveEvent', { event: ev });
        renderZone1(App);
        App.toast(`✅ 已更新加購項「${a.name}」(+NT$${a.price})`, 'success');
      };
    });
    $$('[data-del-addon]').forEach((b) => {
      b.onclick = async () => {
        schema.addons.splice(Number(b.dataset.delAddon), 1);
        ev.formSchemaJson = JSON.stringify(schema);
        await C.TurDB.put('events', ev);
        await App.enqueueSync('saveEvent', { event: ev });
        renderZone1(App);
      };
    });

    // 自訂擴充報名欄位事件綁定
    if (!Array.isArray(schema.customFields)) schema.customFields = [];
    const saveSchema = async (msg) => {
      ev.formSchemaJson = JSON.stringify(schema);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      renderZone1(App);
      if (msg) App.toast(msg, 'success');
    };
    const updateCfOptionsVisibility = () => {
      const t = (C.CUSTOM_FIELD_TYPES || []).find((x) => x.id === $('#z1CfType').value);
      $('#z1CfOptionsRow').classList.toggle('hidden', !(t && t.needsOptions));
    };
    $('#z1CfType').onchange = updateCfOptionsVisibility;
    updateCfOptionsVisibility();

    $$('[data-preset-cf]').forEach((b) => {
      b.onclick = async () => {
        const pr = (C.CUSTOM_FIELD_PRESETS || [])[Number(b.dataset.presetCf)];
        if (!pr) return;
        if (schema.customFields.some((f) => f.key === pr.key)) {
          return App.toast(`欄位「${pr.label}」已存在於本活動報名表`, 'warn');
        }
        schema.customFields.push({ ...pr, options: [...(pr.options || [])] });
        await saveSchema(`✅ 已一鍵加入自訂欄位「${pr.label}」`);
      };
    });

    $('#btnZ1AddCustomField').onclick = async () => {
      const label = $('#z1CfLabel').value.trim();
      const type = $('#z1CfType').value;
      const typeObj = (C.CUSTOM_FIELD_TYPES || []).find((x) => x.id === type);
      const rawOpts = $('#z1CfOptions').value.trim();
      const options = rawOpts ? rawOpts.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean) : [];
      const placeholder = $('#z1CfPlaceholder').value.trim();
      const required = $('#z1CfReq').checked;
      if (!label) return App.toast('請輸入自訂欄位名稱', 'warn');
      if (typeObj && typeObj.needsOptions && options.length < 2) {
        return App.toast('下拉 / 單選 / 多選欄位請至少填寫 2 個選項（以逗號分隔）', 'warn');
      }
      const key = 'cf_' + Date.now().toString(36);
      schema.customFields.push({ key, label, type, required, options, placeholder });
      await saveSchema(`✅ 已新增自訂欄位「${label}」(${type})`);
    };

    $$('[data-move-reg-field]').forEach((b) => {
      b.onclick = async () => {
        const ordered = C.getEffectiveRegFieldOrder(schema).map((x) => x.id);
        const i = Number(b.dataset.moveRegField);
        const j = i + Number(b.dataset.dir);
        if (j < 0 || j >= ordered.length) return;
        const tmp = ordered[i];
        ordered[i] = ordered[j];
        ordered[j] = tmp;
        schema.fieldOrder = ordered;
        // 同步更新 customFields 陣列順序，讓多場聯報與 Excel 匯出順序一致
        const cfById = new Map(schema.customFields.map((f) => [`cf:${f.key}`, f]));
        const reorderedCfs = ordered.filter((id) => cfById.has(id)).map((id) => cfById.get(id));
        if (reorderedCfs.length === schema.customFields.length) schema.customFields = reorderedCfs;
        await saveSchema('✅ 已調整報名表欄位順序並同步雲端');
      };
    });
    const resetOrderBtn = document.getElementById('btnZ1ResetFieldOrder');
    if (resetOrderBtn) {
      resetOrderBtn.onclick = async () => {
        delete schema.fieldOrder;
        await saveSchema('↺ 已恢復報名表預設欄位順序');
      };
    }
    $$('[data-toggle-req-cf]').forEach((b) => {
      b.onclick = async () => {
        const f = schema.customFields[Number(b.dataset.toggleReqCf)];
        if (!f) return;
        f.required = !f.required;
        await saveSchema(`已將「${f.label}」改為${f.required ? '必填' : '選填'}`);
      };
    });
    $$('[data-del-cf]').forEach((b) => {
      b.onclick = async () => {
        const idx = Number(b.dataset.delCf);
        const removed = schema.customFields.splice(idx, 1)[0];
        if (removed && Array.isArray(schema.fieldOrder)) {
          schema.fieldOrder = schema.fieldOrder.filter((id) => id !== `cf:${removed.key}`);
        }
        await saveSchema(`已移除自訂欄位「${removed?.label || ''}」`);
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

    const payMode = C.getEventPaymentMode(ev);
    const isPayuniEv = payMode === 'ONLINE_PAYUNi';
    const box = $('#z1-recon');
    box.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="bg-white p-3 rounded-xl border"><div class="text-slate-500">總報名</div><div class="text-2xl font-black mono">${parts.length}</div></div>
        <div class="bg-rose-50 p-3 rounded-xl border border-rose-200"><div class="text-rose-700 font-bold">待對帳</div><div class="text-2xl font-black mono text-rose-700">${unpaid.length}</div></div>
        <div class="bg-emerald-50 p-3 rounded-xl border border-emerald-200"><div class="text-emerald-700 font-bold">已繳費</div><div class="text-2xl font-black mono text-emerald-700">${paid.length}</div></div>
        <div class="bg-sky-50 p-3 rounded-xl border border-sky-200"><div class="text-sky-700 font-bold">已配號</div><div class="text-2xl font-black mono text-sky-700">${parts.filter((p) => p.bibNumber).length}</div></div>
      </div>

      <div class="bg-white p-3 rounded-xl border shadow-sm space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ1BatchPaid" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold">✅ 批次入帳</button>
            ${groupsUnpaid.map((gc) => `<button data-group-paid="${gc}" class="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-black">👥 入帳 ${gc}</button>`).join('')}
            <button id="btnZ1AutoBib" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold">🏷️ 自動配號</button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ1ExportPaidXlsx" class="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-black">📋 繳費名單 .xlsx</button>
            <button id="btnZ1ExportPaidCsv" class="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-bold border border-emerald-300">📄 CSV</button>
            <button id="btnZ1ExportXlsx" class="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold">📊 全場 Excel</button>
            <button id="btnZ1ExportChipCsv" class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold">📡 晶片 CSV</button>
            <button id="btnZ1ToggleExtCsv" class="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-900 font-black border border-indigo-300">📥 匯入名單</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
          <input id="z1ReconSearch" type="text" value="${C.escapeHtml(App.State.z1ReconSearch || '')}" placeholder="🔎 姓名 / 身分證 / 號碼布 / 手機" class="w-full sm:w-80 px-3 py-1.5 border rounded-lg text-xs" />
          <span class="px-2 py-0.5 rounded-full font-bold ${isPayuniEv ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}">${isPayuniEv ? '💳 線上金流' : '🏦 銀行轉帳'}</span>
        </div>
      </div>

      <!-- 外部名單匯入 -->
      <div id="z1ExtImportBox" class="hidden bg-indigo-50/90 p-4 rounded-2xl border-2 border-indigo-300 space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-200 pb-2.5">
          <div class="font-black text-sm text-indigo-950">📥 匯入外部已繳費名單</div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" id="btnZ1DlExtXlsx" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold">📥 Excel 範本</button>
            <button type="button" id="btnZ1DlExtCsv" class="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-indigo-300 text-indigo-900 font-bold">📄 CSV 範本</button>
          </div>
        </div>

        <details class="bg-white rounded-xl border border-indigo-200 overflow-hidden">
          <summary class="px-3 py-2 bg-indigo-950 text-white font-bold cursor-pointer flex items-center justify-between">
            <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-amber-300">▶</span><span>📋 欄位順序說明（1～4 必填）</span></span>
            <span class="text-[11px] text-amber-300">展開查看</span>
          </summary>
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] text-left">
              <thead class="bg-slate-100 border-b">
                <tr>
                  <th class="p-1.5 text-center w-12">序</th>
                  <th class="p-1.5">欄位</th>
                  <th class="p-1.5 w-16">必填</th>
                  <th class="p-1.5">範例</th>
                  <th class="p-1.5">說明</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                ${(C.EXTERNAL_IMPORT_SPEC || []).map((s, idx) => `
                  <tr class="${s.required ? 'bg-rose-50/40' : ''}">
                    <td class="p-1.5 text-center mono font-black text-indigo-700">${s.order || idx + 1}</td>
                    <td class="p-1.5 font-bold">${C.escapeHtml(s.label)}</td>
                    <td class="p-1.5">${s.required ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 font-bold">必填*</span>' : '<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">選填</span>'}</td>
                    <td class="p-1.5 mono text-slate-700">${C.escapeHtml(s.example || '(留空)')}</td>
                    <td class="p-1.5 text-slate-600">${C.escapeHtml(s.desc || '')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 bg-white p-3 rounded-xl border border-indigo-200">
          <div>
            <label class="font-bold block mb-1">1. 上傳 Excel / CSV</label>
            <input id="z1ExtCsvFile" type="file" accept=".xlsx,.xls,.csv,.txt" class="w-full text-[11px]" />
          </div>
          <div>
            <label class="font-bold block mb-1">2. 匯入狀態</label>
            <select id="z1ExtJoinMode" class="w-full px-2.5 py-1.5 border rounded-lg bg-slate-50 font-bold">
              <option value="pre_pending" ${!ev.raceStart ? 'selected' : ''}>賽前匯入（未報到）</option>
              <option value="pre_checked">已報到匯入</option>
              <option value="mid_race" ${ev.raceStart ? 'selected' : ''}>🏃 賽中補加（進行中）</option>
            </select>
          </div>
          <div class="space-y-1.5 pt-1">
            <label class="flex items-center gap-1.5 font-bold cursor-pointer"><input id="z1ExtAutoBib" type="checkbox" checked /> 自動補配號碼布</label>
            <label class="flex items-center gap-1.5 font-bold cursor-pointer"><input id="z1ExtMergeDup" type="checkbox" checked /> 重複身分證合併更新</label>
          </div>
        </div>

        <div>
          <label class="font-bold text-indigo-950 block mb-1">或直接貼上名單：</label>
          <textarea id="z1ExtCsvText" rows="3" placeholder="姓名,身分證,性別,組別,號碼布,國籍,生日,手機,Email,晶片UID,跑團" class="w-full p-2.5 border rounded-xl mono text-xs bg-white"></textarea>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="btnZ1PreviewExtImport" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black">🔍 1. 預檢名單</button>
          <button type="button" id="btnZ1RunExtImport" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black shadow">✅ 2. 確認匯入</button>
        </div>

        <div id="z1ExtPreviewBox" class="hidden bg-white rounded-xl border border-indigo-200 p-3 space-y-2"></div>
      </div>

      ${(() => {
        const evGroups = C.summarizeGroupOrders({
          participants: parts,
          categories: App.State.categories,
          eventId: ev.eventId
        });
        if (!evGroups.length) return '';
        return `
          <div class="bg-amber-50/90 p-4 rounded-2xl border-2 border-amber-400 space-y-2.5 text-xs">
            <div class="border-b border-amber-200 pb-2">
              <div class="font-black text-sm text-amber-950">👥 團報對帳（${evGroups.length} 團）</div>
            </div>
            <div class="space-y-2">
              ${evGroups.map((g) => `
                <div class="p-3 rounded-xl bg-white border ${g.allPaid ? 'border-emerald-200' : 'border-amber-400'} flex flex-wrap items-center justify-between gap-3">
                  <div class="space-y-1 min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-black mono">${C.escapeHtml(g.groupCode)}</span>
                      <span class="font-black text-slate-900">${C.escapeHtml(g.groupName)}</span>
                      <span class="px-2 py-0.5 rounded bg-slate-900 text-amber-300 font-bold">👑 團長：${C.escapeHtml(g.leader.name)} (${C.escapeHtml(C.maskIdCard(g.leader.idCard))})</span>
                      <span class="px-2 py-0.5 rounded-full font-bold ${g.allPaid ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${g.allPaid ? `✅ 全團 ${g.memberCount} 人已入帳` : `待對帳 ${g.unpaidCount}/${g.memberCount} 人`}</span>
                      ${g.remittanceLast5 ? `<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-950 mono font-bold">統一末五碼 ${C.escapeHtml(g.remittanceLast5)}</span>` : '<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-500">尚未填報末五碼</span>'}
                    </div>
                    <div class="text-[11px] text-slate-600">
                      團長信箱：<span class="mono">${C.escapeHtml(g.leader.email || '-')}</span> ｜ 成員：${g.members.map((m) => `<span class="inline-block mr-2">${m.role === 'leader' ? '<b>👑 ' : ''}${C.escapeHtml(m.name)}(${C.escapeHtml(m.catName)}${m.bibNumber ? `・${m.bibNumber}` : ''})${m.role === 'leader' ? '</b>' : ''}</span>`).join('')}
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <div class="text-right">
                      <div class="text-[10px] text-slate-500">共 ${g.memberCount} 人統一匯款</div>
                      <div class="font-black text-sm mono text-amber-700">整團總額 NT$${g.totalAmount.toLocaleString()}</div>
                    </div>
                    ${!g.allPaid ? `<button type="button" data-group-paid="${C.escapeHtml(g.groupCode)}" class="px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black shadow">💰 整團一次入帳 (${g.unpaidCount} 人)</button>` : ''}
                  </div>
                </div>`).join('')}
            </div>
          </div>`;
      })()}

      ${(() => {
        const allBundles = C.summarizeBundleOrders({
          participants: App.State.participants,
          events: App.State.events,
          categories: App.State.categories
        });
        const evBundles = allBundles.filter((b) => b.eventIds.includes(ev.eventId));
        if (!evBundles.length) return '';
        const u = App.State.currentUser;
        return `
          <div class="bg-emerald-50/90 p-4 rounded-2xl border-2 border-emerald-400 space-y-2.5 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-200 pb-2">
              <div class="font-black text-sm text-emerald-950">📦 聯合報名合併單（${evBundles.length} 筆）</div>
              <button type="button" id="btnZ1ExportBundleXlsx" class="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold">📊 匯出對帳表</button>
            </div>
            <div class="space-y-2">
              ${evBundles.map((b) => {
                const canCrossConfirm = u?.role === 'super_admin' || b.items.every((it) => it.event?.ownerUsername === u?.username);
                const thisEvItem = b.items.find((it) => it.eventId === ev.eventId);
                return `
                  <div class="p-3 rounded-xl bg-white border ${b.allPaid ? 'border-emerald-200' : 'border-amber-400'} flex flex-wrap items-center justify-between gap-3">
                    <div class="space-y-1 min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="px-2 py-0.5 rounded bg-slate-900 text-amber-300 font-black mono">${b.bundleCode}</span>
                        <span class="font-black text-slate-900">${C.escapeHtml(b.runnerName)}</span>
                        <span class="mono text-slate-500">${C.escapeHtml(C.maskIdCard(b.idCard))}</span>
                        <span class="px-2 py-0.5 rounded-full font-bold ${b.allPaid ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${b.allPaid ? '✅ 已全數入帳' : `待對帳 ${b.unpaidCount}/${b.items.length} 場`}</span>
                        ${b.remittanceLast5 ? `<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-950 mono font-bold">末五碼 ${C.escapeHtml(b.remittanceLast5)}</span>` : ''}
                      </div>
                      <div class="text-[11px] text-slate-600">
                        包含場次：${b.items.map((it) => `<span class="inline-block mr-2">${it.eventId === ev.eventId ? '<b>★ ' : ''}${C.escapeHtml(it.eventName)} (${C.escapeHtml(it.catName)}・NT$${it.amount.toLocaleString()}${it.bibNumber ? `・${it.bibNumber}` : ''})${it.eventId === ev.eventId ? '</b>' : ''}</span>`).join('')}
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <div class="text-right">
                        <div class="text-[10px] text-slate-500">本場 NT$${Number(thisEvItem?.amount || 0).toLocaleString()}</div>
                        <div class="font-black text-sm mono text-emerald-700">合併總額 NT$${b.totalAmount.toLocaleString()}</div>
                      </div>
                      ${!b.allPaid
                        ? (canCrossConfirm
                          ? `<button type="button" data-bundle-paid="${b.bundleCode}" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black shadow">💰 合併整單入帳 (${b.unpaidCount} 場)</button>`
                          : `<span class="text-[10px] text-amber-800 font-bold max-w-[140px]">跨承辦人單，請由管理員整單入帳或於下方單場入帳</span>`)
                        : ''}
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>`;
      })()}

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
            ${sorted
              .filter((p) => {
                const q = String(App.State.z1ReconSearch || '').trim().toUpperCase();
                if (!q) return true;
                return `${p.name} ${p.idCard} ${p.bibNumber} ${p.phone} ${p.groupCode} ${p.groupName} ${p.remittanceLast5}`.toUpperCase().includes(q);
              })
              .map((p) => {
              const st = String(p.payStatus).toUpperCase();
              const isUn = st === 'UNPAID' || st === 'PENDING_PAY';
              const grpRole = p.groupCode ? C.getParticipantGroupRole(p, parts) : '';
              return `
                <tr class="${isUn ? 'bg-rose-50/90' : ''}">
                  <td class="p-2"><input type="checkbox" class="z1-cb" value="${p.participantId}" ${isUn ? '' : 'disabled'} /></td>
                  <td class="p-2 whitespace-nowrap">
                    <span class="px-2 py-0.5 rounded-full font-bold ${isUn ? 'bg-rose-600 text-white' : (st === 'PAID' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600')}">${st}</span>
                    <div class="text-[10px] text-slate-500 mt-0.5">${p.payMethod || 'MANUAL_ATM'}</div>
                  </td>
                  <td class="p-2 mono font-black">${p.bibNumber || '<span class="text-slate-400 font-normal">未配</span>'}</td>
                  <td class="p-2">
                    <div class="font-bold flex flex-wrap items-center gap-1">
                      <span>${C.escapeHtml(p.name)}</span>
                      <span class="px-1 rounded bg-sky-100 text-sky-800 text-[10px]">${p.nationality || 'TWN'}</span>
                      ${grpRole === 'leader' ? '<span class="px-1.5 py-0.5 rounded bg-amber-400 text-slate-950 text-[10px] font-black">👑 團長</span>' : (grpRole === 'member' ? '<span class="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-bold">👥 組員</span>' : '')}
                    </div>
                    <div class="text-[10px] text-slate-500 mono">${C.escapeHtml(C.maskIdCard(p.idCard))} · ${p.phone || '-'} ${p.groupCode ? `· <b class="text-amber-700">${p.groupCode}</b>` : ''}</div>
                  </td>
                  <td class="p-2">${C.escapeHtml(catMap.get(p.catId) || p.catId)}</td>
                  <td class="p-2 mono font-bold">
                    <div>NT$${Number(p.totalAmount).toLocaleString()}</div>
                    ${String(p.remark || '').includes('[早鳥價]') ? '<div class="mt-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] inline-block">🐤 早鳥價</div>' : ''}
                  </td>
                  <td class="p-2 mono text-[11px]">
                    <div>${C.escapeHtml(p.remittanceLast5 || p.merTradeNo || '-')}</div>
                    ${p.groupCode ? `<div class="mt-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-950 font-bold text-[10px] inline-block">👥 團報統一匯款</div>` : ''}
                    ${C.isBundleOrderCode(p.merTradeNo) ? `<div class="mt-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-[10px] inline-block">📦 合併單 ${C.escapeHtml(p.merTradeNo)}</div>` : ''}
                  </td>
                  <td class="p-2 whitespace-nowrap">
                    <div class="flex flex-wrap gap-1">
                      ${isUn
                        ? (p.groupCode
                          ? `<button data-group-paid="${C.escapeHtml(p.groupCode)}" class="px-2 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-black">👥 整團入帳</button>`
                          : `<button data-mark-paid="${p.participantId}" class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold">入帳</button>`)
                        : ''}
                      <button data-edit-part="${p.participantId}" class="px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold">✏️ 修改</button>
                      <button data-del-part="${p.participantId}" class="px-2 py-1 rounded bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold">🗑️ 刪除</button>
                    </div>
                  </td>
                </tr>`;
            }).join('') || '<tr><td colspan="8" class="p-6 text-center text-slate-400">尚無符合條件之已報名選手</td></tr>'}
          </tbody>
        </table>
      </div>`;

    $('#z1ReconSearch').oninput = (e) => {
      App.State.z1ReconSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderZ1Recon(App, ev);
      const inp = $('#z1ReconSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    };
    $('#z1CheckAll').onchange = (e) => $$('.z1-cb:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
    $$('[data-bundle-paid]').forEach((b) => {
      b.onclick = () => markBundlePaid(App, b.dataset.bundlePaid);
    });
    const expBundleBtn = document.getElementById('btnZ1ExportBundleXlsx');
    if (expBundleBtn) {
      expBundleBtn.onclick = () => {
        const allB = C.summarizeBundleOrders({ participants: App.State.participants, events: App.State.events, categories: App.State.categories });
        exportBundleReconExcel(App, ev, allB.filter((x) => x.eventIds.includes(ev.eventId)));
      };
    }
    $$('[data-mark-paid]').forEach((b) => {
      b.onclick = () => markParticipantsPaid(App, [b.dataset.markPaid]);
    });
    $$('[data-edit-part]').forEach((b) => {
      b.onclick = () => openEditParticipantModal(App, ev, b.dataset.editPart);
    });
    $$('[data-del-part]').forEach((b) => {
      b.onclick = async () => {
        const pid = b.dataset.delPart;
        const target = App.State.participants.find((x) => x.participantId === pid);
        if (!target) return;
        const isPaid = String(target.payStatus).toUpperCase() === 'PAID';
        const hasLogs = target.bibNumber && App.State.timingLogs.some((l) => l.eventId === ev.eventId && l.bibNumber === target.bibNumber && l.isValid !== false);
        if (isPaid || hasLogs) {
          const typed = prompt(`🔒 階段 2/4 資料防呆保護！\n選手「${target.name}」${isPaid ? '【已繳費 PAID】' : ''}${hasLogs ? '【已有賽道感應紀錄】' : ''}。\n為避免誤刪帳務與成績，請輸入選手完整姓名「${target.name}」以確認永久刪除：`);
          if (typed !== target.name) return App.toast('姓名輸入不符，已安全取消刪除', 'info');
        } else {
          if (!confirm(`⚠️ 確定要永久刪除待繳費選手「${target.name} (${target.participantId})」嗎？此動作將同步刪除雲端 Google 試算表該筆紀錄。`)) return;
        }
        App.State.participants = App.State.participants.filter((x) => x.participantId !== pid);
        await C.TurDB.remove('participants', pid);
        await App.enqueueSync('deleteParticipant', { participantId: pid });
        App.rebuildIndices(ev.eventId);
        App.renderAll();
        App.toast(`🗑️ 已刪除選手 ${target.name}（同步雲端）`, 'warn');
      };
    });
    $('#btnZ1BatchPaid').onclick = () => {
      const ids = $$('.z1-cb:checked').map((c) => c.value);
      if (!ids.length) return App.toast('請先勾選未繳費選手', 'warn');
      markParticipantsPaid(App, ids);
    };
    $$('[data-group-paid]').forEach((b) => {
      b.onclick = () => {
        const gc = b.dataset.groupPaid;
        const ids = parts.filter((p) => p.groupCode === gc && ['UNPAID', 'PENDING_PAY'].includes(String(p.payStatus).toUpperCase())).map((p) => p.participantId);
        if (!ids.length) return App.toast(`團報 ${gc} 目前無待對帳之未繳費成員`, 'info');
        markParticipantsPaid(App, ids, `整團 ${gc} 共 ${ids.length} 人`);
      };
    });
    $('#btnZ1AutoBib').onclick = () => App.autoAssignBibsForEvent(ev.eventId);
    $('#btnZ1ExportPaidXlsx').onclick = () => exportPaidRoster(App, ev, 'xlsx');
    $('#btnZ1ExportPaidCsv').onclick = () => exportPaidRoster(App, ev, 'csv');
    $('#btnZ1ExportXlsx').onclick = () => export3SheetExcel(App, ev, false);
    $('#btnZ1ExportChipCsv').onclick = () => exportChipCsv(App, ev);
    $('#btnZ1ToggleExtCsv').onclick = () => $('#z1ExtImportBox').classList.toggle('hidden');

    // 下載標準 Excel / CSV 外部匯入範本
    const buildExtSampleRows = () => {
      const evCats = App.State.categories.filter((c) => c.eventId === ev.eventId);
      const c1 = evCats[0]?.name || '50K 超馬組';
      const c2 = evCats[1]?.name || c1;
      return [
        ['姓名', '身分證', '性別', '組別', '號碼布', '國籍', '出生年月日', '手機', 'Email', '晶片UID', '跑團'],
        ['林大為', 'A128877661', 'M', c1, '', 'TWN', '1988-06-15', '0912345678', 'lin@example.com', '', '外場報名'],
        ['陳小美', 'F229988772', 'F', c2, '', 'TWN', '1992-03-20', '0922334455', 'mei@example.com', '', '外場報名']
      ];
    };
    $('#btnZ1DlExtXlsx').onclick = async () => {
      const rows = buildExtSampleRows();
      await C.ensureExternalLib('xlsx');
      if (global.XLSX) {
        const wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(rows), '外部選手名單範本');
        global.XLSX.writeFile(wb, `TUR_外部名單匯入範本_${ev.eventId}.xlsx`);
        App.toast('📥 已下載標準 Excel 匯入範本 (.xlsx)', 'success');
      } else {
        $('#btnZ1DlExtCsv').click();
      }
    };
    $('#btnZ1DlExtCsv').onclick = () => {
      const rows = buildExtSampleRows();
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      downloadText(`TUR_外部名單匯入範本_${ev.eventId}.csv`, csv, 'text/csv;charset=utf-8');
      App.toast('📄 已下載標準 CSV 匯入範本 (.csv)', 'success');
    };

    let extRawMatrix = null;
    let extParsedResult = null;
    const parseRawTextToMatrix = (raw) => raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/,|\t/).map((s) => s.trim()));

    const runExtPreview = () => {
      const raw = $('#z1ExtCsvText').value.trim();
      const matrix = extRawMatrix || (raw ? parseRawTextToMatrix(raw) : []);
      if (!matrix.length) {
        App.toast('請先上傳 Excel/CSV 檔，或於文字框貼上名單內容', 'warn');
        return null;
      }
      extParsedResult = C.parseExternalRosterRows({
        rawRows: matrix, event: ev, categories: App.State.categories, existingParticipants: App.State.participants
      });
      const sm = extParsedResult.summary;
      const box = $('#z1ExtPreviewBox');
      box.classList.remove('hidden');
      box.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-black text-indigo-950">🔍 預檢結果（共 ${sm.total} 列｜${extParsedResult.hasHeader ? '已自動對應表頭欄位' : '採標準欄位順序解析'}）</div>
          <div class="flex flex-wrap gap-1.5 mono font-bold text-[11px]">
            <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">✅ 可新增 ${sm.ready}</span>
            <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-900">🔄 重複身分證 ${sm.dupUpdate}</span>
            <span class="px-2 py-0.5 rounded bg-rose-100 text-rose-800">❌ 缺必要欄 ${sm.invalid}</span>
          </div>
        </div>
        <div class="max-h-52 overflow-y-auto border rounded-lg">
          <table class="w-full text-[11px] text-left">
            <thead class="bg-slate-100 sticky top-0">
              <tr><th class="p-1.5">列</th><th class="p-1.5">檢核狀態</th><th class="p-1.5">姓名</th><th class="p-1.5">身分證/護照</th><th class="p-1.5">性別</th><th class="p-1.5">對應組別</th><th class="p-1.5">號碼布</th><th class="p-1.5">備註/提醒</th></tr>
            </thead>
            <tbody class="divide-y">
              ${extParsedResult.items.map((it) => `
                <tr class="${it.status === 'invalid' ? 'bg-rose-50' : (it.status === 'duplicate' ? 'bg-amber-50' : '')}">
                  <td class="p-1.5 mono text-slate-400">#${it.rowNum}</td>
                  <td class="p-1.5 font-bold whitespace-nowrap">${it.status === 'ready' ? '<span class="text-emerald-700">✅ 可新增</span>' : (it.status === 'duplicate' ? '<span class="text-amber-800">🔄 重複</span>' : '<span class="text-rose-700">❌ 異常</span>')}</td>
                  <td class="p-1.5 font-bold">${C.escapeHtml(it.data.name || '-')}</td>
                  <td class="p-1.5 mono">${C.escapeHtml(C.maskIdCard(it.data.idCard) || '-')}</td>
                  <td class="p-1.5 mono">${C.escapeHtml(it.data.gender || '-')}</td>
                  <td class="p-1.5">${C.escapeHtml(it.data.categoryName)}</td>
                  <td class="p-1.5 mono">${it.data.bibNumber || '<span class="text-indigo-600">(自動配號)</span>'}</td>
                  <td class="p-1.5 text-[10px] ${it.errors.length ? 'text-rose-700 font-bold' : 'text-slate-500'}">${C.escapeHtml([...it.errors, ...it.warnings].join('；') || 'OK')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
      return extParsedResult;
    };

    $('#z1ExtCsvText').oninput = () => { extRawMatrix = null; };
    $('#z1ExtCsvFile').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (/\.(xlsx|xls)$/i.test(f.name)) await C.ensureExternalLib('xlsx');
      if (/\.(xlsx|xls)$/i.test(f.name) && global.XLSX) {
        const buf = await f.arrayBuffer();
        const wb = global.XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        extRawMatrix = global.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        $('#z1ExtCsvText').value = extRawMatrix.map((r) => r.join(',')).join('\n');
        runExtPreview();
      } else {
        extRawMatrix = null;
        $('#z1ExtCsvText').value = await f.text();
        runExtPreview();
      }
    };
    $('#btnZ1PreviewExtImport').onclick = () => runExtPreview();

    $('#btnZ1RunExtImport').onclick = async () => {
      const parsed = runExtPreview();
      if (!parsed || !parsed.items.length) return;
      const joinMode = $('#z1ExtJoinMode').value;
      const autoBib = $('#z1ExtAutoBib').checked;
      const mergeDup = $('#z1ExtMergeDup').checked;
      const checkinStatus = joinMode === 'pre_pending' ? 'pending' : 'checked_in';
      const raceStatus = joinMode === 'mid_race' ? 'on_track' : 'dns';

      const added = [];
      const updated = [];
      const needBibIds = [];
      const now = C.formatDateTime();

      for (let i = 0; i < parsed.items.length; i++) {
        const it = parsed.items[i];
        if (it.status === 'invalid') continue;
        const d = it.data;
        if (it.status === 'duplicate') {
          if (!mergeDup) continue;
          const exist = App.State.participants.find((p) => p.participantId === it.existingParticipantId);
          if (exist) {
            exist.name = d.name;
            exist.catId = d.catId || exist.catId;
            if (d.bibNumber && !exist.bibNumber) exist.bibNumber = d.bibNumber;
            if (d.phone) exist.phone = d.phone;
            if (d.email) exist.email = d.email;
            if (d.chipUid) exist.chipUid = d.chipUid;
            exist.payStatus = 'PAID';
            if (!exist.paidAt) exist.paidAt = now;
            if (checkinStatus === 'checked_in') exist.checkinStatus = 'checked_in';
            if (raceStatus === 'on_track' && exist.raceStatus === 'dns') exist.raceStatus = 'on_track';
            await C.TurDB.put('participants', exist);
            await App.enqueueSync('updateParticipant', exist);
            updated.push(exist);
            if (autoBib && !exist.bibNumber) needBibIds.push(exist.participantId);
          }
          continue;
        }

        const split = C.splitFullName(d.name);
        const rec = {
          participantId: `EXT-${Date.now().toString().slice(-6)}-${i}`,
          eventId: ev.eventId, catId: d.catId, bibNumber: d.bibNumber,
          groupCode: '', groupName: d.groupName || '外部名單匯入',
          name: d.name, lastName: split.lastName, firstName: split.firstName,
          idCard: d.idCard, gender: d.gender, birthday: d.birthday, age: C.calcAge(d.birthday) || 35,
          nationality: d.nationality || 'TWN', phone: d.phone, email: d.email, city: '',
          emergencyName: '', emergencyPhone: '', diet: '葷',
          remark: joinMode === 'mid_race' ? '外部名單（賽事進行中補加）' : '外部名單匯入',
          totalAmount: d.fee, addonsDetail: '[]', customFieldsJson: '{}',
          payMethod: 'EXTERNAL_IMPORT', remittanceLast5: '', merTradeNo: '',
          payStatus: 'PAID', paymentType: 'EXTERNAL', tradeNo: '', payInfo: '外部名單匯入免收費', paidAt: now,
          chipUid: d.chipUid, checkinStatus, raceStatus, penaltySeconds: 0, createdAt: now
        };
        App.State.participants.push(rec);
        await C.TurDB.put('participants', rec);
        added.push(rec);
        if (autoBib && !rec.bibNumber) needBibIds.push(rec.participantId);
      }

      if (added.length) await App.enqueueSync('registerRunner', { runners: added });
      if (needBibIds.length) await App.autoAssignBibsForEvent(ev.eventId, needBibIds);
      App.rebuildIndices(ev.eventId);
      App.renderAll();
      App.toast(`📥 外部名單匯入完成！新增 ${added.length} 位、合併更新 ${updated.length} 位${joinMode === 'mid_race' ? '（已設為賽道進行中，立即可感應計時！）' : ''}`, 'success');
    };
  }

  function openEditParticipantModal(App, ev, pid) {
    const p = App.State.participants.find((x) => x.participantId === pid);
    if (!p) return;
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    $('#epId').value = p.participantId;
    $('#epSubtitle').textContent = `報名序號：${p.participantId} · 所屬活動：${ev.nameZh}`;
    $('#epName').value = p.name || '';
    $('#epCatId').innerHTML = cats.map((c) => `<option value="${c.catId}" ${c.catId === p.catId ? 'selected' : ''}>${C.escapeHtml(c.name)} ($${c.fee})</option>`).join('');
    $('#epBib').value = p.bibNumber || '';
    $('#epIdCard').value = '';
    $('#epIdCard').placeholder = p.idCard ? `${C.maskIdCard(p.idCard)}（隱碼保護，留空不變更）` : '請輸入身分證 / 護照';
    $('#epGender').value = p.gender || 'M';
    $('#epBirthday').value = p.birthday || '';
    $('#epNat').value = p.nationality || 'TWN';
    $('#epPhone').value = p.phone || '';
    $('#epEmail').value = p.email || '';
    $('#epCity').value = p.city || '';
    $('#epDiet').value = p.diet || '葷';
    $('#epGroupName').value = p.groupName || '';
    $('#epEmergName').value = p.emergencyName || '';
    $('#epEmergPhone').value = p.emergencyPhone || '';
    $('#epChipUid').value = p.chipUid || '';
    $('#epAmount').value = Number(p.totalAmount || 0);
    $('#epLast5').value = p.remittanceLast5 || '';
    const wasPaid = String(p.payStatus || '').toUpperCase() === 'PAID';
    const isSuper = App.State.currentUser?.role === 'super_admin';
    $('#epPayStatus').value = String(p.payStatus || 'UNPAID').toUpperCase();
    $('#epRemark').value = p.remark || '';

    // 階段 2 防呆管制：已繳費選手預設鎖定費用相關欄位（組別、應繳金額、末五碼、繳費狀態）
    const setFeeLock = (locked) => {
      ['#epCatId', '#epAmount', '#epLast5', '#epPayStatus'].forEach((sel) => {
        const el = $(sel);
        if (el) {
          el.disabled = locked;
          el.classList.toggle('bg-slate-100', locked);
          el.classList.toggle('cursor-not-allowed', locked);
        }
      });
    };
    setFeeLock(wasPaid);

    // 承辦人自訂擴充欄位顯示與編輯 ＋ 已繳費費用防呆提示
    const schema = C.parseJsonSafe(ev.formSchemaJson, C.defaultFormSchema());
    const cfDefs = Array.isArray(schema.customFields) ? schema.customFields : [];
    const cfVals = C.parseJsonSafe(p.customFieldsJson, {});
    const cfBox = $('#epCustomFieldsBox');
    if (cfBox) {
      const lockBanner = wasPaid
        ? `<div class="mb-2.5 p-2.5 rounded-lg bg-amber-100 border border-amber-300 text-amber-950 text-[11px] flex flex-wrap items-center justify-between gap-2">
            <span>🔒 <b>已繳費費用防呆保護</b>：組別、金額、末五碼與繳費狀態已鎖定，避免帳務異動異常。</span>
            ${isSuper ? '<label class="flex items-center gap-1 font-black cursor-pointer text-rose-800"><input type="checkbox" id="epAdminUnlockFee" /> 🔓 最高管理員緊急解鎖費用欄位</label>' : ''}
          </div>`
        : '';
      if (!cfDefs.length && !wasPaid) {
        cfBox.classList.add('hidden');
        cfBox.innerHTML = '';
      } else {
        cfBox.classList.remove('hidden');
        cfBox.innerHTML = lockBanner + (cfDefs.length ? `
          <div class="text-[11px] font-black text-indigo-900 mb-1.5">📝 活動自訂擴充欄位填答內容</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${cfDefs.map((f) => {
              const val = cfVals[f.key];
              const strVal = Array.isArray(val) ? val.join(', ') : String(val ?? '');
              return `
                <div>
                  <label class="font-bold text-[11px]">${C.escapeHtml(f.label)} <span class="text-slate-400 font-normal">(${f.type})</span></label>
                  <input data-ep-cf="${C.escapeHtml(f.key)}" data-ep-cftype="${f.type}" value="${C.escapeHtml(strVal)}" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5 bg-white" />
                </div>`;
            }).join('')}
          </div>` : '');
        if ($('#epAdminUnlockFee')) {
          $('#epAdminUnlockFee').onchange = (e) => setFeeLock(!e.target.checked);
        }
      }
    }

    const closeModal = () => $('#editParticipantModal').classList.add('hidden');
    $('#btnCloseEditPart').onclick = closeModal;
    $('#btnCancelEditPart').onclick = closeModal;
    $('#editParticipantForm').onsubmit = async (e) => {
      e.preventDefault();
      const newName = $('#epName').value.trim();
      if (!newName) return App.toast('姓名不可為空', 'error');
      const split = C.splitFullName(newName);
      const feeAllowed = !wasPaid || Boolean($('#epAdminUnlockFee')?.checked);
      p.name = newName;
      p.lastName = split.lastName;
      p.firstName = split.firstName;
      if (feeAllowed) p.catId = $('#epCatId').value;
      p.bibNumber = $('#epBib').value.trim().toUpperCase();
      const newIdRaw = $('#epIdCard').value.trim().toUpperCase();
      if (newIdRaw && !newIdRaw.includes('*')) p.idCard = newIdRaw;
      p.gender = $('#epGender').value;
      p.birthday = $('#epBirthday').value;
      p.age = C.calcAge(p.birthday) || p.age;
      p.nationality = ($('#epNat').value.trim() || 'TWN').toUpperCase();
      p.phone = $('#epPhone').value.trim();
      p.email = $('#epEmail').value.trim();
      p.city = $('#epCity').value.trim();
      p.diet = $('#epDiet').value;
      p.groupName = $('#epGroupName').value.trim();
      p.emergencyName = $('#epEmergName').value.trim();
      p.emergencyPhone = $('#epEmergPhone').value.trim();
      p.chipUid = $('#epChipUid').value.trim().toUpperCase();
      if (feeAllowed) {
        p.totalAmount = Number($('#epAmount').value || 0);
        p.remittanceLast5 = $('#epLast5').value.trim();
        p.payStatus = $('#epPayStatus').value;
      }
      const becamePaid = !wasPaid && p.payStatus === 'PAID';
      if (p.payStatus === 'PAID' && !p.paidAt) p.paidAt = C.formatDateTime();
      p.remark = $('#epRemark').value.trim();
      if (cfDefs.length) {
        const nextCf = { ...cfVals };
        $$('[data-ep-cf]').forEach((inp) => {
          const k = inp.dataset.epCf;
          const t = inp.dataset.epCftype;
          nextCf[k] = t === 'checkbox'
            ? inp.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
            : inp.value.trim();
        });
        p.customFieldsJson = JSON.stringify(nextCf);
      }

      await C.TurDB.put('participants', p);
      await App.enqueueSync('updateParticipant', p);
      if (becamePaid && !p.bibNumber) await App.autoAssignBibsForEvent(ev.eventId, [p.participantId]);
      App.rebuildIndices(ev.eventId);
      closeModal();
      App.renderAll();
      App.toast(`✅ 已更新選手「${p.name}」資料${becamePaid ? '｜✉️ 已自動寄發入帳確認信' : ''}並同步雲端！`, 'success');
    };

    $('#editParticipantModal').classList.remove('hidden');
  }

  async function exportBundleReconExcel(App, ev, bundles) {
    if (!bundles || !bundles.length) return App.toast('目前尚無多場合併訂單可匯出', 'warn');
    const rows = bundles.map((b, i) => ({
      序號: i + 1,
      合併單號: b.bundleCode,
      選手姓名: b.runnerName,
      '身分證/護照': b.idCard,
      手機: b.phone,
      Email: b.email,
      付款管道: b.payMethod,
      匯款末五碼: b.remittanceLast5 || '',
      合併場次數: b.items.length,
      合併總金額: b.totalAmount,
      狀態: b.allPaid ? '已全數入帳' : `待對帳 (${b.unpaidCount}/${b.items.length}場)`,
      包含場次與各場明細: b.items.map((it) => `${it.eventName}[${it.catName}] NT$${it.amount}(${it.payStatus}${it.bibNumber ? '/' + it.bibNumber : ''})`).join('；')
    }));
    await C.ensureExternalLib('xlsx');
    if (global.XLSX) {
      const wb = global.XLSX.utils.book_new();
      global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.json_to_sheet(rows), '多場合併繳費對帳總表');
      global.XLSX.writeFile(wb, `TUR_合併繳費對帳總表_${ev.eventId}.xlsx`);
      return App.toast(`📊 已匯出合併繳費對帳總表 Excel（共 ${rows.length} 筆合併單）`, 'success');
    }
    const headers = Object.keys(rows[0]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
    downloadText(`TUR_合併繳費對帳總表_${ev.eventId}.csv`, csv, 'text/csv;charset=utf-8');
  }

  async function markBundlePaid(App, bundleCode) {
    const code = String(bundleCode || '').trim().toUpperCase();
    const targets = App.State.participants.filter((p) => {
      const st = String(p.payStatus || '').toUpperCase();
      return String(p.merTradeNo || '').toUpperCase() === code && st !== 'PAID' && st !== 'CANCELLED';
    });
    if (!targets.length) return App.toast(`合併單 ${code} 已無待入帳場次`, 'info');
    const now = C.formatDateTime();
    const byEvent = new Map();
    const bibMap = {};
    for (const p of targets) {
      p.payStatus = 'PAID';
      p.paidAt = now;
      if (!p.bibNumber) {
        const usedBibs = new Set(App.State.participants.filter((x) => x.eventId === p.eventId && x.bibNumber).map((x) => String(x.bibNumber).toUpperCase()));
        const cat = App.State.categories.find((c) => c.catId === p.catId);
        const prefix = String(cat?.bibPrefix || 'R').toUpperCase();
        const startStr = String(cat?.bibStartNum || '001');
        const width = Math.max(3, startStr.length);
        let num = parseInt(startStr, 10) || 1;
        let bib = `${prefix}${String(num).padStart(width, '0')}`;
        while (usedBibs.has(bib)) { num++; bib = `${prefix}${String(num).padStart(width, '0')}`; }
        p.bibNumber = bib;
      }
      bibMap[p.participantId] = p.bibNumber;
      await C.TurDB.put('participants', p);
      if (!byEvent.has(p.eventId)) byEvent.set(p.eventId, []);
      byEvent.get(p.eventId).push(p.participantId);
    }
    await App.enqueueSync('markBundlePaid', { bundleCode: code, paidAt: now, bibMap });
    App.rebuildIndices();
    App.renderAll();
    App.toast(`✅ 合併單 ${code} 已整單跨場入帳（共 ${targets.length} 場同步 PAID＋各自自動配號）並寄發確認信！`, 'success');
  }

  async function markParticipantsPaid(App, ids, label = '') {
    const now = C.formatDateTime();
    let targetEventId = '';
    for (const pid of ids) {
      const p = App.State.participants.find((x) => x.participantId === pid);
      if (p) {
        targetEventId = p.eventId;
        p.payStatus = 'PAID';
        p.paidAt = now;
        await C.TurDB.put('participants', p);
        await App.enqueueSync('updateParticipant', { participantId: pid, payStatus: 'PAID', paidAt: now });
      }
    }
    if (targetEventId) {
      await App.autoAssignBibsForEvent(targetEventId, ids);
    }
    App.rebuildIndices(targetEventId);
    App.renderAll();
    App.toast(`✅ 已確認入帳（${label || ids.length + ' 筆'}）、自動補配號碼布並✉️自動寄發繳費入帳確認信！`, 'success');
  }

  /* --------------------------------------------------------------------------
   * 專區 1 分頁 3：📡 晶片管制（寫卡讀取 → 報到管制 → 起跑與站點 → 賽道即時管制到終點）
   * 完整比照「路跑晶片計時系統」運作流程
   * -------------------------------------------------------------------------- */
  const adminScanDebounceMap = new Map();

  async function adminSenseRunner(App, ev, stCodeRaw, tokenRaw, source = 'manual', opts = {}) {
    const stCode = String(stCodeRaw || '').trim().toUpperCase();
    const token = String(tokenRaw || '').trim().toUpperCase();
    if (!ev || !stCode || !token) return { ok: false, level: 'warn', msg: '請輸入或感應有效資料' };
    if (ev.status === 'finished') {
      C.NFC.sound.beepError();
      return { ok: false, level: 'error', msg: '🔒 本活動已結案鎖定，禁止寫入感應紀錄' };
    }

    const evParts = App.State.participants.filter((p) => p.eventId === ev.eventId);
    const idFromPipe = token.includes('|') ? token.split('|')[1]?.trim().toUpperCase() : '';
    let runner = idFromPipe ? evParts.find((p) => String(p.idCard || '').toUpperCase() === idFromPipe) : null;
    if (!runner) {
      runner = evParts.find((p) =>
        String(p.bibNumber || '').toUpperCase() === token ||
        String(p.chipUid || '').toUpperCase() === token ||
        String(p.idCard || '').toUpperCase() === token
      );
    }
    if (!runner || String(runner.payStatus || '').toUpperCase() !== 'PAID' || !runner.bibNumber) {
      C.NFC.sound.beepError();
      return { ok: false, level: 'error', msg: `🚫 攔截：查無本場已繳費且配號選手（${token}）` };
    }

    const cat = App.State.categories.find((c) => c.catId === runner.catId) || null;
    const effStart = (cat && cat.customRaceStart) || ev.raceStart || '';
    if (stCode !== 'CHECKIN' && !effStart) {
      C.NFC.sound.beepError();
      return { ok: false, level: 'error', msg: `🔒 尚未鳴槍開跑，請先於「起跑與站點」設定起跑時間` };
    }

    const bibU = String(runner.bibNumber).toUpperCase();
    const evValidLogs = App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.isValid !== false);

    if (stCode === 'CHECKIN') {
      const existingChk = evValidLogs.find((l) => String(l.bibNumber).toUpperCase() === bibU && String(l.stationCode).toUpperCase() === 'CHECKIN');
      if (runner.checkinStatus === 'checked_in' || existingChk) {
        C.NFC.sound.beepWarning();
        return {
          ok: false, level: 'warn', duplicate: true, runner,
          msg: `⚠️ ${runner.bibNumber} ${runner.name} 已完成報到${existingChk ? `（${String(existingChk.sensedTime).slice(11)}）` : ''}，無須重複感應`
        };
      }
    }

    if (stCode === 'FINISH' && !opts.allowDuplicateFinish) {
      const existingFin = evValidLogs.find((l) => String(l.bibNumber).toUpperCase() === bibU && String(l.stationCode).toUpperCase() === 'FINISH');
      if (existingFin) {
        C.NFC.sound.beepWarning();
        return {
          ok: false, level: 'warn', duplicate: true, runner,
          msg: `⚠️ ${runner.bibNumber} ${runner.name} 已於 ${String(existingFin.sensedTime).slice(11)} 完賽，保留首次衝線紀錄`
        };
      }
    }

    const nowMs = Date.now();
    if (!opts.bypassDebounce && source === 'nfc' && stCode !== 'CHECKIN') {
      const cdMs = Math.max(1, Number(ev.debounceSeconds || 15)) * 1000;
      const dKey = `${ev.eventId}::${stCode}::${bibU}`;
      const lastMs = adminScanDebounceMap.get(dKey) || 0;
      if (nowMs - lastMs < cdMs) {
        const waitSec = Math.ceil((cdMs - (nowMs - lastMs)) / 1000);
        C.NFC.sound.beepWarning();
        return { ok: false, level: 'warn', duplicate: true, runner, msg: `⚠️ 防連點略過：${runner.bibNumber} ${runner.name} 剛感應過（剩 ${waitSec} 秒）` };
      }
      adminScanDebounceMap.set(dKey, nowMs);
    }

    let senseMs = nowMs;
    if (opts.customTime) {
      const ct = String(opts.customTime).trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ct)) {
        return { ok: false, level: 'error', msg: '時間格式須為 YYYY-MM-DD HH:mm:ss' };
      }
      const parsed = C.parseDateTime(ct);
      if (!parsed) return { ok: false, level: 'error', msg: '無效的日期時間' };
      if (stCode !== 'CHECKIN' && effStart) {
        const startDt = C.parseDateTime(effStart);
        if (startDt && parsed.getTime() < startDt.getTime()) {
          return { ok: false, level: 'error', msg: `🔒 通過時間 (${ct}) 不可早於起跑時間 (${effStart})` };
        }
      }
      senseMs = parsed.getTime();
    }

    const timeStr = C.formatDateTime(new Date(senseMs));
    let lapCount = 0;
    let isValid = true;
    let note = opts.note || '';

    if (stCode === 'CHECKIN') {
      runner.checkinStatus = 'checked_in';
      await C.TurDB.put('participants', runner);
      await App.enqueueSync('updateParticipant', { participantId: runner.participantId, checkinStatus: 'checked_in' });
      note = note || '晶片管制報到完成';
    } else if (stCode === 'LAP') {
      const prevLaps = evValidLogs.filter((l) => String(l.bibNumber).toUpperCase() === bibU && String(l.stationCode).toUpperCase() === 'LAP').length;
      lapCount = prevLaps + 1;
      const startDt = C.parseDateTime(effStart);
      if (startDt && cat && Number(cat.timeLimitHours) > 0 && ((senseMs - startDt.getTime()) / 1000) > Number(cat.timeLimitHours) * 3600) {
        note = note || `逾 ${cat.timeLimitHours}H 限時（留存超時圈）`;
      } else {
        const lapKm = Number(ev.lapDistanceKm || cat?.distanceKm || 1.0);
        note = note || `第 ${lapCount} 圈（累計 ${(lapCount * lapKm).toFixed(2)} km）`;
      }
      if (runner.raceStatus === 'dns') {
        runner.raceStatus = 'on_track';
        await C.TurDB.put('participants', runner);
        await App.enqueueSync('updateParticipant', { participantId: runner.participantId, raceStatus: 'on_track' });
      }
    } else if (stCode === 'FINISH') {
      runner.raceStatus = 'finished';
      await C.TurDB.put('participants', runner);
      await App.enqueueSync('updateParticipant', { participantId: runner.participantId, raceStatus: 'finished' });
      const startDt = C.parseDateTime(effStart);
      const sec = startDt ? Math.max(0, Math.round((senseMs - startDt.getTime()) / 1000) + Number(runner.penaltySeconds || 0)) : null;
      note = note || `🏁 終點完賽 ${C.formatDuration(sec)}`;
    } else {
      if (runner.raceStatus === 'dns') {
        runner.raceStatus = 'on_track';
        await C.TurDB.put('participants', runner);
        await App.enqueueSync('updateParticipant', { participantId: runner.participantId, raceStatus: 'on_track' });
      }
      note = note || `通過 ${stCode}`;
    }

    const log = {
      logId: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}-${bibU}-${stCode}`,
      eventId: ev.eventId,
      stationCode: stCode,
      bibNumber: runner.bibNumber,
      idCardHash: await C.sha256Hex(runner.idCard || ''),
      sensedTime: timeStr,
      lapCount,
      operator: App.State.currentUser?.username || 'admin',
      source,
      isValid,
      note
    };
    App.State.timingLogs.push(log);
    await C.TurDB.put('timingLogs', log);
    await App.enqueueSync('addTimingLog', log, false);
    C.NFC.sound.beepSuccess();

    return {
      ok: true, level: 'success', runner, log,
      msg: `✅ ${runner.bibNumber} ${runner.name} @ ${stCode}（${timeStr.slice(11)}）${note ? ' · ' + note : ''}`
    };
  }

  function renderZ1ChipControl(App, ev) {
    const box = $('#z1-chip');
    if (!box || !ev) return;

    const sub = ['write', 'checkin', 'start', 'track'].includes(App.State.z1ChipSub) ? App.State.z1ChipSub : 'write';
    App.State.z1ChipSub = sub;

    const paid = App.State.participants.filter((p) => p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID');
    const chippedCnt = paid.filter((p) => Boolean(p.chipUid)).length;
    const checkedCnt = paid.filter((p) => p.checkinStatus === 'checked_in').length;
    const lbRows = C.computeLeaderboard({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs
    });
    const isLap = ev.raceType === 'lap_timed';
    const finishedCnt = lbRows.filter((r) => r.status === 'finished').length;
    const totalLapsAll = lbRows.reduce((s, r) => s + Number(r.lapCount || 0), 0);

    const subMeta = [
      { id: 'write', icon: '✍️', title: '1. 寫卡讀取', badge: `${chippedCnt}/${paid.length}` },
      { id: 'checkin', icon: '📋', title: '2. 報到管制', badge: `${checkedCnt}/${paid.length}` },
      { id: 'start', icon: '🔫', title: '3. 起跑與站點', badge: ev.raceStart ? '已開跑' : '未鳴槍' },
      { id: 'track', icon: '📡', title: '4. 賽道管制', badge: isLap ? `${totalLapsAll} 圈` : `${finishedCnt} 完賽` }
    ];

    box.innerHTML = `
      <div class="bg-white p-2.5 rounded-xl border shadow-sm space-y-2">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          ${subMeta.map((m) => `
            <button type="button" data-z1-chip-sub="${m.id}" class="px-3 py-2 rounded-xl border-2 font-black transition flex items-center justify-between gap-1 ${sub === m.id ? 'bg-slate-900 border-slate-900 text-amber-300 shadow' : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'}">
              <span>${m.icon} ${m.title}</span>
              <span class="px-1.5 py-0.5 rounded-full text-[10px] mono ${sub === m.id ? 'bg-amber-400 text-slate-950' : 'bg-white border text-slate-600'}">${m.badge}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div id="z1ChipSubBody" class="space-y-4"></div>`;

    $$('[data-z1-chip-sub]').forEach((b) => {
      b.onclick = () => {
        if (C.NFC.isScanning) C.NFC.stopScanning();
        App.State.z1ChipSub = b.dataset.z1ChipSub;
        renderZ1ChipControl(App, ev);
      };
    });

    const body = $('#z1ChipSubBody');
    if (sub === 'write') renderZ1ChipSubWrite(App, ev, body, paid, chippedCnt, checkedCnt);
    else if (sub === 'checkin') renderZ1ChipSubCheckin(App, ev, body, paid, checkedCnt, lbRows);
    else if (sub === 'start') renderZ1ChipSubStart(App, ev, body);
    else if (sub === 'track') renderZ1ChipSubTrack(App, ev, body, lbRows);
  }

  /* ---- 子分頁 1：✍️ 晶片寫入與讀取（移植晶片計時系統 NFC v3.1 核心） ---- */
  function renderZ1ChipSubWrite(App, ev, body, paid, chippedCnt, checkedCnt) {
    const catMap = new Map(App.State.categories.map((c) => [c.catId, c.name]));
    const evNameMap = new Map(App.State.events.map((e) => [e.eventId, e.nameZh]));
    const diag = C.NFC.getDiagnostics();
    const q = String(App.State.z1ChipSearch || '').trim().toUpperCase();
    const flt = App.State.z1ChipFilter || 'all';
    const autoChk = App.State.z1ChipAutoCheckin !== false;
    const chipPct = paid.length ? Math.round((chippedCnt / paid.length) * 100) : 0;

    const list = paid.filter((p) => {
      if (flt === 'no_chip' && p.chipUid) return false;
      if (flt === 'has_chip' && !p.chipUid) return false;
      if (flt === 'unchecked' && p.checkinStatus === 'checked_in') return false;
      if (flt === 'checked' && p.checkinStatus !== 'checked_in') return false;
      if (!q) return true;
      return `${p.bibNumber} ${p.name} ${p.idCard} ${p.chipUid || ''} ${catMap.get(p.catId) || ''}`.toUpperCase().includes(q);
    });

    if (App.State.z1ChipSelectedPid && !paid.some((p) => p.participantId === App.State.z1ChipSelectedPid)) {
      App.State.z1ChipSelectedPid = '';
    }
    const selRunner = paid.find((p) => p.participantId === App.State.z1ChipSelectedPid) || null;

    body.innerHTML = `
      <div class="bg-white p-3.5 rounded-xl border shadow-sm flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-1 rounded-lg font-bold ${diag.supported ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}">${diag.statusMessage}</span>
          <span class="px-2 py-1 rounded-lg bg-slate-100 font-bold mono">已寫卡 ${chippedCnt}/${paid.length} (${chipPct}%)</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" id="btnZ1TapReadReal" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-amber-300 font-black">🔍 實體貼卡讀卡測試</button>
          <button type="button" id="btnZ1TapReadSim" class="px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 font-bold">🧪 模擬讀卡</button>
        </div>
      </div>

      <div id="z1ChipTapResult" class="hidden p-3.5 rounded-xl border-2 text-xs space-y-1"></div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 text-xs">
        <!-- 左：已繳費選手清單 -->
        <div class="lg:col-span-5 bg-white p-3.5 rounded-xl border shadow-sm space-y-2.5">
          <div class="flex flex-wrap gap-2">
            <input id="z1ChipSearch" value="${C.escapeHtml(App.State.z1ChipSearch || '')}" placeholder="🔎 號碼布 / 姓名 / 身分證 / UID" class="flex-1 min-w-[140px] px-2.5 py-1.5 border rounded-lg" />
            <select id="z1ChipFilter" class="px-2 py-1.5 border rounded-lg bg-slate-50 font-bold">
              <option value="all" ${flt === 'all' ? 'selected' : ''}>全部 (${paid.length})</option>
              <option value="no_chip" ${flt === 'no_chip' ? 'selected' : ''}>⏳ 未寫卡 (${paid.length - chippedCnt})</option>
              <option value="has_chip" ${flt === 'has_chip' ? 'selected' : ''}>✅ 已寫卡 (${chippedCnt})</option>
              <option value="unchecked" ${flt === 'unchecked' ? 'selected' : ''}>📋 未報到 (${paid.length - checkedCnt})</option>
              <option value="checked" ${flt === 'checked' ? 'selected' : ''}>🟢 已報到 (${checkedCnt})</option>
            </select>
          </div>
          <div class="divide-y max-h-[460px] overflow-y-auto">
            ${list.map((p) => {
              const isPicked = p.participantId === App.State.z1ChipSelectedPid;
              const isChk = p.checkinStatus === 'checked_in';
              return `
                <div class="py-2 px-1.5 flex items-center justify-between gap-2 ${isPicked ? 'bg-sky-50 rounded-lg ring-1 ring-sky-300' : ''}">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1 font-bold">
                      <span class="mono font-black text-slate-900">${p.bibNumber || '<span class="text-rose-600">未配號</span>'}</span>
                      <span>${C.escapeHtml(p.name)}</span>
                      <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">${C.escapeHtml(catMap.get(p.catId) || '')}</span>
                    </div>
                    <div class="text-[10px] mono mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span class="${p.chipUid ? 'text-sky-800 font-bold' : 'text-slate-400'}">${p.chipUid ? `✅ ${C.escapeHtml(p.chipUid)}` : '⏳ 未寫卡'}</span>
                      <span class="px-1 py-0.5 rounded font-sans font-bold ${isChk ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${isChk ? '已報到' : '未報到'}</span>
                    </div>
                  </div>
                  <button type="button" data-z1-pick-chip="${p.participantId}" class="px-2.5 py-1 rounded-lg font-bold shrink-0 ${isPicked ? 'bg-sky-600 text-white' : 'bg-slate-900 hover:bg-slate-800 text-white'}">帶入寫卡</button>
                </div>`;
            }).join('') || '<div class="py-8 text-center text-slate-400">查無符合條件之已繳費選手</div>'}
          </div>
        </div>

        <!-- 右：共用晶片寫入與回讀驗證控制台 -->
        <div class="lg:col-span-7 bg-white p-4 rounded-xl border shadow-sm space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
            <h3 class="font-black text-sm">✍️ 晶片寫入與回讀驗證</h3>
            <label class="inline-flex items-center gap-1.5 font-bold text-emerald-900 cursor-pointer">
              <input id="z1ChipAutoChk" type="checkbox" ${autoChk ? 'checked' : ''} class="accent-emerald-600" />
              <span>寫卡同步報到</span>
            </label>
          </div>

          ${selRunner ? `
            <div class="p-3.5 rounded-xl bg-emerald-50 border-2 border-emerald-300 space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="font-black text-sm text-slate-900">
                  <span class="mono text-indigo-800">${C.escapeHtml(selRunner.bibNumber || '未配號')}</span> · ${C.escapeHtml(selRunner.name)}
                  <span class="text-xs font-bold text-slate-600">(${C.escapeHtml(catMap.get(selRunner.catId) || '-')})</span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[11px] font-black ${selRunner.checkinStatus === 'checked_in' ? 'bg-emerald-600 text-white' : 'bg-amber-200 text-amber-950'}">${selRunner.checkinStatus === 'checked_in' ? '✅ 已報到' : '⏳ 未報到'}</span>
              </div>
              <div class="mono text-[11px] text-slate-700">寫入字串：<b>${C.escapeHtml(selRunner.name)}|${C.escapeHtml(C.maskIdCard(selRunner.idCard))}</b> ｜ 晶片 UID：<b>${C.escapeHtml(selRunner.chipUid || '尚未綁定')}</b></div>
            </div>
          ` : `
            <div class="p-4 rounded-xl bg-slate-50 border border-dashed text-center text-slate-500">請從左側點選一位選手「帶入寫卡」</div>
          `}

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button type="button" id="btnZ1WriteNtag" ${selRunner ? '' : 'disabled'} class="p-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-black">✍️ 寫入 NTAG</button>
            <button type="button" id="btnZ1VerifyChip" ${selRunner ? '' : 'disabled'} class="p-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white font-black">✅ 回讀驗證</button>
            <button type="button" id="btnZ1BindUid" ${selRunner ? '' : 'disabled'} class="p-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-black">🔗 綁定 UID</button>
            <button type="button" id="btnZ1SimWrite" ${selRunner ? '' : 'disabled'} class="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold">🧪 模擬寫卡</button>
          </div>

          <div id="z1ChipVerifyBox" class="hidden p-3.5 rounded-xl border-2 text-xs space-y-2">
            <div id="z1ChipVerifyTitle" class="font-black text-sm"></div>
            <div id="z1ChipVerifyDetail" class="leading-relaxed"></div>
            <div class="flex flex-wrap gap-2">
              <button type="button" id="btnZ1CancelNfc" class="hidden px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 font-bold text-slate-800">✕ 取消等待</button>
              <button type="button" id="btnZ1PostVerify" class="hidden px-3 py-1 rounded-lg bg-teal-600 text-white font-black">✅ 立即回讀驗證並擷取 UID</button>
              <button type="button" id="btnZ1FallbackUid" class="hidden px-3 py-1 rounded-lg bg-sky-600 text-white font-black">🔗 改用僅綁定 UID</button>
            </div>
          </div>
        </div>
      </div>`;

    const setVerifyBox = (status, title, detail, { showCancel = false, showVerify = false, showUidFallback = false } = {}) => {
      const vb = $('#z1ChipVerifyBox');
      if (!vb) return;
      const styles = {
        working: 'p-3.5 rounded-xl border-2 border-sky-400 bg-sky-50 text-sky-950 text-xs space-y-2',
        success: 'p-3.5 rounded-xl border-2 border-emerald-400 bg-emerald-50 text-emerald-950 text-xs space-y-2',
        error: 'p-3.5 rounded-xl border-2 border-rose-400 bg-rose-50 text-rose-950 text-xs space-y-2'
      };
      vb.className = styles[status] || styles.working;
      $('#z1ChipVerifyTitle').textContent = title;
      $('#z1ChipVerifyDetail').textContent = detail;
      $('#btnZ1CancelNfc').classList.toggle('hidden', !showCancel);
      $('#btnZ1PostVerify').classList.toggle('hidden', !showVerify);
      $('#btnZ1FallbackUid').classList.toggle('hidden', !showUidFallback);
    };

    const showTapCard = (matched, uid, rawTxt) => {
      const boxEl = $('#z1ChipTapResult');
      if (!boxEl) return;
      boxEl.classList.remove('hidden');
      if (!matched) {
        boxEl.className = 'p-3.5 rounded-xl border-2 border-rose-400 bg-rose-50 text-rose-950 text-xs space-y-1';
        boxEl.innerHTML = `<div class="font-black">🔴 讀卡結果：查無本場對應選手</div><div class="mono">UID：${C.escapeHtml(uid || '-')} ｜ NDEF：${C.escapeHtml(C.maskNdefPayload(rawTxt) || '（空）')}</div>`;
        return;
      }
      const idU = String(matched.idCard || '').toUpperCase();
      const joined = App.State.participants
        .filter((x) => String(x.idCard || '').toUpperCase() === idU && String(x.payStatus).toUpperCase() !== 'CANCELLED')
        .map((x) => `${evNameMap.get(x.eventId) || x.eventId} [${x.bibNumber || '未配號'}]`);
      const logs = App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.bibNumber === matched.bibNumber && l.isValid !== false);
      boxEl.className = 'p-3.5 rounded-xl border-2 border-sky-400 bg-sky-50 text-sky-950 text-xs space-y-1';
      boxEl.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-black text-sm">🔍 貼卡讀取成功：${C.escapeHtml(matched.bibNumber || '未配號')} ${C.escapeHtml(matched.name)}（${C.escapeHtml(catMap.get(matched.catId) || '-')}）</span>
          <span class="px-2 py-0.5 rounded-full font-bold ${matched.checkinStatus === 'checked_in' ? 'bg-emerald-600 text-white' : 'bg-amber-200 text-amber-950'}">${matched.checkinStatus === 'checked_in' ? '✅ 已報到' : '⏳ 未報到'}</span>
        </div>
        <div class="mono text-slate-700">UID：<b>${C.escapeHtml(uid || matched.chipUid || '-')}</b> ｜ NDEF：<b>${C.escapeHtml(C.maskNdefPayload(rawTxt || `${matched.name}|${matched.idCard}`))}</b></div>
        <div class="text-slate-600">已報名場次：${C.escapeHtml(joined.join('、') || ev.nameZh)} ｜ 本場通過：${logs.length ? logs.map((l) => `${l.stationCode}(${String(l.sensedTime).slice(11)})`).join(' → ') : '尚無紀錄'}</div>`;
    };

    const saveRunnerChip = async (runner, uidVal) => {
      if (uidVal) runner.chipUid = uidVal;
      const shouldAutoChk = App.State.z1ChipAutoCheckin !== false;
      if (shouldAutoChk && runner.checkinStatus !== 'checked_in') {
        runner.checkinStatus = 'checked_in';
        const hasChkLog = App.State.timingLogs.some((l) => l.eventId === ev.eventId && l.bibNumber === runner.bibNumber && l.stationCode === 'CHECKIN' && l.isValid !== false);
        if (!hasChkLog && runner.bibNumber) {
          const chkLog = {
            logId: `LOG-${Date.now()}-${runner.bibNumber}-CHECKIN`, eventId: ev.eventId, stationCode: 'CHECKIN',
            bibNumber: runner.bibNumber, idCardHash: await C.sha256Hex(runner.idCard || ''),
            sensedTime: C.formatDateTime(), lapCount: 0, operator: App.State.currentUser?.username || 'admin',
            source: 'write_auto', isValid: true, note: '寫卡同步報到'
          };
          App.State.timingLogs.push(chkLog);
          await C.TurDB.put('timingLogs', chkLog);
          await App.enqueueSync('addTimingLog', chkLog, false);
        }
      }
      await C.TurDB.put('participants', runner);
      await App.enqueueSync('updateParticipant', { participantId: runner.participantId, chipUid: runner.chipUid, checkinStatus: runner.checkinStatus });
      App.rebuildIndices(ev.eventId);
      renderZ1StageGateBar(App, ev);
    };

    $('#z1ChipSearch').oninput = (e) => {
      App.State.z1ChipSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderZ1ChipControl(App, ev);
      const inp = $('#z1ChipSearch'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    };
    $('#z1ChipFilter').onchange = (e) => { App.State.z1ChipFilter = e.target.value; renderZ1ChipControl(App, ev); };
    $('#z1ChipAutoChk').onchange = (e) => { App.State.z1ChipAutoCheckin = e.target.checked; };
    $$('[data-z1-pick-chip]').forEach((b) => {
      b.onclick = () => { App.State.z1ChipSelectedPid = b.dataset.z1PickChip; renderZ1ChipControl(App, ev); };
    });

    $('#btnZ1CancelNfc').onclick = () => {
      C.NFC.cancelActiveOperation();
      setVerifyBox('error', '已取消等待感應', '可重新點擊上方寫入或驗證按鈕。');
    };

    const runWrite = async (isSim) => {
      if (!selRunner) return App.toast('請先帶入選手', 'warn');
      if (!selRunner.bibNumber) return App.toast('請先於「2. 對帳配號」配發號碼布後再寫卡', 'warn');
      if (ev.status === 'finished') return App.toast('🔒 本活動已結案，禁止寫入晶片', 'error');
      setVerifyBox('working', isSim ? '🧪 模擬寫入晶片中…' : '📡 等待貼近 NFC 晶片寫入…', `對象：${selRunner.bibNumber} ${selRunner.name}`, { showCancel: !isSim });
      try {
        const res = isSim
          ? await C.NFC.mockWriteChip({ name: selRunner.name, idNumber: selRunner.idCard }, { onStep: (s) => setVerifyBox('working', '🧪 模擬寫卡…', s) })
          : await C.NFC.writeChip({ name: selRunner.name, idNumber: selRunner.idCard }, { onStep: (s) => setVerifyBox('working', '📡 請貼緊手機背面感應區…', s, { showCancel: true }) });
        await saveRunnerChip(selRunner, res.nfcUid || selRunner.chipUid || 'NDEF-WRITTEN');
        renderZ1ChipControl(App, ev);
        setVerifyBox('success', `✅ 寫入成功（${selRunner.bibNumber} ${selRunner.name}）`,
          isSim ? `模擬 UID：${selRunner.chipUid}，可直接使用於各站點感應。` : '已寫入 NDEF！建議點下方「立即回讀驗證」核對資料並擷取晶片硬體 UID。',
          { showVerify: !isSim });
        App.toast(`✅ 已寫入晶片：${selRunner.bibNumber} ${selRunner.name}`, 'success');
      } catch (err) {
        C.NFC.sound.beepError();
        setVerifyBox('error', '❌ 晶片寫入失敗', err.message, { showUidFallback: true });
        App.toast(err.message, 'error');
      }
    };

    const runVerify = async () => {
      if (!selRunner) return;
      setVerifyBox('working', '🔍 回讀驗證中：請將剛寫入的晶片貼近背面…', `核對 ${selRunner.name}|${C.maskIdCard(selRunner.idCard)} 並擷取 UID`, { showCancel: true });
      try {
        const tag = await C.NFC.readSingleTag((s) => setVerifyBox('working', '🔍 等待貼卡回讀…', s, { showCancel: true }));
        const rId = String(tag.parsed?.idNumber || '').toUpperCase();
        if (!rId || rId !== String(selRunner.idCard || '').toUpperCase()) {
          throw new Error(`回讀不符！卡片內容「${C.maskNdefPayload(tag.raw) || '空'}」與選手 ${selRunner.name} 不一致`);
        }
        await saveRunnerChip(selRunner, tag.nfcUid || selRunner.chipUid || 'NDEF-VERIFIED');
        C.NFC.sound.beepWriteVerified();
        renderZ1ChipControl(App, ev);
        setVerifyBox('success', `✅ 回讀驗證 100% 一致！（UID: ${tag.nfcUid || '標準 NDEF'}）`, `讀回：${C.maskNdefPayload(tag.raw)}`);
        App.toast(`✅ 回讀驗證通過！UID=${tag.nfcUid || '-'}`, 'success');
      } catch (err) {
        C.NFC.sound.beepError();
        setVerifyBox('error', '❌ 回讀驗證失敗', err.message, { showVerify: true, showUidFallback: true });
      }
    };

    const runBindUid = async () => {
      if (!selRunner) return;
      if (!selRunner.bibNumber) return App.toast('請先配發號碼布', 'warn');
      setVerifyBox('working', '🔗 UID 綁定模式：請貼近唯讀晶片…', '直接擷取晶片硬體 UID 並綁定至此選手（免寫入記憶體）。', { showCancel: true });
      try {
        const tag = await C.NFC.readSingleTag((s) => setVerifyBox('working', '🔗 讀取 UID 中…', s, { showCancel: true }));
        if (!tag.nfcUid) throw new Error('此晶片未回傳硬體 UID');
        await saveRunnerChip(selRunner, tag.nfcUid);
        C.NFC.sound.beepWriteVerified();
        renderZ1ChipControl(App, ev);
        setVerifyBox('success', `✅ UID 綁定成功（${tag.nfcUid}）`, `${selRunner.bibNumber} ${selRunner.name} 已完成晶片綁定`);
        App.toast(`🔗 已綁定 UID：${tag.nfcUid}`, 'success');
      } catch (err) {
        C.NFC.sound.beepError();
        setVerifyBox('error', '❌ UID 綁定失敗', err.message);
      }
    };

    $('#btnZ1WriteNtag').onclick = () => runWrite(false);
    $('#btnZ1SimWrite').onclick = () => runWrite(true);
    $('#btnZ1VerifyChip').onclick = runVerify;
    $('#btnZ1PostVerify').onclick = runVerify;
    $('#btnZ1BindUid').onclick = runBindUid;
    $('#btnZ1FallbackUid').onclick = runBindUid;

    $('#btnZ1TapReadReal').onclick = async () => {
      const boxEl = $('#z1ChipTapResult');
      boxEl.classList.remove('hidden');
      boxEl.className = 'p-3.5 rounded-xl border-2 border-sky-400 bg-sky-50 text-sky-950 text-xs font-bold';
      boxEl.textContent = '📡 請將任意 NFC 晶片緊貼手機背面感應區…';
      try {
        const tag = await C.NFC.readSingleTag();
        const rId = String(tag.parsed?.idNumber || '').toUpperCase();
        const m = paid.find((p) => (rId && String(p.idCard || '').toUpperCase() === rId) || (tag.nfcUid && String(p.chipUid || '').toUpperCase() === tag.nfcUid));
        if (m) { App.State.z1ChipSelectedPid = m.participantId; renderZ1ChipControl(App, ev); }
        showTapCard(m, tag.nfcUid, tag.raw);
      } catch (err) {
        boxEl.className = 'p-3.5 rounded-xl border-2 border-rose-400 bg-rose-50 text-rose-900 text-xs font-bold';
        boxEl.textContent = `❌ 讀卡失敗：${err.message}`;
      }
    };
    $('#btnZ1TapReadSim').onclick = () => {
      const sample = selRunner || paid.find((p) => p.chipUid) || paid[0];
      if (!sample) return App.toast('本場尚無已繳費選手可模擬', 'warn');
      C.NFC.sound.beepSuccess();
      showTapCard(sample, sample.chipUid || 'SIM-UID-01', `${sample.name}|${sample.idCard}`);
    };
  }

  /* ---- 子分頁 2：📋 報到管制（含即時 NFC 感應報到、報到時間紀錄與防重複） ---- */
  function renderZ1ChipSubCheckin(App, ev, body, paid, checkedCnt, lbRows) {
    const catMap = new Map(App.State.categories.map((c) => [c.catId, c.name]));
    const chkTimeMap = new Map();
    lbRows.forEach((r) => { if (r.checkInTime) chkTimeMap.set(r.participant.participantId, r.checkInTime); });
    const chkPct = paid.length ? Math.round((checkedCnt / paid.length) * 100) : 0;
    const q = String(App.State.z1ChkSearch || '').trim().toUpperCase();
    const flt = App.State.z1ChkFilter || 'all';

    const list = paid.filter((p) => {
      const isChk = p.checkinStatus === 'checked_in';
      if (flt === 'checked' && !isChk) return false;
      if (flt === 'unchecked' && isChk) return false;
      if (!q) return true;
      return `${p.bibNumber} ${p.name} ${p.idCard} ${p.chipUid || ''} ${catMap.get(p.catId) || ''}`.toUpperCase().includes(q);
    });

    body.innerHTML = `
      <div class="grid grid-cols-3 gap-3 text-xs">
        <div class="bg-white p-3 rounded-xl border"><div class="text-slate-500">已繳費人數</div><div class="text-2xl font-black mono">${paid.length}</div></div>
        <div class="bg-emerald-50 p-3 rounded-xl border border-emerald-200"><div class="text-emerald-800 font-bold">✅ 已報到</div><div class="text-2xl font-black mono text-emerald-800">${checkedCnt} <span class="text-xs">(${chkPct}%)</span></div></div>
        <div class="bg-amber-50 p-3 rounded-xl border border-amber-200"><div class="text-amber-900 font-bold">⏳ 未報到</div><div class="text-2xl font-black mono text-amber-900">${paid.length - checkedCnt}</div></div>
      </div>

      <!-- 即時報到感應與快刷列 -->
      <div class="bg-white p-3.5 rounded-xl border shadow-sm space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-black text-sm">📡 現場晶片報到感應（不計成績與圈數）</div>
          <button type="button" id="btnZ1ChkToggleNfc" class="px-3.5 py-1.5 rounded-lg font-black ${C.NFC.isScanning ? 'bg-rose-600 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">
            ${C.NFC.isScanning ? '🛑 停止 NFC 報到感應' : '📡 啟動 NFC 報到感應'}
          </button>
        </div>
        <form id="z1ChkManualForm" class="flex flex-wrap gap-2">
          <input id="z1ChkManualInput" placeholder="輸入號碼布 / 身分證 / UID 按 Enter 快速報到" autocomplete="off" class="flex-1 min-w-[200px] px-3 py-2 border-2 rounded-lg font-bold mono uppercase" />
          <button type="submit" class="px-4 py-2 rounded-lg bg-slate-900 text-white font-black">✅ 報到</button>
        </form>
        <div id="z1ChkBanner" class="hidden p-2.5 rounded-lg border font-bold"></div>
      </div>

      <div class="bg-white p-3.5 rounded-xl border shadow-sm space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <input id="z1ChkSearch" value="${C.escapeHtml(App.State.z1ChkSearch || '')}" placeholder="🔎 搜尋號碼布 / 姓名 / UID" class="flex-1 min-w-[180px] px-2.5 py-1.5 border rounded-lg" />
          <select id="z1ChkFilter" class="px-2.5 py-1.5 border rounded-lg bg-slate-50 font-bold">
            <option value="all" ${flt === 'all' ? 'selected' : ''}>全部 (${paid.length})</option>
            <option value="unchecked" ${flt === 'unchecked' ? 'selected' : ''}>⏳ 未報到 (${paid.length - checkedCnt})</option>
            <option value="checked" ${flt === 'checked' ? 'selected' : ''}>✅ 已報到 (${checkedCnt})</option>
          </select>
        </div>
        <div class="overflow-x-auto max-h-[460px]">
          <table class="w-full text-left">
            <thead class="bg-slate-100 sticky top-0">
              <tr><th class="p-2">號碼布</th><th class="p-2">選手 / 組別</th><th class="p-2">晶片 UID</th><th class="p-2">報到時間</th><th class="p-2">操作</th></tr>
            </thead>
            <tbody class="divide-y">
              ${list.map((p) => {
                const isChk = p.checkinStatus === 'checked_in';
                const cTime = chkTimeMap.get(p.participantId) || (isChk ? '已報到' : '-');
                return `
                  <tr class="${isChk ? 'bg-emerald-50/40' : ''}">
                    <td class="p-2 mono font-black">${p.bibNumber || '<span class="text-rose-500">未配號</span>'}</td>
                    <td class="p-2"><b>${C.escapeHtml(p.name)}</b> <span class="text-slate-500 text-[11px]">${C.escapeHtml(catMap.get(p.catId) || '')}</span></td>
                    <td class="p-2 mono text-[11px]">${p.chipUid ? `<span class="text-sky-800 font-bold">${C.escapeHtml(p.chipUid)}</span>` : '<span class="text-slate-400">未寫卡</span>'}</td>
                    <td class="p-2 mono font-bold ${isChk ? 'text-emerald-800' : 'text-slate-400'}">${C.escapeHtml(cTime)}</td>
                    <td class="p-2">
                      <button type="button" data-z1-toggle-chk="${p.participantId}" class="px-2.5 py-1 rounded-lg font-bold ${isChk ? 'bg-emerald-600 text-white' : 'bg-amber-100 hover:bg-emerald-600 hover:text-white text-amber-950'}">
                        ${isChk ? '✅ 已報到（點取消）' : '📋 辦理報到'}
                      </button>
                    </td>
                  </tr>`;
              }).join('') || '<tr><td colspan="5" class="p-6 text-center text-slate-400">查無符合條件之選手</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    const showBanner = (res) => {
      const bn = $('#z1ChkBanner');
      if (!bn) return;
      bn.classList.remove('hidden');
      const cls = res.level === 'success' ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : (res.level === 'warn' ? 'bg-amber-50 border-amber-300 text-amber-950' : 'bg-rose-50 border-rose-300 text-rose-900');
      bn.className = `p-2.5 rounded-lg border font-bold ${cls}`;
      bn.textContent = res.msg;
    };

    $('#z1ChkManualForm').onsubmit = async (e) => {
      e.preventDefault();
      const inp = $('#z1ChkManualInput');
      const val = inp.value.trim();
      if (!val) return;
      const res = await adminSenseRunner(App, ev, 'CHECKIN', val, 'manual', { bypassDebounce: true });
      inp.value = '';
      renderZ1StageGateBar(App, ev);
      renderZ1ChipControl(App, ev);
      showBanner(res);
      const nextInp = $('#z1ChkManualInput'); if (nextInp) nextInp.focus();
    };

    $('#btnZ1ChkToggleNfc').onclick = async () => {
      if (C.NFC.isScanning) {
        C.NFC.stopScanning();
        renderZ1ChipControl(App, ev);
        return App.toast('已停止 NFC 報到感應', 'info');
      }
      try {
        await C.NFC.startScanning(async (tag) => {
          const token = tag.idNumber ? `${tag.name}|${tag.idNumber}` : (tag.bib || tag.nfcUid);
          const res = await adminSenseRunner(App, ev, 'CHECKIN', token, 'nfc', { bypassDebounce: true });
          renderZ1StageGateBar(App, ev);
          renderZ1ChipControl(App, ev);
          showBanner(res);
        }, (err) => App.toast(err.message, 'error'));
        renderZ1ChipControl(App, ev);
        App.toast('📡 已啟動 NFC 報到感應，請選手貼近晶片', 'success');
      } catch (err) {
        App.toast(err.message, 'warn');
      }
    };

    $('#z1ChkSearch').oninput = (e) => {
      App.State.z1ChkSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderZ1ChipControl(App, ev);
      const inp = $('#z1ChkSearch'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    };
    $('#z1ChkFilter').onchange = (e) => { App.State.z1ChkFilter = e.target.value; renderZ1ChipControl(App, ev); };

    $$('[data-z1-toggle-chk]').forEach((b) => {
      b.onclick = async () => {
        const p = App.State.participants.find((x) => x.participantId === b.dataset.z1ToggleChk);
        if (!p) return;
        const willCheck = p.checkinStatus !== 'checked_in';
        if (willCheck) {
          if (p.bibNumber) {
            await adminSenseRunner(App, ev, 'CHECKIN', p.bibNumber, 'manual', { bypassDebounce: true });
          } else {
            p.checkinStatus = 'checked_in';
            await C.TurDB.put('participants', p);
            await App.enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: 'checked_in' });
          }
        } else {
          p.checkinStatus = 'pending';
          await C.TurDB.put('participants', p);
          await App.enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: 'pending' });
          for (const l of App.State.timingLogs) {
            if (l.eventId === ev.eventId && String(l.bibNumber).toUpperCase() === String(p.bibNumber || '').toUpperCase() && String(l.stationCode).toUpperCase() === 'CHECKIN' && l.isValid !== false) {
              l.isValid = false;
              await C.TurDB.put('timingLogs', l);
              await App.enqueueSync('adjustTimingLog', { log: l });
            }
          }
        }
        renderZ1StageGateBar(App, ev);
        renderZ1ChipControl(App, ev);
        App.toast(`${willCheck ? '✅ 已辦理報到' : '↩️ 已取消報到'}：${p.bibNumber || ''} ${p.name}`, 'success');
      };
    });
  }

  /* ---- 子分頁 3：🔫 起跑與站點（統一鳴槍＋分組個別起跑微調＋站點配置） ---- */
  function renderZ1ChipSubStart(App, ev, body) {
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    const isLap = ev.raceType === 'lap_timed';
    const gate = C.evaluateEventStageGates({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs,
      syncQueue: App.State.syncQueue, hasCloudGas: Boolean(App.State.gasUrl)
    });

    body.innerHTML = `
      <div class="p-3.5 rounded-xl border-2 ${gate.gunWarnings.length ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-300'} text-xs space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-black ${gate.gunWarnings.length ? 'text-amber-950' : 'text-emerald-950'}">
            ${gate.gunWarnings.length ? `⚠️ 開跑前提醒（${gate.gunWarnings.length} 項）` : '✅ 賽前檢核通過'}
          </div>
          ${gate.metrics.paidNoBibCount > 0 ? '<button type="button" id="btnZ1GunFixBib" class="px-3 py-1 rounded-lg bg-slate-900 text-white font-bold">🏷️ 補配號碼布</button>' : ''}
        </div>
        ${gate.gunWarnings.length ? `<ul class="list-disc list-inside text-amber-900 space-y-0.5">${gate.gunWarnings.map((w) => `<li>${C.escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div class="space-y-3">
          <div class="bg-slate-900 text-white p-5 rounded-2xl space-y-3 shadow">
            <div class="text-amber-400 font-bold">🏁 統一律定起跑時間</div>
            <div class="text-3xl font-black mono text-amber-300" id="z1GunDisplay">${ev.raceStart || '尚未設定'}</div>
            <div class="flex flex-wrap gap-2">
              <button type="button" id="btnZ1GunNow" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 font-black text-sm shadow">🔫 立即統一鳴槍</button>
            </div>
            <div class="pt-2 border-t border-slate-700 flex gap-2">
              <input id="z1CustomGunTime" value="${ev.raceStart || C.formatDateTime()}" placeholder="YYYY-MM-DD HH:mm:ss" class="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 mono text-white" />
              <button type="button" id="btnZ1ApplyGunTime" class="px-3 py-2 rounded-lg bg-amber-400 text-slate-950 font-black">套用時間</button>
            </div>
          </div>

          <!-- 分組個別起跑時間微調（比照晶片計時系統） -->
          <details class="bg-white rounded-xl border shadow-sm overflow-hidden">
            <summary class="px-4 py-3 cursor-pointer font-black text-slate-800 flex items-center justify-between">
              <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-slate-400">▶</span><span>⏱️ 分組個別起跑時間微調（${cats.length} 組）</span></span>
              <span class="text-[11px] text-sky-700">展開設定</span>
            </summary>
            <div class="px-4 pb-4 pt-2 border-t space-y-2">
              ${cats.map((c) => {
                const eff = c.customRaceStart || ev.raceStart || '';
                const effDt = C.parseDateTime(eff);
                const cutoffStr = isLap && effDt && Number(c.timeLimitHours) > 0
                  ? ` · 截止 ${C.formatDateTime(new Date(effDt.getTime() + Number(c.timeLimitHours) * 3600000))}`
                  : '';
                return `
                  <div class="p-2.5 rounded-xl bg-slate-50 border space-y-1.5">
                    <div class="flex flex-wrap items-center justify-between gap-1">
                      <span class="font-black text-slate-900">${C.escapeHtml(c.name)}</span>
                      <span class="mono text-[11px] ${c.customRaceStart ? 'text-indigo-700 font-bold' : 'text-slate-500'}">
                        ${c.customRaceStart ? `自訂：${c.customRaceStart}` : `跟隨統一 (${ev.raceStart || '未設'})`}${cutoffStr}
                      </span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <button type="button" data-cat-gun-now="${c.catId}" class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-bold">🔫 分組鳴槍</button>
                      <input type="text" data-cat-gun-inp="${c.catId}" value="${C.escapeHtml(c.customRaceStart || ev.raceStart || '')}" placeholder="YYYY-MM-DD HH:mm:ss" class="flex-1 min-w-[155px] px-2 py-1 border rounded-lg bg-white mono" />
                      <button type="button" data-cat-gun-set="${c.catId}" class="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold">套用</button>
                      ${c.customRaceStart ? `<button type="button" data-cat-gun-clr="${c.catId}" class="px-2 py-1 rounded-lg bg-slate-200 text-slate-700 font-bold">重設</button>` : ''}
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </details>
        </div>

        <div id="z1ChipStationsHost"></div>
      </div>`;

    if ($('#btnZ1GunFixBib')) $('#btnZ1GunFixBib').onclick = () => App.autoAssignBibsForEvent(ev.eventId);

    const applyGun = async (timeStr) => {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeStr)) {
        return App.toast('起跑時間強制包含完整日期與整數秒：YYYY-MM-DD HH:mm:ss', 'error');
      }
      if (!gate.metrics.hasTimingStation) {
        return App.toast('🔒 請先於右側建立 FINISH 或 LAP 站點後再鳴槍！', 'error');
      }
      if (ev.raceStart && ev.raceStart !== timeStr) {
        if (!confirm(`⚠️ 本活動已於 ${ev.raceStart} 鳴槍！確定覆蓋起跑時間為 ${timeStr} 嗎？`)) return;
      } else if (gate.gunWarnings.length) {
        if (!confirm(`⚠️ 尚有 ${gate.gunWarnings.length} 項開跑前提醒：\n- ${gate.gunWarnings.join('\n- ')}\n\n確定仍要立即鳴槍開跑？`)) return;
      }
      ev.raceStart = timeStr;
      if (ev.status === 'open' && confirm('鳴槍開跑後，是否一併將本活動切換為「停止報名 (closed)」？')) {
        ev.status = 'closed';
      }
      await C.TurDB.put('events', ev);
      for (const p of App.State.participants) {
        if (p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.raceStatus === 'dns') {
          p.raceStatus = 'on_track';
          await C.TurDB.put('participants', p);
        }
      }
      await App.enqueueSync('saveEvent', { event: ev });
      await App.enqueueSync('triggerGunStart', { eventId: ev.eventId, raceStart: timeStr });
      C.NFC.sound.beepGun();
      App.renderAll();
      App.toast(`🔫 鳴槍時間已寫入：${timeStr}`, 'success');
    };
    $('#btnZ1GunNow').onclick = () => applyGun(C.formatDateTime());
    $('#btnZ1ApplyGunTime').onclick = () => applyGun($('#z1CustomGunTime').value.trim());

    const saveCatStart = async (catId, timeVal) => {
      const cat = App.State.categories.find((c) => c.catId === catId);
      if (!cat) return;
      if (timeVal && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeVal)) {
        return App.toast('分組起跑時間格式須為 YYYY-MM-DD HH:mm:ss', 'error');
      }
      cat.customRaceStart = timeVal;
      await C.TurDB.put('categories', cat);
      await App.enqueueSync('saveCategory', { category: cat });
      if (timeVal) C.NFC.sound.beepGun();
      renderZ1ChipControl(App, ev);
      App.toast(timeVal ? `✅ 分組「${cat.name}」起跑時間已設為 ${timeVal}` : `↩️ 分組「${cat.name}」已改回跟隨統一鳴槍`, 'success');
    };
    $$('[data-cat-gun-now]').forEach((b) => { b.onclick = () => saveCatStart(b.dataset.catGunNow, C.formatDateTime()); });
    $$('[data-cat-gun-set]').forEach((b) => {
      b.onclick = () => {
        const inp = document.querySelector(`[data-cat-gun-inp="${b.dataset.catGunSet}"]`);
        saveCatStart(b.dataset.catGunSet, (inp?.value || '').trim());
      };
    });
    $$('[data-cat-gun-clr]').forEach((b) => { b.onclick = () => saveCatStart(b.dataset.catGunClr, ''); });

    renderEventStationsManager(App, ev, $('#z1ChipStationsHost'), () => {
      z1DirtyTabs.add('ops');
      z1DirtyTabs.add('setup');
      renderZ1StageGateBar(App, ev);
      renderZ1ChipControl(App, ev);
    });
  }

  /* ---- 子分頁 4：📡 賽道即時管制（各站通過進度 → 終點／繞圈全矩陣點擊補登） ---- */
  function renderZ1ChipSubTrack(App, ev, body, lbRows) {
    const isLap = ev.raceType === 'lap_timed';
    const cats = App.State.categories.filter((c) => c.eventId === ev.eventId);
    const raceStations = App.State.stations
      .filter((s) => s.eventId === ev.eventId && String(s.stationCode).toUpperCase() !== 'CHECKIN')
      .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));

    const totalPaid = lbRows.length;
    const checkedCnt = lbRows.filter((r) => r.checkedIn || r.status === 'finished' || r.status === 'on_track').length;
    const finishedCnt = lbRows.filter((r) => r.status === 'finished').length;
    const onTrackCnt = lbRows.filter((r) => r.status === 'on_track').length;
    const totalLapsAll = lbRows.reduce((s, r) => s + Number(r.lapCount || 0), 0);
    const totalKmAll = lbRows.reduce((s, r) => s + Number(r.totalDistanceKm || 0), 0);
    const topKm = lbRows.length ? Math.max(...lbRows.map((r) => Number(r.totalDistanceKm || 0))) : 0;

    const flt = App.State.z1TrackFilter || { q: '', catId: 'all', status: 'all', senseSt: raceStations[0]?.stationCode || 'FINISH' };
    if (raceStations.length && !raceStations.some((s) => s.stationCode === flt.senseSt) && flt.senseSt !== 'CHECKIN') {
      flt.senseSt = raceStations[0].stationCode;
    }
    App.State.z1TrackFilter = flt;

    const q = String(flt.q || '').trim().toUpperCase();
    const filtered = lbRows.filter((r) => {
      if (flt.catId !== 'all' && r.participant.catId !== flt.catId) return false;
      if (flt.status === 'finished' && r.status !== 'finished') return false;
      if (flt.status === 'on_track' && r.status !== 'on_track') return false;
      if (flt.status === 'checked_in' && !r.checkedIn) return false;
      if (flt.status === 'not_checked_in' && r.checkedIn) return false;
      if (flt.status === 'dnf' && r.status !== 'dnf') return false;
      if (!q) return true;
      return `${r.participant.bibNumber} ${r.participant.name} ${r.participant.idCard} ${r.category.name}`.toUpperCase().includes(q);
    });

    const statusBadge = {
      finished: '<span class="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">已完賽</span>',
      on_track: '<span class="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold text-[10px]">賽道上</span>',
      dnf: '<span class="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[10px]">DNF</span>',
      dns: '<span class="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-bold text-[10px]">未起跑</span>'
    };

    body.innerHTML = `
      <!-- KPI 看板 -->
      ${isLap ? `
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
          <div class="bg-white p-3 rounded-xl border"><div class="text-slate-500">已配號</div><div class="text-xl font-black mono">${totalPaid}</div></div>
          <div class="bg-sky-50 p-3 rounded-xl border border-sky-200"><div class="text-sky-800 font-bold">已報到</div><div class="text-xl font-black mono text-sky-900">${checkedCnt}</div></div>
          <div class="bg-indigo-50 p-3 rounded-xl border border-indigo-200"><div class="text-indigo-800 font-bold">累積總圈數</div><div class="text-xl font-black mono text-indigo-900">${totalLapsAll} 圈</div></div>
          <div class="bg-emerald-50 p-3 rounded-xl border border-emerald-200"><div class="text-emerald-800 font-bold">全場總里程</div><div class="text-xl font-black mono text-emerald-800">${totalKmAll.toFixed(1)} km</div></div>
          <div class="bg-amber-50 p-3 rounded-xl border border-amber-200"><div class="text-amber-900 font-bold">最高里程</div><div class="text-xl font-black mono text-amber-900">${topKm.toFixed(2)} km</div></div>
        </div>
      ` : `
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
          <div class="bg-white p-3 rounded-xl border"><div class="text-slate-500">已配號</div><div class="text-xl font-black mono">${totalPaid}</div></div>
          <div class="bg-sky-50 p-3 rounded-xl border border-sky-200"><div class="text-sky-800 font-bold">已報到</div><div class="text-xl font-black mono text-sky-900">${checkedCnt}</div></div>
          <div class="bg-amber-50 p-3 rounded-xl border border-amber-200"><div class="text-amber-900 font-bold">賽道上</div><div class="text-xl font-black mono text-amber-900">${onTrackCnt}</div></div>
          <div class="bg-emerald-50 p-3 rounded-xl border border-emerald-200"><div class="text-emerald-800 font-bold">已完賽</div><div class="text-xl font-black mono text-emerald-800">${finishedCnt}</div></div>
          <div class="bg-slate-50 p-3 rounded-xl border"><div class="text-slate-500">未報到</div><div class="text-xl font-black mono text-slate-600">${totalPaid - checkedCnt}</div></div>
        </div>
      `}

      <!-- 各站通過人數進度 -->
      <div class="bg-white p-3.5 rounded-xl border shadow-sm space-y-2 text-xs">
        <div class="font-black text-slate-800">📍 各管制點即時通過進度</div>
        <div class="grid grid-cols-2 sm:grid-cols-${Math.min(6, Math.max(2, raceStations.length + 1))} gap-2">
          <div class="p-2 rounded-lg bg-sky-50 border border-sky-200">
            <div class="font-bold text-sky-900">📋 報到檢錄</div>
            <div class="mono font-black text-base text-sky-950">${checkedCnt} / ${totalPaid}</div>
          </div>
          ${raceStations.map((st) => {
            const passed = isLap
              ? lbRows.filter((r) => r.lapCount > 0).length
              : lbRows.filter((r) => Boolean(r.splits[st.stationCode])).length;
            const pct = totalPaid ? Math.round((passed / totalPaid) * 100) : 0;
            return `
              <div class="p-2 rounded-lg bg-slate-50 border">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-black mono text-slate-900">${C.escapeHtml(st.stationCode)}</span>
                  <span class="text-[10px] text-slate-500">${Number(st.distanceKm || 0)}km</span>
                </div>
                <div class="text-[11px] text-slate-600 truncate">${C.escapeHtml(st.name)}</div>
                <div class="mono font-black text-sm text-indigo-800 mt-0.5">${passed}/${totalPaid} <span class="text-[10px] font-bold">(${pct}%)</span></div>
              </div>`;
          }).join('')}
        </div>
      </div>

      <!-- 後台即時站點感應 / 快刷列 -->
      <div class="bg-white p-3.5 rounded-xl border shadow-sm space-y-2 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-black text-sm">📡 總部即時站點感應／快刷</div>
          <button type="button" id="btnZ1TrackToggleNfc" class="px-3 py-1.5 rounded-lg font-black ${C.NFC.isScanning ? 'bg-rose-600 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">
            ${C.NFC.isScanning ? '🛑 停止 NFC 感應' : '📡 啟動該站 NFC 感應'}
          </button>
        </div>
        <form id="z1TrackSenseForm" class="flex flex-wrap gap-2">
          <select id="z1TrackSenseSt" class="px-2.5 py-2 border-2 border-indigo-300 rounded-lg bg-indigo-50/50 font-black">
            <option value="CHECKIN" ${flt.senseSt === 'CHECKIN' ? 'selected' : ''}>CHECKIN（報到檢錄）</option>
            ${raceStations.map((s) => `<option value="${C.escapeHtml(s.stationCode)}" ${flt.senseSt === s.stationCode ? 'selected' : ''}>${C.escapeHtml(s.stationCode)}（${C.escapeHtml(s.name)}）</option>`).join('')}
          </select>
          <input id="z1TrackQuickInput" placeholder="輸入號碼布 / 身分證 / UID 按 Enter 立即記錄" autocomplete="off" class="flex-1 min-w-[200px] px-3 py-2 border-2 rounded-lg font-bold mono uppercase" />
          <button type="submit" class="px-4 py-2 rounded-lg bg-slate-900 text-white font-black">⚡ 記錄通過</button>
        </form>
        <div id="z1TrackSenseBanner" class="hidden p-2.5 rounded-lg border font-bold"></div>
      </div>

      <!-- 單格補登 / 修訂內嵌面板（點擊任一站點格開啟） -->
      <div id="z1TrackCellEditor" class="hidden bg-sky-50 border-2 border-sky-400 p-3.5 rounded-xl space-y-2 text-xs"></div>

      <!-- 逐圈明細管理內嵌面板（繞圈賽點擊展開） -->
      <div id="z1TrackLapEditor" class="hidden bg-indigo-50 border-2 border-indigo-400 p-3.5 rounded-xl space-y-2 text-xs"></div>

      <!-- 全賽道跑者管制矩陣總表 -->
      <div class="bg-white p-3.5 rounded-xl border shadow-sm space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 flex-1">
            <input id="z1TrackSearch" value="${C.escapeHtml(flt.q)}" placeholder="🔎 號碼布 / 姓名 / 身分證" class="min-w-[160px] flex-1 max-w-xs px-2.5 py-1.5 border rounded-lg" />
            <select id="z1TrackCatFilter" class="px-2.5 py-1.5 border rounded-lg bg-slate-50 font-bold">
              <option value="all" ${flt.catId === 'all' ? 'selected' : ''}>全部組別</option>
              ${cats.map((c) => `<option value="${c.catId}" ${flt.catId === c.catId ? 'selected' : ''}>${C.escapeHtml(c.name)}</option>`).join('')}
            </select>
            <select id="z1TrackStatusFilter" class="px-2.5 py-1.5 border rounded-lg bg-slate-50 font-bold">
              <option value="all" ${flt.status === 'all' ? 'selected' : ''}>全部狀態</option>
              <option value="finished" ${flt.status === 'finished' ? 'selected' : ''}>已完賽</option>
              <option value="on_track" ${flt.status === 'on_track' ? 'selected' : ''}>賽道上</option>
              <option value="checked_in" ${flt.status === 'checked_in' ? 'selected' : ''}>已報到</option>
              <option value="not_checked_in" ${flt.status === 'not_checked_in' ? 'selected' : ''}>未報到</option>
              <option value="dnf" ${flt.status === 'dnf' ? 'selected' : ''}>DNF</option>
            </select>
          </div>
          <span class="text-[11px] text-slate-500 font-bold">💡 點擊任一站點時間格即可補登或修改</span>
        </div>

        <div class="overflow-x-auto max-h-[520px]">
          <table class="w-full text-left">
            <thead class="bg-slate-100 sticky top-0 z-10">
              ${isLap ? `
                <tr>
                  <th class="p-2">總/組名次</th>
                  <th class="p-2">號碼布 / 姓名</th>
                  <th class="p-2">組別</th>
                  <th class="p-2">報到時間</th>
                  <th class="p-2">有效圈數</th>
                  <th class="p-2">累積里程</th>
                  <th class="p-2">累積耗時</th>
                  <th class="p-2">最速 / 均圈</th>
                  <th class="p-2">平均配速</th>
                  <th class="p-2">逐圈管理</th>
                </tr>
              ` : `
                <tr>
                  <th class="p-2">名次</th>
                  <th class="p-2">號碼布 / 姓名</th>
                  <th class="p-2">組別</th>
                  <th class="p-2">狀態</th>
                  <th class="p-2">報到</th>
                  ${raceStations.map((st) => `<th class="p-2 whitespace-nowrap">${C.escapeHtml(st.stationCode)}<div class="text-[10px] font-normal text-slate-500">${C.escapeHtml(st.name)}</div></th>`).join('')}
                  <th class="p-2">分段配速 / ETA</th>
                  <th class="p-2">完賽成績</th>
                </tr>
              `}
            </thead>
            <tbody class="divide-y">
              ${isLap ? (filtered.map((r) => `
                <tr class="hover:bg-slate-50">
                  <td class="p-2 mono font-black text-amber-700 whitespace-nowrap">${r.overallRank} <span class="text-slate-400 font-normal">/ ${r.catRank}</span></td>
                  <td class="p-2 whitespace-nowrap"><b class="mono">${C.escapeHtml(r.participant.bibNumber)}</b> ${C.escapeHtml(r.participant.name)}</td>
                  <td class="p-2 whitespace-nowrap text-slate-600">${C.escapeHtml(r.category.name)}</td>
                  <td class="p-2 mono whitespace-nowrap">
                    <button type="button" data-cell-edit="${r.participant.participantId}" data-cell-st="CHECKIN" data-cell-log="${C.escapeHtml(r.checkInLog?.logId || '')}" class="px-2 py-0.5 rounded border border-dashed ${r.checkedIn ? 'border-emerald-400 bg-emerald-50 text-emerald-800 font-bold' : 'border-slate-300 text-slate-400 hover:border-sky-400'}">
                      ${r.checkInTime ? `✅ ${r.checkInTime}` : (r.checkedIn ? '✅ 已報到' : '+ 報到')}
                    </button>
                  </td>
                  <td class="p-2 mono font-black text-indigo-800 whitespace-nowrap">${r.lapCount} 圈${r.overtimeCount ? ` <span class="text-[10px] text-rose-600">(+${r.overtimeCount}超時)</span>` : ''}</td>
                  <td class="p-2 mono font-black text-emerald-700 whitespace-nowrap">${r.totalDistanceKm.toFixed(2)} km</td>
                  <td class="p-2 mono whitespace-nowrap">${r.elapsedSec !== null ? C.formatDuration(r.elapsedSec) : '--'}</td>
                  <td class="p-2 mono text-[11px] whitespace-nowrap">${r.bestLapSec !== null ? C.formatDuration(r.bestLapSec) : '--'} / ${r.avgLapSec !== null ? C.formatDuration(r.avgLapSec) : '--'}</td>
                  <td class="p-2 mono whitespace-nowrap">${C.escapeHtml(r.avgPace)}</td>
                  <td class="p-2 whitespace-nowrap">
                    <button type="button" data-open-lap-mgr="${r.participant.participantId}" class="px-2.5 py-1 rounded-lg bg-indigo-100 hover:bg-indigo-200 text-indigo-900 font-bold">🔁 逐圈 (${r.lapDetails.length})</button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="10" class="p-6 text-center text-slate-400">查無符合條件之選手</td></tr>'
              ) : (filtered.map((r) => `
                <tr class="hover:bg-slate-50 align-top">
                  <td class="p-2 mono font-black text-amber-700 whitespace-nowrap">${r.overallRank} <span class="text-slate-400 font-normal">/ ${r.catRank}</span></td>
                  <td class="p-2 whitespace-nowrap"><b class="mono">${C.escapeHtml(r.participant.bibNumber)}</b> ${C.escapeHtml(r.participant.name)}</td>
                  <td class="p-2 whitespace-nowrap text-slate-600">${C.escapeHtml(r.category.name)}</td>
                  <td class="p-2 whitespace-nowrap">${statusBadge[r.status] || r.status}</td>
                  <td class="p-2 mono whitespace-nowrap">
                    <button type="button" data-cell-edit="${r.participant.participantId}" data-cell-st="CHECKIN" data-cell-log="${C.escapeHtml(r.checkInLog?.logId || '')}" class="px-2 py-0.5 rounded border border-dashed ${r.checkedIn ? 'border-emerald-400 bg-emerald-50 text-emerald-800 font-bold' : 'border-slate-300 text-slate-400 hover:border-sky-400'}">
                      ${r.checkInTime ? `✅ ${r.checkInTime}` : (r.checkedIn ? '✅ 已報到' : '+ 報到')}
                    </button>
                  </td>
                  ${raceStations.map((st) => {
                    const sp = r.splits[st.stationCode];
                    return `
                      <td class="p-2 mono whitespace-nowrap">
                        <button type="button" data-cell-edit="${r.participant.participantId}" data-cell-st="${C.escapeHtml(st.stationCode)}" data-cell-log="${C.escapeHtml(sp?.logId || '')}" class="px-2 py-0.5 rounded border border-dashed ${sp ? 'border-sky-400 bg-sky-50 text-sky-900 font-bold' : 'border-slate-300 text-slate-400 hover:border-amber-400 hover:text-amber-700'}">
                          ${sp ? sp.time : '+ 補登'}
                        </button>
                      </td>`;
                  }).join('')}
                  <td class="p-2 text-[11px] mono">
                    ${r.splitDetails.map((sp) => `<div>${C.escapeHtml(sp.code)}: <b>${sp.segPace}</b></div>`).join('') || ''}
                    ${r.etaTimeStr ? `<div class="text-indigo-700 font-bold">預估完賽 ${r.etaTimeStr}</div>` : ''}
                    ${!r.splitDetails.length && !r.etaTimeStr ? '<span class="text-slate-400">--</span>' : ''}
                  </td>
                  <td class="p-2 mono font-black whitespace-nowrap ${r.elapsedSec !== null ? 'text-emerald-700' : 'text-slate-400'}">
                    ${r.elapsedSec !== null ? C.formatDuration(r.elapsedSec) : '--'}
                    ${r.elapsedSec !== null ? `<div class="text-[10px] font-normal text-slate-500">${C.escapeHtml(r.avgPace)}</div>` : ''}
                  </td>
                </tr>`).join('') || `<tr><td colspan="${7 + raceStations.length}" class="p-6 text-center text-slate-400">查無符合條件之選手</td></tr>`)}
            </tbody>
          </table>
        </div>
      </div>`;

    const showSenseBanner = (res) => {
      const bn = $('#z1TrackSenseBanner');
      if (!bn) return;
      bn.classList.remove('hidden');
      const cls = res.level === 'success' ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : (res.level === 'warn' ? 'bg-amber-50 border-amber-300 text-amber-950' : 'bg-rose-50 border-rose-300 text-rose-900');
      bn.className = `p-2.5 rounded-lg border font-bold ${cls}`;
      bn.textContent = res.msg;
    };

    $('#z1TrackSenseSt').onchange = (e) => {
      flt.senseSt = e.target.value;
      if (C.NFC.isScanning) { C.NFC.stopScanning(); renderZ1ChipControl(App, ev); }
    };

    $('#z1TrackSenseForm').onsubmit = async (e) => {
      e.preventDefault();
      const inp = $('#z1TrackQuickInput');
      const val = inp.value.trim();
      if (!val) return;
      const res = await adminSenseRunner(App, ev, flt.senseSt, val, 'manual', { bypassDebounce: true });
      inp.value = '';
      renderZ1StageGateBar(App, ev);
      renderZ1ChipControl(App, ev);
      showSenseBanner(res);
      const nextInp = $('#z1TrackQuickInput'); if (nextInp) nextInp.focus();
    };

    $('#btnZ1TrackToggleNfc').onclick = async () => {
      if (C.NFC.isScanning) {
        C.NFC.stopScanning();
        renderZ1ChipControl(App, ev);
        return App.toast('已停止 NFC 感應', 'info');
      }
      try {
        await C.NFC.startScanning(async (tag) => {
          const token = tag.idNumber ? `${tag.name}|${tag.idNumber}` : (tag.bib || tag.nfcUid);
          const res = await adminSenseRunner(App, ev, flt.senseSt, token, 'nfc');
          renderZ1StageGateBar(App, ev);
          renderZ1ChipControl(App, ev);
          showSenseBanner(res);
        }, (err) => App.toast(err.message, 'error'));
        renderZ1ChipControl(App, ev);
        App.toast(`📡 已啟動 ${flt.senseSt} 站 NFC 感應`, 'success');
      } catch (err) {
        App.toast(err.message, 'warn');
      }
    };

    $('#z1TrackSearch').oninput = (e) => {
      flt.q = e.target.value;
      const pos = e.target.selectionStart;
      renderZ1ChipControl(App, ev);
      const inp = $('#z1TrackSearch'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    };
    $('#z1TrackCatFilter').onchange = (e) => { flt.catId = e.target.value; renderZ1ChipControl(App, ev); };
    $('#z1TrackStatusFilter').onchange = (e) => { flt.status = e.target.value; renderZ1ChipControl(App, ev); };

    // 點擊任一站點時間格 → 開啟內嵌補登 / 修訂 / 作廢面板
    $$('[data-cell-edit]').forEach((btn) => {
      btn.onclick = () => {
        const pid = btn.dataset.cellEdit;
        const stCode = btn.dataset.cellSt;
        const logId = btn.dataset.cellLog;
        const p = App.State.participants.find((x) => x.participantId === pid);
        if (!p) return;
        const existLog = logId ? App.State.timingLogs.find((l) => l.logId === logId) : null;
        const stObj = App.State.stations.find((s) => s.eventId === ev.eventId && String(s.stationCode).toUpperCase() === stCode);
        const stLabel = stCode === 'CHECKIN' ? 'CHECKIN（報到檢錄）' : `${stCode}${stObj ? `（${stObj.name}）` : ''}`;
        const ed = $('#z1TrackCellEditor');
        ed.classList.remove('hidden');
        ed.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-sky-200 pb-1.5">
            <div class="font-black text-sky-950">⏱️ ${existLog ? '修訂' : '補登'}站點時間：${C.escapeHtml(p.bibNumber)} ${C.escapeHtml(p.name)} @ ${C.escapeHtml(stLabel)}</div>
            <button type="button" id="btnCloseCellEd" class="text-slate-500 hover:text-slate-900 font-bold">✕ 關閉</button>
          </div>
          <div class="flex flex-wrap items-end gap-2">
            <div class="flex-1 min-w-[200px]">
              <label class="font-bold text-[11px] block">通過日期與時間 (YYYY-MM-DD HH:mm:ss)</label>
              <input id="cellEdTime" value="${C.escapeHtml(existLog ? existLog.sensedTime : C.formatDateTime())}" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mono font-bold mt-0.5" />
            </div>
            <button type="button" id="btnCellEdNow" class="px-2.5 py-1.5 rounded-lg bg-white border font-bold">帶入現在時間</button>
            <button type="button" id="btnCellEdSave" class="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black">💾 儲存</button>
            ${existLog ? '<button type="button" id="btnCellEdVoid" class="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold">🗑️ 作廢此筆</button>' : ''}
          </div>`;
        $('#btnCloseCellEd').onclick = () => ed.classList.add('hidden');
        $('#btnCellEdNow').onclick = () => { $('#cellEdTime').value = C.formatDateTime(); };
        $('#btnCellEdSave').onclick = async () => {
          const tm = $('#cellEdTime').value.trim();
          if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tm)) return App.toast('格式須為 YYYY-MM-DD HH:mm:ss', 'error');
          const cat = App.State.categories.find((c) => c.catId === p.catId);
          const effStart = (cat && cat.customRaceStart) || ev.raceStart;
          if (stCode !== 'CHECKIN' && effStart) {
            const sDt = C.parseDateTime(effStart);
            const tDt = C.parseDateTime(tm);
            if (sDt && tDt && tDt.getTime() < sDt.getTime()) {
              return App.toast(`🔒 通過時間 (${tm}) 不可早於起跑時間 (${effStart})`, 'error');
            }
          }
          if (existLog) {
            existLog.sensedTime = tm;
            existLog.source = 'manual';
            existLog.note = '後台修訂時間';
            await C.TurDB.put('timingLogs', existLog);
            await App.enqueueSync('adjustTimingLog', { log: existLog });
            App.toast(`✅ 已更新 ${p.bibNumber} @ ${stCode} 時間為 ${tm}`, 'success');
          } else {
            const res = await adminSenseRunner(App, ev, stCode, p.bibNumber, 'manual', { customTime: tm, bypassDebounce: true, allowDuplicateFinish: true, note: '矩陣補登' });
            if (!res.ok) return App.toast(res.msg, 'error');
            App.toast(res.msg, 'success');
          }
          renderZ1StageGateBar(App, ev);
          renderZ1ChipControl(App, ev);
        };
        if ($('#btnCellEdVoid')) {
          $('#btnCellEdVoid').onclick = async () => {
            if (!confirm(`確定作廢 ${p.bibNumber} @ ${stCode}（${existLog.sensedTime}）這筆感應紀錄嗎？`)) return;
            existLog.isValid = false;
            await C.TurDB.put('timingLogs', existLog);
            await App.enqueueSync('adjustTimingLog', { log: existLog });
            if (stCode === 'CHECKIN') {
              p.checkinStatus = 'pending';
              await C.TurDB.put('participants', p);
              await App.enqueueSync('updateParticipant', { participantId: p.participantId, checkinStatus: 'pending' });
            } else if (stCode === 'FINISH') {
              const hasOtherFin = App.State.timingLogs.some((l) => l.eventId === ev.eventId && String(l.bibNumber).toUpperCase() === String(p.bibNumber).toUpperCase() && String(l.stationCode).toUpperCase() === 'FINISH' && l.isValid !== false);
              if (!hasOtherFin) {
                p.raceStatus = 'on_track';
                await C.TurDB.put('participants', p);
                await App.enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'on_track' });
              }
            }
            renderZ1StageGateBar(App, ev);
            renderZ1ChipControl(App, ev);
            App.toast(`🗑️ 已作廢 ${p.bibNumber} @ ${stCode}`, 'info');
          };
        }
      };
    });

    // 繞圈賽：展開逐圈明細與補刪圈面板
    $$('[data-open-lap-mgr]').forEach((btn) => {
      btn.onclick = () => {
        const pid = btn.dataset.openLapMgr;
        const row = lbRows.find((r) => r.participant.participantId === pid);
        if (!row) return;
        const p = row.participant;
        const lapBox = $('#z1TrackLapEditor');
        lapBox.classList.remove('hidden');
        lapBox.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-200 pb-1.5">
            <div class="font-black text-indigo-950">🔁 逐圈明細管理：${C.escapeHtml(p.bibNumber)} ${C.escapeHtml(p.name)}（有效 ${row.lapCount} 圈 / ${row.totalDistanceKm.toFixed(2)} km）</div>
            <button type="button" id="btnCloseLapEd" class="text-slate-500 hover:text-slate-900 font-bold">✕ 關閉</button>
          </div>
          <div class="flex flex-wrap items-end gap-2">
            <input id="lapAddTime" value="${C.formatDateTime()}" placeholder="YYYY-MM-DD HH:mm:ss" class="px-2.5 py-1.5 border rounded-lg bg-white mono font-bold w-52" />
            <button type="button" id="btnLapAddSubmit" class="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-black">+ 補登一圈</button>
          </div>
          <div class="max-h-56 overflow-y-auto bg-white rounded-lg border">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-100 sticky top-0">
                <tr><th class="p-1.5">圈次</th><th class="p-1.5">通過時間</th><th class="p-1.5">單圈耗時</th><th class="p-1.5">單圈配速</th><th class="p-1.5">累積里程</th><th class="p-1.5">操作</th></tr>
              </thead>
              <tbody class="divide-y mono">
                ${row.lapDetails.map((ld) => `
                  <tr class="${ld.overtime ? 'bg-rose-50 text-rose-700' : ''}">
                    <td class="p-1.5 font-black">${ld.overtime ? '超時' : `#${ld.lapNumber}`}</td>
                    <td class="p-1.5">${C.escapeHtml(ld.fullTime)}</td>
                    <td class="p-1.5">${ld.segSec !== null ? C.formatDuration(ld.segSec) : '--'}</td>
                    <td class="p-1.5">${C.escapeHtml(ld.segPace)}</td>
                    <td class="p-1.5">${ld.cumKm !== null ? `${ld.cumKm.toFixed(2)} km` : '不計入'}</td>
                    <td class="p-1.5"><button type="button" data-void-lap="${C.escapeHtml(ld.logId)}" class="px-2 py-0.5 rounded bg-rose-100 text-rose-700 font-sans font-bold">作廢</button></td>
                  </tr>`).join('') || '<tr><td colspan="6" class="p-4 text-center text-slate-400 font-sans">尚無繞圈紀錄</td></tr>'}
              </tbody>
            </table>
          </div>`;
        $('#btnCloseLapEd').onclick = () => lapBox.classList.add('hidden');
        $('#btnLapAddSubmit').onclick = async () => {
          const tm = $('#lapAddTime').value.trim();
          const res = await adminSenseRunner(App, ev, 'LAP', p.bibNumber, 'manual', { customTime: tm, bypassDebounce: true, note: '後台補圈' });
          if (!res.ok) return App.toast(res.msg, 'error');
          renderZ1StageGateBar(App, ev);
          renderZ1ChipControl(App, ev);
          App.toast(res.msg, 'success');
        };
        $$('[data-void-lap]').forEach((vb) => {
          vb.onclick = async () => {
            const lg = App.State.timingLogs.find((x) => x.logId === vb.dataset.voidLap);
            if (!lg) return;
            lg.isValid = false;
            await C.TurDB.put('timingLogs', lg);
            await App.enqueueSync('adjustTimingLog', { log: lg });
            renderZ1StageGateBar(App, ev);
            renderZ1ChipControl(App, ev);
            App.toast('🗑️ 已作廢該圈紀錄', 'info');
          };
        });
      };
    });
  }

  function renderEventStationsManager(App, ev, hostEl, onChanged) {
    if (!hostEl || !ev) return;
    const sts = App.State.stations
      .filter((s) => s.eventId === ev.eventId)
      .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const stTypeMeta = {
      checkin: { label: '報到檢錄', badge: 'bg-emerald-100 text-emerald-800' },
      checkpoint: { label: '中繼管制點', badge: 'bg-sky-100 text-sky-800' },
      finish: { label: '終點衝線', badge: 'bg-rose-100 text-rose-800' },
      lap: { label: '繞圈主拱門', badge: 'bg-indigo-100 text-indigo-800' }
    };
    const evOps = App.State.users.filter((x) => x.role === 'operator' && x.allowedEventId === ev.eventId);
    const opCountByCode = new Map();
    evOps.forEach((op) => {
      const c = String(op.allowedStation || '').toUpperCase();
      opCountByCode.set(c, (opCountByCode.get(c) || 0) + 1);
    });

    hostEl.innerHTML = `
      <div class="bg-white p-4 rounded-xl border shadow-sm space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div class="flex items-center gap-2">
            <h3 class="font-black text-sm">📍 管制點與站點配置</h3>
            <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold mono">${sts.length} 站</span>
          </div>
          <button type="button" data-st-open-add class="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold">+ 新增站點</button>
        </div>

        <div data-st-editor class="hidden p-3 rounded-xl bg-sky-50/80 border-2 border-sky-300 space-y-2.5">
          <div class="flex items-center justify-between border-b border-sky-200 pb-1.5">
            <div data-st-ed-title class="font-black text-sky-950">➕ 新增管制站點</div>
            <button type="button" data-st-cancel class="text-slate-500 hover:text-slate-800 font-bold">✕ 關閉</button>
          </div>
          <input type="hidden" data-st-field="stationId" value="" />
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <label class="font-bold text-[11px]">站點代碼 *</label>
              <input data-st-field="stationCode" type="text" placeholder="CP1 / FINISH / LAP" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono uppercase font-bold" />
            </div>
            <div>
              <label class="font-bold text-[11px]">自訂站點名稱 *</label>
              <input data-st-field="name" type="text" placeholder="例：水庫折返站" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5" />
            </div>
            <div>
              <label class="font-bold text-[11px]">站點類型</label>
              <select data-st-field="stationType" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 font-bold">
                <option value="checkin">報到檢錄 (checkin)</option>
                <option value="checkpoint">中繼管制點 (checkpoint)</option>
                <option value="finish">終點衝線 (finish)</option>
                <option value="lap">繞圈主拱門 (lap)</option>
              </select>
            </div>
            <div>
              <label class="font-bold text-[11px]">累計距離 (km)</label>
              <input data-st-field="distanceKm" type="number" step="0.1" min="0" value="0" class="w-full px-2.5 py-1.5 border rounded-lg bg-white mt-0.5 mono" />
            </div>
          </div>
          <div data-st-lock-hint class="hidden text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5"></div>
          <div class="flex justify-end gap-2">
            <button type="button" data-st-cancel class="px-3 py-1.5 rounded-lg bg-white border font-bold text-slate-600">取消</button>
            <button type="button" data-st-save class="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black shadow">💾 儲存站點</button>
          </div>
        </div>

        <div class="space-y-1.5">
          ${sts.map((s, idx) => {
            const tm = stTypeMeta[s.stationType] || stTypeMeta.checkpoint;
            const opCnt = opCountByCode.get(String(s.stationCode || '').toUpperCase()) || 0;
            return `
              <div class="p-2 rounded-lg bg-slate-50 border flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span class="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-bold mono text-[10px]">#${idx + 1}</span>
                  <span class="px-2 py-0.5 rounded bg-slate-900 text-amber-300 font-black mono">${C.escapeHtml(s.stationCode)}</span>
                  <b class="text-slate-900">${C.escapeHtml(s.name)}</b>
                  <span class="px-1.5 py-0.5 rounded font-bold text-[10px] ${tm.badge}">${tm.label}</span>
                  <span class="text-slate-500 mono">${Number(s.distanceKm || 0)} km</span>
                  <span class="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-bold">${opCnt} 名作業員</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button type="button" data-move-st="${s.stationId}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} class="px-1.5 py-0.5 rounded bg-white border hover:bg-slate-100 disabled:opacity-35" title="上移">↑</button>
                  <button type="button" data-move-st="${s.stationId}" data-dir="1" ${idx === sts.length - 1 ? 'disabled' : ''} class="px-1.5 py-0.5 rounded bg-white border hover:bg-slate-100 disabled:opacity-35" title="下移">↓</button>
                  <button type="button" data-edit-st="${s.stationId}" class="px-2 py-0.5 rounded bg-sky-50 border border-sky-300 text-sky-900 hover:bg-sky-100 font-bold text-[11px]">✏️ 修改</button>
                  <button type="button" data-del-st="${s.stationId}" class="px-2 py-0.5 rounded bg-rose-50 text-rose-600 hover:bg-rose-100 font-bold text-[11px]">刪</button>
                </div>
              </div>`;
          }).join('') || '<div class="text-slate-400 text-center py-4 border border-dashed rounded-lg">本活動尚未建立站點，請點右上「+ 新增站點」</div>'}
        </div>
      </div>`;

    const q = (sel) => hostEl.querySelector(sel);
    const qAll = (sel) => Array.from(hostEl.querySelectorAll(sel));
    const edBox = q('[data-st-editor]');
    const fId = q('[data-st-field="stationId"]');
    const fCode = q('[data-st-field="stationCode"]');
    const fName = q('[data-st-field="name"]');
    const fType = q('[data-st-field="stationType"]');
    const fKm = q('[data-st-field="distanceKm"]');
    const lockHint = q('[data-st-lock-hint]');
    const edTitle = q('[data-st-ed-title]');

    const resetEditor = () => {
      fId.value = '';
      fCode.value = '';
      fCode.disabled = false;
      fName.value = '';
      fType.value = ev.raceType === 'lap_timed' ? 'lap' : 'checkpoint';
      fKm.value = '0';
      lockHint.classList.add('hidden');
      lockHint.textContent = '';
      edTitle.textContent = '➕ 新增管制站點';
      edBox.classList.add('hidden');
    };

    fCode.oninput = () => {
      if (fId.value) return;
      const c = fCode.value.trim().toUpperCase();
      if (c === 'CHECKIN') fType.value = 'checkin';
      else if (c === 'FINISH') fType.value = 'finish';
      else if (c === 'LAP') fType.value = 'lap';
      else if (c.startsWith('CP')) fType.value = 'checkpoint';
    };

    q('[data-st-open-add]').onclick = () => {
      resetEditor();
      const nextCp = sts.filter((s) => /^CP\d+$/i.test(s.stationCode)).length + 1;
      fCode.value = ev.raceType === 'lap_timed' && !sts.some((s) => s.stationCode === 'LAP') ? 'LAP' : `CP${nextCp}`;
      fName.value = fCode.value === 'LAP' ? '主會場繞圈拱門' : `CP${nextCp} 檢查站`;
      fType.value = fCode.value === 'LAP' ? 'lap' : 'checkpoint';
      edBox.classList.remove('hidden');
      fName.focus();
    };
    qAll('[data-st-cancel]').forEach((b) => { b.onclick = resetEditor; });

    qAll('[data-edit-st]').forEach((b) => {
      b.onclick = () => {
        const stObj = sts.find((x) => x.stationId === b.dataset.editSt);
        if (!stObj) return;
        const logCnt = App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.stationCode === stObj.stationCode).length;
        fId.value = stObj.stationId;
        fCode.value = stObj.stationCode;
        fCode.disabled = logCnt > 0;
        fName.value = stObj.name || '';
        fType.value = stObj.stationType || 'checkpoint';
        fKm.value = String(Number(stObj.distanceKm || 0));
        if (logCnt > 0) {
          lockHint.textContent = `🔒 本站已有 ${logCnt} 筆感應紀錄，站點代碼鎖定不可改（仍可自由修改站名、類型與距離）`;
          lockHint.classList.remove('hidden');
        } else {
          lockHint.classList.add('hidden');
        }
        edTitle.textContent = `✏️ 修改站點：${stObj.stationCode} ${stObj.name}`;
        edBox.classList.remove('hidden');
        fName.focus();
      };
    });

    q('[data-st-save]').onclick = async () => {
      const editId = fId.value.trim();
      const code = fCode.value.trim().toUpperCase().replace(/\s+/g, '');
      const name = fName.value.trim();
      const stationType = fType.value;
      const distanceKm = Math.max(0, Number(fKm.value || 0));
      if (!code) return App.toast('請填寫站點代碼（例：CP1、FINISH、LAP）', 'error');
      if (code === 'WRITER') return App.toast('WRITER 為系統保留之發卡站代碼，請使用其他代碼', 'error');
      if (!name) return App.toast('請填寫站點名稱', 'error');

      const dup = sts.find((s) => String(s.stationCode).toUpperCase() === code && s.stationId !== editId);
      if (dup) return App.toast(`本活動已有重複站點代碼「${code}」`, 'error');

      if (editId) {
        const stObj = App.State.stations.find((s) => s.stationId === editId);
        if (!stObj) return;
        const oldCode = stObj.stationCode;
        stObj.stationCode = code;
        stObj.name = name;
        stObj.stationType = stationType;
        stObj.distanceKm = distanceKm;
        await C.TurDB.put('stations', stObj);
        await App.enqueueSync('saveStation', { station: stObj });
        if (oldCode !== code) {
          const affectedOps = App.State.users.filter((x) => x.role === 'operator' && x.allowedEventId === ev.eventId && x.allowedStation === oldCode);
          for (const op of affectedOps) {
            op.allowedStation = code;
            await C.TurDB.put('users', op);
            await App.enqueueSync('saveUser', { user: op });
          }
        }
        App.toast(`✅ 已更新站點「${code} ${name}」`, 'success');
      } else {
        const st = {
          stationId: `ST-${Date.now().toString().slice(-6)}`,
          eventId: ev.eventId,
          stationCode: code,
          name,
          distanceKm,
          stationType,
          orderIndex: sts.length
        };
        App.State.stations.push(st);
        await C.TurDB.put('stations', st);
        await App.enqueueSync('saveStation', { station: st });
        App.toast(`✅ 已新增站點「${code} ${name}」`, 'success');
      }
      if (onChanged) onChanged();
    };

    qAll('[data-move-st]').forEach((b) => {
      b.onclick = async () => {
        const idx = sts.findIndex((s) => s.stationId === b.dataset.moveSt);
        const dir = Number(b.dataset.dir);
        const targetIdx = idx + dir;
        if (idx < 0 || targetIdx < 0 || targetIdx >= sts.length) return;
        const reordered = [...sts];
        const [moved] = reordered.splice(idx, 1);
        reordered.splice(targetIdx, 0, moved);
        for (let i = 0; i < reordered.length; i++) {
          reordered[i].orderIndex = i;
          await C.TurDB.put('stations', reordered[i]);
          await App.enqueueSync('saveStation', { station: reordered[i] });
        }
        if (onChanged) onChanged();
      };
    });

    qAll('[data-del-st]').forEach((b) => {
      b.onclick = async () => {
        const sid = b.dataset.delSt;
        const stObj = App.State.stations.find((s) => s.stationId === sid);
        if (!stObj) return;
        const logCnt = App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.stationCode === stObj.stationCode).length;
        if (logCnt > 0) {
          return App.toast(`🔒 防呆攔截：站點「${stObj.stationCode}」已有 ${logCnt} 筆感應紀錄，禁止刪除！`, 'error');
        }
        const boundOps = opCountByCode.get(String(stObj.stationCode).toUpperCase()) || 0;
        const warnOp = boundOps > 0 ? `\n⚠️ 目前有 ${boundOps} 個作業員帳號鎖定此站點，刪除後請記得調整該作業員站點。` : '';
        if (!confirm(`確定刪除站點「${stObj.stationCode} ${stObj.name}」嗎？${warnOp}`)) return;
        App.State.stations = App.State.stations.filter((s) => s.stationId !== sid);
        await C.TurDB.remove('stations', sid);
        await App.enqueueSync('deleteStation', { stationId: sid });
        App.toast(`🗑️ 已刪除站點「${stObj.stationCode}」`, 'info');
        if (onChanged) onChanged();
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
    const gate = C.evaluateEventStageGates({
      event: ev, categories: App.State.categories, stations: App.State.stations,
      participants: App.State.participants, timingLogs: App.State.timingLogs,
      syncQueue: App.State.syncQueue, hasCloudGas: Boolean(App.State.gasUrl)
    });
    const hasBlockers = gate.closureBlockers.length > 0;

    const box = $('#z1-score');
    box.innerHTML = `
      <div id="z1ClosureGateBox" class="rounded-xl p-4 border-2 ${hasBlockers ? 'bg-rose-50 border-rose-300' : (gate.closureWarnings.length ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-300')} space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-black text-sm ${hasBlockers ? 'text-rose-950' : (gate.closureWarnings.length ? 'text-amber-950' : 'text-emerald-950')}">
            🔒 結案檢核（${hasBlockers ? `阻塞 ${gate.closureBlockers.length} 項` : (gate.closureWarnings.length ? `提醒 ${gate.closureWarnings.length} 項` : '✅ 全數通過')}）
          </div>
          <div class="flex flex-wrap gap-2">
            ${gate.metrics.pendingSyncCount > 0 ? '<button id="btnZ1ClosureSync" class="px-3 py-2 rounded-xl bg-sky-600 text-white font-bold">☁️ 上傳佇列</button>' : ''}
            ${gate.metrics.onTrackCount > 0 ? `<button id="btnZ1MarkOnTrackDnf" class="px-3 py-2 rounded-xl bg-amber-500 text-slate-950 font-black">🛑 在途 ${gate.metrics.onTrackCount} 人轉 DNF</button>` : ''}
            <button id="btnZ1LockFinish" ${hasBlockers ? 'disabled' : ''} class="px-4 py-2 rounded-xl font-black shadow ${hasBlockers ? 'bg-slate-300 text-slate-500 cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-500 text-white'}">🔒 結案鎖定</button>
          </div>
        </div>
        ${gate.closureBlockers.length ? `<div class="p-2.5 rounded-lg bg-rose-100/80 text-rose-900 space-y-0.5"><div class="font-black">⛔ 阻塞項目：</div>${gate.closureBlockers.map((b) => `<div>• ${C.escapeHtml(b)}</div>`).join('')}</div>` : ''}
        ${gate.closureWarnings.length ? `<div class="p-2.5 rounded-lg bg-amber-100/80 text-amber-950 space-y-0.5"><div class="font-black">⚠️ 提醒：</div>${gate.closureWarnings.map((w) => `<div>• ${C.escapeHtml(w)}</div>`).join('')}</div>` : ''}
      </div>

      ${buildEventRatioStatsHtml(App, ev, '📊 活動統計')}

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2">
          <h3 class="font-black text-sm">⚖️ 成績與罰時</h3>
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

        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2.5">
          <h3 class="font-black text-sm">🛠️ 補登與明細</h3>
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

    if ($('#btnZ1ClosureSync')) $('#btnZ1ClosureSync').onclick = async () => { await App.syncPushNow(false); renderZone1(App); };
    if ($('#btnZ1MarkOnTrackDnf')) {
      $('#btnZ1MarkOnTrackDnf').onclick = async () => {
        if (!confirm(`確定將本場目前仍處於「賽道進行中 (on_track)」之 ${gate.metrics.onTrackCount} 位選手批次標註為 DNF（未完賽）？`)) return;
        for (const p of App.State.participants) {
          if (p.eventId === ev.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.raceStatus === 'on_track') {
            p.raceStatus = 'dnf';
            await C.TurDB.put('participants', p);
            await App.enqueueSync('updateParticipant', { participantId: p.participantId, raceStatus: 'dnf' });
          }
        }
        App.renderAll();
        App.toast('🛑 已將在途未歸隊選手批次轉列 DNF', 'warn');
      };
    }

    $('#btnZ1LockFinish').onclick = async () => {
      if (hasBlockers) return App.toast('尚有結案阻塞項目未排除，禁止結案！', 'error');
      const warnText = gate.closureWarnings.length ? `\n\n⚠️ 提醒項目：\n- ${gate.closureWarnings.join('\n- ')}` : '';
      const typed = prompt(`🔒 階段 5 最終結案鎖定防誤觸！\n確定將「${ev.nameZh}」結案並移轉至專區 2（結案後所有感應與反向修改全面唯讀鎖定）？${warnText}\n\n請輸入大寫 LOCK 以確認執行：`);
      if (typed !== 'LOCK') return App.toast('輸入不符，已取消結案鎖定', 'info');
      ev.status = 'finished';
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.State.z2EventId = ev.eventId;
      App.switchView('zone2');
      App.toast('🔒 活動已通過 5 階段把關並結案鎖定，已移轉至專區 2！', 'success');
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
        renderZone1(App);
        App.toast(`已更新 ${p.bibNumber} 成績參數`, 'success');
      };
    });

    $('#z1AddLogForm').onsubmit = async (e) => {
      e.preventDefault();
      const bib = $('#z1LogBib').value.trim().toUpperCase();
      const st = $('#z1LogSt').value;
      const tm = $('#z1LogTime').value.trim();
      // 階段 4 補登防呆把關：核對已繳費號碼布、日期格式、不得早於鳴槍起跑時間
      const runner = App.State.participants.find((p) => p.eventId === ev.eventId && String(p.bibNumber || '').toUpperCase() === bib && String(p.payStatus).toUpperCase() === 'PAID');
      if (!runner) return App.toast(`🔒 階段 4 防呆攔截：找不到本場已繳費之號碼布「${bib}」`, 'error');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tm)) return App.toast('時間格式須為 YYYY-MM-DD HH:mm:ss', 'error');
      if (st !== 'CHECKIN' && ev.raceStart) {
        const stDt = C.parseDateTime(ev.raceStart);
        const logDt = C.parseDateTime(tm);
        if (stDt && logDt && logDt.getTime() < stDt.getTime()) {
          return App.toast(`🔒 階段 4 防呆攔截：補登時間 (${tm}) 不可早於鳴槍起跑時間 (${ev.raceStart})！`, 'error');
        }
      }
      const log = {
        logId: `ADJ-${Date.now()}-${bib}`, eventId: ev.eventId, stationCode: st, bibNumber: bib,
        idCardHash: '', sensedTime: tm, lapCount: st === 'LAP' ? (App.State.timingLogs.filter((l) => l.eventId === ev.eventId && l.bibNumber === bib && l.stationCode === 'LAP' && l.isValid !== false).length + 1) : 0,
        operator: App.State.currentUser.username, source: 'manual', isValid: true, note: '後台補登'
      };
      App.State.timingLogs.push(log);
      await C.TurDB.put('timingLogs', log);
      await App.enqueueSync('adjustTimingLog', { log });
      if (st === 'FINISH' && runner.raceStatus !== 'finished') {
        runner.raceStatus = 'finished';
        await C.TurDB.put('participants', runner);
        await App.enqueueSync('updateParticipant', { participantId: runner.participantId, raceStatus: 'finished' });
      }
      renderZone1(App);
      App.toast(`✅ 已補登 ${bib} @ ${st}`, 'success');
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
    if (!u || (u.role !== 'super_admin' && u.role !== 'organizer')) {
      $('#z1-ops').innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：現場作業員不可進入權限設定，僅限最高權責管理員與承辦人存取。</div>';
      return;
    }
    const isSuper = u.role === 'super_admin';
    const evNameMap = new Map(App.State.events.map((e) => [e.eventId, e.nameZh]));
    const myOwnedEvents = isSuper
      ? App.State.events
      : App.State.events.filter((e) => e.ownerUsername === u.username);
    const myEventIds = new Set(myOwnedEvents.map((e) => e.eventId));

    // 建立「活動+站點代碼 → 自訂站名」對照表
    const stNameByEvCode = new Map();
    App.State.stations.forEach((s) => {
      stNameByEvCode.set(`${s.eventId}::${String(s.stationCode || '').toUpperCase()}`, s.name || s.stationCode);
    });
    const getStationLabel = (eventId, code) => {
      const c = String(code || 'ALL').toUpperCase();
      if (c === 'WRITER') return 'WRITER（發卡寫入站）';
      if (c === 'ALL') return 'ALL';
      const customName = stNameByEvCode.get(`${eventId}::${c}`);
      return customName ? `${c}（${customName}）` : c;
    };

    // 權限隔離：最高管理員可看全平台全部帳號與密碼；承辦人僅能看到自己承辦場次的鎖定站點作業員與密碼
    const scopedUsers = isSuper
      ? [...App.State.users]
      : App.State.users.filter((x) => {
          if (x.role !== 'operator') return false;
          const evId = String(x.allowedEventId || '');
          if (evId && evId !== 'ALL') return myEventIds.has(evId);
          return x.parentOrganizer === u.username;
        });

    const sts = App.State.stations
      .filter((s) => s.eventId === ev.eventId)
      .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const allStations = [...new Set(scopedUsers.map((x) => x.allowedStation || 'ALL'))].sort();
    const roleLabelMap = { super_admin: '管理員', organizer: '承辦人', operator: '作業員' };
    const roleBadgeMap = {
      super_admin: 'bg-rose-100 text-rose-800',
      organizer: 'bg-amber-100 text-amber-900',
      operator: 'bg-sky-100 text-sky-800'
    };

    const flt = App.State.z1OpsFilter || { q: '', role: 'all', eventId: isSuper ? 'all' : '__CURRENT__', station: 'all', status: 'all' };
    if (!isSuper) {
      flt.role = 'all';
      if (flt.eventId !== 'all' && flt.eventId !== '__CURRENT__' && !myEventIds.has(flt.eventId)) flt.eventId = '__CURRENT__';
    }
    if (flt.station !== 'all' && !allStations.includes(flt.station)) flt.station = 'all';
    App.State.z1OpsFilter = flt;
    const box = $('#z1-ops');

    const buildStationOptionsHtml = (targetEvId, selectedCode = '') => {
      const targetSts = App.State.stations
        .filter((s) => s.eventId === targetEvId)
        .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
      const opts = [
        `<option value="WRITER" ${selectedCode === 'WRITER' ? 'selected' : ''}>WRITER（發卡寫入站）</option>`,
        ...targetSts.map((s) => `<option value="${C.escapeHtml(s.stationCode)}" ${selectedCode === s.stationCode ? 'selected' : ''}>${C.escapeHtml(s.stationCode)}（${C.escapeHtml(s.name)}）</option>`)
      ];
      if (selectedCode && selectedCode !== 'WRITER' && !targetSts.some((s) => s.stationCode === selectedCode)) {
        opts.push(`<option value="${C.escapeHtml(selectedCode)}" selected>${C.escapeHtml(selectedCode)}（原鎖定站點）</option>`);
      }
      return opts.join('');
    };

    box.innerHTML = `
      <!-- 區塊 1：本活動管制點與站點配置（承辦人可自由新增／改名／排序） -->
      <div id="z1OpsStationsHost"></div>

      <!-- 區塊 2：晶片作業員帳號與密碼 -->
      <div class="bg-white p-4 rounded-xl border shadow-sm space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div class="flex items-center gap-2">
            <h3 class="font-black text-sm">🔐 晶片作業員與權限</h3>
            <span id="z1OpsCount" class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold mono">${scopedUsers.length} 筆</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[11px] font-bold ${isSuper ? 'text-rose-700' : 'text-sky-700'}">
              ${isSuper ? '🛡️ 最高管理員：顯示全平台帳號與密碼' : `👤 承辦人：僅顯示本人場次與站點密碼`}
            </span>
            ${isSuper ? '<button type="button" id="btnZ1JumpZone3" class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 font-bold text-[11px]">👥 管理員／承辦人專區 →</button>' : ''}
          </div>
        </div>

        <form id="z1NewOpForm" autocomplete="off" class="p-3 rounded-xl bg-slate-50 border space-y-2">
          <div class="flex items-center justify-between">
            <div id="z1OpFormTitle" class="font-black text-slate-800">➕ 為「${C.escapeHtml(ev.nameZh)}」新增晶片作業員</div>
            <button type="button" id="btnZ1CancelOpEdit" class="hidden px-2 py-0.5 rounded bg-white border text-slate-600 font-bold">✕ 取消修改</button>
          </div>
          <input type="hidden" id="opEditOrigUser" value="" />
          <input type="hidden" id="opEditEventId" value="${C.escapeHtml(ev.eventId)}" />
          <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <input id="opNewUser" required placeholder="帳號 (例 cp2)" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
            <input id="opNewPass" required type="text" autocomplete="off" placeholder="密碼" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
            <input id="opNewName" required placeholder="顯示名稱" class="px-2.5 py-1.5 border rounded-lg bg-white" />
            <select id="opNewStation" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
              ${buildStationOptionsHtml(ev.eventId)}
            </select>
            <button type="submit" id="btnZ1SubmitOp" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold">+ 新增站點帳號</button>
          </div>
        </form>

        <!-- 欄位篩選查詢列 -->
        <div class="flex flex-wrap items-center gap-2 bg-slate-50/70 p-2.5 rounded-xl border">
          <input id="z1OpsSearch" type="text" value="${C.escapeHtml(flt.q)}" placeholder="🔎 搜尋帳號 / 密碼 / 名稱 / 站點 / 站名" class="flex-1 min-w-[180px] px-2.5 py-1.5 border rounded-lg bg-white" />
          ${isSuper ? `
            <select id="z1OpsRoleFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
              <option value="all" ${flt.role === 'all' ? 'selected' : ''}>全部角色</option>
              <option value="super_admin" ${flt.role === 'super_admin' ? 'selected' : ''}>管理員</option>
              <option value="organizer" ${flt.role === 'organizer' ? 'selected' : ''}>承辦人</option>
              <option value="operator" ${flt.role === 'operator' ? 'selected' : ''}>作業員</option>
            </select>` : ''}
          <select id="z1OpsEventFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold max-w-[230px]">
            <option value="__CURRENT__" ${flt.eventId === '__CURRENT__' ? 'selected' : ''}>📍 僅目前活動</option>
            <option value="all" ${flt.eventId === 'all' ? 'selected' : ''}>${isSuper ? '全部場次' : '本人全部場次'}</option>
            ${isSuper ? `<option value="ALL" ${flt.eventId === 'ALL' ? 'selected' : ''}>全平台 (ALL)</option>` : ''}
            ${myOwnedEvents.map((e) => `<option value="${e.eventId}" ${flt.eventId === e.eventId ? 'selected' : ''}>${C.escapeHtml(e.nameZh)}</option>`).join('')}
          </select>
          <select id="z1OpsStationFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
            <option value="all" ${flt.station === 'all' ? 'selected' : ''}>全部站點</option>
            ${allStations.map((st) => `<option value="${C.escapeHtml(st)}" ${flt.station === st ? 'selected' : ''}>${C.escapeHtml(st)}</option>`).join('')}
          </select>
          <select id="z1OpsStatusFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
            <option value="all" ${flt.status === 'all' ? 'selected' : ''}>全部狀態</option>
            <option value="1" ${flt.status === '1' ? 'selected' : ''}>啟用中</option>
            <option value="0" ${flt.status === '0' ? 'selected' : ''}>已停用</option>
          </select>
          <button type="button" id="btnZ1OpsResetFilter" class="px-2.5 py-1.5 rounded-lg bg-white border hover:bg-slate-100 font-bold text-slate-600">↺ 重設</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-100">
              <tr>
                <th class="p-2">帳號</th>
                <th class="p-2">密碼</th>
                <th class="p-2">名稱</th>
                ${isSuper ? '<th class="p-2">角色</th><th class="p-2">承辦人</th>' : ''}
                <th class="p-2">承辦場次</th>
                <th class="p-2">鎖定站點</th>
                <th class="p-2">狀態</th>
                <th class="p-2">操作</th>
              </tr>
            </thead>
            <tbody id="z1OpsTbody" class="divide-y"></tbody>
          </table>
        </div>
      </div>`;

    // 掛載本活動管制點與站點配置元件（變動時即時重整站點與作業員選單）
    renderEventStationsManager(App, ev, $('#z1OpsStationsHost'), () => {
      z1DirtyTabs.add('chip');
      z1DirtyTabs.add('setup');
      renderZ1StageGateBar(App, ev);
      renderZ1Ops(App, ev);
    });

    if ($('#btnZ1JumpZone3')) {
      $('#btnZ1JumpZone3').onclick = () => App.switchView('zone3');
    }

    const resetOpForm = () => {
      $('#opEditOrigUser').value = '';
      $('#opEditEventId').value = ev.eventId;
      $('#opNewUser').value = '';
      $('#opNewUser').disabled = false;
      $('#opNewPass').value = '';
      $('#opNewName').value = '';
      $('#opNewStation').innerHTML = buildStationOptionsHtml(ev.eventId);
      $('#z1OpFormTitle').textContent = `➕ 為「${ev.nameZh}」新增晶片作業員`;
      $('#btnZ1SubmitOp').textContent = '+ 新增站點帳號';
      $('#btnZ1SubmitOp').className = 'px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold';
      $('#btnZ1CancelOpEdit').classList.add('hidden');
    };
    $('#btnZ1CancelOpEdit').onclick = resetOpForm;

    const renderRows = () => {
      const q = String(flt.q || '').trim().toUpperCase();
      const targetEvFilter = flt.eventId === '__CURRENT__' ? ev.eventId : flt.eventId;
      const filtered = scopedUsers.filter((op) => {
        if (isSuper && flt.role !== 'all' && op.role !== flt.role) return false;
        if (targetEvFilter !== 'all' && String(op.allowedEventId || 'ALL') !== targetEvFilter) return false;
        if (flt.station !== 'all' && String(op.allowedStation || 'ALL') !== flt.station) return false;
        if (flt.status !== 'all' && String(Number(op.enabled) ? 1 : 0) !== flt.status) return false;
        if (!q) return true;
        const evNm = evNameMap.get(op.allowedEventId) || '';
        const stLbl = getStationLabel(op.allowedEventId, op.allowedStation);
        return `${op.username} ${op.passwordHash || ''} ${op.displayName || ''} ${op.role || ''} ${roleLabelMap[op.role] || ''} ${op.parentOrganizer || ''} ${op.allowedEventId || ''} ${evNm} ${op.allowedStation || ''} ${stLbl}`.toUpperCase().includes(q);
      });

      const cntEl = $('#z1OpsCount');
      if (cntEl) cntEl.textContent = `${filtered.length} / ${scopedUsers.length} 筆`;

      const colSpan = isSuper ? 9 : 7;
      $('#z1OpsTbody').innerHTML = filtered.map((op) => {
        const evId = op.allowedEventId || 'ALL';
        const evLabel = evId === 'ALL' ? '全部活動 (ALL)' : (evNameMap.get(evId) || evId);
        const stLbl = getStationLabel(evId, op.allowedStation);
        const canToggle = op.username !== u.username;
        const isOpRole = op.role === 'operator';
        return `
          <tr class="hover:bg-slate-50">
            <td class="p-2 mono font-bold whitespace-nowrap">${C.escapeHtml(op.username)}</td>
            <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-950 mono font-bold select-all">${C.escapeHtml(op.passwordHash || '-')}</span></td>
            <td class="p-2 whitespace-nowrap">${C.escapeHtml(op.displayName)}</td>
            ${isSuper ? `
              <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded font-bold ${roleBadgeMap[op.role] || 'bg-slate-100 text-slate-700'}">${roleLabelMap[op.role] || op.role}</span></td>
              <td class="p-2 mono whitespace-nowrap">${C.escapeHtml(op.parentOrganizer || '-')}</td>
            ` : ''}
            <td class="p-2">
              <div class="font-semibold text-slate-800">${C.escapeHtml(evLabel)}</div>
              ${evId !== 'ALL' ? `<div class="text-[10px] mono text-slate-400">${C.escapeHtml(evId)}</div>` : ''}
            </td>
            <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-bold">${C.escapeHtml(stLbl)}</span></td>
            <td class="p-2 whitespace-nowrap">
              <button data-toggle-op="${C.escapeHtml(op.username)}" ${canToggle ? '' : 'disabled'} class="px-2 py-0.5 rounded font-bold ${Number(op.enabled) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'} ${canToggle ? '' : 'opacity-50 cursor-not-allowed'}">${Number(op.enabled) ? '啟用中' : '已停用'}</button>
            </td>
            <td class="p-2 whitespace-nowrap">
              ${isOpRole
                ? `<div class="flex items-center gap-1">
                    <button type="button" data-edit-op="${C.escapeHtml(op.username)}" class="px-2 py-0.5 rounded bg-sky-50 border border-sky-300 text-sky-900 hover:bg-sky-100 font-bold">✏️ 修改</button>
                    <button type="button" data-del-op="${C.escapeHtml(op.username)}" class="px-2 py-0.5 rounded bg-rose-50 text-rose-600 hover:bg-rose-100 font-bold">刪</button>
                  </div>`
                : '<button type="button" data-goto-z3="1" class="px-2 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-800 font-bold">帳號專區</button>'}
            </td>
          </tr>`;
      }).join('') || `<tr><td colspan="${colSpan}" class="p-6 text-center text-slate-400">查無符合條件之帳號</td></tr>`;

      $$('[data-toggle-op]').forEach((b) => {
        b.onclick = async () => {
          const target = App.State.users.find((x) => x.username === b.dataset.toggleOp);
          if (!target || target.username === u.username) return;
          if (!isSuper && target.role !== 'operator') return;
          target.enabled = Number(target.enabled) ? 0 : 1;
          await C.TurDB.put('users', target);
          await App.enqueueSync('saveUser', { user: target });
          renderRows();
        };
      });
      $$('[data-edit-op]').forEach((b) => {
        b.onclick = () => {
          const target = scopedUsers.find((x) => x.username === b.dataset.editOp && x.role === 'operator');
          if (!target) return;
          const targetEvId = target.allowedEventId && target.allowedEventId !== 'ALL' ? target.allowedEventId : ev.eventId;
          $('#opEditOrigUser').value = target.username;
          $('#opEditEventId').value = targetEvId;
          $('#opNewUser').value = target.username;
          $('#opNewUser').disabled = true;
          $('#opNewPass').value = target.passwordHash || '';
          $('#opNewName').value = target.displayName || '';
          $('#opNewStation').innerHTML = buildStationOptionsHtml(targetEvId, target.allowedStation);
          $('#z1OpFormTitle').textContent = `✏️ 修改作業員：${target.username}（${evNameMap.get(targetEvId) || targetEvId}）`;
          $('#btnZ1SubmitOp').textContent = '💾 儲存修改';
          $('#btnZ1SubmitOp').className = 'px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black';
          $('#btnZ1CancelOpEdit').classList.remove('hidden');
          $('#opNewPass').focus();
        };
      });
      $$('[data-del-op]').forEach((b) => {
        b.onclick = async () => {
          const target = scopedUsers.find((x) => x.username === b.dataset.delOp && x.role === 'operator');
          if (!target) return;
          if (!confirm(`確定要刪除晶片作業員「${target.username}（${target.displayName}）」嗎？`)) return;
          App.State.users = App.State.users.filter((x) => x.username !== target.username);
          await C.TurDB.remove('users', target.username);
          await App.enqueueSync('deleteUser', { username: target.username });
          renderZ1Ops(App, ev);
          App.toast(`🗑️ 已刪除作業員 ${target.username}`, 'info');
        };
      });
      $$('[data-goto-z3]').forEach((b) => { b.onclick = () => App.switchView('zone3'); });
    };

    renderRows();
    C.bindFastInput($('#z1OpsSearch'), (e) => { flt.q = e.target.value; renderRows(); }, 100);
    if ($('#z1OpsRoleFilter')) $('#z1OpsRoleFilter').onchange = (e) => { flt.role = e.target.value; renderRows(); };
    $('#z1OpsEventFilter').onchange = (e) => { flt.eventId = e.target.value; renderRows(); };
    $('#z1OpsStationFilter').onchange = (e) => { flt.station = e.target.value; renderRows(); };
    $('#z1OpsStatusFilter').onchange = (e) => { flt.status = e.target.value; renderRows(); };
    $('#btnZ1OpsResetFilter').onclick = () => {
      flt.q = ''; flt.role = 'all'; flt.eventId = isSuper ? 'all' : '__CURRENT__'; flt.station = 'all'; flt.status = 'all';
      $('#z1OpsSearch').value = '';
      if ($('#z1OpsRoleFilter')) $('#z1OpsRoleFilter').value = 'all';
      $('#z1OpsEventFilter').value = flt.eventId;
      $('#z1OpsStationFilter').value = 'all';
      $('#z1OpsStatusFilter').value = 'all';
      renderRows();
    };

    $('#z1NewOpForm').onsubmit = async (e) => {
      e.preventDefault();
      const origUser = $('#opEditOrigUser').value.trim();
      const un = $('#opNewUser').value.trim();
      const pw = $('#opNewPass').value.trim();
      const nm = $('#opNewName').value.trim();
      const st = $('#opNewStation').value;
      if (!un || !pw || !nm) return App.toast('請填寫完整帳號、密碼與顯示名稱', 'error');

      if (origUser) {
        const target = App.State.users.find((x) => x.username === origUser && x.role === 'operator');
        if (!target) return App.toast('找不到要修改的作業員', 'error');
        target.passwordHash = pw;
        target.displayName = nm;
        target.allowedStation = st;
        await C.TurDB.put('users', target);
        await App.enqueueSync('saveUser', { user: target });
        renderZ1Ops(App, ev);
        App.toast(`✅ 已更新作業員「${origUser}」密碼與站點設定`, 'success');
      } else {
        if (App.State.users.some((x) => x.username === un)) return App.toast('此帳號已存在，請更換帳號名稱', 'error');
        const userObj = {
          username: un, passwordHash: pw, displayName: nm,
          role: 'operator', parentOrganizer: ev.ownerUsername || u.username, allowedEventId: ev.eventId,
          allowedStation: st, enabled: 1
        };
        App.State.users.push(userObj);
        await C.TurDB.put('users', userObj);
        await App.enqueueSync('saveUser', { user: userObj });
        renderZ1Ops(App, ev);
        App.toast(`✅ 已新增站點作業員 ${un}（${st}）`, 'success');
      }
    };
  }

  /* --------------------------------------------------------------------------
   * 專區 2：📦 已結案專區（鎖定防誤改、3表Excel、DUV、承辦人動態證書 + 批次ZIP/PDF）
   * -------------------------------------------------------------------------- */
  let z2CustomBgImg = null;

  function renderZone2(App) {
    C.ensureCertFonts();
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
    const certRows = rows.filter((r) => C.isCertEligible(ev, r).ok);
    const excludedCertCount = Math.max(0, rows.length - certRows.length);
    const warriorsCount = certRows.filter((r) => r.isWarrior800).length;

    const toggles = [
      ['showEventName', '活動名稱'], ['showRunnerName', '選手姓名'], ['showBib', '參賽編號 Bib'],
      ['showCategory', '參賽組別'], ['showPrimaryResult', '主要成績'], ['showSecondaryResult', '次要成績'],
      ['showDate', '活動日期'], ['showRaceDirector', '賽事總監姓名'], ['showOverallRank', '總名次 Overall'], ['showCatRank', '分組名次 Cat'],
      ['showPace', '平均配速 Pace'], ['showSplitAnalysis', '感應點區段均速分析'], ['showOfficialStamp', '下方 Logo 與鋼印'],
      ['allowPublicPhotoQuote', '開放前台照片(3框)與40字感言'], ['enableWarrior800', '啟用八百壯士 100K+ 榮譽標註']
    ];

    box.innerHTML = `
      <div class="bg-white p-4 rounded-xl border shadow-sm flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-800 font-black">🔒 已結案</span>
          <select id="z2EventSelect" class="px-3 py-1.5 border rounded-lg font-bold text-sm">
            ${finished.map((e) => `<option value="${e.eventId}" ${e.eventId === ev.eventId ? 'selected' : ''}>${C.isTestSuiteId(e.eventId) ? '🧪 ' : ''}${C.escapeHtml(e.nameZh)}</option>`).join('')}
          </select>
        </div>
        <button id="btnZ2Reopen" class="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold">🔓 解鎖退回</button>
      </div>

      ${buildEventRatioStatsHtml(App, ev, '🏁 結案統計')}

      <!-- 報表與 DUV 送審 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div class="bg-white p-4 rounded-xl border shadow-sm space-y-2">
          <h3 class="font-black text-sm">📊 正式 Excel</h3>
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ2XlsxFull" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold">⬇️ 完整版</button>
            <button id="btnZ2XlsxMask" class="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold">⬇️ 隱碼公開版</button>
          </div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-emerald-200 shadow-sm space-y-2">
          <h3 class="font-black text-sm text-emerald-900">🌍 DUV 送審檔</h3>
          <div class="flex flex-wrap gap-1.5">
            <button id="btnZ2DuvPrev" class="px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-900 font-bold">👁️ 預覽</button>
            <button id="btnZ2DuvTxt" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold">⬇️ .txt</button>
            <button id="btnZ2DuvCsv" class="px-3 py-1.5 rounded-lg bg-teal-600 text-white font-bold">⬇️ .csv</button>
          </div>
        </div>
        <div class="bg-gradient-to-br from-rose-50 to-amber-50 p-4 rounded-xl border border-rose-200 shadow-sm space-y-2">
          <h3 class="font-black text-sm text-rose-900">🏅 八百壯士（${warriorsCount} 位）</h3>
          <button id="btnZ2ExportW800" class="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold">⬇️ 匯出 Excel</button>
        </div>
      </div>

      <div id="z2DuvBox" class="hidden bg-slate-950 text-emerald-300 p-4 rounded-xl space-y-2">
        <div class="flex justify-between text-xs text-white font-bold"><span>DUV 預覽</span><button id="btnZ2DuvClose">✕</button></div>
        <pre id="z2DuvPre" class="mono text-[11px] overflow-x-auto max-h-56"></pre>
      </div>

      <!-- 完賽證書工作室 -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <div>
            <h3 class="font-black text-base">🏆 完賽證書</h3>
            <p class="text-xs text-slate-500">合格 <b class="text-emerald-700">${certRows.length}</b> 人${excludedCertCount ? `（排除未完賽 ${excludedCertCount} 人）` : ''}</p>
          </div>
          <div class="flex flex-wrap gap-2 text-xs">
            <button id="btnZ2SaveCertCfg" class="px-3.5 py-2 rounded-xl bg-slate-900 text-white font-black">💾 儲存設定</button>
            <button id="btnZ2BatchZip" ${certRows.length ? '' : 'disabled'} class="px-3.5 py-2 rounded-xl font-black ${certRows.length ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}">📦 匯出 .zip (${certRows.length})</button>
            <button id="btnZ2BatchPdf" ${certRows.length ? '' : 'disabled'} class="px-3.5 py-2 rounded-xl font-black ${certRows.length ? 'bg-amber-500 text-slate-950' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}">📄 匯出 .pdf (${certRows.length})</button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2.5 text-xs">
          <button type="button" id="btnZ2CertOfficial" class="p-3 rounded-xl border-2 text-left transition ${cfg.certMode !== 'custom_runner' ? 'border-slate-900 bg-slate-900 text-white shadow' : 'border-slate-200 bg-slate-50 text-slate-700'}">
            <div class="font-black text-sm">🏛️ 官方證書</div>
            <div class="text-[11px] opacity-80 mt-0.5">純淨公版（無個人照）</div>
          </button>
          <button type="button" id="btnZ2CertCustom" class="p-3 rounded-xl border-2 text-left transition ${cfg.certMode === 'custom_runner' ? 'border-amber-500 bg-amber-500 text-slate-950 shadow' : 'border-slate-200 bg-slate-50 text-slate-700'}">
            <div class="font-black text-sm">📸 客製化證書</div>
            <div class="text-[11px] opacity-85 mt-0.5">含個人照片與感言</div>
          </button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 text-xs">
          <div class="lg:col-span-5 space-y-3">
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="font-bold block mb-1">方向</label>
                <select id="certOrientSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  <option value="landscape" ${cfg.orientation === 'landscape' ? 'selected' : ''}>A4 橫式</option>
                  <option value="portrait" ${cfg.orientation === 'portrait' ? 'selected' : ''}>A4 直式</option>
                </select>
              </div>
              <div>
                <label class="font-bold block mb-1">字型</label>
                <select id="certFontSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  ${C.CERT_FONTS.map((f) => `<option value="${f.id}" ${cfg.fontId === f.id ? 'selected' : ''}>${f.name}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="font-bold block mb-1">樣式</label>
                <select id="certLayoutSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  ${C.CERT_LAYOUTS.map((l) => `<option value="${l.id}" ${cfg.layoutId === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="font-bold block mb-1">底圖</label>
                <select id="certPaletteSel" class="w-full px-2.5 py-1.5 border rounded-lg">
                  ${C.CERT_PALETTES.map((p) => `<option value="${p.id}" ${cfg.paletteId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                </select>
              </div>
            </div>

            <details id="certCustomBgDetails" ${cfg.customBgDataUrl ? 'open' : ''} class="rounded-xl bg-indigo-50/70 border-2 border-indigo-300">
              <summary class="px-3 py-2.5 cursor-pointer font-black text-indigo-950 flex items-center justify-between">
                <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-indigo-500">▶</span><span>🖼️ 自訂底圖排版</span></span>
                <span class="text-[11px] font-bold ${cfg.customBgDataUrl ? 'text-emerald-700' : 'text-indigo-700'}">${cfg.customBgDataUrl ? '已啟用 ✓' : '選用'}</span>
              </summary>
              <div class="px-3 pb-3 pt-2 space-y-2.5 border-t border-indigo-200/70">
                <div class="flex items-center justify-between gap-2">
                  <input id="certCustomBgFile" type="file" accept="image/*" class="text-[11px] flex-1" />
                  <button type="button" id="btnCertClearBg" class="px-2.5 py-1 rounded-lg bg-white border border-indigo-300 text-indigo-800 font-bold text-[11px] shrink-0">恢復內建</button>
                </div>
                <div class="flex gap-1.5">
                  <input id="certCustomBgUrl" type="url" value="${/^https?:\/\//i.test(cfg.customBgDataUrl || '') ? C.escapeHtml(cfg.customBgDataUrl) : ''}" placeholder="或貼上圖片網址 (https://...)" class="flex-1 px-2 py-1 border rounded-lg bg-white text-[11px]" />
                  <button type="button" id="btnCertApplyBgUrl" class="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold text-[11px] shrink-0">套用</button>
                </div>

                <div id="certCustomElemEditor" class="${cfg.customBgDataUrl ? '' : 'hidden'} p-2.5 rounded-xl bg-white border border-indigo-200 space-y-2.5">
                  <div class="flex items-center justify-between">
                    <span class="font-black text-indigo-950">🎯 選欄位或直接拖曳畫布</span>
                    <button type="button" id="btnCeResetAll" class="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[10px]">↩️ 重設</button>
                  </div>
                  <div id="ceLayerPills" class="grid grid-cols-2 gap-1"></div>

                  <div id="ceActivePanel" class="p-2.5 rounded-lg bg-indigo-50/70 border border-indigo-200 space-y-2">
                    <div class="flex items-center justify-between">
                      <span id="ceActiveTitle" class="font-black text-indigo-950">🏃 選手姓名</span>
                      <label class="inline-flex items-center gap-1 font-bold text-slate-800 cursor-pointer">
                        <input id="ceVisible" type="checkbox" class="accent-indigo-600" /> 顯示此欄位
                      </label>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="font-bold w-12 shrink-0">大小</span>
                      <input id="ceSize" type="range" min="14" max="160" step="1" class="flex-1 accent-indigo-600" />
                      <span id="ceSizeVal" class="mono font-black text-indigo-700 w-12 text-right">98px</span>
                    </div>
                    <div class="grid grid-cols-3 gap-1.5 items-center">
                      <div class="flex items-center gap-1">
                        <span class="font-bold">顏色</span>
                        <input id="ceColor" type="color" value="#ffffff" class="w-7 h-6 border rounded cursor-pointer" />
                      </div>
                      <select id="ceAlign" class="border rounded px-1.5 py-1 bg-white font-semibold">
                        <option value="center">置中對齊</option>
                        <option value="left">靠左對齊</option>
                        <option value="right">靠右對齊</option>
                      </select>
                      <button type="button" id="btnCeCenterX" class="px-2 py-1 rounded bg-white border border-indigo-300 hover:bg-indigo-100 text-indigo-900 font-bold">↔ 水平置中</button>
                    </div>
                    <div class="grid grid-cols-3 gap-1.5 items-center">
                      <label class="flex items-center gap-1"><span class="font-bold">X%</span><input id="ceX" type="number" min="2" max="98" step="1" class="w-14 px-1.5 py-0.5 border rounded bg-white mono" /></label>
                      <label class="flex items-center gap-1"><span class="font-bold">Y%</span><input id="ceY" type="number" min="2" max="98" step="1" class="w-14 px-1.5 py-0.5 border rounded bg-white mono" /></label>
                      <button type="button" id="btnCeApplyColorAll" class="px-1.5 py-1 rounded bg-amber-100 hover:bg-amber-200 text-amber-950 font-bold text-[10px]">🎨 全欄同色</button>
                    </div>
                  </div>
                </div>
              </div>
            </details>

            <div class="p-3 rounded-xl bg-amber-50/70 border border-amber-200 space-y-1">
              <label class="font-black text-amber-950 block">🎖️ 賽事總監姓名（置於證書最下列）</label>
              <input id="certDirectorInput" value="${C.escapeHtml(cfg.raceDirectorName || '')}" placeholder="例如：林政宏" class="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg bg-white font-bold" />
            </div>

            <details class="rounded-xl bg-slate-50 border">
              <summary class="px-3 py-2.5 cursor-pointer font-bold text-slate-800 flex items-center justify-between">
                <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-slate-400">▶</span><span>🎛️ 欄位顯示開關（15 項）</span></span>
                <span class="text-[11px] text-slate-500 font-normal">點開細調</span>
              </summary>
              <div class="px-3 pb-3 pt-1 grid grid-cols-2 gap-1.5 border-t">
                ${toggles.map(([k, lbl]) => `
                  <label class="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" class="cert-toggle" data-ckey="${k}" ${cfg[k] ? 'checked' : ''} />
                    <span>${lbl}</span>
                  </label>`).join('')}
              </div>
            </details>

            <div>
              <label class="font-bold block mb-1">預覽選手切換（僅列完賽有成績 ${certRows.length} 人）</label>
              <select id="certPreviewRunner" class="w-full px-2.5 py-1.5 border rounded-lg" ${certRows.length ? '' : 'disabled'}>
                ${certRows.length
                  ? certRows.map((r, i) => `<option value="${i}">#${r.overallRank} ${r.participant.bibNumber} ${C.escapeHtml(r.participant.name)} (${r.totalDistanceKm}km)</option>`).join('')
                  : '<option value="">尚無完賽有成績之合格選手</option>'}
              </select>
            </div>
          </div>

          <div class="lg:col-span-7 bg-slate-950 p-3 rounded-xl flex items-center justify-center">
            <canvas id="z2CertCanvas" class="max-w-full max-h-[560px] w-auto h-auto rounded-lg shadow-2xl cursor-move"></canvas>
          </div>
        </div>
      </div>`;

    // 確保 10 欄自訂底圖獨立圖層配置已初始化（預設載入原資訊）
    cfg.customBgElements = C.getMergedCustomBgElements(cfg);
    let selectedElemKey = 'runnerName';

    const syncCustomElemEditorUI = () => {
      const edBox = $('#certCustomElemEditor');
      if (!edBox) return;
      edBox.classList.toggle('hidden', !z2CustomBgImg);
      const pillsEl = $('#ceLayerPills');
      if (pillsEl) {
        pillsEl.innerHTML = C.CERT_CUSTOM_ELEMENTS.map((m) => {
          const el = cfg.customBgElements[m.key];
          const act = m.key === selectedElemKey;
          return `<button type="button" data-pick-celem="${m.key}" class="px-2 py-1 rounded-lg border text-left text-[11px] flex items-center justify-between gap-1 transition ${act ? 'bg-indigo-600 border-indigo-700 text-white font-black shadow-sm' : (el.visible ? 'bg-slate-50 border-slate-200 text-slate-800 hover:border-indigo-400 font-bold' : 'bg-slate-100 border-slate-200 text-slate-400 line-through')}">
            <span class="truncate">${m.icon} ${m.label}</span>
            <span class="text-[10px] shrink-0">${el.visible ? '👁️' : '🚫'}</span>
          </button>`;
        }).join('');
        $$('[data-pick-celem]').forEach((b) => {
          b.onclick = () => { selectedElemKey = b.dataset.pickCelem; syncCustomElemEditorUI(); redraw(); };
        });
      }
      const meta = C.CERT_CUSTOM_ELEMENTS.find((m) => m.key === selectedElemKey) || C.CERT_CUSTOM_ELEMENTS[1];
      const cur = cfg.customBgElements[meta.key];
      if (!cur) return;
      $('#ceActiveTitle').textContent = `${meta.icon} ${meta.label}`;
      $('#ceVisible').checked = Boolean(cur.visible);
      $('#ceSize').min = String(meta.minSize);
      $('#ceSize').max = String(meta.maxSize);
      $('#ceSize').value = String(Math.round(cur.size));
      $('#ceSizeVal').textContent = `${Math.round(cur.size)}px`;
      $('#ceColor').value = cur.color || '#ffffff';
      $('#ceAlign').value = cur.align || 'center';
      $('#ceAlign').disabled = Boolean(meta.isLogo);
      $('#ceX').value = String(Math.round(Number(cur.x) * 100));
      $('#ceY').value = String(Math.round(Number(cur.y) * 100));
    };

    const redraw = () => {
      const idx = Number($('#certPreviewRunner')?.value || 0);
      const targetRow = certRows[idx] || certRows[0];
      const cEl = $('#z2CertCanvas');
      if (!targetRow) {
        cEl.width = 1200; cEl.height = 520;
        const g = cEl.getContext('2d');
        g.fillStyle = '#0f172a'; g.fillRect(0, 0, cEl.width, cEl.height);
        g.strokeStyle = '#f59e0b'; g.lineWidth = 4; g.strokeRect(24, 24, cEl.width - 48, cEl.height - 48);
        g.fillStyle = '#fbbf24'; g.textAlign = 'center'; g.font = '900 34px "Noto Sans TC", sans-serif';
        g.fillText('🔒 本活動尚無符合「完賽且有成績」之選手', cEl.width / 2, 235);
        g.fillStyle = '#cbd5e1'; g.font = '500 22px "Noto Sans TC", sans-serif';
        g.fillText('DNF / DNS 或無正式成績之選手已自動排除，不得列印完賽證書。', cEl.width / 2, 295);
        return;
      }
      C.renderCertificateCanvas(cEl, targetRow, cfg, {
        certMode: cfg.certMode || 'official',
        customBgImg: z2CustomBgImg,
        selectedElementKey: z2CustomBgImg ? selectedElemKey : '',
        showPhotoPlaceholder: cfg.certMode === 'custom_runner',
        quote: '突破極限，感謝每一站熱情的志工！'
      });
    };

    const loadCustomBgSrc = (src) => {
      const im = new Image();
      if (/^https?:\/\//i.test(src)) im.crossOrigin = 'anonymous';
      im.onload = () => {
        z2CustomBgImg = im;
        const det = $('#certCustomBgDetails');
        if (det) det.open = true;
        syncCustomElemEditorUI();
        redraw();
      };
      im.onerror = () => App.toast('自訂底圖載入失敗，請檢查圖片格式或網址是否允許跨網域讀取', 'error');
      im.src = src;
    };

    if (cfg.customBgDataUrl && !z2CustomBgImg) {
      loadCustomBgSrc(cfg.customBgDataUrl);
    }
    C.onLogoReady(() => { if ($('#z2CertCanvas')) redraw(); });
    syncCustomElemEditorUI();
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

    const syncModeBtns = () => {
      const isCust = cfg.certMode === 'custom_runner';
      $('#btnZ2CertOfficial').className = `p-3 rounded-xl border-2 text-left transition ${!isCust ? 'border-slate-900 bg-slate-900 text-white shadow' : 'border-slate-200 bg-slate-50 text-slate-700'}`;
      $('#btnZ2CertCustom').className = `p-3 rounded-xl border-2 text-left transition ${isCust ? 'border-amber-500 bg-amber-500 text-slate-950 shadow' : 'border-slate-200 bg-slate-50 text-slate-700'}`;
      redraw();
    };
    $('#btnZ2CertOfficial').onclick = () => { cfg.certMode = 'official'; syncModeBtns(); };
    $('#btnZ2CertCustom').onclick = () => { cfg.certMode = 'custom_runner'; syncModeBtns(); };
    $('#certOrientSel').onchange = (e) => { cfg.orientation = e.target.value; redraw(); };
    $('#certFontSel').onchange = (e) => { cfg.fontId = e.target.value; redraw(); };
    $('#certLayoutSel').onchange = (e) => { cfg.layoutId = e.target.value; redraw(); };
    $('#certPaletteSel').onchange = (e) => { cfg.paletteId = e.target.value; redraw(); };
    C.bindFastInput($('#certDirectorInput'), (e) => { cfg.raceDirectorName = e.target.value; redraw(); }, 150);
    $('#certPreviewRunner').onchange = redraw;
    $$('.cert-toggle').forEach((cb) => { cb.onchange = () => { cfg[cb.dataset.ckey] = cb.checked; redraw(); }; });
    $('#ceVisible').onchange = (e) => {
      cfg.customBgElements[selectedElemKey].visible = e.target.checked;
      syncCustomElemEditorUI();
      redraw();
    };
    $('#ceSize').oninput = (e) => {
      const v = Number(e.target.value);
      cfg.customBgElements[selectedElemKey].size = v;
      $('#ceSizeVal').textContent = `${Math.round(v)}px`;
      redraw();
    };
    $('#ceColor').oninput = (e) => {
      cfg.customBgElements[selectedElemKey].color = e.target.value;
      redraw();
    };
    $('#ceAlign').onchange = (e) => {
      cfg.customBgElements[selectedElemKey].align = e.target.value;
      redraw();
    };
    $('#ceX').oninput = (e) => {
      cfg.customBgElements[selectedElemKey].x = Math.max(0.02, Math.min(0.98, Number(e.target.value || 50) / 100));
      redraw();
    };
    $('#ceY').oninput = (e) => {
      cfg.customBgElements[selectedElemKey].y = Math.max(0.02, Math.min(0.98, Number(e.target.value || 50) / 100));
      redraw();
    };
    $('#btnCeCenterX').onclick = () => {
      cfg.customBgElements[selectedElemKey].x = 0.5;
      syncCustomElemEditorUI();
      redraw();
    };
    $('#btnCeApplyColorAll').onclick = () => {
      const clr = cfg.customBgElements[selectedElemKey].color || '#ffffff';
      C.CERT_CUSTOM_ELEMENTS.forEach((m) => { if (!m.isLogo) cfg.customBgElements[m.key].color = clr; });
      redraw();
      App.toast(`🎨 已將全部文字欄位套用顏色 ${clr}`, 'info');
    };
    $('#btnCeResetAll').onclick = () => {
      cfg.customBgElements = C.defaultCustomBgElements(cfg.orientation);
      syncCustomElemEditorUI();
      redraw();
      App.toast('↩️ 已恢復 10 欄預設排版與字級', 'info');
    };
    $('#btnCertClearBg').onclick = () => {
      cfg.customBgDataUrl = '';
      z2CustomBgImg = null;
      $('#certCustomBgFile').value = '';
      if ($('#certCustomBgUrl')) $('#certCustomBgUrl').value = '';
      syncCustomElemEditorUI();
      redraw();
    };
    $('#btnCertApplyBgUrl').onclick = () => {
      const url = ($('#certCustomBgUrl')?.value || '').trim();
      if (!/^https?:\/\/.+/i.test(url)) return App.toast('請輸入 http:// 或 https:// 開頭之底圖網址', 'warn');
      cfg.customBgDataUrl = url;
      loadCustomBgSrc(url);
      App.toast('🖼️ 已載入外部自訂底圖，可直接點選畫布欄位拖曳！', 'success');
    };
    $('#certCustomBgFile').onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        const compressed = await C.compressCustomBgImage(r.result, 1280, 42000);
        cfg.customBgDataUrl = compressed;
        loadCustomBgSrc(compressed);
        App.toast(`🖼️ 已載入自訂底圖並自動壓縮最佳化（${Math.round(compressed.length / 1024)} KB），可點選畫布各欄位拖曳微調！`, 'success');
      };
      r.readAsDataURL(f);
    };

    // 自訂底圖畫布直接點選任一欄位＋獨立拖曳（含水平中線 50% 磁吸）
    const cv = $('#z2CertCanvas');
    let dragElemKey = '';
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    cv.onpointerdown = (e) => {
      if (!z2CustomBgImg) return;
      const rect = cv.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (cv.width / rect.width);
      const py = (e.clientY - rect.top) * (cv.height / rect.height);
      const boxes = cv._customHitBoxes || [];
      let hit = null;
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          hit = b;
          break;
        }
      }
      if (hit) {
        selectedElemKey = hit.key;
        dragElemKey = hit.key;
        const cur = cfg.customBgElements[hit.key];
        grabOffsetX = (px / cv.width) - Number(cur.x);
        grabOffsetY = (py / cv.height) - Number(cur.y);
        cv.setPointerCapture?.(e.pointerId);
        syncCustomElemEditorUI();
        redraw();
      }
    };
    cv.onpointerup = () => { dragElemKey = ''; };
    cv.onpointercancel = () => { dragElemKey = ''; };
    cv.onpointermove = (e) => {
      if (!dragElemKey || !z2CustomBgImg) return;
      const rect = cv.getBoundingClientRect();
      let nx = (e.clientX - rect.left) / rect.width - grabOffsetX;
      let ny = (e.clientY - rect.top) / rect.height - grabOffsetY;
      nx = Math.max(0.02, Math.min(0.98, nx));
      ny = Math.max(0.02, Math.min(0.98, ny));
      if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
      cfg.customBgElements[dragElemKey].x = Number(nx.toFixed(4));
      cfg.customBgElements[dragElemKey].y = Number(ny.toFixed(4));
      if ($('#ceX')) $('#ceX').value = String(Math.round(nx * 100));
      if ($('#ceY')) $('#ceY').value = String(Math.round(ny * 100));
      redraw();
    };

    $('#btnZ2SaveCertCfg').onclick = async () => {
      ev.certConfigJson = JSON.stringify(cfg);
      await C.TurDB.put('events', ev);
      await App.enqueueSync('saveEvent', { event: ev });
      App.toast('✅ 證書設定（模式 / 6樣式 / 6底圖 / 6字型 / 自訂底圖套印）已儲存並同步前台！', 'success');
    };

    $('#btnZ2BatchZip').onclick = async () => {
      if (!certRows.length) return App.toast('🔒 本活動無符合「已結案完賽有成績」之選手，無法批次匯出證書', 'warning');
      if (!global.JSZip) { App.toast('⏳ 正在載入壓縮套件...', 'info'); await C.ensureExternalLib('jszip'); }
      if (!global.JSZip) return App.toast('JSZip 未載入', 'error');
      const zip = new global.JSZip();
      const tmp = document.createElement('canvas');
      for (const r of certRows) {
        C.renderCertificateCanvas(tmp, r, cfg, { certMode: 'official', customBgImg: z2CustomBgImg });
        const b64 = tmp.toDataURL('image/png').split(',')[1];
        zip.file(`${r.participant.bibNumber}_${r.participant.name}.png`, b64, { base64: true });
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${ev.nameZh}_官方完賽證書.zip`, blob);
      App.toast(`📦 離線批次匯出完成！共 ${certRows.length} 張完賽證書 (.zip)`, 'success');
    };

    $('#btnZ2BatchPdf').onclick = async () => {
      if (!certRows.length) return App.toast('🔒 本活動無符合「已結案完賽有成績」之選手，無法匯出證書 PDF', 'warning');
      if (!global.jspdf?.jsPDF) { App.toast('⏳ 正在載入 PDF 套件...', 'info'); await C.ensureExternalLib('jspdf'); }
      if (!global.jspdf?.jsPDF) return App.toast('jsPDF 未載入', 'error');
      const orient = cfg.orientation === 'portrait' ? 'portrait' : 'landscape';
      const pdf = new global.jspdf.jsPDF({ orientation: orient, unit: 'mm', format: 'a4' });
      const tmp = document.createElement('canvas');
      const pw = orient === 'portrait' ? 210 : 297;
      const ph = orient === 'portrait' ? 297 : 210;
      certRows.forEach((r, i) => {
        if (i > 0) pdf.addPage();
        C.renderCertificateCanvas(tmp, r, cfg, { certMode: 'official', customBgImg: z2CustomBgImg });
        pdf.addImage(tmp.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph);
      });
      pdf.save(`${ev.nameZh}_全組完賽證書.pdf`);
      App.toast(`📄 已匯出多頁合併版完賽 PDF（${certRows.length} 頁）`, 'success');
    };
  }

  /* --------------------------------------------------------------------------
   * 專區 3：👥 最高管理員與承辦人帳號管制專區 (Super Admin ONLY)
   * -------------------------------------------------------------------------- */
  function renderZone3(App) {
    const box = $('#view-zone3');
    const curUser = App.State.currentUser;
    if (curUser?.role !== 'super_admin') {
      box.innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：僅限最高管理員存取。</div>';
      return;
    }

    const tab = ['super_admin', 'organizer', 'operator'].includes(App.State.z3Tab) ? App.State.z3Tab : 'organizer';
    App.State.z3Tab = tab;

    const superList = App.State.users.filter((x) => x.role === 'super_admin');
    const orgList = App.State.users.filter((x) => x.role === 'organizer');
    const opList = App.State.users.filter((x) => x.role === 'operator');
    const evNameMap = new Map(App.State.events.map((e) => [e.eventId, e.nameZh]));
    const stNameByEvCode = new Map();
    App.State.stations.forEach((s) => {
      stNameByEvCode.set(`${s.eventId}::${String(s.stationCode || '').toUpperCase()}`, s.name || s.stationCode);
    });
    const getStLabel = (evId, code) => {
      const c = String(code || 'ALL').toUpperCase();
      if (c === 'WRITER') return 'WRITER（發卡寫入站）';
      if (c === 'ALL') return 'ALL';
      const nm = stNameByEvCode.get(`${evId}::${c}`);
      return nm ? `${c}（${nm}）` : c;
    };

    const flt = App.State.z3Filter || { q: '', eventId: 'all', station: 'all', status: 'all' };
    App.State.z3Filter = flt;

    const tabMeta = {
      super_admin: { label: '🛡️ 最高權責管理員', addTitle: '➕ 新增最高權責管理員', list: superList, activeCls: 'bg-rose-600 text-white shadow' },
      organizer: { label: '👤 活動承辦人', addTitle: '➕ 新增活動承辦人', list: orgList, activeCls: 'bg-amber-500 text-slate-950 shadow' },
      operator: { label: '👷 全平台作業員', addTitle: '➕ 新增晶片作業員', list: opList, activeCls: 'bg-sky-600 text-white shadow' }
    };
    const activeList = tabMeta[tab].list;
    const allOpStations = [...new Set(opList.map((x) => x.allowedStation || 'ALL'))].sort();

    const buildOpStationOpts = (evId, selCode = '') => {
      const targetSts = App.State.stations
        .filter((s) => s.eventId === evId)
        .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
      const opts = [
        `<option value="WRITER" ${selCode === 'WRITER' ? 'selected' : ''}>WRITER（發卡寫入站）</option>`,
        ...targetSts.map((s) => `<option value="${C.escapeHtml(s.stationCode)}" ${selCode === s.stationCode ? 'selected' : ''}>${C.escapeHtml(s.stationCode)}（${C.escapeHtml(s.name)}）</option>`)
      ];
      if (!targetSts.length) {
        ['CHECKIN', 'CP1', 'CP2', 'FINISH', 'LAP'].forEach((c) => {
          opts.push(`<option value="${c}" ${selCode === c ? 'selected' : ''}>${c}</option>`);
        });
      }
      if (selCode && selCode !== 'WRITER' && !targetSts.some((s) => s.stationCode === selCode)) {
        opts.push(`<option value="${C.escapeHtml(selCode)}" selected>${C.escapeHtml(selCode)}</option>`);
      }
      return opts.join('');
    };

    const firstEvId = App.State.events[0]?.eventId || 'ALL';

    box.innerHTML = `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-4 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <div class="flex items-center gap-2">
            <h2 class="font-black text-base">👥 帳號與權責管制專區</h2>
            <span id="z3UsersCount" class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold mono">${activeList.length} 筆</span>
          </div>
          <span class="text-[11px] font-bold text-rose-700">🛡️ 最高管理員專用：管理最高權責、承辦人及全平台帳密</span>
        </div>

        <!-- 三大角色管制頁籤 -->
        <div class="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-100">
          ${['super_admin', 'organizer', 'operator'].map((k) => `
            <button type="button" data-z3-tab="${k}" class="py-2 px-3 rounded-lg font-black transition flex items-center justify-center gap-1.5 ${tab === k ? tabMeta[k].activeCls : 'text-slate-600 hover:bg-white'}">
              <span>${tabMeta[k].label}</span>
              <span class="px-1.5 py-0.5 rounded-full text-[10px] mono ${tab === k ? 'bg-black/15' : 'bg-slate-200 text-slate-700'}">${tabMeta[k].list.length}</span>
            </button>
          `).join('')}
        </div>

        <!-- 新增 / 修訂表單 -->
        <form id="z3NewUserForm" autocomplete="off" class="p-3 rounded-xl bg-slate-50 border space-y-2">
          <div class="flex items-center justify-between">
            <div id="z3FormTitle" class="font-black text-slate-900">${tabMeta[tab].addTitle}</div>
            <button type="button" id="btnZ3CancelEdit" class="hidden px-2 py-0.5 rounded bg-white border text-slate-600 font-bold">✕ 取消修改</button>
          </div>
          <input type="hidden" id="z3EditOrigUser" value="" />
          ${tab === 'operator' ? `
            <div class="grid grid-cols-2 sm:grid-cols-6 gap-2">
              <input id="z3User" required placeholder="帳號" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
              <input id="z3Pass" required type="text" autocomplete="off" placeholder="密碼" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
              <input id="z3Name" required placeholder="名稱" class="px-2.5 py-1.5 border rounded-lg bg-white" />
              <select id="z3Event" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
                ${App.State.events.map((e) => `<option value="${e.eventId}">${C.escapeHtml(e.nameZh)} (${C.escapeHtml(e.ownerUsername || '-')})</option>`).join('')}
                <option value="ALL">ALL（全平台）</option>
              </select>
              <select id="z3Station" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
                ${buildOpStationOpts(firstEvId)}
              </select>
              <button type="submit" id="btnZ3Submit" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-black">+ 新增作業員</button>
            </div>
          ` : `
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <input id="z3User" required placeholder="帳號" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
              <input id="z3Pass" required type="text" autocomplete="off" placeholder="密碼" class="px-2.5 py-1.5 border rounded-lg bg-white mono" />
              <input id="z3Name" required placeholder="姓名 / 單位名稱" class="px-2.5 py-1.5 border rounded-lg bg-white" />
              <select id="z3Role" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
                <option value="super_admin" ${tab === 'super_admin' ? 'selected' : ''}>🛡️ 最高管理員</option>
                <option value="organizer" ${tab === 'organizer' ? 'selected' : ''}>👤 活動承辦人</option>
              </select>
              <button type="submit" id="btnZ3Submit" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-black">+ 新增帳號</button>
            </div>
          `}
        </form>

        <!-- 篩選列 -->
        <div class="flex flex-wrap items-center gap-2 bg-slate-50/70 p-2.5 rounded-xl border">
          <input id="z3Search" type="text" value="${C.escapeHtml(flt.q)}" placeholder="🔎 搜尋帳號 / 密碼 / 名稱${tab === 'operator' ? ' / 承辦人 / 場次 / 站點' : ''}" class="flex-1 min-w-[200px] px-2.5 py-1.5 border rounded-lg bg-white" />
          ${tab === 'operator' ? `
            <select id="z3EventFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold max-w-[210px]">
              <option value="all" ${flt.eventId === 'all' ? 'selected' : ''}>全部場次</option>
              ${App.State.events.map((e) => `<option value="${e.eventId}" ${flt.eventId === e.eventId ? 'selected' : ''}>${C.escapeHtml(e.nameZh)}</option>`).join('')}
            </select>
            <select id="z3StationFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
              <option value="all" ${flt.station === 'all' ? 'selected' : ''}>全部站點</option>
              ${allOpStations.map((st) => `<option value="${C.escapeHtml(st)}" ${flt.station === st ? 'selected' : ''}>${C.escapeHtml(st)}</option>`).join('')}
            </select>
          ` : ''}
          <select id="z3StatusFilter" class="px-2.5 py-1.5 border rounded-lg bg-white font-bold">
            <option value="all" ${flt.status === 'all' ? 'selected' : ''}>全部狀態</option>
            <option value="1" ${flt.status === '1' ? 'selected' : ''}>啟用中</option>
            <option value="0" ${flt.status === '0' ? 'selected' : ''}>已停用</option>
          </select>
          <button type="button" id="btnZ3ResetFilter" class="px-2.5 py-1.5 rounded-lg bg-white border hover:bg-slate-100 font-bold text-slate-600">↺ 重設</button>
        </div>

        <!-- 清冊表格 -->
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-100">
              ${tab === 'operator' ? `
                <tr>
                  <th class="p-2">帳號</th>
                  <th class="p-2">密碼</th>
                  <th class="p-2">名稱</th>
                  <th class="p-2">承辦人</th>
                  <th class="p-2">鎖定場次</th>
                  <th class="p-2">鎖定站點</th>
                  <th class="p-2">狀態</th>
                  <th class="p-2">操作</th>
                </tr>
              ` : `
                <tr>
                  <th class="p-2">帳號</th>
                  <th class="p-2">密碼</th>
                  <th class="p-2">姓名 / 單位</th>
                  <th class="p-2">名下承辦活動</th>
                  <th class="p-2">狀態</th>
                  <th class="p-2">操作</th>
                </tr>
              `}
            </thead>
            <tbody id="z3UsersTbody" class="divide-y"></tbody>
          </table>
        </div>
      </div>`;

    $$('[data-z3-tab]').forEach((b) => {
      b.onclick = () => {
        App.State.z3Tab = b.dataset.z3Tab;
        renderZone3(App);
      };
    });

    if ($('#z3Event')) {
      $('#z3Event').onchange = () => {
        if ($('#z3Station')) $('#z3Station').innerHTML = buildOpStationOpts($('#z3Event').value);
      };
    }

    const resetForm = () => {
      $('#z3EditOrigUser').value = '';
      $('#z3User').value = '';
      $('#z3User').disabled = false;
      $('#z3Pass').value = '';
      $('#z3Name').value = '';
      if ($('#z3Role')) { $('#z3Role').value = tab; $('#z3Role').disabled = false; }
      if ($('#z3Event')) {
        $('#z3Event').value = firstEvId;
        if ($('#z3Station')) $('#z3Station').innerHTML = buildOpStationOpts(firstEvId);
      }
      $('#z3FormTitle').textContent = tabMeta[tab].addTitle;
      $('#btnZ3Submit').textContent = tab === 'operator' ? '+ 新增作業員' : '+ 新增帳號';
      $('#btnZ3Submit').className = 'px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-black';
      $('#btnZ3CancelEdit').classList.add('hidden');
    };
    $('#btnZ3CancelEdit').onclick = resetForm;

    const renderZ3Rows = () => {
      const q = String(flt.q || '').trim().toUpperCase();
      const filtered = activeList.filter((u) => {
        if (tab === 'operator') {
          if (flt.eventId !== 'all' && String(u.allowedEventId || 'ALL') !== flt.eventId) return false;
          if (flt.station !== 'all' && String(u.allowedStation || 'ALL') !== flt.station) return false;
        }
        if (flt.status !== 'all' && String(Number(u.enabled) ? 1 : 0) !== flt.status) return false;
        if (!q) return true;
        const evNm = evNameMap.get(u.allowedEventId) || '';
        const stLbl = getStLabel(u.allowedEventId, u.allowedStation);
        return `${u.username} ${u.passwordHash || ''} ${u.displayName || ''} ${u.parentOrganizer || ''} ${u.allowedEventId || ''} ${evNm} ${u.allowedStation || ''} ${stLbl}`.toUpperCase().includes(q);
      });

      const cntEl = $('#z3UsersCount');
      if (cntEl) cntEl.textContent = `${filtered.length} / ${activeList.length} 筆`;

      if (tab === 'operator') {
        $('#z3UsersTbody').innerHTML = filtered.map((u) => {
          const evId = u.allowedEventId || 'ALL';
          const evLabel = evId === 'ALL' ? 'ALL' : (evNameMap.get(evId) || evId);
          return `
            <tr class="hover:bg-slate-50">
              <td class="p-2 mono font-bold whitespace-nowrap">${C.escapeHtml(u.username)}</td>
              <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-950 mono font-bold select-all">${C.escapeHtml(u.passwordHash || '-')}</span></td>
              <td class="p-2 whitespace-nowrap">${C.escapeHtml(u.displayName)}</td>
              <td class="p-2 mono whitespace-nowrap">${C.escapeHtml(u.parentOrganizer || '-')}</td>
              <td class="p-2">
                <div class="font-semibold text-slate-800">${C.escapeHtml(evLabel)}</div>
                ${evId !== 'ALL' ? `<div class="text-[10px] mono text-slate-400">${C.escapeHtml(evId)}</div>` : ''}
              </td>
              <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-bold">${C.escapeHtml(getStLabel(evId, u.allowedStation))}</span></td>
              <td class="p-2 whitespace-nowrap"><button data-z3-toggle="${C.escapeHtml(u.username)}" class="px-2 py-0.5 rounded font-bold ${Number(u.enabled) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'}">${Number(u.enabled) ? '啟用中' : '已停用'}</button></td>
              <td class="p-2 whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <button type="button" data-z3-edit="${C.escapeHtml(u.username)}" class="px-2 py-0.5 rounded bg-sky-50 border border-sky-300 text-sky-900 hover:bg-sky-100 font-bold">✏️ 修改</button>
                  <button type="button" data-z3-del="${C.escapeHtml(u.username)}" class="px-2 py-0.5 rounded bg-rose-50 text-rose-600 hover:bg-rose-100 font-bold">刪</button>
                </div>
              </td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" class="p-6 text-center text-slate-400">查無符合條件之作業員</td></tr>';
      } else {
        $('#z3UsersTbody').innerHTML = filtered.map((u) => {
          const isSelf = u.username === curUser.username;
          const ownEvs = App.State.events.filter((e) => e.ownerUsername === u.username);
          const evSummary = ownEvs.length
            ? `${ownEvs.length} 場（${ownEvs.slice(0, 2).map((e) => e.nameZh).join('、')}${ownEvs.length > 2 ? '…' : ''}）`
            : '0 場';
          return `
            <tr class="hover:bg-slate-50 ${isSelf ? 'bg-amber-50/40' : ''}">
              <td class="p-2 mono font-bold whitespace-nowrap">
                ${C.escapeHtml(u.username)}
                ${isSelf ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-950 text-[10px]">本人</span>' : ''}
              </td>
              <td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-950 mono font-bold select-all">${C.escapeHtml(u.passwordHash || '-')}</span></td>
              <td class="p-2 whitespace-nowrap font-semibold">${C.escapeHtml(u.displayName)}</td>
              <td class="p-2 text-slate-600">${C.escapeHtml(evSummary)}</td>
              <td class="p-2 whitespace-nowrap">
                <button data-z3-toggle="${C.escapeHtml(u.username)}" ${isSelf ? 'disabled' : ''} class="px-2 py-0.5 rounded font-bold ${Number(u.enabled) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'} ${isSelf ? 'opacity-50 cursor-not-allowed' : ''}">${Number(u.enabled) ? '啟用中' : '已停用'}</button>
              </td>
              <td class="p-2 whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <button type="button" data-z3-edit="${C.escapeHtml(u.username)}" class="px-2 py-0.5 rounded bg-sky-50 border border-sky-300 text-sky-900 hover:bg-sky-100 font-bold">✏️ 修改</button>
                  ${isSelf ? '' : `<button type="button" data-z3-del="${C.escapeHtml(u.username)}" class="px-2 py-0.5 rounded bg-rose-50 text-rose-600 hover:bg-rose-100 font-bold">刪</button>`}
                </div>
              </td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="p-6 text-center text-slate-400">查無符合條件之帳號</td></tr>';
      }

      $$('[data-z3-toggle]').forEach((b) => {
        b.onclick = async () => {
          const target = App.State.users.find((x) => x.username === b.dataset.z3Toggle);
          if (!target || target.username === curUser.username) return;
          const enabledSupers = App.State.users.filter((x) => x.role === 'super_admin' && Number(x.enabled)).length;
          if (target.role === 'super_admin' && Number(target.enabled) && enabledSupers <= 1) {
            return App.toast('🔒 系統至少須保留 1 位啟用中之最高管理員！', 'error');
          }
          target.enabled = Number(target.enabled) ? 0 : 1;
          await C.TurDB.put('users', target);
          await App.enqueueSync('saveUser', { user: target });
          renderZ3Rows();
        };
      });

      $$('[data-z3-edit]').forEach((b) => {
        b.onclick = () => {
          const target = App.State.users.find((x) => x.username === b.dataset.z3Edit);
          if (!target) return;
          const isSelf = target.username === curUser.username;
          $('#z3EditOrigUser').value = target.username;
          $('#z3User').value = target.username;
          $('#z3User').disabled = true;
          $('#z3Pass').value = target.passwordHash || '';
          $('#z3Name').value = target.displayName || '';
          if ($('#z3Role')) {
            $('#z3Role').value = target.role;
            $('#z3Role').disabled = isSelf;
          }
          if ($('#z3Event')) {
            $('#z3Event').value = target.allowedEventId || 'ALL';
            if ($('#z3Station')) $('#z3Station').innerHTML = buildOpStationOpts($('#z3Event').value, target.allowedStation);
          }
          $('#z3FormTitle').textContent = `✏️ 修訂帳號：${target.username}`;
          $('#btnZ3Submit').textContent = '💾 儲存修訂';
          $('#btnZ3Submit').className = 'px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black';
          $('#btnZ3CancelEdit').classList.remove('hidden');
          $('#z3Pass').focus();
        };
      });

      $$('[data-z3-del]').forEach((b) => {
        b.onclick = async () => {
          const target = App.State.users.find((x) => x.username === b.dataset.z3Del);
          if (!target || target.username === curUser.username) return;
          const enabledSupers = App.State.users.filter((x) => x.role === 'super_admin' && Number(x.enabled)).length;
          if (target.role === 'super_admin' && Number(target.enabled) && enabledSupers <= 1) {
            return App.toast('🔒 系統至少須保留 1 位啟用中之最高管理員，禁止刪除！', 'error');
          }
          const ownEvCnt = App.State.events.filter((e) => e.ownerUsername === target.username).length;
          const warnTxt = ownEvCnt > 0 ? `\n⚠️ 此帳號名下仍有 ${ownEvCnt} 場活動，建議先至「1. 設定」移轉承辦人或改用停用。` : '';
          if (!confirm(`確定永久刪除帳號「${target.username}（${target.displayName}）」嗎？${warnTxt}`)) return;
          App.State.users = App.State.users.filter((x) => x.username !== target.username);
          await C.TurDB.remove('users', target.username);
          await App.enqueueSync('deleteUser', { username: target.username });
          renderZone3(App);
          App.toast(`🗑️ 已刪除帳號 ${target.username}`, 'info');
        };
      });
    };

    renderZ3Rows();
    C.bindFastInput($('#z3Search'), (e) => { flt.q = e.target.value; renderZ3Rows(); }, 100);
    if ($('#z3EventFilter')) $('#z3EventFilter').onchange = (e) => { flt.eventId = e.target.value; renderZ3Rows(); };
    if ($('#z3StationFilter')) $('#z3StationFilter').onchange = (e) => { flt.station = e.target.value; renderZ3Rows(); };
    $('#z3StatusFilter').onchange = (e) => { flt.status = e.target.value; renderZ3Rows(); };
    $('#btnZ3ResetFilter').onclick = () => {
      flt.q = ''; flt.eventId = 'all'; flt.station = 'all'; flt.status = 'all';
      $('#z3Search').value = '';
      if ($('#z3EventFilter')) $('#z3EventFilter').value = 'all';
      if ($('#z3StationFilter')) $('#z3StationFilter').value = 'all';
      $('#z3StatusFilter').value = 'all';
      renderZ3Rows();
    };

    $('#z3NewUserForm').onsubmit = async (e) => {
      e.preventDefault();
      const origUser = $('#z3EditOrigUser').value.trim();
      const un = $('#z3User').value.trim();
      const pw = $('#z3Pass').value.trim();
      const nm = $('#z3Name').value.trim();
      if (!un || !pw || !nm) return App.toast('請填寫完整帳號、密碼與名稱', 'error');

      if (origUser) {
        const target = App.State.users.find((x) => x.username === origUser);
        if (!target) return App.toast('找不到要修改的帳號', 'error');
        const nextRole = tab === 'operator' ? 'operator' : ($('#z3Role')?.value || target.role);
        if (target.role === 'super_admin' && nextRole !== 'super_admin') {
          const enabledSupers = App.State.users.filter((x) => x.role === 'super_admin' && Number(x.enabled)).length;
          if (enabledSupers <= 1) return App.toast('🔒 系統至少須保留 1 位最高管理員！', 'error');
        }
        target.passwordHash = pw;
        target.displayName = nm;
        target.role = nextRole;
        if (tab === 'operator') {
          const evId = $('#z3Event')?.value || 'ALL';
          const evObj = App.State.events.find((x) => x.eventId === evId);
          target.allowedEventId = evId;
          target.parentOrganizer = evObj ? (evObj.ownerUsername || '') : '';
          target.allowedStation = $('#z3Station')?.value || 'WRITER';
        } else {
          target.allowedEventId = 'ALL';
          target.allowedStation = 'ALL';
          target.parentOrganizer = '';
        }
        await C.TurDB.put('users', target);
        await App.enqueueSync('saveUser', { user: target });
        App.State.z3Tab = target.role;
        renderZone3(App);
        App.toast(`✅ 已修訂帳號「${origUser}」`, 'success');
      } else {
        if (App.State.users.some((x) => x.username === un)) return App.toast('此帳號已存在', 'error');
        let obj;
        if (tab === 'operator') {
          const evId = $('#z3Event')?.value || 'ALL';
          const evObj = App.State.events.find((x) => x.eventId === evId);
          obj = {
            username: un, passwordHash: pw, displayName: nm,
            role: 'operator', parentOrganizer: evObj ? (evObj.ownerUsername || '') : '',
            allowedEventId: evId, allowedStation: $('#z3Station')?.value || 'WRITER', enabled: 1
          };
        } else {
          const roleVal = $('#z3Role')?.value || tab;
          obj = {
            username: un, passwordHash: pw, displayName: nm,
            role: roleVal, parentOrganizer: '', allowedEventId: 'ALL',
            allowedStation: 'ALL', enabled: 1
          };
        }
        App.State.users.push(obj);
        await C.TurDB.put('users', obj);
        await App.enqueueSync('saveUser', { user: obj });
        App.State.z3Tab = obj.role;
        renderZone3(App);
        App.toast(`✅ 已新增帳號 ${un}`, 'success');
      }
    };
  }

  /* --------------------------------------------------------------------------
   * 專區 4：📚 歷屆完賽成績匯入與手動標示八百壯士（7 欄標準順序 + 金框預覽選組/選員標示）
   * -------------------------------------------------------------------------- */
  let pendingHistoryPreview = [];

  function renderZone4(App) {
    const box = $('#view-zone4');
    if (App.State.currentUser?.role !== 'super_admin') {
      box.innerHTML = '<div class="bg-rose-50 text-rose-700 p-6 rounded-xl font-bold text-center">⛔ 權限不足：專區 4 僅限最高管理員存取。</div>';
      return;
    }
    const warriors = App.State.historyResults.filter((h) => h.isWarrior800);
    const prevW800Cnt = pendingHistoryPreview.filter((r) => r.isWarrior800).length;
    const prevGroupMap = new Map();
    pendingHistoryPreview.forEach((r) => {
      const g = r.categoryName || '未分組';
      if (!prevGroupMap.has(g)) prevGroupMap.set(g, { total: 0, marked: 0 });
      const info = prevGroupMap.get(g);
      info.total++;
      if (r.isWarrior800) info.marked++;
    });

    box.innerHTML = `
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <h2 class="font-black text-base">📚 歷屆成績匯入</h2>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" id="btnHisDlXlsx" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold">📥 Excel 範本</button>
            <button type="button" id="btnHisDlCsv" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 border font-bold text-slate-800">📄 CSV 範本</button>
          </div>
        </div>

        <details class="rounded-xl border border-amber-300 overflow-hidden">
          <summary class="px-3 py-2 bg-slate-900 text-white font-bold cursor-pointer flex items-center justify-between">
            <span class="flex items-center gap-1.5"><span class="acc-arrow inline-block text-amber-300">▶</span><span>📋 欄位格式說明（7 欄）</span></span>
            <span class="text-[11px] text-amber-300">展開查看</span>
          </summary>
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] text-left bg-white">
              <thead class="bg-amber-50 border-b">
                <tr>
                  <th class="p-1.5 text-center w-12">序</th>
                  <th class="p-1.5">欄位</th>
                  <th class="p-1.5 w-16">必填</th>
                  <th class="p-1.5">範例</th>
                  <th class="p-1.5">說明</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                ${(C.HISTORY_IMPORT_SPEC || []).map((s) => `
                  <tr>
                    <td class="p-1.5 text-center mono font-black text-amber-700">${s.order}</td>
                    <td class="p-1.5 font-bold">${C.escapeHtml(s.label)}</td>
                    <td class="p-1.5">${s.required ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 font-bold">必填*</span>' : '<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">選填</span>'}</td>
                    <td class="p-1.5 mono text-slate-800">${C.escapeHtml(s.example)}</td>
                    <td class="p-1.5 text-slate-600">${C.escapeHtml(s.desc)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label class="font-bold text-[11px] text-slate-600">日期</label>
            <input id="hisEventDate" value="2025-11-15" placeholder="YYYY-MM-DD" class="w-full px-2.5 py-1.5 border rounded-lg mono mt-0.5" />
          </div>
          <div class="sm:col-span-2">
            <label class="font-bold text-[11px] text-slate-600">賽事名稱</label>
            <input id="hisEventName" value="2025 TUR 冬季八百壯士 100K 邀請賽" placeholder="賽事名稱" class="w-full px-2.5 py-1.5 border rounded-lg mt-0.5" />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input id="hisFileInput" type="file" accept=".xlsx,.xls,.csv,.txt" class="text-[11px]" />
          <button type="button" id="btnHisSample" class="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border border-indigo-200">✨ 載入範例</button>
        </div>
        <textarea id="hisRawInput" rows="3" placeholder="組別,號碼布,姓,名,身分證,成績,距離km" class="w-full p-2.5 border rounded-lg mono bg-slate-50"></textarea>
        <button type="button" id="btnHisAnalyze" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black">🔍 1. 解析預覽</button>

        <div id="hisGoldenBox" class="${pendingHistoryPreview.length ? '' : 'hidden'} p-4 rounded-2xl border-4 border-amber-400 bg-amber-50/70 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="font-black text-amber-950 text-sm">🛡️ 2. 預覽與標示八百壯士（${pendingHistoryPreview.length} 筆）</div>
              <div class="text-[11px] text-amber-900 mt-0.5">已標示：<b class="text-rose-700 mono">${prevW800Cnt} / ${pendingHistoryPreview.length}</b> 人</div>
            </div>
            <button type="button" id="btnHisConfirmCommit" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black shadow">✅ 3. 確認匯入</button>
          </div>

          <!-- 依組別快速批次標示工具列 -->
          <div class="p-2.5 rounded-xl bg-white border border-amber-300 space-y-1.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-black text-slate-800">🏷️ 依組別快速標示 / 取消八百壯士：</span>
              <div class="flex gap-1.5">
                <button type="button" id="btnHisW800All" class="px-2 py-0.5 rounded bg-rose-600 text-white font-bold text-[11px]">全選八百壯士</button>
                <button type="button" id="btnHisW800None" class="px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-bold text-[11px]">全部取消</button>
              </div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              ${[...prevGroupMap.entries()].map(([grpName, info]) => {
                const allOn = info.marked === info.total && info.total > 0;
                return `<button type="button" data-his-grp-w800="${C.escapeHtml(grpName)}" class="px-2.5 py-1 rounded-lg font-bold text-[11px] border ${allOn ? 'bg-rose-600 border-rose-700 text-white' : (info.marked > 0 ? 'bg-amber-200 border-amber-400 text-amber-950' : 'bg-slate-50 border-slate-300 text-slate-700 hover:bg-amber-50')}">
                  ${allOn ? '🏅 ' : '☆ '}${C.escapeHtml(grpName)}（${info.marked}/${info.total}）
                </button>`;
              }).join('')}
            </div>
          </div>

          <div class="overflow-x-auto max-h-64">
            <table class="w-full text-left bg-white rounded-lg overflow-hidden">
              <thead class="bg-amber-200/70">
                <tr>
                  <th class="p-2">八百壯士</th>
                  <th class="p-2">合併姓名</th>
                  <th class="p-2">組別 / 號碼布</th>
                  <th class="p-2">成績</th>
                  <th class="p-2">距離</th>
                  <th class="p-2">完賽狀態</th>
                  <th class="p-2">SHA-256 歸併碼</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                ${pendingHistoryPreview.map((r, idx) => `
                  <tr class="${r.isWarrior800 ? 'bg-amber-50/70' : ''}">
                    <td class="p-2 whitespace-nowrap">
                      <label class="inline-flex items-center gap-1.5 cursor-pointer font-bold">
                        <input type="checkbox" data-his-prev-w800="${idx}" ${r.isWarrior800 ? 'checked' : ''} class="accent-rose-600" />
                        ${r.isWarrior800 ? '<span class="px-1.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px]">🏅 八百壯士</span>' : '<span class="text-slate-400 text-[10px]">一般</span>'}
                      </label>
                    </td>
                    <td class="p-2 font-bold">${C.escapeHtml(r.name)}</td>
                    <td class="p-2">${C.escapeHtml(r.categoryName)} / <span class="mono">${C.escapeHtml(r.bibNumber)}</span></td>
                    <td class="p-2 mono">${C.escapeHtml(r.finishTime)}</td>
                    <td class="p-2 mono font-bold">${r.distanceKm} km</td>
                    <td class="p-2"><span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">✅ 已完賽</span></td>
                    <td class="p-2 mono text-[10px] text-slate-500">${String(r.idCardHash).slice(0, 14)}...</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 八百壯士英雄榜 + 歷屆資料庫總覽（支援事後補改標示） -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-2 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-black text-sm text-rose-900">🏅 歷屆資料庫總覽（已標示八百壯士 ${warriors.length} 筆 / 全歷屆已完賽 ${App.State.historyResults.length} 筆）</h3>
          <span class="text-[11px] text-slate-500">點擊右側標註鈕可直接切換已存檔紀錄之八百壯士資格並同步雲端</span>
        </div>
        <div class="overflow-x-auto max-h-80">
          <table class="w-full text-left">
            <thead class="bg-slate-900 text-white sticky top-0">
              <tr><th class="p-2">日期</th><th class="p-2">賽事名稱</th><th class="p-2">姓名</th><th class="p-2">組別</th><th class="p-2">距離</th><th class="p-2">成績</th><th class="p-2">狀態</th><th class="p-2">八百壯士標註</th></tr>
            </thead>
            <tbody class="divide-y">
              ${App.State.historyResults.map((h) => `
                <tr class="${h.isWarrior800 ? 'bg-amber-50/60' : ''}">
                  <td class="p-2 mono whitespace-nowrap">${C.escapeHtml(h.eventDate)}</td>
                  <td class="p-2 font-semibold">${C.escapeHtml(h.eventName)}</td>
                  <td class="p-2 font-black whitespace-nowrap">${C.escapeHtml(h.name)}</td>
                  <td class="p-2 whitespace-nowrap">${C.escapeHtml(h.categoryName)}</td>
                  <td class="p-2 mono font-bold whitespace-nowrap">${h.distanceKm} km</td>
                  <td class="p-2 mono whitespace-nowrap">${C.escapeHtml(h.finishTime)}</td>
                  <td class="p-2 whitespace-nowrap"><span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">已完賽</span></td>
                  <td class="p-2 whitespace-nowrap">
                    <button type="button" data-his-saved-w800="${C.escapeHtml(h.historyId)}" class="px-2 py-0.5 rounded-full font-bold text-[11px] border ${h.isWarrior800 ? 'bg-rose-600 border-rose-700 text-white' : 'bg-white border-slate-300 text-slate-500 hover:bg-amber-50'}">${h.isWarrior800 ? '🏅 八百壯士 ✓' : '☆ 標示壯士'}</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    const buildHisSampleRows = () => [
      ['組別名稱', '參賽號碼布', '姓', '名', '身分證', '完賽成績', '完賽距離km'],
      ['100K八百壯士組', 'W001', '諸葛', '亮', 'A123456789', '09:48:12', '100'],
      ['100K八百壯士組', 'W002', 'Smith', 'John', 'US88776655', '10:32:05', '100'],
      ['50K挑戰組', 'B023', '上官', '婉兒', 'F223456786', '05:12:40', '50']
    ];

    $('#btnHisDlXlsx').onclick = async () => {
      const rows = buildHisSampleRows();
      await C.ensureExternalLib('xlsx');
      if (global.XLSX) {
        const wb = global.XLSX.utils.book_new();
        global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(rows), '歷屆完賽成績範本');
        global.XLSX.writeFile(wb, 'TUR_歷屆完賽成績匯入範本.xlsx');
        App.toast('📥 已下載歷屆成績 Excel 範本 (.xlsx)', 'success');
      } else {
        $('#btnHisDlCsv').click();
      }
    };
    $('#btnHisDlCsv').onclick = () => {
      const rows = buildHisSampleRows();
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      downloadText('TUR_歷屆完賽成績匯入範本.csv', csv, 'text/csv;charset=utf-8');
      App.toast('📄 已下載歷屆成績 CSV 範本 (.csv)', 'success');
    };

    $('#hisFileInput').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const dateMatch = f.name.match(/(20\d{2}[-_]?\d{2}[-_]?\d{2})/);
      if (dateMatch) $('#hisEventDate').value = dateMatch[1].replace(/_/g, '-');
      $('#hisEventName').value = f.name.replace(/\.(xlsx|xls|csv|txt)$/i, '');
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        await C.ensureExternalLib('xlsx');
        if (global.XLSX) {
          const buf = await f.arrayBuffer();
          const wb = global.XLSX.read(buf, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const mat = global.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          $('#hisRawInput').value = mat.map((r) => r.join(',')).join('\n');
          return App.toast(`已載入 Excel 檔案（${mat.length} 列），請按「步驟 1」產生預覽`, 'info');
        }
      }
      $('#hisRawInput').value = await f.text();
    };

    $('#btnHisSample').onclick = () => {
      $('#hisRawInput').value = buildHisSampleRows().map((r) => r.join(',')).join('\n');
    };

    $('#btnHisAnalyze').onclick = async () => {
      const raw = $('#hisRawInput').value.trim();
      if (!raw) return App.toast('請先貼上或上傳歷屆成績檔案', 'warn');
      const evDate = $('#hisEventDate').value.trim() || C.formatDateTime().slice(0, 10);
      const evName = $('#hisEventName').value.trim() || '歷屆賽事';
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(/,|\t/).map((s) => s.trim());
        if (i === 0 && /組別|姓名|號碼布|bib|name/i.test(lines[i])) continue;
        const cat = cols[0] || '超馬組';
        const bib = cols[1] || `H${out.length + 1}`;
        const mergedName = C.mergeNameParts(cols[2], cols[3]);
        const idCard = cols[4] || `${mergedName}-${bib}`;
        const finishTime = (cols[5] || '00:00:00').split('.')[0];
        const dist = Number(cols[6] || 0);
        const hash = await C.sha256Hex(idCard);
        out.push({
          historyId: `HIS-${Date.now()}-${out.length}`,
          eventDate: evDate, eventName: evName, categoryName: cat, bibNumber: bib,
          name: mergedName, idCardHash: hash, finishTime, distanceKm: dist,
          lapCount: 0, overallRank: out.length + 1, catRank: 1, status: 'FINISHED',
          isWarrior800: false, remark: '歷屆完賽匯入'
        });
      }
      pendingHistoryPreview = out;
      renderZone4(App);
      App.toast(`已解析 ${out.length} 筆已完賽明細！請於金框手動選取組別或跑者標示八百壯士後再存檔`, 'info');
    };

    if ($('#btnHisW800All')) {
      $('#btnHisW800All').onclick = () => {
        pendingHistoryPreview.forEach((r) => { r.isWarrior800 = true; });
        renderZone4(App);
      };
    }
    if ($('#btnHisW800None')) {
      $('#btnHisW800None').onclick = () => {
        pendingHistoryPreview.forEach((r) => { r.isWarrior800 = false; });
        renderZone4(App);
      };
    }
    $$('[data-his-grp-w800]').forEach((b) => {
      b.onclick = () => {
        const grp = b.dataset.hisGrpW800;
        const targets = pendingHistoryPreview.filter((r) => (r.categoryName || '未分組') === grp);
        const allOn = targets.length > 0 && targets.every((r) => r.isWarrior800);
        targets.forEach((r) => { r.isWarrior800 = !allOn; });
        renderZone4(App);
      };
    });
    $$('[data-his-prev-w800]').forEach((cb) => {
      cb.onchange = () => {
        const idx = Number(cb.dataset.hisPrevW800);
        if (pendingHistoryPreview[idx]) {
          pendingHistoryPreview[idx].isWarrior800 = cb.checked;
          renderZone4(App);
        }
      };
    });

    if ($('#btnHisConfirmCommit')) {
      $('#btnHisConfirmCommit').onclick = async () => {
        if (!pendingHistoryPreview.length) return;
        const rowsToSave = pendingHistoryPreview.map((r) => ({ ...r, status: 'FINISHED', isWarrior800: Boolean(r.isWarrior800) }));
        for (const r of rowsToSave) {
          App.State.historyResults.push(r);
          await C.TurDB.put('historyResults', r);
        }
        await App.enqueueSync('batchImportHistory', { rows: rowsToSave });
        const cnt = rowsToSave.length;
        const wCnt = rowsToSave.filter((r) => r.isWarrior800).length;
        pendingHistoryPreview = [];
        renderZone4(App);
        App.toast(`✅ 已存檔匯入 ${cnt} 筆歷屆已完賽成績（含手動標示八百壯士 ${wCnt} 人）並同步雲端！`, 'success');
      };
    }

    $$('[data-his-saved-w800]').forEach((b) => {
      b.onclick = async () => {
        const h = App.State.historyResults.find((x) => x.historyId === b.dataset.hisSavedW800);
        if (!h) return;
        h.isWarrior800 = !Boolean(h.isWarrior800);
        await C.TurDB.put('historyResults', h);
        await App.enqueueSync('saveHistory', { history: h });
        renderZone4(App);
        App.toast(h.isWarrior800 ? `🏅 已標示「${h.name}」為八百壯士` : `已取消「${h.name}」的八百壯士標示`, 'info');
      };
    });
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
      Categories: { arr: App.State.categories, store: 'categories', cols: ['catId', 'eventId', 'name', 'distanceKm', 'timeLimitHours', 'fee', 'earlyBirdFee', 'bibPrefix', 'quota', 'isWarrior800'] },
      Stations: { arr: App.State.stations, store: 'stations', cols: ['stationId', 'eventId', 'stationCode', 'name', 'distanceKm', 'stationType'] },
      Participants: { arr: App.State.participants, store: 'participants', cols: ['participantId', 'eventId', 'bibNumber', 'name', 'nationality', 'payMethod', 'payStatus', 'totalAmount', 'chipUid'] },
      Users: { arr: App.State.users, store: 'users', cols: ['username', 'displayName', 'role', 'parentOrganizer', 'allowedStation', 'enabled'] }
    };
    const activeTbl = storeMap[directSheetName] || storeMap.GlobalConfig;

    box.innerHTML = `
      <!-- 資料庫與同步 -->
      <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
        <h2 class="font-black text-base">🗄️ 同步與資料庫</h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mono">
          <div class="p-2.5 rounded-xl bg-slate-50 border">活動：<b>${App.State.events.length}</b></div>
          <div class="p-2.5 rounded-xl bg-slate-50 border">選手：<b>${App.State.participants.length}</b></div>
          <div class="p-2.5 rounded-xl bg-slate-50 border">計時：<b>${App.State.timingLogs.length}</b></div>
          <div class="p-2.5 rounded-xl bg-amber-50 border border-amber-200">待上傳：<b>${App.State.syncQueue.length}</b></div>
        </div>
        <div class="flex flex-wrap gap-2 items-end pt-1">
          <div class="flex-1 min-w-[260px]">
            <label class="font-bold block mb-1">GAS 網址 (/exec)</label>
            <input id="z5GasUrl" value="${C.escapeHtml(App.State.gasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full px-3 py-2 border rounded-lg mono" />
          </div>
          <button id="btnZ5TestGas" class="px-3.5 py-2 rounded-lg bg-sky-600 text-white font-bold">測試連線</button>
          <button id="btnZ5Pull" class="px-3.5 py-2 rounded-lg bg-slate-900 text-white font-bold">🔄 拉取</button>
          <button id="btnZ5Push" class="px-3.5 py-2 rounded-lg bg-emerald-600 text-white font-bold">☁️ 上傳 (${App.State.syncQueue.length})</button>
        </div>
      </div>

      ${isSuper ? `
        <div class="bg-white p-4 rounded-2xl border-2 border-indigo-400 shadow-sm space-y-3 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
            <h3 class="font-black text-base">🛡️ 試算表直通編輯</h3>
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
            <button id="btnZ5DirectBatchSave" class="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black shadow">💾 儲存並同步</button>
          </div>
        </div>

        ${(() => {
          const ts = C.countTestSuiteStats(App.State);
          const realEvCnt = App.State.events.length - ts.events;
          const realPartCnt = App.State.participants.length - ts.participants;
          return `
          <div class="bg-emerald-50/70 p-4 rounded-2xl border-2 border-emerald-400 shadow-sm space-y-3 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-200 pb-2">
              <h3 class="font-black text-base text-emerald-950">🧪 測試資料（與正式資料隔離）</h3>
              <div class="text-right mono text-[11px]">
                <span class="text-emerald-900 font-black">測試：${ts.events} 場 / ${ts.participants} 人</span> ｜ <span class="text-slate-600">正式：${realEvCnt} 場 / ${realPartCnt} 人</span>
              </div>
            </div>
            <div class="flex flex-wrap gap-2 items-center">
              <button id="btnZ5LoadTestSuite10" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black shadow">🧪 載入測試資料</button>
              <button id="btnZ5ClearTestSuite10" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black shadow">🧹 清除測試資料</button>
            </div>
          </div>`;
        })()}

        <div class="bg-white p-4 rounded-2xl border shadow-sm space-y-3 text-xs">
          <h3 class="font-black text-sm">💾 備份與還原</h3>
          <div class="flex flex-wrap gap-2 items-center">
            <button id="btnZ5DownloadJson" class="px-3.5 py-2 rounded-lg bg-slate-900 text-white font-bold">⬇️ 備份 JSON</button>
            <label class="px-3.5 py-2 rounded-lg bg-emerald-100 text-emerald-900 font-bold cursor-pointer">
              ➕ 合併還原<input id="z5RestoreMerge" type="file" accept=".json" class="hidden" />
            </label>
            <label class="px-3.5 py-2 rounded-lg bg-amber-100 text-amber-900 font-bold cursor-pointer">
              ♻️ 覆蓋還原<input id="z5RestoreOverwrite" type="file" accept=".json" class="hidden" />
            </label>
            <button id="btnZ5Seed5" class="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold">⚡ 重建示範資料</button>
            <button id="btnZ5ClearAll" class="px-3.5 py-2 rounded-lg bg-rose-600 text-white font-bold">🗑️ 清空資料</button>
          </div>
        </div>
      ` : ``}`;

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
        const numCols = new Set(['distanceKm', 'timeLimitHours', 'fee', 'earlyBirdFee', 'quota', 'maxQuota', 'totalAmount', 'enabled']);
        const boolCols = new Set(['isWarrior800']);
        $$('[data-grid-r]').forEach((inp) => {
          const r = Number(inp.dataset.gridR);
          const col = inp.dataset.gridC;
          if (!activeTbl.arr[r]) return;
          let v = inp.value;
          if (numCols.has(col)) v = Number(v || 0);
          else if (boolCols.has(col)) v = String(v).trim().toLowerCase() === 'true' || v === '1';
          activeTbl.arr[r][col] = v;
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

      $('#btnZ5LoadTestSuite10').onclick = async () => {
        const hasCloud = Boolean(App.State.gasUrl && navigator.onLine);
        if (!confirm(`確定載入／重建「10 大全情境測試資料（TEST-S01 ～ TEST-S10）」？\n\n✅ 本操作採「獨立隔離合併寫入」，100% 保留您現有的所有正式活動、選手與帳號！\n${hasCloud ? '☁️ 已連線 GAS：將同步以 Upsert 寫入 Google 試算表。' : '💻 本機模式：將寫入本機 IndexedDB。'}`)) return;

        const { suite, merged } = C.mergeTestSuiteIntoState(App.State);
        const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users'];
        for (const k of stores) {
          App.State[k] = merged[k];
          await C.TurDB.clearAndFill(k, merged[k]);
        }

        let cloudMsg = '';
        if (hasCloud) {
          App.toast('☁️ 正在以安全 Upsert 模式同步 10 大情境測試資料至雲端試算表...', 'info');
          const pairs = [
            ['Events', suite.events], ['Categories', suite.categories], ['Stations', suite.stations],
            ['Participants', suite.participants], ['TimingLogs', suite.timingLogs],
            ['HistoryResults', suite.historyResults], ['Users', suite.users]
          ];
          let okCnt = 0;
          for (const [sn, rows] of pairs) {
            try {
              const r = await C.gasPost(App.State.gasUrl, { action: 'adminBatchUpdateSheet', sheetName: sn, rows, mode: 'upsert' });
              if (r && r.ok) okCnt++;
            } catch (_) {}
          }
          cloudMsg = `（☁️ 雲端同步 ${okCnt}/${pairs.length} 表）`;
        }
        App.rebuildIndices();
        App.renderAll();
        App.toast(`🧪 已載入 10 大情境測試資料（${suite.events.length} 場 / ${suite.participants.length} 筆報名 / ${suite.timingLogs.length} 筆感應），正式資料完整保留！${cloudMsg}`, 'success');
      };

      $('#btnZ5ClearTestSuite10').onclick = async () => {
        const ts = C.countTestSuiteStats(App.State);
        if (ts.total === 0) return App.toast('目前系統內已無任何 TEST-* 測試資料', 'info');
        const hasCloud = Boolean(App.State.gasUrl && navigator.onLine);
        if (!confirm(`確定「單獨一鍵清除」全部測試資料嗎？\n\n即將清除（僅限 TEST-* 與 test_*）：\n• 測試活動：${ts.events} 場\n• 測試組別／站點：${ts.categories} 組 / ${ts.stations} 站\n• 測試報名填表資料：${ts.participants} 筆（含您於測試場內新增之測試單）\n• 測試計時紀錄：${ts.timingLogs} 筆\n• 測試歷屆紀錄：${ts.historyResults} 筆\n• 測試帳號：${ts.users} 個\n\n🛡️ 所有正式活動、正式選手、正式帳號與系統設定 100% 保留不受影響！`)) return;

        const { cleaned, totalRemoved } = C.stripTestSuiteFromState(App.State);
        const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users'];
        for (const k of stores) {
          App.State[k] = cleaned[k];
          await C.TurDB.clearAndFill(k, cleaned[k]);
        }
        // 同步清除佇列中屬於測試場的待傳項目，保留正式資料待傳項目
        App.State.syncQueue = App.State.syncQueue.filter((q) => {
          const p = q.payload || {};
          const evId = p.eventId || p.event?.eventId || p.category?.eventId || p.station?.eventId || p.log?.eventId || (Array.isArray(p.runners) ? p.runners[0]?.eventId : '');
          const pid = p.participantId || '';
          const un = p.user?.username || '';
          return !C.isTestSuiteId(evId) && !C.isTestSuiteId(pid) && !/^test_/i.test(String(un));
        });
        await C.TurDB.clearAndFill('syncQueue', App.State.syncQueue);

        let cloudMsg = '';
        if (hasCloud) {
          try {
            const res = await C.gasPost(App.State.gasUrl, { action: 'clearTestSuiteData' });
            if (res && res.ok) cloudMsg = `（☁️ 雲端試算表同步清除 ${res.totalDeleted} 列測試資料！）`;
          } catch (err) {
            await App.enqueueSync('clearTestSuiteData', {});
            cloudMsg = `（雲端清除已排入佇列）`;
          }
        }
        App.State.z1EventId = App.State.events.find((e) => e.status !== 'finished')?.eventId || '';
        App.State.z2EventId = App.State.events.find((e) => e.status === 'finished')?.eventId || '';
        App.rebuildIndices();
        App.renderAll();
        App.toast(`🧹 已安全清除 ${totalRemoved} 筆測試資料，正式資料 100% 完整保留！${cloudMsg}`, 'success');
      };

      $('#btnZ5Seed5').onclick = async () => {
        const hasCloud = Boolean(App.State.gasUrl && navigator.onLine);
        const tip = hasCloud
          ? '確定清空「本機與雲端 Google 試算表」原來建的所有活動資料，並重建 6 場全情境示範資料（64 位選手／70+ 筆計時紀錄／18 筆 2022–2025 歷年成績）？\n\n註：您的帳號密碼 (Users) 與系統參數 (GlobalConfig) 會保留不變！'
          : '確定清空原來建的所有活動資料，並重建 6 場全情境示範資料（64 位選手／70+ 筆計時紀錄／18 筆 2022–2025 歷年成績）？';
        if (!confirm(tip)) return;

        const seed = C.buildFull5EventsSeed();
        const eventStores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults'];
        for (const k of eventStores) {
          App.State[k] = seed[k];
          await C.TurDB.clearAndFill(k, seed[k]);
        }
        App.State.syncQueue = [];
        await C.TurDB.clear('syncQueue');
        if (!App.State.users.length) { App.State.users = seed.users; await C.TurDB.clearAndFill('users', seed.users); }
        if (!App.State.globalConfig.length) { App.State.globalConfig = seed.globalConfig; await C.TurDB.clearAndFill('globalConfig', seed.globalConfig); }

        let cloudMsg = '';
        if (hasCloud) {
          App.toast('☁️ 正在清空雲端試算表舊活動並寫入 6 場全情境示範資料...', 'info');
          const sheetPairs = [
            ['Events', seed.events],
            ['Categories', seed.categories],
            ['Stations', seed.stations],
            ['Participants', seed.participants],
            ['TimingLogs', seed.timingLogs],
            ['HistoryResults', seed.historyResults]
          ];
          let okCnt = 0;
          for (const [sn, rows] of sheetPairs) {
            try {
              const r = await C.gasPost(App.State.gasUrl, { action: 'adminBatchUpdateSheet', sheetName: sn, rows, mode: 'replace' });
              if (r && r.ok) okCnt++;
            } catch (_) {}
          }
          cloudMsg = okCnt === sheetPairs.length ? '（☁️ 雲端 Google 試算表 6 張表已同步清空重建！）' : `（雲端同步完成 ${okCnt}/${sheetPairs.length} 表）`;
        }

        App.State.z1EventId = seed.events[0]?.eventId || '';
        App.State.z2EventId = seed.events.find((e) => e.status === 'finished')?.eventId || '';
        App.rebuildIndices();
        App.renderAll();
        App.toast(`⚡ 已清空舊活動並重建 6 場全情境示範資料（${seed.participants.length} 位選手 / ${seed.timingLogs.length} 筆感應 / ${seed.historyResults.length} 筆歷年）${cloudMsg}`, 'success');
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

  global.TurZones = { renderZone1, renderZone1Tab, renderZone2, renderZone3, renderZone4, renderZone5 };
})(window);
