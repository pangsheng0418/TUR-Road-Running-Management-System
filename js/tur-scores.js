/**
 * ============================================================================
 * 跑管家｜二、成績查詢模組 (js/tur-scores.js)
 * （一）即時賽事：分組進度 / 站點通過 / 成績排名（組別區分＋列尾證書）
 * （二）歷年成績：依年度 / 依個人 / 依場次查詢（列尾證書）
 * （三）八百壯士：當年度綜合成績（選年度） / 英雄榜（年度＋姓名）
 * （四）完賽證書：官方證書 / 客製化照片感言證書（PNG / PDF 下載）
 * ============================================================================
 */
(function (global) {
  'use strict';

  const C = global.TurCore;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const S = {
    activeEventId: '',
    liveSub: 'groups', // 'groups' | 'stations' | 'ranking'
    liveStationFilter: 'all',
    liveCatFilter: 'all',
    liveStageFilter: 'all',
    liveSearch: '',
    hisMode: 'year', // 'year' | 'runner' | 'event'
    hisYear: 'all',
    hisRunner: 'all',
    hisEvent: 'all',
    hisBadge: 'all',
    hisSearch: '',
    warMode: 'year', // 'year' | 'hall'
    warYear: '',
    warHallYear: 'all',
    warSearch: '',
    // Certificate state
    certSearch: '',
    selectedRow: null,
    selectedIsExternalCert: false,
    photoImg: null,
    customBgImg: null,
    photoFrame: 'rounded',
    photoZoom: 1,
    photoOffsetX: 0,
    photoOffsetY: 0,
    quote: '突破極限，感謝每一站熱情的志工！',
    certMode: 'official',
    overrideOrient: '',
    overrideLayout: '',
    overridePalette: '',
    overrideFont: '',
    dragging: false,
    dx0: 0,
    dy0: 0
  };

  function getPublicData(App) {
    const st = App.State;
    return {
      events: st.events || [],
      categories: st.categories || [],
      stations: (st.stations || []).filter((x) => String(x.stationCode).toUpperCase() !== 'CHECKIN'),
      allStations: st.stations || [],
      participants: (st.participants || []).map((p) => ({
        participantId: p.participantId, eventId: p.eventId, catId: p.catId, bibNumber: p.bibNumber || '',
        groupName: p.groupName || '', name: p.name, gender: p.gender || '', nationality: p.nationality || 'TWN',
        payStatus: p.payStatus || 'UNPAID',
        checkinStatus: String(p.checkinStatus || '').toLowerCase() === 'checked_in' ? 'checked_in' : 'pending',
        raceStatus: p.raceStatus || 'dns', penaltySeconds: Number(p.penaltySeconds || 0)
      })),
      timingLogs: (st.timingLogs || []).filter((l) => String(l.stationCode).toUpperCase() !== 'CHECKIN'),
      allTimingLogs: st.timingLogs || [],
      historyResults: st.historyResults || []
    };
  }

  function getLiveEligibleEvents(data) {
    return (data.events || []).filter((e) => {
      if (!C.isEventBibConfirmed(e)) return false;
      return (data.participants || []).some((p) =>
        p.eventId === e.eventId &&
        String(p.payStatus || '').toUpperCase() === 'PAID' &&
        Boolean(String(p.bibNumber || '').trim())
      );
    });
  }

  function ensureActiveEvent(data, onlyLiveEligible = false) {
    const pool = onlyLiveEligible ? getLiveEligibleEvents(data) : (data.events || []);
    if (S.activeEventId && pool.some((e) => e.eventId === S.activeEventId)) {
      return pool.find((e) => e.eventId === S.activeEventId);
    }
    const liveEv = pool.find((e) => e.status !== 'finished' && e.raceStart);
    const finEv = pool.find((e) => e.status === 'finished');
    const chosen = liveEv || finEv || pool[0] || null;
    S.activeEventId = chosen ? chosen.eventId : '';
    return chosen;
  }

  function loadCertConfigForEvent(ev) {
    if (!ev) return;
    const cfg = C.parseJsonSafe(ev.certConfigJson, C.defaultCertConfig());
    S.certMode = cfg.certMode || 'official';
    S.overrideOrient = cfg.orientation || 'landscape';
    S.overrideLayout = cfg.layoutId;
    S.overridePalette = cfg.paletteId;
    S.overrideFont = cfg.fontId || 'sans-modern';
    S.customBgImg = null;
    if (cfg.customBgDataUrl) {
      const im = new Image();
      if (/^https?:\/\//i.test(cfg.customBgDataUrl)) im.crossOrigin = 'anonymous';
      im.onload = () => { S.customBgImg = im; drawCertNow(ev); };
      im.src = cfg.customBgDataUrl;
    }
  }

  function openCertFromRecord(App, certRow) {
    if (!certRow) return;
    const chk = C.isCertEligible(certRow.event, certRow);
    if (!chk.ok) {
      App.toast(`🔒 無法列印證書：${chk.reason}`, 'warn');
      return;
    }
    S.selectedRow = certRow;
    S.selectedIsExternalCert = true;
    App.State.scoreSubTab = 'cert';
    App.renderAll();
  }

  function renderScoresView(App) {
    const box = $('#view-scores');
    if (!box) return;
    const data = getPublicData(App);
    const tab = ['live', 'history', 'warriors', 'cert'].includes(App.State.scoreSubTab) ? App.State.scoreSubTab : 'live';
    App.State.scoreSubTab = tab;

    const unifiedHistory = C.buildUnifiedHistoryRecords({
      events: data.events, categories: data.categories, stations: data.stations,
      participants: data.participants, timingLogs: data.timingLogs, historyResults: data.historyResults
    });

    if (tab === 'live') renderLiveTab(App, box, data);
    else if (tab === 'history') renderHistoryTab(App, box, unifiedHistory);
    else if (tab === 'warriors') renderWarriorsTab(App, box, unifiedHistory);
    else if (tab === 'cert') renderCertTab(App, box, data);
  }

  /* --------------------------------------------------------------------------
   * （一）即時賽事：僅列出完成繳費＋最終配號確認之活動與正式出賽選手
   * -------------------------------------------------------------------------- */
  function renderLiveTab(App, box, data) {
    const liveEvents = getLiveEligibleEvents(data);
    const ev = ensureActiveEvent(data, true);
    if (!ev || !liveEvents.length) {
      box.innerHTML = `
        <div class="bg-slate-900 text-slate-200 p-10 rounded-2xl border border-slate-800 text-center space-y-2">
          <div class="text-3xl">🏁</div>
          <div class="text-base font-black text-white">目前尚無已完成繳費與最終配號確認的即時賽事</div>
          <div class="text-xs text-slate-400">賽事須由主辦單位於「核帳／名單」完成「✅ 確認完成最終配號」後，才會公開顯示於即時賽事名單。</div>
        </div>`;
      return;
    }

    // 嚴格僅納入「已繳費 PAID ＋ 已配號 bibNumber」之正式參賽選手（完全隱藏未繳費／已取消／未配號）
    const officialParts = data.participants.filter((p) =>
      p.eventId === ev.eventId &&
      String(p.payStatus || '').toUpperCase() === 'PAID' &&
      Boolean(String(p.bibNumber || '').trim())
    );
    const scopedData = { ...data, participants: officialParts };

    const rows = C.computeLeaderboard({
      event: ev, categories: data.categories, stations: data.stations,
      participants: officialParts, timingLogs: data.timingLogs
    });
    const A = C.computeEventProgressAnalytics({
      event: ev, categories: data.categories, stations: data.stations,
      participants: officialParts, timingLogs: data.timingLogs
    });
    const evCats = data.categories.filter((c) => c.eventId === ev.eventId);
    const evSts = data.allStations.filter((s) => s.eventId === ev.eventId).sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const sum = A.summary;

    const statusBadge = ev.status === 'finished'
      ? '<span class="px-2.5 py-0.5 rounded-full bg-slate-700 text-slate-200 font-black text-[11px]">📦 已結案</span>'
      : '<span class="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-black text-[11px]">✅ 已配號定案・進行中</span>';

    box.innerHTML = `
      <div class="bg-slate-950 text-slate-100 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg border border-slate-800">
        <!-- 活動明細選擇列（僅列已完成繳費與最終配號確認之活動） -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div class="space-y-1 flex-1 min-w-[240px]">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-bold text-amber-400">📊 即時賽事（僅列已繳費配號定案活動）</span>
              ${statusBadge}
              <span class="px-2 py-0.5 rounded bg-slate-800 text-sky-300 text-[11px] font-bold">${ev.raceType === 'lap_timed' ? `🔁 繞圈賽 (${ev.lapDistanceKm || 1}km/圈)` : '🏃 距離賽'}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <select id="scLiveEventSelect" class="bg-slate-950 border border-slate-700 text-amber-300 rounded-xl px-3 py-2 text-xs sm:text-sm font-black max-w-full">
                ${liveEvents.map((e) => {
                  const cnt = data.participants.filter((p) => p.eventId === e.eventId && String(p.payStatus || '').toUpperCase() === 'PAID' && Boolean(String(p.bibNumber || '').trim())).length;
                  const tag = e.status === 'finished' ? '已結案' : '已配號進行中';
                  return `<option value="${e.eventId}" ${e.eventId === ev.eventId ? 'selected' : ''}>[${tag}] ${C.escapeHtml(e.nameZh)} (${cnt}人)</option>`;
                }).join('')}
              </select>
              <span class="text-[11px] text-slate-400 mono">起跑：${C.escapeHtml(ev.raceStart || '尚未鳴槍')} ｜ 📍 ${C.escapeHtml(ev.location || '-')}</span>
            </div>
          </div>
          <div class="flex gap-2.5 text-right mono text-xs">
            <div class="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
              <div class="text-[10px] text-slate-400">正式參賽 / 報到</div>
              <div class="text-base font-black text-white">${sum.paid} / <span class="text-indigo-300">${sum.checkedIn}</span></div>
            </div>
            <div class="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
              <div class="text-[10px] text-slate-400">進行中 / 已完賽</div>
              <div class="text-base font-black text-sky-300">${sum.onTrack} / <span class="text-emerald-400">${sum.finished}</span></div>
            </div>
            <div class="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800">
              <div class="text-[10px] text-slate-400">完賽率</div>
              <div class="text-base font-black text-amber-400">${sum.finishRate}%</div>
            </div>
          </div>
        </div>

        <!-- 三大視角切換：分組進度 / 站點通過 / 成績排名 -->
        <div class="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-900 border border-slate-800 text-xs sm:text-sm">
          <button type="button" data-sc-livesub="groups" class="py-2 px-3 rounded-lg font-black transition ${S.liveSub === 'groups' ? 'bg-amber-400 text-slate-950 shadow' : 'text-slate-300 hover:bg-slate-800'}">📊 分組進度</button>
          <button type="button" data-sc-livesub="stations" class="py-2 px-3 rounded-lg font-black transition ${S.liveSub === 'stations' ? 'bg-amber-400 text-slate-950 shadow' : 'text-slate-300 hover:bg-slate-800'}">📍 站點通過</button>
          <button type="button" data-sc-livesub="ranking" class="py-2 px-3 rounded-lg font-black transition ${S.liveSub === 'ranking' ? 'bg-amber-400 text-slate-950 shadow' : 'text-slate-300 hover:bg-slate-800'}">🏆 成績排名（依組別）</button>
        </div>

        <div id="scLiveSubBody" class="space-y-4"></div>
      </div>`;

    $('#scLiveEventSelect').onchange = (e) => {
      S.activeEventId = e.target.value;
      S.liveCatFilter = 'all';
      S.liveStationFilter = 'all';
      S.liveStageFilter = 'all';
      S.selectedRow = null;
      S.selectedIsExternalCert = false;
      renderScoresView(App);
    };
    $$('[data-sc-livesub]').forEach((b) => {
      b.onclick = () => { S.liveSub = b.dataset.scLivesub; renderScoresView(App); };
    });

    const subBox = $('#scLiveSubBody');
    if (S.liveSub === 'groups') {
      renderLiveGroupsSub(subBox, A);
    } else if (S.liveSub === 'stations') {
      renderLiveStationsSub(subBox, ev, A, evSts, scopedData);
    } else {
      renderLiveRankingSub(App, subBox, ev, A, rows, evCats);
    }
  }

  function renderLiveGroupsSub(subBox, A) {
    const gTotal = Math.max(1, A.byGender.M + A.byGender.F + A.byGender.other);
    const mPct = Math.round((A.byGender.M / gTotal) * 100);
    const fPct = Math.round((A.byGender.F / gTotal) * 100);
    subBox.innerHTML = `
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 text-xs">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2">
          <h3 class="font-black text-sm text-amber-300">📊 各組別即時進度明細</h3>
          <span class="text-slate-400">共 ${A.byCategory.length} 組</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-800/80 text-slate-300">
              <tr>
                <th class="p-2.5">組別</th>
                <th class="p-2.5 text-right">有效報名</th>
                <th class="p-2.5 text-right">已繳費</th>
                <th class="p-2.5 text-right">已報到(率)</th>
                <th class="p-2.5 text-right text-sky-300">賽道進行中</th>
                <th class="p-2.5 text-right text-emerald-400">已完賽</th>
                <th class="p-2.5 text-right text-orange-300">DNF</th>
                <th class="p-2.5 w-40">完賽進度</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800 mono">
              ${A.byCategory.map((c) => {
                const chkRate = c.paid > 0 ? Math.round((c.checkedIn / c.paid) * 100) : 0;
                return `
                  <tr class="hover:bg-slate-800/40">
                    <td class="p-2.5 font-sans font-bold text-white">${C.escapeHtml(c.name)}</td>
                    <td class="p-2.5 text-right">${c.active}</td>
                    <td class="p-2.5 text-right text-amber-300">${c.paid}</td>
                    <td class="p-2.5 text-right text-indigo-300">${c.checkedIn} <span class="text-[10px] opacity-75">(${chkRate}%)</span></td>
                    <td class="p-2.5 text-right text-sky-300 font-bold">${c.onTrack}</td>
                    <td class="p-2.5 text-right text-emerald-400 font-black">${c.finished}</td>
                    <td class="p-2.5 text-right text-orange-300">${c.dnf}</td>
                    <td class="p-2.5">
                      <div class="flex items-center gap-2">
                        <div class="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div class="h-full bg-emerald-400 rounded-full" style="width:${Math.min(100, c.finishRate)}%"></div>
                        </div>
                        <span class="w-9 text-right font-bold text-emerald-300">${c.finishRate}%</span>
                      </div>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-800">
          <div class="space-y-1.5">
            <div class="flex justify-between">
              <span class="font-bold text-slate-300">性別分佈</span>
              <span class="mono text-slate-300">♂ 男 ${A.byGender.M} (${mPct}%) ｜ ♀ 女 ${A.byGender.F} (${fPct}%)</span>
            </div>
            <div class="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden flex">
              <div class="bg-sky-500 h-full" style="width:${mPct}%"></div>
              <div class="bg-pink-500 h-full" style="width:${fPct}%"></div>
            </div>
          </div>
          <div class="space-y-1.5">
            <div class="font-bold text-slate-300">🌍 參賽國籍分佈</div>
            <div class="flex flex-wrap gap-1.5">
              ${A.byNationality.map((n) => `<span class="px-2 py-0.5 rounded-lg bg-slate-800 border border-slate-700 mono"><b class="text-amber-300">${C.escapeHtml(n.code)}</b> ${n.count}人 (${n.pct}%)</span>`).join('') || '<span class="text-slate-500">-</span>'}
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderLiveStationsSub(subBox, ev, A, evSts, data) {
    const sum = A.summary;
    const baseDenom = Math.max(1, sum.activeTotal);
    const funnelRows = [
      { code: 'CHECKIN', title: '起點現場報到檢錄', count: sum.checkedIn, pct: Math.round((sum.checkedIn / baseDenom) * 100), color: 'bg-indigo-400', sub: `已繳費 ${sum.paid} 人` },
      ...A.stations.map((st) => {
        const isFin = String(st.stationCode).toUpperCase() === 'FINISH';
        return {
          code: st.stationCode,
          title: `${isFin ? '🏁' : '🚩'} ${st.stationCode} ${st.name}${st.distanceKm ? ` (${st.distanceKm}km)` : ''}`,
          count: st.passedCount,
          pct: Math.round((st.passedCount / baseDenom) * 100),
          color: isFin ? 'bg-emerald-400' : 'bg-sky-400',
          sub: `佔已報到選手 ${st.passRate}%${!isFin && st.currentAtCount > 0 ? ` ｜ 目前停留區間 ${st.currentAtCount} 人` : ''}`
        };
      })
    ];

    const partByBib = new Map(data.participants.filter((p) => p.eventId === ev.eventId && p.bibNumber).map((p) => [String(p.bibNumber).toUpperCase(), p]));
    const catMap = new Map(data.categories.map((c) => [c.catId, c.name]));
    const logs = data.timingLogs
      .filter((l) => l.eventId === ev.eventId && l.isValid !== false)
      .filter((l) => S.liveStationFilter === 'all' || String(l.stationCode).toUpperCase() === S.liveStationFilter)
      .sort((a, b) => String(b.sensedTime || '').localeCompare(String(a.sensedTime || '')));

    subBox.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 text-xs">
        <div class="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 class="font-black text-sm text-amber-300">📍 各站點通過人數</h3>
            <span class="text-slate-400">有效 ${sum.activeTotal} 人</span>
          </div>
          <div class="space-y-2.5">
            ${funnelRows.map((fr) => `
              <div class="space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-slate-200">${C.escapeHtml(fr.title)}</span>
                  <span class="mono font-black text-white">${fr.count} 人 <span class="text-slate-400 font-normal">(${fr.pct}%)</span></span>
                </div>
                <div class="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                  <div class="h-full ${fr.color} rounded-full" style="width:${Math.min(100, fr.pct)}%"></div>
                </div>
                <div class="text-[10px] text-slate-500">${C.escapeHtml(fr.sub)}</div>
              </div>`).join('')}
          </div>
        </div>

        <div class="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
            <h3 class="font-black text-sm text-amber-300">⏱️ 最新站點通過明細（${logs.length} 筆）</h3>
            <select id="scLiveStFilter" class="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 font-bold">
              <option value="all" ${S.liveStationFilter === 'all' ? 'selected' : ''}>全部賽道站點</option>
              ${evSts.filter((s) => String(s.stationCode).toUpperCase() !== 'CHECKIN').map((s) => `<option value="${C.escapeHtml(String(s.stationCode).toUpperCase())}" ${S.liveStationFilter === String(s.stationCode).toUpperCase() ? 'selected' : ''}>${C.escapeHtml(s.stationCode)} ${C.escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="overflow-x-auto max-h-[420px]">
            <table class="w-full text-left">
              <thead class="bg-slate-800 text-slate-300 sticky top-0">
                <tr>
                  <th class="p-2">通過時間</th>
                  <th class="p-2">站點</th>
                  <th class="p-2">號碼布</th>
                  <th class="p-2">姓名 / 組別</th>
                  <th class="p-2">圈數 / 來源</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                ${logs.slice(0, 120).map((l) => {
                  const p = partByBib.get(String(l.bibNumber || '').toUpperCase());
                  return `
                    <tr class="hover:bg-slate-800/50">
                      <td class="p-2 mono text-emerald-400 font-bold whitespace-nowrap">${C.escapeHtml(String(l.sensedTime || '').slice(11, 19) || l.sensedTime)}</td>
                      <td class="p-2 mono font-black text-amber-300">${C.escapeHtml(l.stationCode)}</td>
                      <td class="p-2 mono font-black text-white">${C.escapeHtml(l.bibNumber)}</td>
                      <td class="p-2"><span class="font-bold text-white">${C.escapeHtml(p?.name || '-')}</span> <span class="text-[10px] text-slate-400">${C.escapeHtml(p ? (catMap.get(p.catId) || '') : '')}</span></td>
                      <td class="p-2 text-[11px] text-slate-400 mono">${l.lapCount ? `第 ${l.lapCount} 圈 · ` : ''}${C.escapeHtml(l.source || 'nfc')}</td>
                    </tr>`;
                }).join('') || '<tr><td colspan="5" class="p-8 text-center text-slate-500">尚無站點通過感應紀錄</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;

    const sel = $('#scLiveStFilter');
    if (sel) sel.onchange = (e) => { S.liveStationFilter = e.target.value; renderLiveStationsSub(subBox, ev, A, evSts, data); };
  }

  function renderLiveRankingSub(App, subBox, ev, A, rows, evCats) {
    const drawTable = () => {
      const q = (S.liveSearch || '').trim().toUpperCase();
      const list = A.runners.filter((r) => {
        if (S.liveCatFilter !== 'all' && r.participant.catId !== S.liveCatFilter) return false;
        if (S.liveStageFilter !== 'all' && r.stage !== S.liveStageFilter) return false;
        if (!q) return true;
        return `${r.participant.bibNumber} ${r.participant.name} ${r.participant.groupName} ${r.category.name}`.toUpperCase().includes(q);
      });
      const badgeCls = {
        finished: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
        on_track: 'bg-sky-500/20 text-sky-300 border border-sky-500/40',
        checked_in: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
        paid_not_checked: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
        unpaid: 'bg-rose-500/20 text-rose-300 border border-rose-500/40',
        dnf: 'bg-orange-500/20 text-orange-300 border border-orange-500/40',
        cancelled: 'bg-slate-800 text-slate-400 border border-slate-700'
      };
      const stepDot = {
        done: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300',
        active: 'bg-sky-500/25 border-sky-400 text-sky-200',
        pending: 'bg-slate-900 border-slate-700 text-slate-500',
        fail: 'bg-rose-500/20 border-rose-500/60 text-rose-300'
      };
      const statsEl = $('#scRankStats');
      if (statsEl) statsEl.textContent = `顯示 ${list.length} / ${A.runners.length} 位`;
      const tbody = $('#scRankBody');
      if (!tbody) return;
      tbody.innerHTML = list.map((r) => {
        const chk = C.isCertEligible(ev, r.leaderboardRow);
        return `
          <tr class="hover:bg-slate-800/50 align-middle">
            <td class="p-2.5 whitespace-nowrap">
              ${r.overallRank ? `<div class="font-black mono text-amber-400 text-sm">#${r.overallRank} <span class="text-slate-400 text-[10px]">(組#${r.catRank})</span></div>` : '<div class="text-slate-500 mono text-[11px]">-</div>'}
              <span class="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeCls[r.stage] || badgeCls.cancelled}">${r.stageLabel}</span>
            </td>
            <td class="p-2.5 whitespace-nowrap">
              <div class="mono font-black text-white">${r.participant.bibNumber || '未配號'}</div>
              <div class="text-[11px] text-slate-400">${C.escapeHtml(r.category.name)}</div>
            </td>
            <td class="p-2.5 whitespace-nowrap">
              <div class="font-bold text-white">${C.escapeHtml(r.participant.name)} <span class="px-1.5 py-0.5 rounded bg-sky-900 text-sky-300 text-[10px]">${C.escapeHtml(r.participant.nationality)}</span></div>
              ${r.isWarrior800 ? '<span class="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 text-[10px] font-bold">🏅 八百壯士</span>' : ''}
            </td>
            <td class="p-2.5">
              <div class="flex flex-wrap items-center gap-1">
                ${r.steps.map((st, idx) => `${idx > 0 ? '<span class="text-slate-600 text-[10px]">→</span>' : ''}<div class="px-2 py-0.5 rounded border text-[10px] ${stepDot[st.state] || stepDot.pending}"><b>${C.escapeHtml(st.label)}</b> <span class="mono opacity-80">${C.escapeHtml(st.detail)}</span></div>`).join('')}
              </div>
            </td>
            <td class="p-2.5 whitespace-nowrap mono">
              <div class="font-bold text-slate-200">${r.totalDistanceKm > 0 ? `${r.totalDistanceKm} km` : '-'} ${r.lapCount ? `(${r.lapCount}圈)` : ''}</div>
              <div class="font-black text-emerald-400">${r.elapsedSec !== null ? C.formatDuration(r.elapsedSec) : (r.lastStationTime ? `最新 ${r.lastStationTime}` : '--:--:--')}</div>
            </td>
            <td class="p-2.5 mono whitespace-nowrap">${r.avgPace}</td>
            <td class="p-2.5 whitespace-nowrap">
              ${chk.ok
                ? `<button type="button" data-sc-go-cert="${r.participant.participantId}" class="px-2.5 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-black">🏆 證書</button>`
                : (ev.status !== 'finished' ? '<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">⏳ 結案後開放</span>' : '<span class="text-slate-600 text-[11px]">須完賽</span>')}
            </td>
          </tr>`;
      }).join('') || '<tr><td colspan="7" class="p-8 text-center text-slate-500">無符合篩選條件之選手</td></tr>';

      $$('[data-sc-go-cert]').forEach((b) => {
        b.onclick = () => {
          const picked = rows.find((x) => x.participant.participantId === b.dataset.scGoCert);
          if (picked) {
            S.selectedRow = picked;
            S.selectedIsExternalCert = false;
            App.State.scoreSubTab = 'cert';
            App.renderAll();
          }
        };
      });
    };

    subBox.innerHTML = `
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-3 text-xs">
        <!-- 組別快速切換列 -->
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="font-bold text-amber-300 mr-1">組別區分：</span>
          <button type="button" data-sc-cat="all" class="px-3 py-1 rounded-lg font-bold ${S.liveCatFilter === 'all' ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}">全部組別 (${evCats.length})</button>
          ${evCats.map((c) => `<button type="button" data-sc-cat="${c.catId}" class="px-3 py-1 rounded-lg font-bold ${S.liveCatFilter === c.catId ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}">${C.escapeHtml(c.name)}</button>`).join('')}
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <input id="scRankSearch" type="text" value="${C.escapeHtml(S.liveSearch)}" placeholder="🔎 搜尋號碼布 / 姓名 / 跑團" class="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-white w-56" />
            <select id="scRankStage" class="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-slate-200 font-bold">
              <option value="all" ${S.liveStageFilter === 'all' ? 'selected' : ''}>全部狀態</option>
              <option value="finished" ${S.liveStageFilter === 'finished' ? 'selected' : ''}>🏁 已完賽</option>
              <option value="on_track" ${S.liveStageFilter === 'on_track' ? 'selected' : ''}>🏃 賽道進行中</option>
              <option value="checked_in" ${S.liveStageFilter === 'checked_in' ? 'selected' : ''}>✅ 已報到</option>
              <option value="dnf" ${S.liveStageFilter === 'dnf' ? 'selected' : ''}>🛑 DNF</option>
            </select>
          </div>
          <span id="scRankStats" class="font-bold text-slate-300 mono"></span>
        </div>
      </div>

      <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto text-xs">
        <table class="w-full text-left">
          <thead class="bg-slate-800 text-slate-200">
            <tr>
              <th class="p-2.5 whitespace-nowrap">名次 / 狀態</th>
              <th class="p-2.5 whitespace-nowrap">號碼布 / 組別</th>
              <th class="p-2.5 whitespace-nowrap">選手</th>
              <th class="p-2.5 min-w-[260px]">動態進度</th>
              <th class="p-2.5 whitespace-nowrap">里程 / 成績</th>
              <th class="p-2.5 whitespace-nowrap">均速</th>
              <th class="p-2.5 whitespace-nowrap">證書</th>
            </tr>
          </thead>
          <tbody id="scRankBody" class="divide-y divide-slate-800"></tbody>
        </table>
      </div>`;

    $$('[data-sc-cat]').forEach((b) => {
      b.onclick = () => { S.liveCatFilter = b.dataset.scCat; renderLiveRankingSub(App, subBox, ev, A, rows, evCats); };
    });
    $('#scRankStage').onchange = (e) => { S.liveStageFilter = e.target.value; drawTable(); };
    C.bindFastInput($('#scRankSearch'), (e) => { S.liveSearch = e.target.value; drawTable(); }, 120);
    drawTable();
  }

  /* --------------------------------------------------------------------------
   * （二）歷年成績：依年度 / 依個人 / 依場次 分別查詢（每筆附直達證書鈕）
   * -------------------------------------------------------------------------- */
  function renderHistoryTab(App, box, all) {
    const years = [...new Set(all.map((r) => r.year))].sort((a, b) => String(b).localeCompare(String(a)));
    const evNames = [...new Set(all.map((r) => r.eventName))].sort();
    const runners = [...new Set(all.map((r) => r.name))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));

    const q = (S.hisSearch || '').trim().toUpperCase();
    const list = all.filter((h) => {
      if (S.hisMode === 'year' && S.hisYear !== 'all' && h.year !== S.hisYear) return false;
      if (S.hisMode === 'runner' && S.hisRunner !== 'all' && h.name !== S.hisRunner) return false;
      if (S.hisMode === 'event' && S.hisEvent !== 'all' && h.eventName !== S.hisEvent) return false;
      if (S.hisBadge === 'warrior' && !h.isWarrior800) return false;
      if (!q) return true;
      return `${h.year} ${h.name} ${h.bibNumber} ${h.eventName} ${h.categoryName}`.toUpperCase().includes(q);
    });

    const totalKm = Number(list.reduce((s, x) => s + Number(x.distanceKm || 0), 0).toFixed(1));
    const uniqRunners = new Set(list.map((x) => x.name)).size;
    const w800Cnt = list.filter((x) => x.isWarrior800).length;

    // 依不同查詢維度產出精準導覽列
    let modePanelHtml = '';
    if (S.hisMode === 'year') {
      modePanelHtml = `
        <div class="flex flex-wrap gap-1.5">
          <button type="button" data-sc-his-year="all" class="px-3 py-1.5 rounded-lg font-bold ${S.hisYear === 'all' ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300'}">全部年度 (${all.length})</button>
          ${years.map((y) => {
            const cnt = all.filter((x) => x.year === y).length;
            return `<button type="button" data-sc-his-year="${y}" class="px-3 py-1.5 rounded-lg font-bold ${S.hisYear === y ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300'}">${y} 年 (${cnt})</button>`;
          }).join('')}
        </div>`;
    } else if (S.hisMode === 'runner') {
      modePanelHtml = `
        <div class="flex flex-wrap items-center gap-2">
          <select id="scHisRunnerSel" class="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-200 font-bold min-w-[220px]">
            <option value="all" ${S.hisRunner === 'all' ? 'selected' : ''}>🏃 全部選手（${runners.length} 位）</option>
            ${runners.map((nm) => `<option value="${C.escapeHtml(nm)}" ${S.hisRunner === nm ? 'selected' : ''}>${C.escapeHtml(nm)}</option>`).join('')}
          </select>
          <span class="text-slate-400">可下拉選取選手，或於右側搜尋框輸入姓名查跨年度生涯成績</span>
        </div>`;
    } else {
      modePanelHtml = `
        <div class="flex flex-wrap items-center gap-2">
          <select id="scHisEventSel" class="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-200 font-bold min-w-[260px] max-w-full">
            <option value="all" ${S.hisEvent === 'all' ? 'selected' : ''}>🏁 全部場次（${evNames.length} 場）</option>
            ${evNames.map((n) => `<option value="${C.escapeHtml(n)}" ${S.hisEvent === n ? 'selected' : ''}>${C.escapeHtml(n)}</option>`).join('')}
          </select>
        </div>`;
    }

    box.innerHTML = `
      <div class="bg-slate-950 text-slate-100 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg border border-slate-800 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <h2 class="font-black text-base sm:text-lg text-white">📚 （二）歷年成績查詢</h2>
          <div class="flex gap-1.5">
            <button type="button" data-sc-hismode="year" class="px-3.5 py-1.5 rounded-xl font-black ${S.hisMode === 'year' ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-300'}">📅 依年度</button>
            <button type="button" data-sc-hismode="runner" class="px-3.5 py-1.5 rounded-xl font-black ${S.hisMode === 'runner' ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-300'}">🏃 依個人</button>
            <button type="button" data-sc-hismode="event" class="px-3.5 py-1.5 rounded-xl font-black ${S.hisMode === 'event' ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-300'}">🏁 依場次</button>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex-1">${modePanelHtml}</div>
            <div class="flex flex-wrap items-center gap-2">
              <input id="scHisSearch" type="text" value="${C.escapeHtml(S.hisSearch)}" placeholder="🔎 關鍵字：姓名 / 號碼布 / 賽事" class="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-white w-56" />
              <select id="scHisBadge" class="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-slate-200 font-bold">
                <option value="all" ${S.hisBadge === 'all' ? 'selected' : ''}>全部完賽</option>
                <option value="warrior" ${S.hisBadge === 'warrior' ? 'selected' : ''}>🏅 僅八百壯士</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 mono">
            <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800">完賽紀錄：<b class="text-white text-sm">${list.length}</b> 筆（${uniqRunners}人）</div>
            <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800">累計里程：<b class="text-amber-400 text-sm">${totalKm.toLocaleString()} km</b></div>
            <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800">八百壯士：<b class="text-emerald-400 text-sm">${w800Cnt}</b> 人次</div>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-800 text-slate-200">
              <tr>
                <th class="p-2.5 whitespace-nowrap">年度 / 日期</th>
                <th class="p-2.5">賽事場次</th>
                <th class="p-2.5 whitespace-nowrap">組別</th>
                <th class="p-2.5 whitespace-nowrap">選手 / 號碼布</th>
                <th class="p-2.5 whitespace-nowrap">距離</th>
                <th class="p-2.5 whitespace-nowrap">完賽成績</th>
                <th class="p-2.5 whitespace-nowrap">榮譽</th>
                <th class="p-2.5 whitespace-nowrap">證書</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              ${list.map((h) => `
                <tr class="hover:bg-slate-800/60">
                  <td class="p-2.5 mono whitespace-nowrap"><span class="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 font-bold mr-1">${h.year}</span><span class="text-slate-400">${C.escapeHtml(h.eventDate)}</span></td>
                  <td class="p-2.5 font-semibold text-white max-w-[240px] truncate">${C.escapeHtml(h.eventName)}</td>
                  <td class="p-2.5 whitespace-nowrap">${C.escapeHtml(h.categoryName)}</td>
                  <td class="p-2.5 whitespace-nowrap"><div class="font-black text-white">${C.escapeHtml(h.name)}</div><div class="text-[10px] mono text-slate-400">BIB ${C.escapeHtml(h.bibNumber)}</div></td>
                  <td class="p-2.5 mono font-bold text-amber-300 whitespace-nowrap">${h.distanceKm} km</td>
                  <td class="p-2.5 mono whitespace-nowrap"><div class="font-black text-emerald-400">${C.escapeHtml(h.finishTime)}</div><div class="text-[10px] text-slate-400">${C.escapeHtml(h.avgPace)}</div></td>
                  <td class="p-2.5 whitespace-nowrap">${h.isWarrior800 ? '<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/40 font-bold">🏅 八百壯士</span>' : '<span class="text-slate-400">完賽</span>'}</td>
                  <td class="p-2.5 whitespace-nowrap">
                    <button type="button" data-sc-his-cert="${C.escapeHtml(h.recordId)}" class="px-2.5 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-black">🏆 證書</button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="8" class="p-8 text-center text-slate-500">查無符合條件之歷年完賽成績</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    $$('[data-sc-hismode]').forEach((b) => { b.onclick = () => { S.hisMode = b.dataset.scHismode; renderHistoryTab(App, box, all); }; });
    $$('[data-sc-his-year]').forEach((b) => { b.onclick = () => { S.hisYear = b.dataset.scHisYear; renderHistoryTab(App, box, all); }; });
    if ($('#scHisRunnerSel')) $('#scHisRunnerSel').onchange = (e) => { S.hisRunner = e.target.value; renderHistoryTab(App, box, all); };
    if ($('#scHisEventSel')) $('#scHisEventSel').onchange = (e) => { S.hisEvent = e.target.value; renderHistoryTab(App, box, all); };
    $('#scHisBadge').onchange = (e) => { S.hisBadge = e.target.value; renderHistoryTab(App, box, all); };
    C.bindFastInput($('#scHisSearch'), (e) => { S.hisSearch = e.target.value; renderHistoryTab(App, box, all); }, 150);
    $$('[data-sc-his-cert]').forEach((b) => {
      b.onclick = () => {
        const rec = all.find((x) => x.recordId === b.dataset.scHisCert);
        if (rec) openCertFromRecord(App, rec.certRow);
      };
    });
  }

  /* --------------------------------------------------------------------------
   * （三）八百壯士：當年度綜合成績（選年度） ／ 英雄榜（年度＋姓名）
   * -------------------------------------------------------------------------- */
  function renderWarriorsTab(App, box, all) {
    const allW = all.filter((h) => h.isWarrior800);
    const years = [...new Set(allW.map((w) => w.year))].sort((a, b) => String(b).localeCompare(String(a)));
    if (!S.warYear || !years.includes(S.warYear)) S.warYear = years[0] || String(new Date().getFullYear());

    box.innerHTML = `
      <div class="bg-slate-950 text-slate-100 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg border border-amber-500/30 text-xs">
        <div class="bg-gradient-to-r from-slate-900 via-amber-950/80 to-slate-900 p-4 rounded-2xl border border-amber-500/40 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg sm:text-xl font-black text-white">🏅 （三）八百壯士專區</h2>
            <p class="text-[11px] text-amber-200/80 mt-0.5">當年度綜合成績累計排行 ＋ 跨年度英雄榜（可依年度與姓名雙重篩選）</p>
          </div>
          <div class="flex gap-1.5">
            <button type="button" data-sc-warmode="year" class="px-3.5 py-2 rounded-xl font-black ${S.warMode === 'year' ? 'bg-amber-400 text-slate-950 shadow' : 'bg-slate-800 text-slate-200 border border-slate-700'}">📅 當年度綜合成績</button>
            <button type="button" data-sc-warmode="hall" class="px-3.5 py-2 rounded-xl font-black ${S.warMode === 'hall' ? 'bg-amber-400 text-slate-950 shadow' : 'bg-slate-800 text-slate-200 border border-slate-700'}">👑 英雄榜（年度／姓名）</button>
          </div>
        </div>
        <div id="scWarBody" class="space-y-4"></div>
      </div>`;

    $$('[data-sc-warmode]').forEach((b) => {
      b.onclick = () => { S.warMode = b.dataset.scWarmode; renderWarriorsTab(App, box, all); };
    });

    const body = $('#scWarBody');
    if (S.warMode === 'year') {
      const yrRecs = allW.filter((w) => w.year === S.warYear);
      const byRunner = new Map();
      yrRecs.forEach((r) => {
        if (!byRunner.has(r.name)) byRunner.set(r.name, { name: r.name, count: 0, totalKm: 0, recs: [] });
        const o = byRunner.get(r.name);
        o.count++;
        o.totalKm = Number((o.totalKm + Number(r.distanceKm || 0)).toFixed(1));
        o.recs.push(r);
      });
      const ranked = [...byRunner.values()].sort((a, b) => b.totalKm - a.totalKm || b.count - a.count);
      const yrTotalKm = Number(yrRecs.reduce((s, x) => s + Number(x.distanceKm || 0), 0).toFixed(1));

      body.innerHTML = `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-black text-amber-300">選擇年度：</span>
            <select id="scWarYearSel" class="bg-slate-950 border border-amber-400/50 rounded-xl px-3 py-1.5 text-amber-300 font-black mono">
              ${years.map((y) => `<option value="${y}" ${y === S.warYear ? 'selected' : ''}>${y} 年度</option>`).join('') || `<option value="${S.warYear}">${S.warYear} 年度</option>`}
            </select>
          </div>
          <div class="mono text-slate-300">達標 <b>${ranked.length}</b> 人（${yrRecs.length} 人次） ｜ 年度總里程 <b class="text-amber-400">${yrTotalKm.toLocaleString()} km</b></div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-800 text-slate-200">
              <tr>
                <th class="p-2.5 w-16">排名</th>
                <th class="p-2.5">選手姓名</th>
                <th class="p-2.5 text-right">年度累計里程</th>
                <th class="p-2.5 text-right">達標場數</th>
                <th class="p-2.5">完賽場次明細（附證書）</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              ${ranked.map((row, idx) => `
                <tr class="hover:bg-slate-800/50 align-top">
                  <td class="p-2.5 mono font-black text-amber-400 text-sm">#${idx + 1}</td>
                  <td class="p-2.5 font-black text-white text-sm whitespace-nowrap">${C.escapeHtml(row.name)}</td>
                  <td class="p-2.5 mono text-right font-black text-amber-300 text-sm whitespace-nowrap">${row.totalKm.toLocaleString()} km</td>
                  <td class="p-2.5 mono text-right font-bold text-emerald-400 whitespace-nowrap">${row.count} 場</td>
                  <td class="p-2.5 space-y-1">
                    ${row.recs.map((r) => `
                      <div class="flex flex-wrap items-center justify-between gap-2 bg-slate-950/70 px-2.5 py-1 rounded-lg border border-slate-800">
                        <span><b class="mono text-amber-300">${C.escapeHtml(r.eventDate)}</b> ${C.escapeHtml(r.eventName)} (${C.escapeHtml(r.categoryName)})</span>
                        <span class="flex items-center gap-2 mono">
                          <b class="text-white">${r.distanceKm}km</b>
                          <b class="text-emerald-400">${C.escapeHtml(r.finishTime)}</b>
                          ${r.canCert ? `<button type="button" data-sc-war-cert="${C.escapeHtml(r.recordId)}" class="px-2 py-0.5 rounded bg-amber-400 text-slate-950 font-black text-[10px]">🏆 證書</button>` : ''}
                        </span>
                      </div>`).join('')}
                  </td>
                </tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-slate-500">本年度尚無八百壯士完賽紀錄</td></tr>'}
            </tbody>
          </table>
        </div>`;

      if ($('#scWarYearSel')) $('#scWarYearSel').onchange = (e) => { S.warYear = e.target.value; renderWarriorsTab(App, box, all); };
    } else {
      const q = (S.warSearch || '').trim().toUpperCase();
      const filtered = allW.filter((w) => {
        if (S.warHallYear !== 'all' && w.year !== S.warHallYear) return false;
        if (!q) return true;
        return `${w.year} ${w.name} ${w.eventName} ${w.categoryName}`.toUpperCase().includes(q);
      });
      const rMap = new Map();
      filtered.forEach((w) => {
        if (!rMap.has(w.name)) rMap.set(w.name, []);
        rMap.get(w.name).push(w);
      });
      const heroes = [...rMap.entries()].map(([name, recs]) => ({
        name,
        stars: recs.length,
        totalKm: Number(recs.reduce((s, r) => s + Number(r.distanceKm || 0), 0).toFixed(1)),
        years: [...new Set(recs.map((r) => r.year))].sort().join(' / '),
        recs: recs.sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)))
      })).sort((a, b) => b.stars - a.stars || b.totalKm - a.totalKm);

      body.innerHTML = `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap gap-1.5">
            <button type="button" data-sc-hallyear="all" class="px-3 py-1 rounded-lg font-bold ${S.warHallYear === 'all' ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300'}">全部年度 (${allW.length})</button>
            ${years.map((y) => `<button type="button" data-sc-hallyear="${y}" class="px-3 py-1 rounded-lg font-bold ${S.warHallYear === y ? 'bg-amber-400 text-slate-950 font-black' : 'bg-slate-800 text-slate-300'}">${y} 年</button>`).join('')}
          </div>
          <input id="scWarSearch" type="text" value="${C.escapeHtml(S.warSearch)}" placeholder="🔎 依姓名或賽事搜尋英雄榜" class="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-white w-60" />
        </div>
        <div class="space-y-3">
          ${heroes.map((sr, i) => `
            <details open class="bg-slate-900 border border-amber-500/30 rounded-2xl overflow-hidden">
              <summary class="cursor-pointer px-4 py-3 bg-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="mono font-black text-amber-400">#${i + 1}</span>
                  <span class="font-black text-base text-white">${C.escapeHtml(sr.name)}</span>
                  <span class="px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 font-black text-[11px]">${'★'.repeat(Math.min(5, sr.stars))} ${sr.stars} 星壯士</span>
                </div>
                <div class="mono text-slate-300">累計 <b class="text-amber-300">${sr.totalKm} km</b> ｜ 年度：${sr.years}</div>
              </summary>
              <div class="p-3 divide-y divide-slate-800">
                ${sr.recs.map((r) => `
                  <div class="py-2 flex flex-wrap items-center justify-between gap-2">
                    <div><span class="mono text-amber-300 font-bold mr-2">${C.escapeHtml(r.eventDate)}</span><span class="font-bold text-white">${C.escapeHtml(r.eventName)}</span> <span class="text-slate-400">(${C.escapeHtml(r.categoryName)})</span></div>
                    <div class="flex items-center gap-3 mono">
                      <span class="text-amber-400 font-bold">${r.distanceKm} km</span>
                      <span class="text-emerald-400 font-bold">${C.escapeHtml(r.finishTime)}</span>
                      ${r.canCert ? `<button type="button" data-sc-war-cert="${C.escapeHtml(r.recordId)}" class="px-2.5 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-[11px]">🏆 證書</button>` : '<span class="text-slate-500 text-[10px]">⏳ 待結案</span>'}
                    </div>
                  </div>`).join('')}
              </div>
            </details>`).join('') || '<div class="p-8 text-center text-slate-500 bg-slate-900 rounded-2xl border border-slate-800">查無符合條件之英雄榜紀錄</div>'}
        </div>`;

      $$('[data-sc-hallyear]').forEach((b) => { b.onclick = () => { S.warHallYear = b.dataset.scHallyear; renderWarriorsTab(App, box, all); }; });
      C.bindFastInput($('#scWarSearch'), (e) => { S.warSearch = e.target.value; renderWarriorsTab(App, box, all); }, 150);
    }

    $$('[data-sc-war-cert]').forEach((b) => {
      b.onclick = () => {
        const rec = all.find((x) => x.recordId === b.dataset.scWarCert);
        if (rec) openCertFromRecord(App, rec.certRow);
      };
    });
  }

  /* --------------------------------------------------------------------------
   * （四）完賽證書：獨立自助領證 ＋ 從成績列直達領證
   * -------------------------------------------------------------------------- */
  function drawCertNow(ev) {
    const cv = $('#scCertCanvas');
    if (!cv || !ev) return;
    const baseCfg = C.parseJsonSafe(ev.certConfigJson, C.defaultCertConfig());
    const isCustom = S.certMode === 'custom_runner';
    const cfg = {
      ...baseCfg,
      certMode: S.certMode,
      orientation: S.overrideOrient || baseCfg.orientation,
      layoutId: S.overrideLayout || baseCfg.layoutId,
      paletteId: S.overridePalette || baseCfg.paletteId,
      fontId: S.overrideFont || baseCfg.fontId
    };
    const targetEv = S.selectedRow?.event || ev;
    const elig = C.isCertEligible(targetEv, S.selectedRow);
    const canPrint = elig.ok;

    if ($('#btnScDlPng')) $('#btnScDlPng').disabled = !canPrint;
    if ($('#btnScDlPdf')) $('#btnScDlPdf').disabled = !canPrint;
    if ($('#scPhotoControls')) $('#scPhotoControls').classList.toggle('hidden', !(canPrint && isCustom && cfg.allowPublicPhotoQuote));
    if ($('#scCertHint')) {
      $('#scCertHint').textContent = canPrint
        ? `${isCustom ? '📸 客製化證書' : '🏛️ 官方證書'} · ${cfg.orientation === 'portrait' ? 'A4 直式' : 'A4 橫式'} · ${S.selectedRow?.participant?.name || ''}`
        : `🔒 ${elig.reason}`;
    }

    if (!canPrint) {
      cv.width = 1200; cv.height = 500;
      const g = cv.getContext('2d');
      g.fillStyle = '#0f172a'; g.fillRect(0, 0, cv.width, cv.height);
      g.strokeStyle = '#f59e0b'; g.lineWidth = 4; g.strokeRect(24, 24, cv.width - 48, cv.height - 48);
      g.fillStyle = '#fbbf24'; g.textAlign = 'center'; g.font = '900 34px "Noto Sans TC", sans-serif';
      g.fillText('🔒 請選擇已結案之完賽選手', cv.width / 2, 220);
      g.fillStyle = '#cbd5e1'; g.font = '600 22px "Noto Sans TC", sans-serif';
      g.fillText(elig.reason || '須符合「已完賽＋活動已結案＋具正式成績」', cv.width / 2, 280);
      return;
    }

    C.renderCertificateCanvas(cv, S.selectedRow, cfg, {
      certMode: S.certMode,
      customBgImg: S.customBgImg,
      photoImg: isCustom ? S.photoImg : null,
      showPhotoPlaceholder: isCustom && cfg.allowPublicPhotoQuote,
      photoFrame: S.photoFrame,
      photoZoom: S.photoZoom,
      photoOffsetX: S.photoOffsetX,
      photoOffsetY: S.photoOffsetY,
      quote: isCustom ? S.quote : ''
    });
  }

  function renderCertTab(App, box, data) {
    C.ensureCertFonts();
    let ev = ensureActiveEvent(data);
    if (!S.selectedIsExternalCert && ev && ev.status !== 'finished') {
      const fin = data.events.find((e) => e.status === 'finished');
      if (fin) { ev = fin; S.activeEventId = fin.eventId; }
    }
    if (!ev) {
      box.innerHTML = '<div class="bg-slate-900 text-slate-300 p-10 rounded-2xl text-center">尚無可列印證書之活動。</div>';
      return;
    }
    const rows = C.computeLeaderboard({
      event: ev, categories: data.categories, stations: data.stations,
      participants: data.participants, timingLogs: data.timingLogs
    });
    const eligAll = rows.filter((r) => C.isCertEligible(ev, r).ok);
    if (!S.selectedIsExternalCert && (!S.selectedRow || !eligAll.some((x) => x.participant.participantId === S.selectedRow.participant?.participantId))) {
      S.selectedRow = eligAll[0] || null;
    }
    if (!S.overrideLayout) loadCertConfigForEvent(ev);

    const q = (S.certSearch || '').trim().toUpperCase();
    const filteredList = eligAll.filter((r) => !q || `${r.participant.bibNumber} ${r.participant.name}`.toUpperCase().includes(q));
    const isCustom = S.certMode === 'custom_runner';

    box.innerHTML = `
      <div class="bg-slate-950 text-slate-100 rounded-2xl p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-4 shadow-lg border border-slate-800 text-xs">
        <div class="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div class="font-black text-sm text-amber-400">🔍 選擇已結案活動與完賽選手</div>
          <select id="scCertEvSel" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-amber-300 font-bold">
            ${data.events.map((e) => `<option value="${e.eventId}" ${e.eventId === ev.eventId ? 'selected' : ''}>[${e.status === 'finished' ? '已結案' : '進行中'}] ${C.escapeHtml(e.nameZh)}</option>`).join('')}
          </select>
          <input id="scCertSearch" type="text" value="${C.escapeHtml(S.certSearch)}" placeholder="搜尋號碼布或姓名" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white" />
          <div class="divide-y divide-slate-800 max-h-[440px] overflow-y-auto">
            ${filteredList.map((r) => {
              const act = !S.selectedIsExternalCert && S.selectedRow?.participant?.participantId === r.participant.participantId;
              return `
                <button type="button" data-sc-pick-cert="${r.participant.participantId}" class="w-full text-left py-2.5 px-2.5 rounded-xl flex justify-between ${act ? 'bg-amber-500/20 border border-amber-400/50' : 'hover:bg-slate-800'}">
                  <div>
                    <div class="font-bold text-white">#${r.overallRank} ${C.escapeHtml(r.participant.bibNumber)} ${C.escapeHtml(r.participant.name)}</div>
                    <div class="text-[10px] text-slate-400">${C.escapeHtml(r.category.name)} · ${r.totalDistanceKm} km</div>
                  </div>
                  <div class="mono font-bold text-emerald-400">${C.formatDuration(r.elapsedSec)}</div>
                </button>`;
            }).join('') || '<p class="text-slate-500 text-center py-6">此場尚無已結案完賽選手（亦可從「歷年成績」或「八百壯士」列尾直點 🏆 證書）</p>'}
          </div>
        </div>

        <div class="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="font-black text-base text-white">🏆 （四）完賽證書下載</h2>
              <p id="scCertHint" class="text-[11px] text-slate-400 mt-0.5"></p>
            </div>
            <div class="flex gap-2">
              <button type="button" id="btnScDlPng" class="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black">⬇️ PNG</button>
              <button type="button" id="btnScDlPdf" class="px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black">📄 PDF</button>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <button type="button" id="btnScModeOff" class="p-2.5 rounded-xl border-2 text-left font-bold ${!isCustom ? 'border-amber-400 bg-amber-400 text-slate-950' : 'border-slate-700 bg-slate-950 text-slate-300'}">🏛️ 官方證書</button>
            <button type="button" id="btnScModeCus" class="p-2.5 rounded-xl border-2 text-left font-bold ${isCustom ? 'border-amber-400 bg-amber-400 text-slate-950' : 'border-slate-700 bg-slate-950 text-slate-300'}">📸 客製化照片證書</button>
          </div>

          <div class="bg-slate-950 p-2 rounded-xl border border-slate-800 flex items-center justify-center">
            <canvas id="scCertCanvas" class="max-w-full max-h-[480px] w-auto h-auto rounded-lg shadow-xl cursor-grab"></canvas>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950/70 p-3 rounded-xl border border-slate-800">
            <select id="scOrient" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white">
              <option value="landscape" ${S.overrideOrient === 'landscape' ? 'selected' : ''}>A4 橫式</option>
              <option value="portrait" ${S.overrideOrient === 'portrait' ? 'selected' : ''}>A4 直式</option>
            </select>
            <select id="scLayout" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white">
              ${C.CERT_LAYOUTS.map((l) => `<option value="${l.id}" ${l.id === S.overrideLayout ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
            <select id="scPalette" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white">
              ${C.CERT_PALETTES.map((p) => `<option value="${p.id}" ${p.id === S.overridePalette ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
            <select id="scFont" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white">
              ${C.CERT_FONTS.map((f) => `<option value="${f.id}" ${f.id === S.overrideFont ? 'selected' : ''}>${f.name}</option>`).join('')}
            </select>
          </div>

          <div id="scPhotoControls" class="hidden grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-950/70 p-3 rounded-xl border border-amber-500/40">
            <div class="space-y-2">
              <div class="font-bold text-amber-300">📸 個人照片（可於畫布拖曳位置）</div>
              <div class="flex items-center gap-2">
                <input id="scPhotoFile" type="file" accept="image/*" class="text-[11px] flex-1" />
                <button type="button" id="btnScClrPhoto" class="px-2 py-1 rounded bg-slate-800">移除</button>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-slate-400">縮放</span>
                <input id="scZoom" type="range" min="0.5" max="2.8" step="0.05" value="${S.photoZoom}" class="flex-1 accent-amber-400" />
                <span id="scZoomTxt" class="mono text-amber-300 w-10 text-right">${S.photoZoom.toFixed(1)}x</span>
              </div>
            </div>
            <div class="space-y-2">
              <div class="font-bold text-amber-300">💬 完賽感言（限 40 字）</div>
              <input id="scQuote" type="text" maxlength="40" value="${C.escapeHtml(S.quote)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white" />
            </div>
          </div>
        </div>
      </div>`;

    $('#scCertEvSel').onchange = (e) => { S.activeEventId = e.target.value; S.selectedIsExternalCert = false; loadCertConfigForEvent(data.events.find((x) => x.eventId === S.activeEventId)); renderCertTab(App, box, data); };
    C.bindFastInput($('#scCertSearch'), (e) => { S.certSearch = e.target.value; renderCertTab(App, box, data); }, 150);
    $$('[data-sc-pick-cert]').forEach((b) => {
      b.onclick = () => {
        S.selectedRow = eligAll.find((r) => r.participant.participantId === b.dataset.scPickCert) || null;
        S.selectedIsExternalCert = false;
        renderCertTab(App, box, data);
      };
    });
    $('#btnScModeOff').onclick = () => { S.certMode = 'official'; renderCertTab(App, box, data); };
    $('#btnScModeCus').onclick = () => { S.certMode = 'custom_runner'; renderCertTab(App, box, data); };
    $('#scOrient').onchange = (e) => { S.overrideOrient = e.target.value; drawCertNow(ev); };
    $('#scLayout').onchange = (e) => { S.overrideLayout = e.target.value; drawCertNow(ev); };
    $('#scPalette').onchange = (e) => { S.overridePalette = e.target.value; drawCertNow(ev); };
    $('#scFont').onchange = (e) => { S.overrideFont = e.target.value; drawCertNow(ev); };
    $('#scPhotoFile').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const im = new Image(); im.onload = () => { S.photoImg = im; S.photoOffsetX = 0; S.photoOffsetY = 0; drawCertNow(ev); }; im.src = URL.createObjectURL(f);
    };
    $('#btnScClrPhoto').onclick = () => { S.photoImg = null; $('#scPhotoFile').value = ''; drawCertNow(ev); };
    $('#scZoom').oninput = (e) => { S.photoZoom = Number(e.target.value); $('#scZoomTxt').textContent = `${S.photoZoom.toFixed(1)}x`; drawCertNow(ev); };
    C.bindFastInput($('#scQuote'), (e) => { S.quote = e.target.value.slice(0, 40); drawCertNow(ev); }, 120);

    const cv = $('#scCertCanvas');
    cv.onpointerdown = (e) => { if (!S.photoImg) return; S.dragging = true; S.dx0 = e.clientX; S.dy0 = e.clientY; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = (e) => {
      if (!S.dragging) return;
      const rect = cv.getBoundingClientRect();
      const sc = cv.width / rect.width;
      S.photoOffsetX += (e.clientX - S.dx0) * sc;
      S.photoOffsetY += (e.clientY - S.dy0) * sc;
      S.dx0 = e.clientX; S.dy0 = e.clientY;
      drawCertNow(ev);
    };
    cv.onpointerup = () => { S.dragging = false; };

    $('#btnScDlPng').onclick = () => {
      const chk = C.isCertEligible(S.selectedRow?.event || ev, S.selectedRow);
      if (!chk.ok) return App.toast(`🔒 ${chk.reason}`, 'warn');
      const a = document.createElement('a');
      a.download = `TUR_Cert_${S.selectedRow?.participant?.bibNumber || 'FINISHER'}.png`;
      a.href = cv.toDataURL('image/png', 1.0);
      a.click();
    };
    $('#btnScDlPdf').onclick = async () => {
      const chk = C.isCertEligible(S.selectedRow?.event || ev, S.selectedRow);
      if (!chk.ok) return App.toast(`🔒 ${chk.reason}`, 'warn');
      await C.ensureExternalLib('jspdf');
      const orient = cv.height > cv.width ? 'portrait' : 'landscape';
      if (global.jspdf?.jsPDF) {
        const pdf = new global.jspdf.jsPDF({ orientation: orient, unit: 'mm', format: 'a4' });
        pdf.addImage(cv.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, orient === 'portrait' ? 210 : 297, orient === 'portrait' ? 297 : 210);
        pdf.save(`TUR_Cert_${S.selectedRow?.participant?.bibNumber || 'FINISHER'}.pdf`);
      } else {
        window.print();
      }
    };

    drawCertNow(ev);
  }

  global.TurScores = { renderScoresView, openCertFromRecord };
})(window);
