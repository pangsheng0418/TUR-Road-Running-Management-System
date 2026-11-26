/**
 * ============================================================================
 * TUR Race Management System v3.0 (Governance Edition) - Shared Core Engine
 * 供 index.html 與 public.html 共用（非 ESM，支援 file:// 與 HTTPS 直開）
 * ============================================================================
 */
(function (global) {
  'use strict';

  /* --------------------------------------------------------------------------
   * 1. Date / Integer-Second Time Utilities (嚴格整數秒 HH:mm:ss，防跨夜誤差)
   * -------------------------------------------------------------------------- */
  function pad2(n) { return String(Math.floor(Math.abs(Number(n) || 0))).padStart(2, '0'); }

  function formatDateTime(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function parseDateTime(str) {
    if (!str) return null;
    const s = String(str).trim().replace(' ', 'T');
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function formatDuration(totalSec) {
    if (totalSec === null || totalSec === undefined || isNaN(totalSec)) return '--:--:--';
    const neg = totalSec < 0;
    const s = Math.abs(Math.round(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${neg ? '-' : ''}${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  }

  function formatPace(seconds, km) {
    if (!km || km <= 0 || !seconds || seconds <= 0) return '--:--';
    const secPerKm = Math.round(seconds / km);
    return `${Math.floor(secPerKm / 60)}:${pad2(secPerKm % 60)}/km`;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* --------------------------------------------------------------------------
   * 2. 28 組中文複姓與英文姓名拆併、中文賽名自動英譯、身分證檢核 & SHA-256
   * -------------------------------------------------------------------------- */
  const COMPOUND_SURNAMES_28 = [
    '歐陽', '司馬', '諸葛', '上官', '皇甫', '令狐', '東方', '獨孤', '南宮', '慕容',
    '夏侯', '公孫', '長孫', '宇文', '尉遲', '鮮于', '司徒', '司空', '軒轅', '端木',
    '百里', '呼延', '太史', '申屠', '公羊', '澹台', '濮陽', '鍾離'
  ];

  function splitFullName(fullName) {
    const s = String(fullName || '').trim();
    if (!s) return { lastName: '', firstName: '' };
    if (/[a-zA-Z]/.test(s) && s.includes(' ')) {
      const parts = s.split(/\s+/);
      return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
    }
    for (const cs of COMPOUND_SURNAMES_28) {
      if (s.startsWith(cs) && s.length > cs.length) {
        return { lastName: cs, firstName: s.slice(cs.length) };
      }
    }
    if (/^[\u4e00-\u9fff]{2,5}$/.test(s)) {
      return { lastName: s.slice(0, 1), firstName: s.slice(1) };
    }
    return { lastName: s, firstName: '' };
  }

  function mergeNameParts(lastName, firstName) {
    const l = String(lastName || '').trim();
    const f = String(firstName || '').trim();
    if (!l) return f;
    if (!f) return l;
    if (/^[a-zA-Z\s.-]+$/.test(l + f)) return `${f} ${l}`.trim();
    return `${l}${f}`;
  }

  function zhToEnEventName(zh) {
    let s = String(zh || '').trim();
    if (!s) return '';
    const dict = [
      ['超級馬拉松', ' Ultra Marathon'], ['超馬', ' Ultra'], ['馬拉松', ' Marathon'],
      ['繞圈計時賽', ' Lap Timed Race'], ['繞圈賽', ' Lap Ultra'], ['越野挑戰賽', ' Trail Challenge'],
      ['越野賽', ' Trail Run'], ['挑戰賽', ' Challenge'], ['八百壯士', ' 800 Warriors'],
      ['台灣', ' Taiwan'], ['臺灣', ' Taiwan'], ['台北', ' Taipei'], ['臺北', ' Taipei'],
      ['新北', ' New Taipei'], ['台中', ' Taichung'], ['高雄', ' Kaohsiung'], ['花蓮', ' Hualien'],
      ['宜蘭', ' Yilan'], ['陽明山', ' Yangmingshan'], ['日月潭', ' Sun Moon Lake'],
      ['小時', 'H'], ['春季', ' Spring'], ['夏季', ' Summer'], ['秋季', ' Autumn'], ['冬季', ' Winter'],
      ['路跑', ' Road Run'], ['公益', ' Charity'], ['錦標賽', ' Championship']
    ];
    dict.forEach(([k, v]) => { s = s.split(k).join(v); });
    s = s.replace(/[\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s || 'TUR Taiwan Ultra Marathon';
  }

  function verifyTaiwanIdChecksum(id) {
    const s = String(id || '').trim().toUpperCase();
    if (!/^[A-Z][1289]\d{8}$/.test(s)) return false;
    const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
    const n = letters.indexOf(s[0]) + 10;
    const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
    const digits = [Math.floor(n / 10), n % 10, ...s.slice(1).split('').map(Number)];
    return digits.reduce((acc, d, i) => acc + d * weights[i], 0) % 10 === 0;
  }

  function inferGenderFromId(id) {
    const s = String(id || '').trim().toUpperCase();
    if (/^[A-Z][18]/.test(s)) return 'M';
    if (/^[A-Z][29]/.test(s)) return 'F';
    return '';
  }

  function calcAge(birthdayStr) {
    if (!birthdayStr) return null;
    const dob = new Date(birthdayStr);
    if (isNaN(dob.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
  }

  async function sha256Hex(str) {
    const text = String(str || '').trim().toUpperCase();
    if (!text) return '';
    try {
      if (global.crypto && global.crypto.subtle) {
        const buf = new TextEncoder().encode(text);
        const hashBuf = await global.crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) {}
    // Fallback deterministic hash for non-HTTPS file:// contexts without crypto.subtle
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
  }

  /* --------------------------------------------------------------------------
   * 3. 10 款精選活動橫幅 Preset + 預設表單 / 證書設定
   * -------------------------------------------------------------------------- */
  const CURATED_BANNERS = [
    { id: 'banner-1', name: '1. 晨曦超馬金藍', css: 'linear-gradient(135deg,#0f172a 0%,#1d4ed8 55%,#f59e0b 100%)' },
    { id: 'banner-2', name: '2. 夜間繞圈極光', css: 'linear-gradient(135deg,#09090b 0%,#312e81 55%,#06b6d4 100%)' },
    { id: 'banner-3', name: '3. 八百壯士赤焰', css: 'linear-gradient(135deg,#450a0a 0%,#b91c1c 55%,#f59e0b 100%)' },
    { id: 'banner-4', name: '4. 山林越野森綠', css: 'linear-gradient(135deg,#052e16 0%,#15803d 60%,#84cc16 100%)' },
    { id: 'banner-5', name: '5. 東海岸太平洋', css: 'linear-gradient(135deg,#0c4a6e 0%,#0284c7 55%,#2dd4bf 100%)' },
    { id: 'banner-6', name: '6. 皇室黑金榮耀', css: 'linear-gradient(135deg,#09090b 0%,#27272a 60%,#eab308 100%)' },
    { id: 'banner-7', name: '7. 櫻花春季路跑', css: 'linear-gradient(135deg,#500724 0%,#be185d 55%,#f9a8d4 100%)' },
    { id: 'banner-8', name: '8. 高山雲海紫金', css: 'linear-gradient(135deg,#2e1065 0%,#6d28d9 55%,#fbbf24 100%)' },
    { id: 'banner-9', name: '9. 破曉橘紅極速', css: 'linear-gradient(135deg,#431407 0%,#ea580c 55%,#fde047 100%)' },
    { id: 'banner-10', name: '10. 鋼鐵城市灰藍', css: 'linear-gradient(135deg,#1e293b 0%,#475569 55%,#38bdf8 100%)' }
  ];

  function getBannerStyle(bannerUrl) {
    if (!bannerUrl) return `background:${CURATED_BANNERS[0].css};`;
    if (String(bannerUrl).startsWith('data:') || /^https?:\/\//i.test(bannerUrl)) {
      return `background-image:url('${bannerUrl}');background-size:cover;background-position:center;`;
    }
    const preset = CURATED_BANNERS.find((b) => b.id === bannerUrl) || CURATED_BANNERS[0];
    return `background:${preset.css};`;
  }

  function defaultFormSchema() {
    return {
      addons: [
        { code: 'jacket', name: '紀念防風外套', price: 680 },
        { code: 'laser', name: '獎牌雷射刻字', price: 150 },
        { code: 'shuttle', name: '會場接駁專車', price: 250 }
      ],
      customFields: []
    };
  }

  function defaultCertConfig() {
    return {
      engine: 'official', // 'official' | 'custom'
      orientation: 'landscape', // 'landscape' | 'portrait'
      layoutId: 'classic',
      paletteId: 'tur-gold',
      customBgDataUrl: '',
      customTextPos: {
        nameX: 0.5, nameY: 0.42,
        bibX: 0.5, bibY: 0.50,
        resultX: 0.5, resultY: 0.62,
        color: '#ffffff',
        align: 'center'
      },
      // 基本與成績欄位開關
      showEventName: true,
      showRunnerName: true,
      showBib: true,
      showCategory: true,
      showPrimaryResult: true,
      showSecondaryResult: true,
      showDate: true,
      // 進階榮譽與分析開關
      showOverallRank: true,
      showCatRank: true,
      showPace: true,
      showSplitAnalysis: true,
      showOfficialStamp: true,
      allowPublicPhotoQuote: true,
      enableWarrior800: true
    };
  }

  function parseJsonSafe(str, fallback) {
    try {
      if (!str) return fallback;
      return typeof str === 'object' ? { ...fallback, ...str } : { ...fallback, ...JSON.parse(str) };
    } catch (_) { return fallback; }
  }

  /* --------------------------------------------------------------------------
   * 4. IndexedDB Wrapper (8 Core Stores + syncQueue)
   * -------------------------------------------------------------------------- */
  const TurDB = (() => {
    const DB_NAME = 'TUR_GOVERNANCE_V3_DB';
    const DB_VERSION = 1;
    const KEY_PATHS = {
      events: 'eventId',
      categories: 'catId',
      stations: 'stationId',
      participants: 'participantId',
      timingLogs: 'logId',
      historyResults: 'historyId',
      users: 'username',
      globalConfig: 'configKey',
      syncQueue: 'qid'
    };
    const STORES = Object.keys(KEY_PATHS);
    let db = null;

    function open() {
      return new Promise((resolve, reject) => {
        if (db) return resolve(db);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const idb = e.target.result;
          STORES.forEach((s) => {
            if (!idb.objectStoreNames.contains(s)) {
              idb.createObjectStore(s, { keyPath: KEY_PATHS[s] });
            }
          });
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }

    function sanitize(storeName, items) {
      const kf = KEY_PATHS[storeName];
      const out = [];
      for (const it of (items || [])) {
        if (!it || typeof it !== 'object') continue;
        const v = it[kf];
        if (v === undefined || v === null || String(v).trim() === '') continue;
        out.push({ ...it, [kf]: String(v).trim() });
      }
      return out;
    }

    async function getAll(storeName) {
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async function put(storeName, item) {
      const list = sanitize(storeName, [item]);
      if (!list.length) return item;
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(list[0]);
        tx.oncomplete = () => resolve(list[0]);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function bulkPut(storeName, items) {
      const list = sanitize(storeName, items);
      if (!list.length) return;
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        list.forEach((it) => store.put(it));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function clearAndFill(storeName, items) {
      const list = sanitize(storeName, items);
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        list.forEach((it) => store.put(it));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function remove(storeName, key) {
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(String(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function clear(storeName) {
      const idb = await open();
      return new Promise((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    return { open, getAll, put, bulkPut, clearAndFill, remove, clear, STORES, KEY_PATHS };
  })();

  /* --------------------------------------------------------------------------
   * 5. GAS Networking (JSON + JSONP Auto-Fallback + Diagnostics)
   * -------------------------------------------------------------------------- */
  function validateGasUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) throw new Error('尚未填入 GAS Web App 網址');
    if (url.includes('docs.google.com/spreadsheets')) {
      throw new Error('您貼入的是試算表網址，請改貼 Apps Script 部署後的 /exec 網址');
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('網址必須以 https:// 開頭');
    if (/\/dev(\?|$)/i.test(url)) throw new Error('請勿使用測試網址 (/dev)，請改貼正式部署的 /exec 網址');
    return url;
  }

  function buildGasQueryUrl(baseUrl, params = {}) {
    const u = new URL(validateGasUrl(baseUrl));
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    });
    u.searchParams.set('_t', String(Date.now()));
    return u.toString();
  }

  function parseGasText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('伺服器回傳空白內容');
    if (trimmed.startsWith('<')) {
      if (/accounts\.google\.com|ServiceLogin|Sign in/i.test(trimmed)) {
        throw new Error('GAS 存取權限不足：請將部署作業「誰可以存取」設為「所有人」並建立新版本');
      }
      throw new Error('GAS 回傳了 HTML 網頁而非 JSON（請確認 /exec 網址與「所有人」權限）');
    }
    return JSON.parse(trimmed);
  }

  function gasJsonp(baseUrl, params = {}) {
    return new Promise((resolve, reject) => {
      const cb = '__turV3Cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      const sc = document.createElement('script');
      let done = false;
      const cleanup = () => { done = true; delete global[cb]; if (sc.parentNode) sc.parentNode.removeChild(sc); };
      const timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('GAS 連線逾時 (15秒)')); } }, 15000);
      global[cb] = (data) => { clearTimeout(timer); cleanup(); resolve(data); };
      sc.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('無法載入 GAS 腳本（請檢查網址與部署權限）')); };
      sc.src = buildGasQueryUrl(baseUrl, { ...params, callback: cb });
      document.head.appendChild(sc);
    });
  }

  async function gasGet(baseUrl, params = {}) {
    const fullUrl = buildGasQueryUrl(baseUrl, params);
    try {
      const resp = await fetch(fullUrl, { method: 'GET', redirect: 'follow', cache: 'no-store' });
      return parseGasText(await resp.text());
    } catch (err) {
      if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
        return await gasJsonp(baseUrl, params);
      }
      throw err;
    }
  }

  async function gasPost(baseUrl, bodyObj) {
    const url = validateGasUrl(baseUrl);
    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(bodyObj)
    });
    return parseGasText(await resp.text());
  }

  /* --------------------------------------------------------------------------
   * 6. Dual-Mode Race Results Calculator (Distance + Lap Timed + 800 Warriors)
   * -------------------------------------------------------------------------- */
  function isWarrior800Eligible(eventName, catName, totalDistanceKm) {
    if (Number(totalDistanceKm || 0) >= 100) return true;
    const text = `${eventName || ''} ${catName || ''}`;
    return /八百壯士|800壯士|100K|100KM/i.test(text) && Number(totalDistanceKm || 0) >= 99.5;
  }

  function computeLeaderboard({ event, categories, stations, participants, timingLogs }) {
    if (!event) return [];
    const catMap = new Map(categories.filter((c) => c.eventId === event.eventId).map((c) => [c.catId, c]));
    const evStations = stations
      .filter((s) => s.eventId === event.eventId && String(s.stationCode).toUpperCase() !== 'CHECKIN')
      .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const evParts = participants.filter((p) => p.eventId === event.eventId && String(p.payStatus).toUpperCase() === 'PAID' && p.bibNumber);
    const validLogs = timingLogs.filter((l) => l.eventId === event.eventId && l.isValid !== false);

    const logsByBib = new Map();
    for (const l of validLogs) {
      const b = String(l.bibNumber || '').toUpperCase();
      if (!logsByBib.has(b)) logsByBib.set(b, []);
      logsByBib.get(b).push(l);
    }
    for (const arr of logsByBib.values()) {
      arr.sort((a, b) => (parseDateTime(a.sensedTime)?.getTime() || 0) - (parseDateTime(b.sensedTime)?.getTime() || 0));
    }

    const rows = evParts.map((p) => {
      const cat = catMap.get(p.catId) || { name: '-', distanceKm: 0, timeLimitHours: 0 };
      const startDt = parseDateTime(cat.customRaceStart || event.raceStart);
      const bib = String(p.bibNumber).toUpperCase();
      const pLogs = logsByBib.get(bib) || [];
      const penaltySec = Math.round(Number(p.penaltySeconds || 0));

      if (event.raceType === 'lap_timed') {
        const limitSec = Number(cat.timeLimitHours || 12) * 3600;
        const lapDist = Number(event.lapDistanceKm || cat.distanceKm || 1.0);
        const lapLogs = pLogs.filter((l) => String(l.stationCode).toUpperCase() === 'LAP');
        const validLaps = [];
        const splitDetails = [];
        let overtimeCount = 0;
        let prevDt = startDt;

        lapLogs.forEach((ll, idx) => {
          const dt = parseDateTime(ll.sensedTime);
          const elapsed = (startDt && dt) ? Math.round((dt.getTime() - startDt.getTime()) / 1000) : 0;
          const lapSec = (prevDt && dt) ? Math.max(1, Math.round((dt.getTime() - prevDt.getTime()) / 1000)) : null;
          if (!startDt || elapsed <= limitSec) {
            validLaps.push({ ...ll, elapsed });
            splitDetails.push({
              code: `LAP #${validLaps.length}`,
              name: `第 ${validLaps.length} 圈`,
              time: String(ll.sensedTime).slice(11),
              cumSec: elapsed,
              segSec: lapSec,
              segPace: lapSec ? formatPace(lapSec, lapDist) : '--:--'
            });
            prevDt = dt || prevDt;
          } else {
            overtimeCount++;
          }
        });

        const lapCount = validLaps.length;
        const totalDistanceKm = Number((lapCount * lapDist).toFixed(3));
        const lastLap = validLaps[validLaps.length - 1];
        const elapsedSec = lastLap && startDt ? Math.max(0, lastLap.elapsed + penaltySec) : null;
        const status = p.raceStatus === 'dnf' ? 'dnf' : (event.status === 'finished' && lapCount > 0 ? 'finished' : (lapCount > 0 ? (p.raceStatus === 'finished' ? 'finished' : 'on_track') : p.raceStatus));

        return {
          event, participant: p, category: cat, raceType: 'lap_timed',
          lapCount, overtimeCount, totalDistanceKm, elapsedSec,
          avgPace: elapsedSec && totalDistanceKm > 0 ? formatPace(elapsedSec, totalDistanceKm) : '--:--',
          splits: {}, splitDetails,
          isWarrior800: isWarrior800Eligible(event.nameZh, cat.name, totalDistanceKm),
          status
        };
      } else {
        const splits = {};
        const splitDetails = [];
        let prevTime = startDt;
        let prevKm = 0;
        let maxKm = 0;

        for (const st of evStations) {
          const found = pLogs.find((l) => String(l.stationCode).toUpperCase() === String(st.stationCode).toUpperCase());
          if (found) {
            const dt = parseDateTime(found.sensedTime);
            const cumSec = (startDt && dt) ? Math.max(0, Math.round((dt.getTime() - startDt.getTime()) / 1000)) : null;
            const segSec = (prevTime && dt) ? Math.max(0, Math.round((dt.getTime() - prevTime.getTime()) / 1000)) : null;
            const stKm = st.stationCode === 'FINISH' ? Number(cat.distanceKm || st.distanceKm || 0) : Number(st.distanceKm || 0);
            const segKm = Math.max(0.1, stKm - prevKm);
            const spObj = {
              code: st.stationCode,
              name: st.name,
              time: String(found.sensedTime).slice(11),
              cumSec,
              segSec,
              segPace: segSec ? formatPace(segSec, segKm) : '--:--'
            };
            splits[st.stationCode] = spObj;
            splitDetails.push(spObj);
            prevTime = dt || prevTime;
            prevKm = stKm;
            maxKm = Math.max(maxKm, stKm);
          }
        }

        const finLog = pLogs.find((l) => String(l.stationCode).toUpperCase() === 'FINISH');
        let elapsedSec = null;
        if (finLog && startDt) {
          const fdt = parseDateTime(finLog.sensedTime);
          if (fdt) elapsedSec = Math.max(0, Math.round((fdt.getTime() - startDt.getTime()) / 1000) + penaltySec);
        }
        const totalDistanceKm = finLog ? Number(cat.distanceKm || maxKm) : maxKm;
        const status = p.raceStatus === 'dnf' ? 'dnf' : (finLog ? 'finished' : (pLogs.length > 0 ? 'on_track' : p.raceStatus));

        return {
          event, participant: p, category: cat, raceType: 'distance',
          lapCount: 0, overtimeCount: 0, totalDistanceKm, elapsedSec,
          avgPace: elapsedSec && totalDistanceKm > 0 ? formatPace(elapsedSec, totalDistanceKm) : '--:--',
          splits, splitDetails,
          isWarrior800: status === 'finished' && isWarrior800Eligible(event.nameZh, cat.name, totalDistanceKm),
          status
        };
      }
    });

    rows.sort((a, b) => {
      if (event.raceType === 'lap_timed') {
        if (b.totalDistanceKm !== a.totalDistanceKm) return b.totalDistanceKm - a.totalDistanceKm;
        if (a.elapsedSec === null && b.elapsedSec === null) return String(a.participant.bibNumber).localeCompare(String(b.participant.bibNumber));
        if (a.elapsedSec === null) return 1;
        if (b.elapsedSec === null) return -1;
        return a.elapsedSec - b.elapsedSec;
      }
      const order = { finished: 0, on_track: 1, dnf: 2, dns: 3 };
      const ao = order[a.status] ?? 3;
      const bo = order[b.status] ?? 3;
      if (ao !== bo) return ao - bo;
      if (ao === 0 && b.totalDistanceKm !== a.totalDistanceKm) return b.totalDistanceKm - a.totalDistanceKm;
      if (ao === 0 && a.elapsedSec !== null && b.elapsedSec !== null) return a.elapsedSec - b.elapsedSec;
      if (b.totalDistanceKm !== a.totalDistanceKm) return b.totalDistanceKm - a.totalDistanceKm;
      return String(a.participant.bibNumber).localeCompare(String(b.participant.bibNumber));
    });

    const catRanks = new Map();
    let overall = 0;
    rows.forEach((r) => {
      const scored = (r.raceType === 'distance' && r.status === 'finished') || (r.raceType === 'lap_timed' && r.lapCount > 0);
      if (scored) {
        overall++;
        r.overallRank = overall;
        const nextC = (catRanks.get(r.participant.catId) || 0) + 1;
        catRanks.set(r.participant.catId, nextC);
        r.catRank = nextC;
      } else {
        r.overallRank = '-';
        r.catRank = '-';
      }
    });
    return rows;
  }

  /* --------------------------------------------------------------------------
   * 7. 動態完賽證書引擎（官方 6×6 橫/直式 + 自訂底圖拖曳 + 全自由開關）
   * -------------------------------------------------------------------------- */
  const CERT_LAYOUTS = [
    { id: 'classic', name: '1. 經典榮耀' },
    { id: 'diagonal', name: '2. 極速斜切' },
    { id: 'minimal', name: '3. 超馬極簡' },
    { id: 'trail', name: '4. 山水越野' },
    { id: 'neon', name: '5. 夜間霓虹' },
    { id: 'podium', name: '6. 金獎頒獎台' }
  ];

  const CERT_PALETTES = [
    { id: 'tur-gold', name: 'TUR 藍金', bg1: '#0f172a', bg2: '#1e293b', accent: '#f59e0b', accent2: '#38bdf8', text: '#ffffff', sub: '#cbd5e1' },
    { id: 'obsidian', name: '冠軍黑金', bg1: '#09090b', bg2: '#18181b', accent: '#eab308', accent2: '#fbbf24', text: '#fafafa', sub: '#a1a1aa' },
    { id: 'forest', name: '越野森綠', bg1: '#052e16', bg2: '#14532d', accent: '#4ade80', accent2: '#facc15', text: '#f0fdf4', sub: '#bbf7d0' },
    { id: 'lava', name: '日出熔岩', bg1: '#431407', bg2: '#7c2d12', accent: '#fb923c', accent2: '#fde047', text: '#fff7ed', sub: '#fed7aa' },
    { id: 'aurora', name: '櫻花極光', bg1: '#3b0764', bg2: '#831843', accent: '#f472b6', accent2: '#38bdf8', text: '#fdf2f8', sub: '#fbcfe8' },
    { id: 'royal', name: '皇室白金', bg1: '#f8fafc', bg2: '#e2e8f0', accent: '#0f172a', accent2: '#d97706', text: '#0f172a', sub: '#475569' }
  ];

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCoverImage(ctx, img, x, y, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function renderCertificateCanvas(canvas, row, configInput, userOpts = {}) {
    const cfg = { ...defaultCertConfig(), ...(configInput || {}) };
    const isPortrait = cfg.orientation === 'portrait';
    const W = isPortrait ? 1131 : 1600;
    const H = isPortrait ? 1600 : 1131;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    const pal = CERT_PALETTES.find((p) => p.id === cfg.paletteId) || CERT_PALETTES[0];
    const ev = row?.event || { nameZh: 'TUR 台灣超級馬拉松挑戰賽', nameEn: 'TUR Taiwan Ultra Marathon', raceStart: '2026-11-26', organizerZh: 'TUR 台灣超馬協會' };
    const p = row?.participant || { name: '示範選手', bibNumber: 'A001', nationality: 'TWN', gender: 'M' };
    const cat = row?.category || { name: '50K 超馬組', distanceKm: 50 };

    ctx.clearRect(0, 0, W, H);

    // 1. 背景層
    if (cfg.engine === 'custom' && userOpts.customBgImg) {
      drawCoverImage(ctx, userOpts.customBgImg, 0, 0, W, H);
      // 自訂底圖拖曳套印模式
      const pos = cfg.customTextPos || defaultCertConfig().customTextPos;
      ctx.fillStyle = pos.color || '#ffffff';
      ctx.textAlign = pos.align || 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 10;

      if (cfg.showRunnerName) {
        ctx.font = '900 84px "Noto Sans TC", sans-serif';
        ctx.fillText(p.name, W * pos.nameX, H * pos.nameY);
      }
      if (cfg.showBib || cfg.showCategory) {
        ctx.font = '700 34px monospace';
        const parts = [];
        if (cfg.showBib) parts.push(`BIB ${p.bibNumber}`);
        if (cfg.showCategory) parts.push(cat.name);
        ctx.fillText(parts.join('  ·  '), W * pos.bibX, H * pos.bibY);
      }
      if (cfg.showPrimaryResult) {
        const primary = ev.raceType === 'lap_timed'
          ? `${Number(row?.totalDistanceKm || 0).toFixed(2)} KM`
          : formatDuration(row?.elapsedSec);
        ctx.font = '900 66px monospace';
        ctx.fillText(primary, W * pos.resultX, H * pos.resultY);
      }
      ctx.shadowBlur = 0;
      if (cfg.enableWarrior800 && row?.isWarrior800) drawWarriorBadge(ctx, W - 210, 120);
      if (cfg.showOfficialStamp) drawOfficialStamp(ctx, W - 180, H - 170, pal.accent);
      return;
    }

    // 官方 6×6 漸層底圖與版型幾何
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, pal.bg1);
    grad.addColorStop(1, pal.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (cfg.layoutId === 'classic') {
      ctx.strokeStyle = pal.accent; ctx.lineWidth = 10; ctx.strokeRect(40, 40, W - 80, H - 80);
      ctx.lineWidth = 2; ctx.strokeRect(58, 58, W - 116, H - 116);
    } else if (cfg.layoutId === 'diagonal') {
      ctx.fillStyle = pal.accent; ctx.globalAlpha = 0.16;
      ctx.beginPath(); ctx.moveTo(W * 0.56, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(W * 0.36, H); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillRect(0, 0, 24, H);
    } else if (cfg.layoutId === 'minimal') {
      ctx.fillStyle = pal.accent; ctx.fillRect(80, 100, 110, 8); ctx.fillRect(80, H - 110, W - 160, 3);
    } else if (cfg.layoutId === 'trail') {
      ctx.fillStyle = pal.accent; ctx.globalAlpha = 0.14;
      ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, H * 0.72); ctx.lineTo(W * 0.25, H * 0.54);
      ctx.lineTo(W * 0.5, H * 0.74); ctx.lineTo(W * 0.75, H * 0.46); ctx.lineTo(W, H * 0.62); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    } else if (cfg.layoutId === 'neon') {
      ctx.shadowColor = pal.accent2; ctx.shadowBlur = 24;
      ctx.strokeStyle = pal.accent2; ctx.lineWidth = 6; ctx.strokeRect(46, 46, W - 92, H - 92);
      ctx.shadowBlur = 0;
    } else if (cfg.layoutId === 'podium') {
      ctx.fillStyle = pal.accent; ctx.fillRect(0, 0, W, 165);
      ctx.fillStyle = pal.accent2; ctx.fillRect(0, 165, W, 10);
    }
    ctx.restore();

    // 2. 選手個人照片框（若開放且有上傳照片，支援 3 款相框：rounded / circle / polaroid）
    const showPhoto = cfg.allowPublicPhotoQuote && (userOpts.photoImg || userOpts.showPhotoPlaceholder);
    const photoBox = isPortrait
      ? { x: W - 430, y: 230, w: 340, h: 410 }
      : { x: 1010, y: 220, w: 500, h: 610 };

    if (showPhoto) {
      const frameStyle = userOpts.photoFrame || 'rounded';
      ctx.save();
      if (frameStyle === 'polaroid') {
        ctx.fillStyle = '#ffffff';
        roundRectPath(ctx, photoBox.x - 16, photoBox.y - 16, photoBox.w + 32, photoBox.h + 72, 10);
        ctx.fill();
      }
      if (frameStyle === 'circle') {
        const rad = Math.min(photoBox.w, photoBox.h) / 2;
        ctx.beginPath();
        ctx.arc(photoBox.x + photoBox.w / 2, photoBox.y + photoBox.h / 2, rad, 0, Math.PI * 2);
        ctx.clip();
      } else {
        roundRectPath(ctx, photoBox.x, photoBox.y, photoBox.w, photoBox.h, frameStyle === 'polaroid' ? 4 : 22);
        ctx.clip();
      }

      if (userOpts.photoImg) {
        const iw = userOpts.photoImg.width, ih = userOpts.photoImg.height;
        const scale = Math.max(photoBox.w / iw, photoBox.h / ih) * (userOpts.photoZoom || 1);
        const dw = iw * scale, dh = ih * scale;
        const dx = photoBox.x + (photoBox.w - dw) / 2 + (userOpts.photoOffsetX || 0);
        const dy = photoBox.y + (photoBox.h - dh) / 2 + (userOpts.photoOffsetY || 0);
        ctx.drawImage(userOpts.photoImg, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(photoBox.x, photoBox.y, photoBox.w, photoBox.h);
        ctx.fillStyle = pal.sub;
        ctx.font = 'bold 26px "Noto Sans TC", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('選手完賽照片區', photoBox.x + photoBox.w / 2, photoBox.y + photoBox.h / 2 - 8);
        ctx.font = '18px "Noto Sans TC", sans-serif';
        ctx.fillText('（支援 3 款相框 / 拖曳縮放）', photoBox.x + photoBox.w / 2, photoBox.y + photoBox.h / 2 + 28);
      }
      ctx.restore();

      if (frameStyle !== 'polaroid') {
        ctx.strokeStyle = pal.accent; ctx.lineWidth = 4;
        if (frameStyle === 'circle') {
          ctx.beginPath();
          ctx.arc(photoBox.x + photoBox.w / 2, photoBox.y + photoBox.h / 2, Math.min(photoBox.w, photoBox.h) / 2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          roundRectPath(ctx, photoBox.x, photoBox.y, photoBox.w, photoBox.h, 22);
          ctx.stroke();
        }
      }
    }

    // 3. 左側標題與選手資訊
    ctx.textAlign = 'left';
    const isPodium = cfg.layoutId === 'podium';
    let curY = 108;

    ctx.fillStyle = isPodium ? '#0f172a' : pal.accent;
    ctx.font = '900 26px "Noto Sans TC", sans-serif';
    ctx.fillText('OFFICIAL FINISHER CERTIFICATE · 完賽證明', 90, curY);
    curY += 50;

    if (cfg.showEventName) {
      ctx.fillStyle = isPodium ? '#0f172a' : pal.text;
      ctx.font = '900 42px "Noto Sans TC", sans-serif';
      ctx.fillText(ev.nameZh || '', 90, curY);
      curY += 42;
      ctx.fillStyle = pal.sub;
      ctx.font = '600 20px sans-serif';
      ctx.fillText(ev.nameEn || '', 90, curY);
      curY += 72;
    } else {
      curY += 50;
    }

    if (cfg.showRunnerName) {
      ctx.fillStyle = pal.text;
      ctx.font = '900 78px "Noto Sans TC", sans-serif';
      ctx.fillText(p.name || '-', 90, curY);
      curY += 54;
    }

    const metaParts = [];
    if (cfg.showBib) metaParts.push(`BIB ${p.bibNumber || '---'}`);
    metaParts.push(p.nationality || 'TWN');
    if (cfg.showCategory) metaParts.push(cat.name);
    if (metaParts.length) {
      ctx.fillStyle = pal.accent2;
      ctx.font = '800 28px monospace';
      ctx.fillText(metaParts.join('  ·  '), 90, curY);
      curY += 40;
    }

    // 4. 動態成績卡片網格
    const cards = [];
    if (cfg.showPrimaryResult) {
      cards.push(ev.raceType === 'lap_timed'
        ? { label: 'TOTAL DISTANCE 有效里程', val: `${Number(row?.totalDistanceKm || 0).toFixed(2)} KM` }
        : { label: 'OFFICIAL TIME 完賽成績', val: formatDuration(row?.elapsedSec) });
    }
    if (cfg.showSecondaryResult) {
      cards.push(ev.raceType === 'lap_timed'
        ? { label: 'LAPS / TIME 有效圈數與時間', val: `${row?.lapCount || 0} 圈 (${formatDuration(row?.elapsedSec)})` }
        : { label: 'DISTANCE 完賽距離', val: `${Number(row?.totalDistanceKm ?? cat.distanceKm ?? 0).toFixed(1)} KM` });
    }
    if (cfg.showOverallRank || cfg.showCatRank) {
      const rParts = [];
      if (cfg.showOverallRank) rParts.push(`總 #${row?.overallRank ?? '-'}`);
      if (cfg.showCatRank) rParts.push(`組 #${row?.catRank ?? '-'}`);
      cards.push({ label: 'RANKING 名次', val: rParts.join(' / ') });
    }
    if (cfg.showPace) {
      cards.push({ label: 'AVG PACE 平均配速', val: row?.avgPace || '--:--' });
    }

    const cardAreaW = showPhoto && !isPortrait ? 860 : W - 180;
    const cols = 2;
    const gap = 18;
    const cardW = (cardAreaW - gap) / cols;
    const cardH = 96;

    cards.forEach((c, idx) => {
      const col = idx % cols;
      const r = Math.floor(idx / cols);
      const x = 90 + col * (cardW + gap);
      const y = curY + r * (cardH + 16);
      ctx.fillStyle = pal.id === 'royal' ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.08)';
      roundRectPath(ctx, x, y, cardW, cardH, 14);
      ctx.fill();
      ctx.fillStyle = pal.sub;
      ctx.font = '700 18px "Noto Sans TC", sans-serif';
      ctx.fillText(c.label, x + 22, y + 32);
      ctx.fillStyle = pal.accent;
      ctx.font = '900 36px monospace';
      ctx.fillText(c.val, x + 22, y + 76);
    });

    curY += Math.ceil(cards.length / cols) * (cardH + 16) + 20;

    // 5. 感應點區段均速與綜合分析表（若承辦人開啟）
    if (cfg.showSplitAnalysis && row?.splitDetails && row.splitDetails.length > 0) {
      const splits = row.splitDetails.slice(0, isPortrait ? 8 : 4);
      const boxH = 44 + splits.length * 34;
      ctx.fillStyle = pal.id === 'royal' ? 'rgba(15,23,42,0.05)' : 'rgba(255,255,255,0.06)';
      roundRectPath(ctx, 90, curY, cardAreaW, boxH, 14);
      ctx.fill();

      ctx.fillStyle = pal.accent2;
      ctx.font = '700 18px "Noto Sans TC", sans-serif';
      ctx.fillText('CHECKPOINT SPLIT ANALYSIS · 感應點區段均速分析', 112, curY + 30);

      splits.forEach((sp, i) => {
        const sy = curY + 62 + i * 34;
        ctx.fillStyle = pal.text;
        ctx.font = '600 19px monospace';
        ctx.fillText(`${sp.code.padEnd(8, ' ')}  通過 ${sp.time}  |  累計 ${formatDuration(sp.cumSec)}  |  區段均速 ${sp.segPace}`, 112, sy);
      });
      curY += boxH + 22;
    }

    // 6. 選手 40 字完賽感言
    const quote = String(userOpts.quote || '').trim().slice(0, 40);
    if (cfg.allowPublicPhotoQuote && quote) {
      ctx.fillStyle = pal.accent;
      ctx.fillRect(90, curY, 7, 54);
      ctx.fillStyle = pal.text;
      ctx.font = 'italic 600 24px "Noto Sans TC", sans-serif';
      ctx.fillText(`「${quote}」`, 114, curY + 36);
      curY += 74;
    }

    // 7. 八百壯士 100K+ 專屬榮譽徽章
    if (cfg.enableWarrior800 && row?.isWarrior800) {
      drawWarriorBadge(ctx, isPortrait ? W - 160 : 900, 125);
    }

    // 8. 大會鋼印章戳
    if (cfg.showOfficialStamp) {
      drawOfficialStamp(ctx, W - 165, H - 155, pal.accent);
    }

    // 9. 頁尾日期與主辦單位
    if (cfg.showDate) {
      ctx.fillStyle = pal.sub;
      ctx.font = '600 19px "Noto Sans TC", sans-serif';
      const dateStr = (ev.raceStart || formatDateTime()).slice(0, 10);
      ctx.fillText(`DATE: ${dateStr}   |   ORGANIZER: ${ev.organizerZh || ev.organizerEn || 'TUR'}`, 90, H - 72);
    }
  }

  function drawWarriorBadge(ctx, cx, cy) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#b91c1c';
    ctx.beginPath(); ctx.arc(0, 0, 68, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = '#fef08a';
    ctx.textAlign = 'center';
    ctx.font = '900 20px "Noto Sans TC", sans-serif';
    ctx.fillText('八百壯士', 0, -10);
    ctx.font = '900 22px monospace';
    ctx.fillText('100K+', 0, 20);
    ctx.font = '700 12px sans-serif';
    ctx.fillText('WARRIOR', 0, 40);
    ctx.restore();
  }

  function drawOfficialStamp(ctx, cx, cy, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.18);
    ctx.strokeStyle = color; ctx.globalAlpha = 0.78; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 64, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 54, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center';
    ctx.font = '900 20px "Noto Sans TC", sans-serif';
    ctx.fillText('TUR 官方認證', 0, -4);
    ctx.font = '700 13px monospace';
    ctx.fillText('OFFICIAL TIMING', 0, 18);
    ctx.restore();
  }

  /* --------------------------------------------------------------------------
   * 8. 全情境 5 場測試資料（涵蓋距離賽、12H繞圈、八百壯士100K+、已結案雙場）
   * -------------------------------------------------------------------------- */
  function buildFull5EventsSeed() {
    const now = formatDateTime();
    const certJson = JSON.stringify(defaultCertConfig());
    const formJson = JSON.stringify(defaultFormSchema());

    const users = [
      { username: 'superadmin', passwordHash: 'tur2026', displayName: '最高管理員 Super Admin', role: 'super_admin', parentOrganizer: '', allowedEventId: 'ALL', allowedStation: 'ALL', enabled: 1 },
      { username: 'org_north', passwordHash: 'org2026', displayName: '北區賽事承辦人', role: 'organizer', parentOrganizer: '', allowedEventId: 'ALL', allowedStation: 'ALL', enabled: 1 },
      { username: 'org_south', passwordHash: 'org2026', displayName: '南區賽事承辦人', role: 'organizer', parentOrganizer: '', allowedEventId: 'ALL', allowedStation: 'ALL', enabled: 1 },
      { username: 'writer01', passwordHash: '1234', displayName: '晶片寫入發卡組 01', role: 'operator', parentOrganizer: 'org_north', allowedEventId: 'TUR-2026-50K', allowedStation: 'WRITER', enabled: 1 },
      { username: 'checkin01', passwordHash: '1234', displayName: '報到檢錄組 01', role: 'operator', parentOrganizer: 'org_north', allowedEventId: 'TUR-2026-50K', allowedStation: 'CHECKIN', enabled: 1 },
      { username: 'cp1', passwordHash: '1234', displayName: 'CP1 檢查站', role: 'operator', parentOrganizer: 'org_north', allowedEventId: 'TUR-2026-50K', allowedStation: 'CP1', enabled: 1 },
      { username: 'finish01', passwordHash: '1234', displayName: '終點衝線站', role: 'operator', parentOrganizer: 'org_north', allowedEventId: 'TUR-2026-50K', allowedStation: 'FINISH', enabled: 1 },
      { username: 'lap01', passwordHash: '1234', displayName: '12H 繞圈主拱門', role: 'operator', parentOrganizer: 'org_north', allowedEventId: 'TUR-2026-12H', allowedStation: 'LAP', enabled: 1 }
    ];

    const globalConfig = [
      { configKey: 'bankCode', configValue: '004', description: '大會收款銀行代碼', updatedAt: now },
      { configKey: 'bankName', configValue: '台灣銀行 台北分行', description: '大會收款銀行名稱', updatedAt: now },
      { configKey: 'bankAccount', configValue: '004-001-234567-8', description: '大會轉帳匯款帳號', updatedAt: now },
      { configKey: 'bankAccountName', configValue: '社團法人台灣超級馬拉松運動協會', description: '收款戶名', updatedAt: now },
      { configKey: 'payuniMerId', configValue: 'U00000001', description: 'PAYUNi 統一金流商店代號 MerID', updatedAt: now },
      { configKey: 'payuniHashKey', configValue: '12345678901234567890123456789012', description: 'PAYUNi HashKey (32碼)', updatedAt: now },
      { configKey: 'payuniHashIV', configValue: '1234567890123456', description: 'PAYUNi HashIV (16碼)', updatedAt: now },
      { configKey: 'autoSendEmail', configValue: '1', description: '自動寄發報名與入帳通知信 (1=開/0=關)', updatedAt: now }
    ];

    const events = [
      {
        eventId: 'TUR-2026-50K', ownerUsername: 'org_north',
        nameZh: '2026 TUR 台灣超級馬拉松挑戰賽', nameEn: '2026 TUR Taiwan Ultra Marathon Challenge',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '新北市烏來區',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-10-01 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '',
        maxQuota: 800, bannerUrl: 'banner-1', formSchemaJson: formJson, certConfigJson: certJson
      },
      {
        eventId: 'TUR-2026-12H', ownerUsername: 'org_north',
        nameZh: '2026 TUR 台北 12H 繞圈超馬賽', nameEn: '2026 TUR Taipei 12H Lap Ultra',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '台北田徑暖身場',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-01 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '',
        maxQuota: 400, bannerUrl: 'banner-2', formSchemaJson: formJson, certConfigJson: certJson
      },
      {
        eventId: 'TUR-2026-W800', ownerUsername: 'org_south',
        nameZh: '2026 高雄八百壯士 100K 超馬賽', nameEn: '2026 Kaohsiung 800 Warriors 100K Ultra',
        organizerZh: '南區超馬聯盟', organizerEn: 'South Taiwan Ultra Alliance', location: '高雄市旗山區',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-12-01 00:00:00', regEnd: '2027-01-31 23:59:59', raceStart: '',
        maxQuota: 300, bannerUrl: 'banner-3', formSchemaJson: formJson, certConfigJson: certJson
      },
      {
        eventId: 'TUR-2026-FIN100', ownerUsername: 'org_north',
        nameZh: '2026 TUR 春季陽明山 100K 八百壯士賽', nameEn: '2026 TUR Spring Yangmingshan 100K 800 Warriors',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '台北陽明山國家公園',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'finished',
        regStart: '2026-01-01 00:00:00', regEnd: '2026-03-31 23:59:59', raceStart: '2026-04-18 05:00:00',
        maxQuota: 500, bannerUrl: 'banner-4', formSchemaJson: formJson, certConfigJson: certJson
      },
      {
        eventId: 'TUR-2026-FIN24H', ownerUsername: 'org_south',
        nameZh: '2026 台南 24H 跨夜繞圈錦標賽', nameEn: '2026 Tainan 24H Overnight Lap Championship',
        organizerZh: '南區超馬聯盟', organizerEn: 'South Taiwan Ultra Alliance', location: '台南市立田徑場',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'finished',
        regStart: '2026-02-01 00:00:00', regEnd: '2026-05-01 23:59:59', raceStart: '2026-05-23 18:00:00',
        maxQuota: 300, bannerUrl: 'banner-6', formSchemaJson: formJson, certConfigJson: certJson
      }
    ];

    const categories = [
      { catId: 'CAT-50K', eventId: 'TUR-2026-50K', name: '50K 超馬組', distanceKm: 50, timeLimitHours: 8, fee: 1800, bibPrefix: 'A', bibStartNum: '001', quota: 300, customRaceStart: '' },
      { catId: 'CAT-100K', eventId: 'TUR-2026-50K', name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2600, bibPrefix: 'U', bibStartNum: '001', quota: 200, customRaceStart: '' },
      { catId: 'CAT-12H', eventId: 'TUR-2026-12H', name: '12H 繞圈組', distanceKm: 1.0, timeLimitHours: 12, fee: 2200, bibPrefix: 'L', bibStartNum: '001', quota: 200, customRaceStart: '' },
      { catId: 'CAT-6H', eventId: 'TUR-2026-12H', name: '6H 繞圈組', distanceKm: 1.0, timeLimitHours: 6, fee: 1500, bibPrefix: 'S', bibStartNum: '001', quota: 200, customRaceStart: '' },
      { catId: 'CAT-W800', eventId: 'TUR-2026-W800', name: '100K 八百壯士菁英組', distanceKm: 100, timeLimitHours: 15, fee: 2500, bibPrefix: 'W', bibStartNum: '001', quota: 300, customRaceStart: '' },
      { catId: 'CAT-FIN100', eventId: 'TUR-2026-FIN100', name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2600, bibPrefix: 'K', bibStartNum: '001', quota: 200, customRaceStart: '' },
      { catId: 'CAT-FIN50', eventId: 'TUR-2026-FIN100', name: '50K 挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1800, bibPrefix: 'F', bibStartNum: '001', quota: 300, customRaceStart: '' },
      { catId: 'CAT-FIN24H', eventId: 'TUR-2026-FIN24H', name: '24H 繞圈組', distanceKm: 1.0, timeLimitHours: 24, fee: 2800, bibPrefix: 'T', bibStartNum: '001', quota: 300, customRaceStart: '' }
    ];

    const stations = [
      { stationId: 'ST-50K-0', eventId: 'TUR-2026-50K', stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-50K-1', eventId: 'TUR-2026-50K', stationCode: 'CP1', name: 'CP1 水庫折返站', distanceKm: 25, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'ST-50K-2', eventId: 'TUR-2026-50K', stationCode: 'CP2', name: 'CP2 山脊補給站', distanceKm: 50, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'ST-50K-3', eventId: 'TUR-2026-50K', stationCode: 'FINISH', name: '終點衝線拱門', distanceKm: 100, stationType: 'finish', orderIndex: 3 },
      { stationId: 'ST-12H-0', eventId: 'TUR-2026-12H', stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-12H-1', eventId: 'TUR-2026-12H', stationCode: 'LAP', name: '主會場繞圈拱門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 },
      { stationId: 'ST-W800-0', eventId: 'TUR-2026-W800', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-W800-1', eventId: 'TUR-2026-W800', stationCode: 'FINISH', name: '終點衝線', distanceKm: 100, stationType: 'finish', orderIndex: 1 },
      { stationId: 'ST-F100-0', eventId: 'TUR-2026-FIN100', stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-F100-1', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', name: 'CP1 小油坑', distanceKm: 30, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'ST-F100-2', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', name: 'CP2 擎天崗', distanceKm: 65, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'ST-F100-3', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', name: '終點拱門', distanceKm: 100, stationType: 'finish', orderIndex: 3 },
      { stationId: 'ST-F24-0', eventId: 'TUR-2026-FIN24H', stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-F24-1', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', name: '田徑場繞圈門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 }
    ];

    const participants = [
      // 活動 1: 進行中 50K / 100K
      {
        participantId: 'TUR-20260001', eventId: 'TUR-2026-50K', catId: 'CAT-50K', bibNumber: 'A001', groupCode: '', groupName: '',
        name: '陳志明', lastName: '陳', firstName: '志明', idCard: 'A123456789', gender: 'M', birthday: '1988-05-12', age: 38, nationality: 'TWN',
        phone: '0912345678', email: 'chen@tur.tw', city: '台北市', emergencyName: '陳美玲', emergencyPhone: '0988111222',
        diet: '葷', remark: '', totalAmount: 2480, addonsDetail: '["紀念防風外套"]',
        payMethod: 'MANUAL_ATM', remittanceLast5: '88123', merTradeNo: '', payStatus: 'PAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '2026-10-02 10:00:00',
        chipUid: '04:A1:2B:99:10', checkinStatus: 'checked_in', raceStatus: 'dns', penaltySeconds: 0, createdAt: '2026-10-01 09:00:00'
      },
      {
        participantId: 'TUR-20260002', eventId: 'TUR-2026-50K', catId: 'CAT-100K', bibNumber: 'U001', groupCode: '', groupName: '',
        name: '歐陽晴', lastName: '歐陽', firstName: '晴', idCard: 'F223456786', gender: 'F', birthday: '1991-09-20', age: 35, nationality: 'TWN',
        phone: '0922334455', email: 'ouyang@tur.tw', city: '新北市', emergencyName: '歐陽明', emergencyPhone: '0933445566',
        diet: '素', remark: '素食便當', totalAmount: 2750, addonsDetail: '["獎牌雷射刻字"]',
        payMethod: 'ONLINE_PAYUNi', remittanceLast5: '', merTradeNo: 'PU2026100201', payStatus: 'PAID', paymentType: 'CREDIT', tradeNo: '26100299182', payInfo: '4242****4242', paidAt: '2026-10-02 10:16:12',
        chipUid: '04:B2:3C:88:20', checkinStatus: 'checked_in', raceStatus: 'dns', penaltySeconds: 0, createdAt: '2026-10-02 10:15:00'
      },
      {
        participantId: 'TUR-20260003', eventId: 'TUR-2026-50K', catId: 'CAT-50K', bibNumber: '', groupCode: 'GRP26-8801', groupName: '東京超馬團',
        name: 'Tanaka Kenji', lastName: 'Kenji', firstName: 'Tanaka', idCard: 'JP99887766', gender: 'M', birthday: '1985-03-14', age: 41, nationality: 'JPN',
        phone: '0911223344', email: 'kenji@jp-run.jp', city: '海外 / Overseas', emergencyName: 'Tanaka Yuko', emergencyPhone: '0966554433',
        diet: '葷', remark: '', totalAmount: 1800, remittanceLast5: '77654', merTradeNo: '', payStatus: 'UNPAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '',
        chipUid: '', checkinStatus: 'pending', raceStatus: 'dns', penaltySeconds: 0, createdAt: '2026-10-05 14:20:00'
      },
      {
        participantId: 'TUR-20260004', eventId: 'TUR-2026-50K', catId: 'CAT-50K', bibNumber: '', groupCode: 'GRP26-8801', groupName: '東京超馬團',
        name: '張家豪', lastName: '張', firstName: '家豪', idCard: 'B120123453', gender: 'M', birthday: '1995-11-02', age: 31, nationality: 'TWN',
        phone: '0955667788', email: 'chang@tur.tw', city: '台中市', emergencyName: '張媽媽', emergencyPhone: '0977889900',
        diet: '葷', remark: '', totalAmount: 2050, remittanceLast5: '77654', merTradeNo: '', payStatus: 'UNPAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '',
        chipUid: '', checkinStatus: 'pending', raceStatus: 'dns', penaltySeconds: 0, createdAt: '2026-10-05 14:21:00'
      },
      // 活動 2: 12H 繞圈
      {
        participantId: 'TUR-20260005', eventId: 'TUR-2026-12H', catId: 'CAT-12H', bibNumber: 'L001', groupCode: '', groupName: '',
        name: '王超馬', lastName: '王', firstName: '超馬', idCard: 'E121234565', gender: 'M', birthday: '1982-07-08', age: 44, nationality: 'TWN',
        phone: '0919888777', email: 'wang@tur.tw', city: '高雄市', emergencyName: '王太太', emergencyPhone: '0919666555',
        diet: '葷', remark: '', totalAmount: 2200, remittanceLast5: '99887', merTradeNo: '', payStatus: 'PAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '2026-10-08 08:00:00',
        chipUid: '04:C3:4D:77:30', checkinStatus: 'checked_in', raceStatus: 'dns', penaltySeconds: 0, createdAt: '2026-10-07 08:00:00'
      },
      // 活動 4: 已結案陽明山 100K 八百壯士賽
      {
        participantId: 'TUR-FIN-001', eventId: 'TUR-2026-FIN100', catId: 'CAT-FIN100', bibNumber: 'K001', groupCode: '', groupName: '',
        name: '陳志明', lastName: '陳', firstName: '志明', idCard: 'A123456789', gender: 'M', birthday: '1988-05-12', age: 38, nationality: 'TWN',
        phone: '0912345678', email: 'chen@tur.tw', city: '台北市', emergencyName: '陳美玲', emergencyPhone: '0988111222',
        diet: '葷', remark: '', totalAmount: 2600, addonsDetail: '[]',
        payMethod: 'ONLINE_PAYUNi', remittanceLast5: '', merTradeNo: 'PU20260201', payStatus: 'PAID', paymentType: 'CREDIT', tradeNo: '260201001', payInfo: '', paidAt: '2026-02-01 12:00:00',
        chipUid: '04:A1:2B:99:10', checkinStatus: 'checked_in', raceStatus: 'finished', penaltySeconds: 0, createdAt: '2026-02-01 11:55:00'
      },
      {
        participantId: 'TUR-FIN-002', eventId: 'TUR-2026-FIN100', catId: 'CAT-FIN100', bibNumber: 'K002', groupCode: '', groupName: '',
        name: '司馬青雲', lastName: '司馬', firstName: '青雲', idCard: 'E121234565', gender: 'M', birthday: '1982-07-08', age: 44, nationality: 'TWN',
        phone: '0919888777', email: 'sima@tur.tw', city: '高雄市', emergencyName: '司馬太太', emergencyPhone: '0919666555',
        diet: '葷', remark: '', totalAmount: 2600, addonsDetail: '[]',
        payMethod: 'MANUAL_ATM', remittanceLast5: '45678', merTradeNo: '', payStatus: 'PAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '2026-02-05 15:00:00',
        chipUid: '04:C3:4D:77:30', checkinStatus: 'checked_in', raceStatus: 'finished', penaltySeconds: 120, createdAt: '2026-02-04 09:00:00'
      },
      {
        participantId: 'TUR-FIN-003', eventId: 'TUR-2026-FIN100', catId: 'CAT-FIN50', bibNumber: 'F001', groupCode: '', groupName: '',
        name: '歐陽晴', lastName: '歐陽', firstName: '晴', idCard: 'F223456786', gender: 'F', birthday: '1991-09-20', age: 35, nationality: 'TWN',
        phone: '0922334455', email: 'ouyang@tur.tw', city: '新北市', emergencyName: '歐陽明', emergencyPhone: '0933445566',
        diet: '素', remark: '', totalAmount: 1800, addonsDetail: '[]',
        payMethod: 'MANUAL_ATM', remittanceLast5: '54321', merTradeNo: '', payStatus: 'PAID', paymentType: 'MANUAL', tradeNo: '', payInfo: '', paidAt: '2026-02-06 09:30:00',
        chipUid: '04:B2:3C:88:20', checkinStatus: 'checked_in', raceStatus: 'finished', penaltySeconds: 0, createdAt: '2026-02-05 18:00:00'
      },
      // 活動 5: 已結案台南 24H 跨夜繞圈
      {
        participantId: 'TUR-F24-001', eventId: 'TUR-2026-FIN24H', catId: 'CAT-FIN24H', bibNumber: 'T001', groupCode: '', groupName: '',
        name: 'Sarah Miller', lastName: 'Miller', firstName: 'Sarah', idCard: 'US44556677', gender: 'F', birthday: '1990-02-18', age: 36, nationality: 'USA',
        phone: '0988776655', email: 'sarah@ultra.us', city: '台北市', emergencyName: 'John Miller', emergencyPhone: '0988776644',
        diet: '素', remark: '', totalAmount: 2800, addonsDetail: '[]',
        payMethod: 'ONLINE_PAYUNi', remittanceLast5: '', merTradeNo: 'PU20260401', payStatus: 'PAID', paymentType: 'CREDIT', tradeNo: '260401888', payInfo: '', paidAt: '2026-04-01 08:00:00',
        chipUid: '04:D4:5E:66:40', checkinStatus: 'checked_in', raceStatus: 'finished', penaltySeconds: 0, createdAt: '2026-04-01 07:50:00'
      }
    ];

    const timingLogs = [
      // 已結案陽明山 100K 完整各站紀錄
      { logId: 'LOG-F100-1', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 07:45:12', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-2', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 11:18:40', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-3', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 14:52:05', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-4', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 08:02:10', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-5', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 11:55:20', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-6', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 16:10:33', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-7', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'F001', idCardHash: '', sensedTime: '2026-04-18 08:12:00', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-8', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'F001', idCardHash: '', sensedTime: '2026-04-18 10:14:22', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      // 已結案台南 24H 跨夜（18:00起跑 -> 隔日 02:15 刷圈）
      { logId: 'LOG-F24-1', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T001', idCardHash: '', sensedTime: '2026-05-23 18:06:10', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-2', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T001', idCardHash: '', sensedTime: '2026-05-24 02:15:30', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '跨夜測試圈' }
    ];

    const historyResults = [
      { historyId: 'HIS-2024-001', eventDate: '2024-11-16', eventName: '2024 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'A101', name: '陳志明', idCardHash: 'demo-hash-chen', finishTime: '10:12:45', distanceKm: 100, lapCount: 0, overallRank: 3, catRank: 2, status: 'FINISHED', isWarrior800: true, remark: '個人 PB' },
      { historyId: 'HIS-2025-002', eventDate: '2025-04-20', eventName: '2025 台北 24H 超級馬拉松', categoryName: '24H 組', bibNumber: 'B208', name: '司馬青雲', idCardHash: 'demo-hash-sima', finishTime: '23:54:10', distanceKm: 148.5, lapCount: 148, overallRank: 1, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '破場地紀錄' },
      { historyId: 'HIS-2025-003', eventDate: '2025-10-12', eventName: '2025 TUR 宜蘭 50K 海岸超馬', categoryName: '50K 組', bibNumber: 'C055', name: '歐陽晴', idCardHash: 'demo-hash-ouyang', finishTime: '05:08:30', distanceKm: 50, lapCount: 0, overallRank: 5, catRank: 1, status: 'FINISHED', isWarrior800: false, remark: '女總一' }
    ];

    return { users, globalConfig, events, categories, stations, participants, timingLogs, historyResults };
  }

  global.TurCore = {
    pad2, formatDateTime, parseDateTime, formatDuration, formatPace, escapeHtml,
    COMPOUND_SURNAMES_28, splitFullName, mergeNameParts, zhToEnEventName,
    verifyTaiwanIdChecksum, inferGenderFromId, calcAge, sha256Hex,
    CURATED_BANNERS, getBannerStyle, defaultFormSchema, defaultCertConfig, parseJsonSafe,
    TurDB, validateGasUrl, buildGasQueryUrl, gasGet, gasPost,
    isWarrior800Eligible, computeLeaderboard,
    CERT_LAYOUTS, CERT_PALETTES, renderCertificateCanvas,
    buildFull5EventsSeed
  };
})(window);
