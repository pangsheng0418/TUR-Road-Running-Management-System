/**
 * ============================================================================
 * TUR Race Management System v3.0 (Governance Edition) - Shared Core Engine
 * 供 index.html 與 public.html 共用（非 ESM，支援 file:// 與 HTTPS 直開）
 * ============================================================================
 */
(function (global) {
  'use strict';

  // 若要部署至 GitHub Pages / Vercel 讓所有跑者與作業員免設定自動連線，請將 GAS /exec 網址貼於此處：
  // 目前尚未開通線上金流，預設全面鎖定「實體銀行轉帳（核對末五碼）」防止誤選；未來完成串接後改為 true 即可啟用
  const PAYUNi_FEATURE_ENABLED = false;

  const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwPoUdjUz_jGTbATwsqTWbydoFW9ycoXb0jx0EY52GYLMRLJ81zUeqKZgKkb0lWwNOd/exec';

  /* --------------------------------------------------------------------------
   * 0. Official TUR Logo Preloader (Zero CORS Taint via Data URI)
   * -------------------------------------------------------------------------- */
  let turLogoImg = null;
  let turLogoReady = false;
  const logoListeners = [];

  function initTurLogo() {
    if (typeof Image === 'undefined') return;
    const src = global.TUR_LOGO_DATA_URI || 'assets/tur-logo.jpg';
    const img = new Image();
    img.onload = () => {
      turLogoImg = img;
      turLogoReady = true;
      logoListeners.forEach((fn) => { try { fn(img); } catch (_) {} });
    };
    img.src = src;
  }
  initTurLogo();

  function onLogoReady(fn) {
    if (typeof fn !== 'function') return;
    if (turLogoReady && turLogoImg) fn(turLogoImg);
    else logoListeners.push(fn);
  }

  function drawTurLogoBadge(ctx, x, y, w, h, borderColor = '#f59e0b') {
    if (!turLogoImg || !turLogoReady) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2.5;
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.stroke();

    const padX = 16, padY = 10;
    const maxW = w - padX * 2, maxH = h - padY * 2;
    const scale = Math.min(maxW / turLogoImg.width, maxH / turLogoImg.height);
    const dw = turLogoImg.width * scale, dh = turLogoImg.height * scale;
    ctx.drawImage(turLogoImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }

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

  function maskIdCard(id) {
    const s = String(id || '').trim();
    if (!s) return '';
    if (s.length >= 8) return `${s.slice(0, 3)}*****${s.slice(-2)}`;
    if (s.length >= 5) return `${s.slice(0, 2)}*****${s.slice(-1)}`;
    return `${s[0]}*****`;
  }

  function maskNdefPayload(payload) {
    const s = String(payload || '').trim();
    if (!s) return '';
    if (s.includes('|')) {
      const parts = s.split('|');
      parts[1] = maskIdCard(parts[1]);
      return parts.join('|');
    }
    return s;
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
   * 3. 16 款精選活動橫幅（含 6 款動感路跑 / 越野跑 / 跨夜超馬 SVG 插畫）+ 簡章範本
   * -------------------------------------------------------------------------- */
  function svgUri(svg) {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim()).replace(/'/g, '%27');
  }

  const RUNNER_SILHOUETTE = `<g fill="#ffffff" fill-opacity="0.22"><circle cx="675" cy="54" r="14"/><path d="M668 72 L646 112 L612 126 L618 138 L658 124 L672 102 L688 122 L666 164 L680 170 L708 120 L692 94 L718 82 L736 96 L744 84 L718 66 L690 74 Z"/></g>`;

  const CURATED_BANNERS = [
    // 6 款全新動感路跑 / 越野跑 SVG 樣式
    {
      id: 'dyn-road',
      name: '🏃 動感城市路跑',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="55%" stop-color="#1d4ed8"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient></defs><rect width="800" height="220" fill="url(#g1)"/><path d="M0 175 L800 115 L800 220 L0 220 Z" fill="#090d1a" fill-opacity="0.45"/><path d="M0 190 L800 135" stroke="#fbbf24" stroke-width="5" stroke-dasharray="28 18"/><path d="M40 50 L360 50 M120 75 L460 75 M200 100 L540 100" stroke="#38bdf8" stroke-opacity="0.35" stroke-width="4" stroke-linecap="round"/><g fill="#0f172a" fill-opacity="0.32"><rect x="420" y="95" width="28" height="70"/><rect x="454" y="68" width="34" height="97"/><rect x="494" y="84" width="26" height="81"/><rect x="526" y="52" width="38" height="113"/></g>${RUNNER_SILHOUETTE}</svg>`)
    },
    {
      id: 'dyn-trail',
      name: '⛰️ 山林越野奔騰',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#052e16"/><stop offset="55%" stop-color="#15803d"/><stop offset="100%" stop-color="#ca8a04"/></linearGradient></defs><rect width="800" height="220" fill="url(#g2)"/><circle cx="640" cy="48" r="36" fill="#fef08a" fill-opacity="0.28"/><path d="M0 220 L0 155 L140 82 L265 148 L430 58 L595 142 L725 88 L800 128 L800 220 Z" fill="#052e16" fill-opacity="0.58"/><path d="M0 220 L180 132 L340 175 L540 96 L800 185 L800 220 Z" fill="#022c22" fill-opacity="0.65"/><path d="M120 198 Q310 150 470 165 T760 115" fill="none" stroke="#a3e635" stroke-width="4" stroke-dasharray="14 10"/>${RUNNER_SILHOUETTE}</svg>`)
    },
    {
      id: 'dyn-night',
      name: '🔦 跨夜超馬頭燈',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#020617"/><stop offset="60%" stop-color="#312e81"/><stop offset="100%" stop-color="#0e7490"/></linearGradient><linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#fef08a" stop-opacity="0.55"/><stop offset="100%" stop-color="#fef08a" stop-opacity="0"/></linearGradient></defs><rect width="800" height="220" fill="url(#g3)"/><circle cx="110" cy="42" r="2" fill="#fff"/><circle cx="240" cy="28" r="2.5" fill="#fde047"/><circle cx="380" cy="52" r="2" fill="#fff"/><circle cx="510" cy="30" r="2" fill="#38bdf8"/><circle cx="710" cy="36" r="2.5" fill="#fff"/><path d="M0 220 L0 160 L210 118 L430 162 L630 105 L800 148 L800 220 Z" fill="#020617" fill-opacity="0.72"/><polygon points="660,55 340,12 340,108" fill="url(#beam)"/>${RUNNER_SILHOUETTE}</svg>`)
    },
    {
      id: 'dyn-track',
      name: '🏟️ 田徑繞圈極速',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g4" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#450a0a"/><stop offset="55%" stop-color="#b91c1c"/><stop offset="100%" stop-color="#ea580c"/></linearGradient></defs><rect width="800" height="220" fill="url(#g4)"/><path d="M-40 240 Q360 30 840 160" fill="none" stroke="#ffffff" stroke-opacity="0.32" stroke-width="5"/><path d="M-40 212 Q360 2 840 132" fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="4"/><path d="M-40 184 Q360 -26 840 104" fill="none" stroke="#fde047" stroke-opacity="0.45" stroke-width="4" stroke-dasharray="22 14"/><path d="M-40 156 Q360 -54 840 76" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="3"/>${RUNNER_SILHOUETTE}</svg>`)
    },
    {
      id: 'dyn-coast',
      name: '🌊 濱海公路破風',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g5" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0c4a6e"/><stop offset="55%" stop-color="#0284c7"/><stop offset="100%" stop-color="#14b8a6"/></linearGradient></defs><rect width="800" height="220" fill="url(#g5)"/><path d="M0 152 Q160 112 320 152 T640 152 T800 142 L800 220 L0 220 Z" fill="#082f49" fill-opacity="0.45"/><path d="M0 176 Q180 142 360 176 T720 176 L800 170 L800 220 L0 220 Z" fill="#0ea5e9" fill-opacity="0.35"/><path d="M50 64 Q240 34 450 62 T780 46" fill="none" stroke="#e0f2fe" stroke-opacity="0.38" stroke-width="3" stroke-linecap="round"/>${RUNNER_SILHOUETTE}</svg>`)
    },
    {
      id: 'dyn-warrior',
      name: '🔥 八百壯士百K烈焰',
      isDynamic: true,
      svg: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g6" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#18181b"/><stop offset="45%" stop-color="#7f1d1d"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient></defs><rect width="800" height="220" fill="url(#g6)"/><path d="M0 220 Q220 95 440 165 T800 40 L800 220 Z" fill="#f97316" fill-opacity="0.22"/><path d="M0 190 L800 72" stroke="#fbbf24" stroke-opacity="0.55" stroke-width="6"/><text x="520" y="158" font-family="Arial Black,sans-serif" font-size="96" font-weight="900" fill="#fef08a" fill-opacity="0.14">100K</text>${RUNNER_SILHOUETTE}</svg>`)
    },
    // 原有 10 款精選漸層橫幅
    { id: 'banner-1', name: '7. 晨曦超馬金藍', css: 'linear-gradient(135deg,#0f172a 0%,#1d4ed8 55%,#f59e0b 100%)' },
    { id: 'banner-2', name: '8. 夜間繞圈極光', css: 'linear-gradient(135deg,#09090b 0%,#312e81 55%,#06b6d4 100%)' },
    { id: 'banner-3', name: '9. 八百壯士赤焰', css: 'linear-gradient(135deg,#450a0a 0%,#b91c1c 55%,#f59e0b 100%)' },
    { id: 'banner-4', name: '10. 山林越野森綠', css: 'linear-gradient(135deg,#052e16 0%,#15803d 60%,#84cc16 100%)' },
    { id: 'banner-5', name: '11. 東海岸太平洋', css: 'linear-gradient(135deg,#0c4a6e 0%,#0284c7 55%,#2dd4bf 100%)' },
    { id: 'banner-6', name: '12. 皇室黑金榮耀', css: 'linear-gradient(135deg,#09090b 0%,#27272a 60%,#eab308 100%)' },
    { id: 'banner-7', name: '13. 櫻花春季路跑', css: 'linear-gradient(135deg,#500724 0%,#be185d 55%,#f9a8d4 100%)' },
    { id: 'banner-8', name: '14. 高山雲海紫金', css: 'linear-gradient(135deg,#2e1065 0%,#6d28d9 55%,#fbbf24 100%)' },
    { id: 'banner-9', name: '15. 破曉橘紅極速', css: 'linear-gradient(135deg,#431407 0%,#ea580c 55%,#fde047 100%)' },
    { id: 'banner-10', name: '16. 鋼鐵城市灰藍', css: 'linear-gradient(135deg,#1e293b 0%,#475569 55%,#38bdf8 100%)' }
  ];

  const DEFAULT_BROCHURE_TEMPLATE = '';

  function sanitizeBrochureText(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    // 防護舊試算表欄位錯位寫入之系統 JSON / Base64 亂碼
    if (s.startsWith('{') && (/"certMode"|"layoutId"|"paletteId"|"paymentMode"|"addons"|"customFields"/.test(s))) return '';
    if (/^data:image\//i.test(s)) return '';
    return s;
  }

  function normalizeEventData(ev) {
    if (!ev || typeof ev !== 'object') return ev;
    const vals = [ev.brochureText, ev.formSchemaJson, ev.certConfigJson].map((v) => String(v || '').trim());
    const isCert = (s) => s.startsWith('{') && /"certMode"|"layoutId"|"paletteId"/.test(s);
    const isForm = (s) => s.startsWith('{') && /"paymentMode"|"addons"|"customFields"/.test(s);
    if (isCert(vals[0]) || isForm(vals[0]) || (!isForm(vals[1]) && vals.some(isForm)) || (!isCert(vals[2]) && vals.some(isCert))) {
      const foundForm = vals.find(isForm);
      const foundCert = vals.find(isCert);
      if (foundForm) ev.formSchemaJson = foundForm;
      if (foundCert) ev.certConfigJson = foundCert;
    }
    ev.brochureText = sanitizeBrochureText(ev.brochureText);
    return ev;
  }

  function getBannerStyle(bannerUrl) {
    if (!bannerUrl) {
      const first = CURATED_BANNERS[0];
      return first.svg ? `background-image:url('${first.svg}');background-size:cover;background-position:center;` : `background:${first.css};`;
    }
    if (String(bannerUrl).startsWith('data:') || /^https?:\/\//i.test(bannerUrl)) {
      return `background-image:url('${String(bannerUrl).replace(/'/g, '%27')}');background-size:cover;background-position:center;`;
    }
    const preset = CURATED_BANNERS.find((b) => b.id === bannerUrl) || CURATED_BANNERS[0];
    if (preset.svg) return `background-image:url('${preset.svg}');background-size:cover;background-position:center;`;
    return `background:${preset.css};`;
  }

  const CUSTOM_FIELD_TYPES = [
    { id: 'text', label: '單行文字 (text)', needsOptions: false, desc: '適合短填答，例如隊伍縮寫、臉書暱稱、緊急備註' },
    { id: 'textarea', label: '多行文字 (textarea)', needsOptions: false, desc: '適合長填答，例如過敏史、特殊醫療與協助需求' },
    { id: 'number', label: '數字 (number)', needsOptions: false, desc: '適合純數字，例如預估完賽小時、全馬參賽次數' },
    { id: 'select', label: '下拉選單 (select)', needsOptions: true, desc: '適合固定規格單選，例如紀念衣尺寸 XS~3XL' },
    { id: 'radio', label: '單選按鈕 (radio)', needsOptions: true, desc: '適合直覺二選一或三選一，例如接駁車梯次、領物方式' },
    { id: 'checkbox', label: '多選核取 (checkbox)', needsOptions: true, desc: '適合複選調查，例如曾參加賽制、志工支援意願' },
    { id: 'date', label: '日期選擇 (date)', needsOptions: false, desc: '適合日期填報，例如最近一場完賽日期、入住日' },
    { id: 'url', label: '網址連結 (url)', needsOptions: false, desc: '適合貼上成績證明網址、雲端證書連結' }
  ];

  const DEFAULT_TUR_ADDONS = [
    { code: 'chip_buy', name: '晶片採購', price: 300, enabled: false },
    { code: 'lodging', name: '住宿預訂價', price: 1500, enabled: false },
    { code: 'sport_gear', name: '運動用品加購價', price: 680, enabled: false }
  ];

  const DEFAULT_ADDONS_NOTE_FIELD = {
    key: 'addons_note',
    label: '加購項目補充說明／備註',
    type: 'textarea',
    required: false,
    options: [],
    placeholder: ''
  };

  const CUSTOM_FIELD_PRESETS = [
    { key: 'address', label: '住址', type: 'text', required: false, options: [], placeholder: '' },
    { key: 'shirt_size', label: '紀念衣尺寸', type: 'select', required: true, options: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'], placeholder: '請選擇紀念衣尺寸' }
  ];

  const DEFAULT_REG_FIELDS = [
    { id: 'nationality', label: '國籍', required: true },
    { id: 'name', label: '姓名', required: true },
    { id: 'idCard', label: '身分證 / 護照', required: true },
    { id: 'gender', label: '性別', required: true },
    { id: 'birthday', label: '出生日期', required: true },
    { id: 'phone', label: '手機', required: true },
    { id: 'email', label: 'Email', required: true },
    { id: 'diet', label: '飲食', required: true },
    { id: 'remark', label: '備註', required: false },
    { id: 'emergName', label: '緊急聯絡人', required: true },
    { id: 'emergPhone', label: '緊急聯絡電話', required: true }
  ];

  function getEffectiveRegFieldOrder(schema) {
    const sc = schema && typeof schema === 'object' ? schema : {};
    const cfs = Array.isArray(sc.customFields) ? sc.customFields : [];
    const cfMap = new Map(cfs.map((f, idx) => [`cf:${f.key}`, { id: `cf:${f.key}`, label: f.label, required: Boolean(f.required), isCustom: true, cfIndex: idx, cfDef: f }]));
    const baseMap = new Map(DEFAULT_REG_FIELDS.map((f) => [f.id, { ...f, isCustom: false, cfIndex: -1, cfDef: null }]));
    const allValid = new Map([...baseMap, ...cfMap]);

    const rawOrder = Array.isArray(sc.fieldOrder) ? sc.fieldOrder : [];
    const seen = new Set();
    const out = [];
    rawOrder.forEach((id) => {
      if (allValid.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(allValid.get(id));
      }
    });
    DEFAULT_REG_FIELDS.forEach((f) => {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        out.push(baseMap.get(f.id));
      }
    });
    cfs.forEach((f) => {
      const cid = `cf:${f.key}`;
      if (!seen.has(cid)) {
        seen.add(cid);
        out.push(cfMap.get(cid));
      }
    });
    return out;
  }

  const PAYMENT_MODES = [
    {
      id: 'MANUAL_ATM',
      short: '🏦 銀行轉帳',
      label: '🏦 銀行轉帳',
      desc: '匯款核對末 5 碼，入帳後配號'
    },
    {
      id: 'ONLINE_PAYUNi',
      short: '💳 線上金流',
      label: '💳 線上金流 (PAYUNi)',
      desc: '信用卡 / 虛擬 ATM / 超商自動銷帳'
    }
  ];

  function getEventPaymentMode(ev) {
    const sc = parseJsonSafe(ev?.formSchemaJson, defaultFormSchema());
    return sc?.paymentMode === 'ONLINE_PAYUNi' ? 'ONLINE_PAYUNi' : 'MANUAL_ATM';
  }

  function defaultFormSchema(paymentMode = 'MANUAL_ATM') {
    return {
      paymentMode: paymentMode === 'ONLINE_PAYUNi' ? 'ONLINE_PAYUNi' : 'MANUAL_ATM',
      earlyBirdEnabled: true,
      earlyBirdEnd: '2026-12-31 23:59:59', // YYYY-MM-DD HH:mm:ss（含此時間點前適用早鳥價，可隨時核取關閉或改期）
      addons: DEFAULT_TUR_ADDONS.map((a) => ({ ...a })),
      customFields: [{ ...DEFAULT_ADDONS_NOTE_FIELD }]
    };
  }

  function normalizeEarlyBirdEnd(raw) {
    const s = String(raw || '').trim().replace('T', ' ');
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 23:59:59`;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:59`;
    return s;
  }

  function getEventEarlyBirdConfig(ev) {
    const sc = parseJsonSafe(ev?.formSchemaJson, defaultFormSchema());
    return {
      enabled: Boolean(sc?.earlyBirdEnabled),
      endTime: normalizeEarlyBirdEnd(sc?.earlyBirdEnd || '')
    };
  }

  function isEarlyBirdActive(ev, nowDate = new Date()) {
    const cfg = getEventEarlyBirdConfig(ev);
    if (!cfg.enabled || !cfg.endTime) return false;
    const endDt = parseDateTime(cfg.endTime);
    if (!endDt) return false;
    const refMs = nowDate instanceof Date ? nowDate.getTime() : Number(nowDate || Date.now());
    return refMs <= endDt.getTime();
  }

  function getEffectiveCategoryPrice(ev, cat, nowDate = new Date()) {
    const regularFee = Number(cat?.fee || 0);
    const earlyBirdFee = Number(cat?.earlyBirdFee || 0);
    const ebCfg = getEventEarlyBirdConfig(ev);
    const active = isEarlyBirdActive(ev, nowDate);
    const useEarlyBird = Boolean(active && earlyBirdFee > 0 && earlyBirdFee < regularFee);
    return {
      regularFee,
      earlyBirdFee,
      fee: useEarlyBird ? earlyBirdFee : regularFee,
      isEarlyBird: useEarlyBird,
      earlyBirdEnabled: ebCfg.enabled,
      earlyBirdActive: active,
      endTime: ebCfg.endTime
    };
  }

  const CERT_CUSTOM_ELEMENTS = [
    { key: 'eventName', label: '賽事名稱', icon: '🏁', minSize: 18, maxSize: 96, isLogo: false },
    { key: 'runnerName', label: '選手姓名', icon: '🏃', minSize: 28, maxSize: 160, isLogo: false },
    { key: 'bibCategory', label: '號碼布 / 組別', icon: '🏷️', minSize: 16, maxSize: 72, isLogo: false },
    { key: 'primaryResult', label: '主要成績', icon: '⏱️', minSize: 28, maxSize: 140, isLogo: false },
    { key: 'secondaryResult', label: '次要成績 / 距離', icon: '📏', minSize: 16, maxSize: 72, isLogo: false },
    { key: 'rankPace', label: '名次 / 均速', icon: '📊', minSize: 14, maxSize: 60, isLogo: false },
    { key: 'logo', label: 'TUR 官方 LOGO', icon: '🖼️', minSize: 40, maxSize: 180, isLogo: true },
    { key: 'date', label: '比賽日期', icon: '📅', minSize: 14, maxSize: 56, isLogo: false },
    { key: 'organizer', label: '主辦單位', icon: '🏛️', minSize: 14, maxSize: 56, isLogo: false },
    { key: 'director', label: '賽事總監', icon: '🎖️', minSize: 14, maxSize: 56, isLogo: false }
  ];

  function defaultCustomBgElements(orientation = 'landscape') {
    const isP = orientation === 'portrait';
    return {
      eventName:       { visible: true, x: 0.50, y: isP ? 0.13 : 0.14, size: isP ? 42 : 48, color: '#ffffff', align: 'center' },
      runnerName:      { visible: true, x: 0.50, y: isP ? 0.30 : 0.31, size: isP ? 88 : 98, color: '#ffffff', align: 'center' },
      bibCategory:     { visible: true, x: 0.50, y: isP ? 0.38 : 0.40, size: isP ? 30 : 34, color: '#fde047', align: 'center' },
      primaryResult:   { visible: true, x: 0.50, y: isP ? 0.51 : 0.54, size: isP ? 72 : 80, color: '#fde047', align: 'center' },
      secondaryResult: { visible: true, x: 0.50, y: isP ? 0.58 : 0.62, size: isP ? 30 : 34, color: '#ffffff', align: 'center' },
      rankPace:        { visible: true, x: 0.50, y: isP ? 0.65 : 0.69, size: isP ? 24 : 28, color: '#e2e8f0', align: 'center' },
      logo:            { visible: true, x: 0.50, y: isP ? 0.80 : 0.81, size: isP ? 82 : 88, color: '#f59e0b', align: 'center' },
      date:            { visible: true, x: 0.20, y: 0.92, size: isP ? 22 : 26, color: '#ffffff', align: 'center' },
      organizer:       { visible: true, x: 0.50, y: 0.92, size: isP ? 22 : 26, color: '#ffffff', align: 'center' },
      director:        { visible: true, x: 0.80, y: 0.92, size: isP ? 22 : 26, color: '#fde047', align: 'center' }
    };
  }

  function getMergedCustomBgElements(cfg) {
    const base = defaultCustomBgElements(cfg?.orientation || 'landscape');
    const saved = cfg?.customBgElements && typeof cfg.customBgElements === 'object' ? cfg.customBgElements : {};
    const out = {};
    CERT_CUSTOM_ELEMENTS.forEach(({ key }) => {
      out[key] = { ...base[key], ...(saved[key] || {}) };
    });
    return out;
  }

  function compressCustomBgImage(dataUrl, maxDim = 1280, maxChars = 42000) {
    return new Promise((resolve) => {
      if (!dataUrl || typeof global.document === 'undefined') return resolve(dataUrl || '');
      if (dataUrl.length <= maxChars) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.width || maxDim;
          let h = img.height || Math.round(maxDim * 0.707);
          const ratio = Math.min(1, maxDim / Math.max(w, h));
          w = Math.max(320, Math.round(w * ratio));
          h = Math.max(240, Math.round(h * ratio));
          const c = global.document.createElement('canvas');
          let out = dataUrl;
          let curScale = 1;
          for (let attempt = 0; attempt < 6; attempt++) {
            c.width = Math.max(320, Math.round(w * curScale));
            c.height = Math.max(240, Math.round(h * curScale));
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0, c.width, c.height);
            for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
              out = c.toDataURL('image/jpeg', q);
              if (out.length <= maxChars) return resolve(out);
            }
            curScale *= 0.8;
          }
          resolve(out);
        } catch (_) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function defaultCertConfig() {
    return {
      certMode: 'official', // 'official' (官方證書，無個人照片) | 'custom_runner' (選手客製化證書，含個人照片)
      engine: 'official', // 相容舊版：當有上傳 customBgDataUrl 時自動套印自訂底圖
      orientation: 'landscape', // 'landscape' | 'portrait'
      layoutId: 'classic',
      paletteId: 'tur-gold',
      fontId: 'sans-modern',
      customBgDataUrl: '',
      customTextPos: {
        nameX: 0.5, nameY: 0.38,
        bibX: 0.5, bibY: 0.46,
        resultX: 0.5, resultY: 0.58,
        color: '#ffffff',
        align: 'center',
        fontScale: 1.12
      },
      // 活動賽事總監姓名（顯示於證書最下列置中）
      raceDirectorName: '林政宏',
      // 基本與成績欄位開關
      showEventName: true,
      showRunnerName: true,
      showBib: true,
      showCategory: true,
      showPrimaryResult: true,
      showSecondaryResult: true,
      showDate: true,
      showRaceDirector: true,
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
  function isCategoryWarrior800(cat) {
    if (!cat) return false;
    return cat.isWarrior800 === true || cat.isWarrior800 === 1 || String(cat.isWarrior800).toLowerCase() === 'true';
  }

  function isWarrior800Eligible(eventName, catName, totalDistanceKm, catObj = null) {
    // 若已傳入組別物件，一律嚴格依承辦人於組別設定之 isWarrior800 標示為準
    if (catObj && typeof catObj === 'object') return isCategoryWarrior800(catObj);
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
      const checkInLog = pLogs.find((l) => String(l.stationCode).toUpperCase() === 'CHECKIN') || null;
      const checkedIn = Boolean(checkInLog || String(p.checkinStatus || '').toLowerCase() === 'checked_in');
      const checkInTime = checkInLog ? String(checkInLog.sensedTime).slice(11) : '';
      const trackLogs = pLogs.filter((l) => String(l.stationCode).toUpperCase() !== 'CHECKIN');
      const penaltySec = Math.round(Number(p.penaltySeconds || 0));

      if (event.raceType === 'lap_timed') {
        const limitSec = Number(cat.timeLimitHours || 12) * 3600;
        const lapDist = Number(event.lapDistanceKm || cat.distanceKm || 1.0);
        const lapLogs = trackLogs.filter((l) => String(l.stationCode).toUpperCase() === 'LAP');
        const validLaps = [];
        const splitDetails = [];
        const lapDetails = [];
        let overtimeCount = 0;
        let prevDt = startDt;

        lapLogs.forEach((ll) => {
          const dt = parseDateTime(ll.sensedTime);
          const elapsed = (startDt && dt) ? Math.round((dt.getTime() - startDt.getTime()) / 1000) : 0;
          const lapSec = (prevDt && dt) ? Math.max(1, Math.round((dt.getTime() - prevDt.getTime()) / 1000)) : null;
          const isOvertime = Boolean(startDt && elapsed > limitSec);
          if (!isOvertime) {
            validLaps.push({ ...ll, elapsed, lapSec });
            const lapNum = validLaps.length;
            const detailObj = {
              logId: ll.logId,
              lapNumber: lapNum,
              overtime: false,
              code: `LAP #${lapNum}`,
              name: `第 ${lapNum} 圈`,
              fullTime: ll.sensedTime,
              time: String(ll.sensedTime).slice(11),
              cumSec: elapsed,
              segSec: lapSec,
              segPace: lapSec ? formatPace(lapSec, lapDist) : '--:--',
              cumKm: Number((lapNum * lapDist).toFixed(3)),
              source: ll.source || 'nfc',
              note: ll.note || ''
            };
            splitDetails.push(detailObj);
            lapDetails.push(detailObj);
            prevDt = dt || prevDt;
          } else {
            overtimeCount++;
            lapDetails.push({
              logId: ll.logId,
              lapNumber: null,
              overtime: true,
              code: 'LAP (超時)',
              name: '超時圈',
              fullTime: ll.sensedTime,
              time: String(ll.sensedTime).slice(11),
              cumSec: elapsed,
              segSec: lapSec,
              segPace: lapSec ? formatPace(lapSec, lapDist) : '--:--',
              cumKm: null,
              source: ll.source || 'nfc',
              note: ll.note || '逾限時'
            });
          }
        });

        const lapCount = validLaps.length;
        const totalDistanceKm = Number((lapCount * lapDist).toFixed(3));
        const lastLap = validLaps[validLaps.length - 1];
        const elapsedSec = lastLap && startDt ? Math.max(0, lastLap.elapsed + penaltySec) : null;
        const validLapSecs = validLaps.map((l) => l.lapSec).filter((x) => x !== null && x > 0);
        const bestLapSec = validLapSecs.length ? Math.min(...validLapSecs) : null;
        const avgLapSec = validLapSecs.length ? Math.round(validLapSecs.reduce((a, b) => a + b, 0) / validLapSecs.length) : null;
        const status = p.raceStatus === 'dnf' ? 'dnf' : (event.status === 'finished' && lapCount > 0 ? 'finished' : (lapCount > 0 ? (p.raceStatus === 'finished' ? 'finished' : 'on_track') : p.raceStatus));

        return {
          event, participant: p, category: cat, raceType: 'lap_timed',
          checkedIn, checkInLog, checkInTime,
          lapCount, overtimeCount, totalDistanceKm, elapsedSec,
          bestLapSec, avgLapSec, lastLapTime: lastLap ? String(lastLap.sensedTime).slice(11) : '',
          avgPace: elapsedSec && totalDistanceKm > 0 ? formatPace(elapsedSec, totalDistanceKm) : '--:--',
          splits: {}, splitDetails, lapDetails,
          etaSec: null, etaTimeStr: '',
          isWarrior800: status === 'finished' && isCategoryWarrior800(cat),
          status
        };
      } else {
        const splits = {};
        const splitDetails = [];
        let prevTime = startDt;
        let prevKm = 0;
        let maxKm = 0;
        let lastCumSec = null;

        for (const st of evStations) {
          const found = trackLogs.find((l) => String(l.stationCode).toUpperCase() === String(st.stationCode).toUpperCase());
          if (found) {
            const dt = parseDateTime(found.sensedTime);
            const cumSec = (startDt && dt) ? Math.max(0, Math.round((dt.getTime() - startDt.getTime()) / 1000)) : null;
            const segSec = (prevTime && dt) ? Math.max(0, Math.round((dt.getTime() - prevTime.getTime()) / 1000)) : null;
            const stKm = st.stationCode === 'FINISH' ? Number(cat.distanceKm || st.distanceKm || 0) : Number(st.distanceKm || 0);
            const segKm = Math.max(0.1, stKm - prevKm);
            const spObj = {
              logId: found.logId,
              code: st.stationCode,
              name: st.name,
              fullTime: found.sensedTime,
              time: String(found.sensedTime).slice(11),
              source: found.source || 'nfc',
              cumSec,
              segSec,
              segPace: segSec ? formatPace(segSec, segKm) : '--:--'
            };
            splits[st.stationCode] = spObj;
            splitDetails.push(spObj);
            prevTime = dt || prevTime;
            prevKm = stKm;
            maxKm = Math.max(maxKm, stKm);
            if (cumSec !== null) lastCumSec = cumSec;
          }
        }

        const finLog = trackLogs.find((l) => String(l.stationCode).toUpperCase() === 'FINISH');
        let elapsedSec = null;
        if (finLog && startDt) {
          const fdt = parseDateTime(finLog.sensedTime);
          if (fdt) elapsedSec = Math.max(0, Math.round((fdt.getTime() - startDt.getTime()) / 1000) + penaltySec);
        }
        const catDist = Number(cat.distanceKm || 0);
        const totalDistanceKm = finLog ? Number(catDist || maxKm) : maxKm;
        const status = p.raceStatus === 'dnf' ? 'dnf' : (finLog ? 'finished' : (trackLogs.length > 0 ? 'on_track' : p.raceStatus));

        // 預估完賽時間 (ETA)：在途且已過中途站
        let etaSec = null;
        let etaTimeStr = '';
        if (status === 'on_track' && startDt && lastCumSec > 0 && maxKm > 0 && catDist > maxKm) {
          etaSec = Math.round((lastCumSec / maxKm) * catDist);
          etaTimeStr = formatDateTime(new Date(startDt.getTime() + etaSec * 1000)).slice(11);
        }

        return {
          event, participant: p, category: cat, raceType: 'distance',
          checkedIn, checkInLog, checkInTime,
          lapCount: 0, overtimeCount: 0, totalDistanceKm, elapsedSec,
          bestLapSec: null, avgLapSec: null, lastLapTime: '',
          avgPace: elapsedSec && totalDistanceKm > 0 ? formatPace(elapsedSec, totalDistanceKm) : '--:--',
          splits, splitDetails, lapDetails: [],
          etaSec, etaTimeStr,
          isWarrior800: status === 'finished' && isCategoryWarrior800(cat),
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
   * 6B. 全階段賽事進度與詳細統計分析引擎（公開查詢與儀表板共用，嚴格不含個資）
   * -------------------------------------------------------------------------- */
  function computeEventProgressAnalytics({ event, categories, stations, participants, timingLogs }) {
    if (!event) {
      return {
        summary: { total: 0, activeTotal: 0, paid: 0, unpaid: 0, cancelled: 0, bibbed: 0, checkedIn: 0, onTrack: 0, finished: 0, dnf: 0, dnsNotStarted: 0, warriors800: 0, payRate: 0, checkinRate: 0, finishRate: 0, totalKmAll: 0, maxLaps: 0, avgLaps: 0 },
        stations: [], byCategory: [], byGender: { M: 0, F: 0, other: 0 }, byNationality: [], runners: []
      };
    }

    const evCats = categories.filter((c) => c.eventId === event.eventId);
    const catMap = new Map(evCats.map((c) => [c.catId, c]));
    const evStations = stations
      .filter((s) => s.eventId === event.eventId && String(s.stationCode).toUpperCase() !== 'CHECKIN')
      .sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const evParts = participants.filter((p) => p.eventId === event.eventId);

    const lbRows = computeLeaderboard({ event, categories, stations, participants, timingLogs });
    const lbByPid = new Map(lbRows.map((r) => [r.participant.participantId, r]));

    const stageOrder = { finished: 0, on_track: 1, checked_in: 2, paid_not_checked: 3, unpaid: 4, dnf: 5, cancelled: 6 };
    const stageMeta = {
      finished: { label: '🏁 已完賽', short: '已完賽', tone: 'emerald' },
      on_track: { label: '🏃 賽道進行中', short: '進行中', tone: 'sky' },
      checked_in: { label: '✅ 已報到待出發', short: '已報到', tone: 'indigo' },
      paid_not_checked: { label: '🏷️ 已繳費未報到', short: '未報到', tone: 'amber' },
      unpaid: { label: '⏳ 已報名待繳費', short: '待繳費', tone: 'rose' },
      dnf: { label: '🛑 中途棄賽 DNF', short: 'DNF', tone: 'orange' },
      cancelled: { label: '✕ 已取消報名', short: '已取消', tone: 'slate' }
    };

    const stPassedCount = new Map(evStations.map((s) => [String(s.stationCode).toUpperCase(), 0]));
    const stCurrentAtCount = new Map(evStations.map((s) => [String(s.stationCode).toUpperCase(), 0]));
    const catStatsMap = new Map(evCats.map((c) => [c.catId, {
      catId: c.catId, name: c.name, distanceKm: Number(c.distanceKm || 0), quota: Number(c.quota || 0),
      total: 0, active: 0, paid: 0, checkedIn: 0, onTrack: 0, finished: 0, dnf: 0
    }]));
    const byGender = { M: 0, F: 0, other: 0 };
    const natMap = new Map();

    const runners = evParts.map((p) => {
      const cat = catMap.get(p.catId) || { catId: p.catId, name: '-', distanceKm: 0 };
      const lb = lbByPid.get(p.participantId) || null;
      const paySt = String(p.payStatus || 'UNPAID').toUpperCase();
      const isCancelled = paySt === 'CANCELLED';
      const isPaid = paySt === 'PAID';
      const hasTiming = !!(lb && ((lb.splitDetails && lb.splitDetails.length > 0) || lb.lapCount > 0));
      const isCheckedIn = String(p.checkinStatus || '').toLowerCase() === 'checked_in' || hasTiming || p.raceStatus === 'finished' || p.raceStatus === 'on_track' || p.raceStatus === 'dnf';

      let stage = 'unpaid';
      if (isCancelled) stage = 'cancelled';
      else if (!isPaid) stage = 'unpaid';
      else if (lb && lb.status === 'dnf') stage = 'dnf';
      else if (lb && lb.status === 'finished') stage = 'finished';
      else if (lb && (lb.status === 'on_track' || hasTiming)) stage = 'on_track';
      else if (isCheckedIn) stage = 'checked_in';
      else stage = 'paid_not_checked';

      // Build stage steps timeline (privacy-safe: NEVER include CHECKIN timestamp)
      const steps = [];
      steps.push({ code: 'REG', label: '報名', state: isCancelled ? 'fail' : 'done', detail: isCancelled ? '已取消' : '完成' });
      steps.push({ code: 'PAY', label: '繳費', state: isCancelled ? 'fail' : (isPaid ? 'done' : 'pending'), detail: isPaid ? (p.bibNumber ? `配號 ${p.bibNumber}` : '已入帳') : '待繳費' });
      steps.push({ code: 'CHK', label: '報到', state: isCancelled ? 'pending' : (isCheckedIn ? 'done' : 'pending'), detail: isCheckedIn ? '已報到' : '未報到' });

      let lastStationCode = '';
      let lastStationTime = '';
      if (event.raceType === 'lap_timed') {
        const laps = lb ? lb.lapCount : 0;
        const dist = lb ? lb.totalDistanceKm : 0;
        const lastSp = lb && lb.splitDetails.length ? lb.splitDetails[lb.splitDetails.length - 1] : null;
        lastStationCode = laps > 0 ? `LAP #${laps}` : '';
        lastStationTime = lastSp ? lastSp.time : '';
        steps.push({
          code: 'LAP',
          label: laps > 0 ? `繞圈 ${laps} 圈` : '賽道繞圈',
          state: stage === 'dnf' ? 'fail' : (stage === 'finished' ? 'done' : (laps > 0 ? 'active' : 'pending')),
          detail: laps > 0 ? `${dist}km${lastSp ? ` (${lastSp.time})` : ''}` : '尚未刷圈'
        });
        if (laps > 0) {
          stPassedCount.set('LAP', (stPassedCount.get('LAP') || 0) + 1);
          if (stage === 'on_track') stCurrentAtCount.set('LAP', (stCurrentAtCount.get('LAP') || 0) + 1);
        }
      } else {
        let passedAny = false;
        evStations.forEach((st) => {
          const code = String(st.stationCode).toUpperCase();
          const sp = lb && lb.splits ? lb.splits[st.stationCode] || lb.splits[code] : null;
          if (sp) {
            passedAny = true;
            lastStationCode = st.stationCode;
            lastStationTime = sp.time;
            stPassedCount.set(code, (stPassedCount.get(code) || 0) + 1);
            steps.push({ code: st.stationCode, label: st.stationCode, state: 'done', detail: sp.time });
          } else {
            steps.push({ code: st.stationCode, label: st.stationCode, state: (stage === 'dnf' && passedAny) ? 'fail' : 'pending', detail: stage === 'dnf' && passedAny ? '退賽' : '未通過' });
          }
        });
        if (stage === 'on_track' && lastStationCode) {
          const lc = String(lastStationCode).toUpperCase();
          stCurrentAtCount.set(lc, (stCurrentAtCount.get(lc) || 0) + 1);
        }
      }

      if (!isCancelled) {
        const g = String(p.gender || '').toUpperCase();
        if (g === 'M') byGender.M++;
        else if (g === 'F') byGender.F++;
        else byGender.other++;
        const nat = String(p.nationality || 'TWN').toUpperCase();
        natMap.set(nat, (natMap.get(nat) || 0) + 1);
      }

      const cs = catStatsMap.get(p.catId);
      if (cs) {
        cs.total++;
        if (!isCancelled) cs.active++;
        if (isPaid) cs.paid++;
        if (isPaid && isCheckedIn) cs.checkedIn++;
        if (stage === 'on_track') cs.onTrack++;
        if (stage === 'finished') cs.finished++;
        if (stage === 'dnf') cs.dnf++;
      }

      return {
        participant: p,
        category: cat,
        leaderboardRow: lb,
        stage,
        stageLabel: stageMeta[stage].label,
        stageShort: stageMeta[stage].short,
        stageTone: stageMeta[stage].tone,
        isPaid,
        isCheckedIn: isPaid && isCheckedIn,
        overallRank: lb ? lb.overallRank : null,
        catRank: lb ? lb.catRank : null,
        totalDistanceKm: lb ? lb.totalDistanceKm : 0,
        lapCount: lb ? lb.lapCount : 0,
        overtimeCount: lb ? lb.overtimeCount : 0,
        elapsedSec: lb ? lb.elapsedSec : null,
        avgPace: lb ? lb.avgPace : '--:--',
        isWarrior800: lb ? lb.isWarrior800 : false,
        lastStationCode,
        lastStationTime,
        steps
      };
    });

    runners.sort((a, b) => {
      const sa = stageOrder[a.stage] ?? 9;
      const sb = stageOrder[b.stage] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.overallRank && b.overallRank && a.overallRank !== b.overallRank) return a.overallRank - b.overallRank;
      if (b.totalDistanceKm !== a.totalDistanceKm) return b.totalDistanceKm - a.totalDistanceKm;
      return String(a.participant.bibNumber || a.participant.participantId).localeCompare(String(b.participant.bibNumber || b.participant.participantId));
    });

    const total = runners.length;
    const cancelled = runners.filter((r) => r.stage === 'cancelled').length;
    const activeTotal = total - cancelled;
    const paid = runners.filter((r) => r.isPaid).length;
    const unpaid = runners.filter((r) => r.stage === 'unpaid').length;
    const bibbed = runners.filter((r) => r.isPaid && r.participant.bibNumber).length;
    const checkedIn = runners.filter((r) => r.isCheckedIn).length;
    const onTrack = runners.filter((r) => r.stage === 'on_track').length;
    const finished = runners.filter((r) => r.stage === 'finished').length;
    const dnf = runners.filter((r) => r.stage === 'dnf').length;
    const dnsNotStarted = runners.filter((r) => r.stage === 'checked_in' || r.stage === 'paid_not_checked').length;
    const warriors800 = runners.filter((r) => r.isWarrior800).length;
    const totalKmAll = Number(runners.reduce((s, r) => s + Number(r.totalDistanceKm || 0), 0).toFixed(1));
    const lapRunners = runners.filter((r) => r.lapCount > 0);
    const maxLaps = lapRunners.reduce((m, r) => Math.max(m, r.lapCount), 0);
    const avgLaps = lapRunners.length ? Number((lapRunners.reduce((s, r) => s + r.lapCount, 0) / lapRunners.length).toFixed(1)) : 0;

    const stationsOut = evStations.map((st) => {
      const code = String(st.stationCode).toUpperCase();
      const passedCount = stPassedCount.get(code) || 0;
      const currentAtCount = stCurrentAtCount.get(code) || 0;
      return {
        stationCode: st.stationCode,
        name: st.name,
        distanceKm: Number(st.distanceKm || 0),
        stationType: st.stationType,
        passedCount,
        currentAtCount,
        passRate: checkedIn > 0 ? Math.round((passedCount / checkedIn) * 100) : 0
      };
    });

    const byCategory = [...catStatsMap.values()].map((c) => ({
      ...c,
      finishRate: c.checkedIn > 0 ? Math.round((c.finished / c.checkedIn) * 100) : 0
    }));

    const byNationality = [...natMap.entries()]
      .map(([code, count]) => ({ code, count, pct: activeTotal > 0 ? Math.round((count / activeTotal) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    return {
      summary: {
        total, activeTotal, paid, unpaid, cancelled, bibbed, checkedIn, onTrack, finished, dnf, dnsNotStarted, warriors800,
        payRate: activeTotal > 0 ? Math.round((paid / activeTotal) * 100) : 0,
        checkinRate: paid > 0 ? Math.round((checkedIn / paid) * 100) : 0,
        finishRate: checkedIn > 0 ? Math.round((finished / checkedIn) * 100) : 0,
        totalKmAll, maxLaps, avgLaps
      },
      stations: stationsOut,
      byCategory,
      byGender,
      byNationality,
      runners
    };
  }

  /* --------------------------------------------------------------------------
   * 6C. 五階段作業管制節點防呆引擎（報名 → 繳費 → 起跑整備 → 賽事進行 → 結案鎖定）
   * -------------------------------------------------------------------------- */
  function evaluateEventStageGates({ event, categories, stations, participants, timingLogs, syncQueue = [], hasCloudGas = true }) {
    if (!event) return { currentStage: 1, stages: [], closureBlockers: ['尚未選擇活動'], closureWarnings: [], gunWarnings: [] };
    const evCats = categories.filter((c) => c.eventId === event.eventId);
    const evStations = stations.filter((s) => s.eventId === event.eventId);
    const evParts = participants.filter((p) => p.eventId === event.eventId);
    const evLogs = timingLogs.filter((l) => l.eventId === event.eventId && l.isValid !== false);

    const activeParts = evParts.filter((p) => String(p.payStatus).toUpperCase() !== 'CANCELLED');
    const paidParts = evParts.filter((p) => String(p.payStatus).toUpperCase() === 'PAID');
    const unpaidParts = evParts.filter((p) => ['UNPAID', 'PENDING_PAY'].includes(String(p.payStatus).toUpperCase()));
    const paidNoBib = paidParts.filter((p) => !p.bibNumber);
    const paidNoChip = paidParts.filter((p) => !p.chipUid);
    const checkedInParts = paidParts.filter((p) => String(p.checkinStatus || '').toLowerCase() === 'checked_in');
    const onTrackParts = paidParts.filter((p) => p.raceStatus === 'on_track');
    const finishedParts = paidParts.filter((p) => p.raceStatus === 'finished');
    const hasTimingStation = event.raceType === 'lap_timed'
      ? evStations.some((s) => String(s.stationCode).toUpperCase() === 'LAP')
      : evStations.some((s) => String(s.stationCode).toUpperCase() === 'FINISH');
    const hasGunStart = Boolean(event.raceStart && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(event.raceStart).trim()));
    const pendingSyncCount = Array.isArray(syncQueue) ? syncQueue.length : 0;

    // Stage 1: 報名設定管制
    const s1Checks = [
      { ok: evCats.length > 0, label: `分組設定 (${evCats.length} 組)` },
      { ok: hasTimingStation, label: event.raceType === 'lap_timed' ? '已設 LAP 繞圈站' : '已設 FINISH 終點站' },
      { ok: Boolean(event.nameZh && event.organizerZh), label: '活動名稱與主辦完整' }
    ];
    const s1Status = s1Checks.every((c) => c.ok) ? 'pass' : 'block';

    // Stage 2: 繳費對帳與配號管制
    const s2Checks = [
      { ok: paidParts.length > 0, label: `已入帳 PAID (${paidParts.length} 人)` },
      { ok: unpaidParts.length === 0, label: unpaidParts.length === 0 ? '無待對帳未繳筆數' : `待對帳 ${unpaidParts.length} 筆` },
      { ok: paidNoBib.length === 0, label: paidNoBib.length === 0 ? '已繳皆已配號' : `已繳未配號 ${paidNoBib.length} 人` }
    ];
    const s2Status = paidParts.length === 0 ? 'warn' : (paidNoBib.length > 0 || unpaidParts.length > 0 ? 'warn' : 'pass');

    // Stage 3: 賽前整備與開跑鳴槍管制
    const gunWarnings = [];
    if (evCats.length === 0) gunWarnings.push('尚未建立任何分組');
    if (!hasTimingStation) gunWarnings.push(event.raceType === 'lap_timed' ? '缺少 LAP 繞圈站點' : '缺少 FINISH 終點站點');
    if (paidParts.length === 0) gunWarnings.push('尚無任何已繳費 (PAID) 選手');
    if (paidNoBib.length > 0) gunWarnings.push(`仍有 ${paidNoBib.length} 位已繳費選手尚未配發號碼布`);
    if (paidNoChip.length > 0) gunWarnings.push(`仍有 ${paidNoChip.length} 位已繳費選手尚未綁定晶片 UID`);
    const s3Status = hasGunStart ? 'pass' : (gunWarnings.length ? 'warn' : 'ready');

    // Stage 4: 活動進行中管制
    const s4Status = !hasGunStart ? 'locked' : (event.status === 'finished' ? 'pass' : (evLogs.length > 0 || onTrackParts.length > 0 ? 'active' : 'ready'));

    // Stage 5: 結案鎖定把關
    const closureBlockers = [];
    const closureWarnings = [];
    if (!hasGunStart) closureBlockers.push('尚未執行鳴槍開跑（缺少完整起跑時間 YYYY-MM-DD HH:mm:ss）');
    if (pendingSyncCount > 0) {
      if (hasCloudGas) closureBlockers.push(`本機尚有 ${pendingSyncCount} 筆離線待上傳佇列，請先同步至雲端再結案`);
      else closureWarnings.push(`目前為純本機模式，尚有 ${pendingSyncCount} 筆本機待同步佇列（尚未綁定 GAS 網址）`);
    }
    if (paidParts.length === 0) closureBlockers.push('本場無任何已繳費選手，無法進行正式結案');
    if (onTrackParts.length > 0) closureWarnings.push(`仍有 ${onTrackParts.length} 位選手處於「賽道進行中 (on_track)」，結案前建議確認完賽或轉列 DNF`);
    if (unpaidParts.length > 0) closureWarnings.push(`仍有 ${unpaidParts.length} 筆待對帳未繳費名單`);
    if (paidNoBib.length > 0) closureWarnings.push(`仍有 ${paidNoBib.length} 位已繳費選手尚未配號`);
    const s5Status = event.status === 'finished' ? 'pass' : (closureBlockers.length > 0 ? 'block' : (closureWarnings.length > 0 ? 'warn' : 'ready'));

    const currentStage = event.status === 'finished' ? 5 : (hasGunStart ? 4 : (paidParts.length > 0 ? 3 : (activeParts.length > 0 ? 2 : 1)));

    return {
      currentStage,
      metrics: {
        activeCount: activeParts.length,
        paidCount: paidParts.length,
        unpaidCount: unpaidParts.length,
        paidNoBibCount: paidNoBib.length,
        paidNoChipCount: paidNoChip.length,
        checkedInCount: checkedInParts.length,
        onTrackCount: onTrackParts.length,
        finishedCount: finishedParts.length,
        validLogCount: evLogs.length,
        pendingSyncCount,
        hasGunStart,
        hasTimingStation
      },
      gunWarnings,
      closureBlockers,
      closureWarnings,
      stages: [
        { step: 1, key: 'setup', tab: 'setup', subTab: '', title: '1. 活動設定', status: s1Status, detail: `${evCats.length} 組｜${activeParts.length} 人` },
        { step: 2, key: 'recon', tab: 'recon', subTab: '', title: '2. 對帳配號', status: s2Status, detail: `已繳 ${paidParts.length}｜待繳 ${unpaidParts.length}` },
        { step: 3, key: 'gun', tab: 'chip', subTab: 'start', title: '3. 晶片整備', status: s3Status, detail: hasGunStart ? `已開跑 ${String(event.raceStart).slice(11)}` : `未開跑｜缺卡 ${paidNoChip.length}` },
        { step: 4, key: 'inrace', tab: 'chip', subTab: 'track', title: '4. 賽道管制', status: s4Status, detail: `報到 ${checkedInParts.length}｜在途 ${onTrackParts.length}｜完賽 ${finishedParts.length}` },
        { step: 5, key: 'closure', tab: 'score', subTab: '', title: '5. 結案鎖定', status: s5Status, detail: event.status === 'finished' ? '已歸檔' : (closureBlockers.length ? `阻塞 ${closureBlockers.length}` : (closureWarnings.length ? `提醒 ${closureWarnings.length}` : '可結案')) }
      ]
    };
  }

  /* --------------------------------------------------------------------------
   * 6D. 歷年成績與本季完賽歸併引擎 ＋ 證書核發資格嚴格把關（完賽＋已結案＋有效成績）
   * -------------------------------------------------------------------------- */
  function isCertEligible(ev, row) {
    if (!ev || !row) return { ok: false, reason: '查無活動或選手成績資料' };
    const isArchivedHistory = String(ev.eventId || '').startsWith('HIS-EV-');
    const isClosed = isArchivedHistory || String(ev.status || '').toLowerCase() === 'finished';
    if (!isClosed) {
      return { ok: false, reason: '本活動尚未結案鎖定，須待結案後始開放列印證書' };
    }
    const isFinished = String(row.status || '').toLowerCase() === 'finished';
    if (!isFinished) {
      return { ok: false, reason: '選手尚未完賽（DNF / DNS / 進行中），不可列印完賽證書' };
    }
    const isLap = ev.raceType === 'lap_timed' || row.raceType === 'lap_timed';
    const hasResult = isLap
      ? (Number(row.lapCount || 0) > 0 && Number(row.totalDistanceKm || 0) > 0)
      : (row.elapsedSec !== null && row.elapsedSec !== undefined && Number(row.elapsedSec) >= 0);
    if (!hasResult) {
      return { ok: false, reason: '尚無正式有效完賽成績，無法列印證書' };
    }
    return { ok: true, reason: '' };
  }

  function parseDurationToSec(str) {
    const m = String(str || '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  function buildUnifiedHistoryRecords({ events = [], categories = [], stations = [], participants = [], timingLogs = [], historyResults = [] }) {
    const records = [];
    const dedup = new Set();

    // 1. 納入歷屆 HistoryResults 歸併資料
    (historyResults || []).forEach((h, idx) => {
      const dateStr = String(h.eventDate || '').slice(0, 10);
      const year = dateStr.slice(0, 4) || '未知';
      const dist = Number(h.distanceKm || 0);
      const sec = parseDurationToSec(h.finishTime);
      const status = String(h.status || 'FINISHED').toUpperCase();
      const canCert = status === 'FINISHED' && ((sec !== null && sec >= 0) || (Number(h.lapCount || 0) > 0 && dist > 0));
      // 歷年成績僅列「已結案且有正式完賽成績」之紀錄
      if (!canCert) return;
      // 嚴格採用匯入時手動標示之 isWarrior800，不再用距離或活動名自動猜測
      const isW800 = h.isWarrior800 === true || h.isWarrior800 === 1 || String(h.isWarrior800).toLowerCase() === 'true';
      const key = `${dateStr}::${h.eventName}::${h.name}::${h.bibNumber || idx}`;
      if (dedup.has(key)) return;
      dedup.add(key);

      const certRow = {
        event: {
          eventId: `HIS-EV-${h.historyId || idx}`,
          status: 'finished',
          nameZh: h.eventName || 'TUR 歷屆經典賽事',
          nameEn: zhToEnEventName(h.eventName || ''),
          organizerZh: 'TUR 台灣超馬協會',
          organizerEn: 'TUR Taiwan Ultra Runners',
          raceType: Number(h.lapCount || 0) > 0 ? 'lap_timed' : 'distance',
          raceStart: dateStr ? `${dateStr} 05:00:00` : ''
        },
        participant: {
          participantId: h.historyId || `HIS-${idx}`,
          bibNumber: h.bibNumber || 'HIS',
          name: h.name || '-',
          nationality: h.nationality || 'TWN'
        },
        category: { name: h.categoryName || `${dist}K 組`, distanceKm: dist },
        raceType: Number(h.lapCount || 0) > 0 ? 'lap_timed' : 'distance',
        lapCount: Number(h.lapCount || 0),
        totalDistanceKm: dist,
        elapsedSec: sec,
        avgPace: sec && dist > 0 ? formatPace(sec, dist) : '--:--',
        overallRank: h.overallRank || '-',
        catRank: h.catRank || '-',
        splitDetails: [],
        isWarrior800: isW800,
        status: canCert ? 'finished' : 'dnf'
      };

      records.push({
        recordId: h.historyId || `HIS-${idx}`,
        source: 'history',
        year,
        eventDate: dateStr || '-',
        eventName: h.eventName || '-',
        categoryName: h.categoryName || '-',
        bibNumber: h.bibNumber || '-',
        name: h.name || '-',
        nationality: h.nationality || 'TWN',
        distanceKm: dist,
        lapCount: Number(h.lapCount || 0),
        finishTime: h.finishTime || '--:--:--',
        elapsedSec: sec,
        avgPace: certRow.avgPace,
        overallRank: h.overallRank || '-',
        catRank: h.catRank || '-',
        status,
        canCert,
        isWarrior800: isW800,
        remark: h.remark || '',
        certRow
      });
    });

    // 2. 僅彙整系統內「已結案 (finished) 且具正式完賽成績」之選手紀錄
    (events || []).filter((ev) => ev && ev.status === 'finished').forEach((ev) => {
      const rs = computeLeaderboard({ event: ev, categories, stations, participants, timingLogs });
      const dateStr = String(ev.raceStart || ev.regStart || '').slice(0, 10);
      const year = dateStr.slice(0, 4) || '2026';
      rs.filter((r) => isCertEligible(ev, r).ok).forEach((r) => {
        const key = `${dateStr}::${ev.nameZh}::${r.participant.name}::${r.participant.bibNumber}`;
        if (dedup.has(key)) return;
        dedup.add(key);
        records.push({
          recordId: `LIVE-${ev.eventId}-${r.participant.participantId}`,
          source: 'live',
          year,
          eventDate: dateStr || '-',
          eventName: ev.nameZh,
          categoryName: r.category.name,
          bibNumber: r.participant.bibNumber || '-',
          name: r.participant.name,
          nationality: r.participant.nationality || 'TWN',
          distanceKm: Number(r.totalDistanceKm || 0),
          lapCount: Number(r.lapCount || 0),
          finishTime: formatDuration(r.elapsedSec),
          elapsedSec: r.elapsedSec,
          avgPace: r.avgPace || '--:--',
          overallRank: r.overallRank || '-',
          catRank: r.catRank || '-',
          status: 'FINISHED',
          canCert: true,
          isWarrior800: Boolean(r.isWarrior800),
          remark: '系統結案成績',
          certRow: r
        });
      });
    });

    records.sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)) || (b.distanceKm - a.distanceKm));
    return records;
  }

  /* --------------------------------------------------------------------------
   * 6E. 外部已完成報名繳費名單 & 歷屆完賽成績標準匯入欄位順序規範
   * -------------------------------------------------------------------------- */
  const EXTERNAL_IMPORT_SPEC = [
    { order: 1, key: 'name', label: '姓名', required: true, aliases: ['姓名', '選手姓名', 'name', 'fullname', 'runner', '跑者姓名'], example: '林大為', desc: '選手完整姓名（必填）' },
    { order: 2, key: 'idCard', label: '身分證 / 護照', required: true, aliases: ['身分證', '身分證字號', '身分證/護照', '護照', 'id', 'idcard', 'passport'], example: 'A123456789', desc: '唯一識別碼，用於防重複與成績歸併（必填）' },
    { order: 3, key: 'gender', label: '性別 (M/F)', required: true, aliases: ['性別', 'gender', 'sex'], example: 'M', desc: '填 M/F 或 男/女（必填）' },
    { order: 4, key: 'category', label: '報名組別', required: true, aliases: ['組別', '報名組別', '參賽組別', 'category', 'cat', 'group'], example: '50K 超馬組', desc: '對應本活動已建立之組別名稱（必填）' },
    { order: 5, key: 'bibNumber', label: '號碼布 (留空自動配號)', required: false, aliases: ['號碼布', '參賽編號', 'bib', 'bibnumber', '編號'], example: 'A088', desc: '留空或撞號時由系統依組別接續配號' },
    { order: 6, key: 'nationality', label: '國籍 (預設 TWN)', required: false, aliases: ['國籍', 'nationality', 'country', 'nat'], example: 'TWN', desc: '3 碼 ISO 國碼，留空預設 TWN' },
    { order: 7, key: 'birthday', label: '出生年月日', required: false, aliases: ['生日', '出生日期', '出生年月日', 'birthday', 'dob'], example: '1989-06-15', desc: 'YYYY-MM-DD（用於 DUV 年齡分組）' },
    { order: 8, key: 'phone', label: '手機號碼', required: false, aliases: ['手機', '手機號碼', '電話', 'phone', 'mobile', 'tel'], example: '0912345678', desc: '緊急聯絡與查詢使用' },
    { order: 9, key: 'email', label: 'Email', required: false, aliases: ['email', '信箱', '電子信箱', 'mail'], example: 'runner@example.com', desc: '通知與證書寄發信箱' },
    { order: 10, key: 'chipUid', label: '晶片 UID', required: false, aliases: ['晶片', '晶片uid', 'chip', 'chipuid', 'uid'], example: '', desc: '若已預先配卡可填；否則留空由寫卡站燒錄' },
    { order: 11, key: 'groupName', label: '跑團 / 備註單位', required: false, aliases: ['跑團', '團報名稱', '單位', 'team', 'club', 'groupname'], example: '外場報名', desc: '外部來源或所屬跑團名稱' }
  ];

  const HISTORY_IMPORT_SPEC = [
    { order: 1, key: 'categoryName', label: '組別名稱', required: true, example: '100K八百壯士組', desc: '預覽審查時可依此組別一鍵批次標示八百壯士' },
    { order: 2, key: 'bibNumber', label: '參賽號碼布', required: true, example: 'W001', desc: '該場次選手號碼布（留空自動編 H 序號）' },
    { order: 3, key: 'lastName', label: '姓（或完整姓名）', required: true, example: '諸葛', desc: '支援 28 組中文複姓；若無拆格可直接填完整姓名' },
    { order: 4, key: 'firstName', label: '名（選填）', required: false, example: '亮', desc: '與第 3 欄智慧合併；若第 3 欄已填全名請留空' },
    { order: 5, key: 'idCard', label: '身分證 / 護照', required: false, example: 'A123456789', desc: '自動轉 SHA-256 雜湊歸併跨年度紀錄，不存明碼' },
    { order: 6, key: 'finishTime', label: '完賽成績', required: true, example: '09:48:12', desc: 'HH:mm:ss 格式（匯入明細一律列為「已完賽」）' },
    { order: 7, key: 'distanceKm', label: '完賽距離 (km)', required: true, example: '100', desc: '有效完賽公里數（純數字，如 100 或 132.4）' }
  ];

  function parseExternalRosterRows({ rawRows = [], event, categories = [], existingParticipants = [] }) {
    const evCats = categories.filter((c) => c.eventId === event.eventId);
    const defaultCat = evCats[0] || { catId: '', name: '未分類', fee: 0, bibPrefix: 'E', bibStartNum: '001' };
    const existById = new Map();
    const existBibs = new Set();
    existingParticipants.filter((p) => p.eventId === event.eventId).forEach((p) => {
      if (p.idCard) existById.set(String(p.idCard).toUpperCase(), p);
      if (p.bibNumber) existBibs.add(String(p.bibNumber).toUpperCase());
    });

    const cleanRows = rawRows
      .map((r) => (Array.isArray(r) ? r.map((x) => String(x ?? '').trim()) : []))
      .filter((r) => r.some(Boolean));
    if (!cleanRows.length) return { items: [], summary: { total: 0, ready: 0, dupUpdate: 0, invalid: 0 } };

    // 偵測第一列是否為表頭列，並自動建立欄位索引對照
    const firstLower = cleanRows[0].map((c) => c.toLowerCase().replace(/[\s*()（）*]/g, ''));
    const colMap = {};
    let headerHits = 0;
    firstLower.forEach((h, idx) => {
      EXTERNAL_IMPORT_SPEC.forEach((spec) => {
        if (colMap[spec.key] !== undefined) return;
        if (spec.aliases.some((a) => h === a.toLowerCase().replace(/[\s/]/g, '') || h.includes(a.toLowerCase().replace(/[\s/]/g, '')))) {
          colMap[spec.key] = idx;
          headerHits++;
        }
      });
    });

    const hasHeader = headerHits >= 2;
    const dataRows = hasHeader ? cleanRows.slice(1) : cleanRows;
    if (!hasHeader) {
      // 無表頭時依預設固定順序：姓名, 身分證, 性別, 組別, 號碼布, 國籍, 生日, 手機, Email, 晶片UID, 跑團
      EXTERNAL_IMPORT_SPEC.forEach((spec, idx) => { colMap[spec.key] = idx; });
    }

    const seenInBatch = new Set();
    const items = dataRows.map((cols, idx) => {
      const get = (k) => (colMap[k] !== undefined && cols[colMap[k]] !== undefined) ? String(cols[colMap[k]]).trim() : '';
      const name = get('name');
      const idCard = get('idCard').toUpperCase();
      let gender = get('gender').toUpperCase();
      if (gender === '男') gender = 'M';
      else if (gender === '女') gender = 'F';
      if (!gender && idCard) gender = inferGenderFromId(idCard) || 'M';
      const catRaw = get('category');
      const matchedCat = evCats.find((c) => c.name === catRaw || c.catId === catRaw || (catRaw && c.name.toUpperCase().includes(catRaw.toUpperCase()))) || defaultCat;
      const bibNumber = get('bibNumber').toUpperCase();
      const nationality = (get('nationality') || 'TWN').toUpperCase().slice(0, 3);
      const birthday = get('birthday') || '1990-01-01';
      const phone = get('phone');
      const email = get('email');
      const chipUid = get('chipUid').toUpperCase();
      const groupName = get('groupName') || '外部名單匯入';

      const errors = [];
      const warnings = [];
      if (!name || name.length < 2) errors.push('缺少姓名');
      if (!idCard) errors.push('缺少身分證/護照');
      if (gender !== 'M' && gender !== 'F') errors.push('性別須為 M/F');
      if (!catRaw) warnings.push(`未填組別，自動套用「${matchedCat.name}」`);
      else if (matchedCat.name !== catRaw && !matchedCat.name.toUpperCase().includes(catRaw.toUpperCase())) {
        warnings.push(`組別「${catRaw}」改對應「${matchedCat.name}」`);
      }

      const existing = idCard ? existById.get(idCard) : null;
      const dupInBatch = idCard && seenInBatch.has(idCard);
      if (idCard) seenInBatch.add(idCard);
      if (dupInBatch) errors.push('本批名單內身分證重複');
      if (bibNumber && existBibs.has(bibNumber) && (!existing || existing.bibNumber !== bibNumber)) {
        warnings.push(`號碼布 ${bibNumber} 已被使用，匯入時將自動重配`);
      }

      const status = errors.length ? 'invalid' : (existing ? 'duplicate' : 'ready');
      return {
        rowNum: idx + (hasHeader ? 2 : 1),
        status,
        errors,
        warnings,
        existingParticipantId: existing ? existing.participantId : '',
        data: {
          name, idCard, gender, catId: matchedCat.catId, categoryName: matchedCat.name, fee: Number(matchedCat.fee || 0),
          bibNumber: (bibNumber && existBibs.has(bibNumber) && (!existing || existing.bibNumber !== bibNumber)) ? '' : bibNumber,
          nationality, birthday, phone, email, chipUid, groupName
        }
      };
    });

    return {
      hasHeader,
      items,
      summary: {
        total: items.length,
        ready: items.filter((x) => x.status === 'ready').length,
        dupUpdate: items.filter((x) => x.status === 'duplicate').length,
        invalid: items.filter((x) => x.status === 'invalid').length
      }
    };
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
    { id: 'tur-gold', name: '1. TUR 藍金底圖', bg1: '#0f172a', bg2: '#1e293b', accent: '#f59e0b', accent2: '#38bdf8', text: '#ffffff', sub: '#cbd5e1' },
    { id: 'obsidian', name: '2. 冠軍黑金底圖', bg1: '#09090b', bg2: '#18181b', accent: '#eab308', accent2: '#fbbf24', text: '#fafafa', sub: '#a1a1aa' },
    { id: 'forest', name: '3. 越野森綠底圖', bg1: '#052e16', bg2: '#14532d', accent: '#4ade80', accent2: '#facc15', text: '#f0fdf4', sub: '#bbf7d0' },
    { id: 'lava', name: '4. 日出熔岩底圖', bg1: '#431407', bg2: '#7c2d12', accent: '#fb923c', accent2: '#fde047', text: '#fff7ed', sub: '#fed7aa' },
    { id: 'aurora', name: '5. 櫻花極光底圖', bg1: '#3b0764', bg2: '#831843', accent: '#f472b6', accent2: '#38bdf8', text: '#fdf2f8', sub: '#fbcfe8' },
    { id: 'royal', name: '6. 皇室白金底圖', bg1: '#f8fafc', bg2: '#e2e8f0', accent: '#0f172a', accent2: '#d97706', text: '#0f172a', sub: '#475569' }
  ];

  const CERT_FONTS = [
    { id: 'sans-modern', name: '1. 現代黑體', family: '"Noto Sans TC", "Microsoft JhengHei", sans-serif', numFamily: '"Noto Sans TC", monospace' },
    { id: 'serif-classic', name: '2. 典雅明體', family: '"Noto Serif TC", "PMingLiU", Georgia, serif', numFamily: '"Noto Serif TC", Georgia, serif' },
    { id: 'kai-calligraphy', name: '3. 榮耀楷體', family: '"DFKai-SB", "BiauKai", "標楷體", "Kaiti TC", serif', numFamily: '"DFKai-SB", Georgia, serif' },
    { id: 'rounded-sport', name: '4. 動感圓體', family: '"Zen Maru Gothic", "Microsoft JhengHei UI", "Hiragino Maru Gothic ProN", sans-serif', numFamily: '"Zen Maru Gothic", sans-serif' },
    { id: 'condensed-race', name: '5. 競速窄體', family: '"Oswald", "Arial Narrow", "Microsoft JhengHei", sans-serif', numFamily: '"Oswald", "Arial Narrow", sans-serif' },
    { id: 'mono-tech', name: '6. 數位計時體', family: '"JetBrains Mono", Consolas, "Courier New", "Microsoft JhengHei", monospace', numFamily: '"JetBrains Mono", Consolas, monospace' }
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

  function drawRunnerPhotoFrame(ctx, photoBox, pal, userOpts) {
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
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(photoBox.x, photoBox.y, photoBox.w, photoBox.h);
      ctx.fillStyle = pal.sub;
      ctx.font = 'bold 26px "Noto Sans TC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('選手個人完賽照片區', photoBox.x + photoBox.w / 2, photoBox.y + photoBox.h / 2 - 8);
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

  function renderCertificateCanvas(canvas, row, configInput, userOpts = {}) {
    const cfg = { ...defaultCertConfig(), ...(configInput || {}) };
    const isPortrait = cfg.orientation === 'portrait';
    const isCustomRunner = (userOpts.certMode || cfg.certMode) === 'custom_runner';
    const W = isPortrait ? 1131 : 1600;
    const H = isPortrait ? 1600 : 1131;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    const pal = CERT_PALETTES.find((p) => p.id === cfg.paletteId) || CERT_PALETTES[0];
    const fontDef = CERT_FONTS.find((f) => f.id === cfg.fontId) || CERT_FONTS[0];
    const FF = fontDef.family;
    const NF = fontDef.numFamily;

    const ev = row?.event || { nameZh: 'TUR 台灣超級馬拉松挑戰賽', nameEn: 'TUR Taiwan Ultra Marathon', raceStart: '2026-11-26', organizerZh: 'TUR 台灣超馬協會' };
    const p = row?.participant || { name: '示範選手', bibNumber: 'A001', nationality: 'TWN', gender: 'M' };
    const cat = row?.category || { name: '50K 超馬組', distanceKm: 50 };
    const directorName = String(cfg.raceDirectorName ?? ev.raceDirectorName ?? '林政宏').trim();
    const cx = W / 2;

    // 共用頁尾繪製：TUR 官方 LOGO 移至下方置中 ＋ 最下列（比賽日期 / 主辦單位 / 賽事總監）平均置中對齊
    const drawBottomLogoAndFooter = (isCustomBg) => {
      const logoW = isPortrait ? 340 : 370;
      const logoH = isPortrait ? 86 : 90;
      const logoY = H - 252;

      if (cfg.showOfficialStamp) {
        drawTurLogoBadge(ctx, Math.round(cx - logoW / 2), logoY, logoW, logoH, pal.accent);
        drawOfficialStamp(ctx, Math.round(cx + logoW / 2 + (isPortrait ? 92 : 112)), Math.round(logoY + logoH / 2), pal.accent, isPortrait ? 48 : 52);
      }

      const footerItems = [];
      if (cfg.showDate) {
        const dateStr = (ev.raceStart || formatDateTime()).slice(0, 10);
        footerItems.push({ label: '比賽日期  DATE', value: dateStr, highlight: false });
      }
      footerItems.push({
        label: '主辦單位  ORGANIZER',
        value: ev.organizerZh || ev.organizerEn || 'TUR 台灣超馬協會',
        highlight: false
      });
      if (cfg.showRaceDirector !== false && directorName) {
        footerItems.push({
          label: '賽事總監  RACE DIRECTOR',
          value: directorName,
          highlight: true
        });
      }

      if (footerItems.length > 0) {
        const padX = isPortrait ? 84 : 100;
        const innerW = W - padX * 2;
        const dividerY = H - 148;
        const labelY = H - 118;
        const valY = H - 80;

        ctx.save();
        ctx.strokeStyle = isCustomBg ? 'rgba(255,255,255,0.45)' : pal.accent;
        ctx.globalAlpha = isCustomBg ? 0.6 : 0.35;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padX, dividerY);
        ctx.lineTo(W - padX, dividerY);
        ctx.stroke();

        const slotW = innerW / footerItems.length;
        ctx.textAlign = 'center';
        if (isCustomBg) {
          ctx.shadowColor = 'rgba(0,0,0,0.6)';
          ctx.shadowBlur = 8;
        }

        footerItems.forEach((it, idx) => {
          const itemCx = padX + slotW * (idx + 0.5);
          if (idx > 0) {
            ctx.save();
            ctx.strokeStyle = isCustomBg ? '#ffffff' : pal.sub;
            ctx.globalAlpha = 0.28;
            ctx.lineWidth = 1.5;
            const sepX = padX + slotW * idx;
            ctx.beginPath();
            ctx.moveTo(sepX, dividerY + 18);
            ctx.lineTo(sepX, H - 72);
            ctx.stroke();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = isCustomBg ? '#e2e8f0' : pal.sub;
          ctx.font = `700 ${isPortrait ? 18 : 19}px ${FF}`;
          ctx.fillText(it.label, itemCx, labelY, slotW - 24);

          ctx.fillStyle = it.highlight
            ? (isCustomBg ? '#fde047' : pal.accent)
            : (isCustomBg ? '#ffffff' : pal.text);
          ctx.font = `900 ${isPortrait ? 26 : 28}px ${FF}`;
          ctx.fillText(it.value, itemCx, valY, slotW - 24);
        });
        ctx.restore();
      }
    };

    ctx.clearRect(0, 0, W, H);

    // 1. 自訂上傳底圖套印模式（10 欄位各自獨立位置 / 字體大小 / 顏色 / 對齊 / 顯示開關，支援畫布直接點選拖曳）
    if (userOpts.customBgImg) {
      drawCoverImage(ctx, userOpts.customBgImg, 0, 0, W, H);
      const elems = getMergedCustomBgElements(cfg);
      const hitBoxes = [];

      if (isCustomRunner && (userOpts.photoImg || userOpts.showPhotoPlaceholder)) {
        const photoBox = isPortrait
          ? { x: Math.round(cx - 165), y: 200, w: 330, h: 360 }
          : { x: 1030, y: 210, w: 480, h: 580 };
        drawRunnerPhotoFrame(ctx, photoBox, pal, userOpts);
      }

      const bibParts = [];
      if (cfg.showBib !== false) bibParts.push(`BIB ${p.bibNumber || '---'}`);
      if (cfg.showCategory !== false) bibParts.push(cat.name || '');
      if (cfg.enableWarrior800 !== false && row?.isWarrior800) bibParts.push('★ 八百壯士');

      const primaryTxt = ev.raceType === 'lap_timed'
        ? `${Number(row?.totalDistanceKm || 0).toFixed(2)} KM`
        : formatDuration(row?.elapsedSec);
      const secondaryTxt = ev.raceType === 'lap_timed'
        ? `${row?.lapCount || 0} 圈 (${formatDuration(row?.elapsedSec)})`
        : `完賽距離 ${Number(row?.totalDistanceKm ?? cat.distanceKm ?? 0).toFixed(1)} KM`;
      const rankParts = [];
      if (cfg.showOverallRank !== false) rankParts.push(`總名次 #${row?.overallRank ?? '-'}`);
      if (cfg.showCatRank !== false) rankParts.push(`分組 #${row?.catRank ?? '-'}`);
      if (cfg.showPace !== false) rankParts.push(`均速 ${row?.avgPace || '--:--'}`);

      const dateVal = (ev.raceStart || formatDateTime()).slice(0, 10);
      const textValues = {
        eventName: { text: ev.nameZh || '', font: FF, weight: '900' },
        runnerName: { text: p.name || '-', font: FF, weight: '900' },
        bibCategory: { text: bibParts.filter(Boolean).join('  ·  '), font: NF, weight: '800' },
        primaryResult: { text: primaryTxt, font: NF, weight: '900' },
        secondaryResult: { text: secondaryTxt, font: FF, weight: '800' },
        rankPace: { text: rankParts.join('   |   '), font: FF, weight: '700' },
        date: { text: `比賽日期：${dateVal}`, font: FF, weight: '800' },
        organizer: { text: `主辦單位：${ev.organizerZh || 'TUR 台灣超馬協會'}`, font: FF, weight: '800' },
        director: { text: directorName ? `賽事總監：${directorName}` : '', font: FF, weight: '800' }
      };

      const selKey = userOpts.selectedElementKey || '';
      const selEl = selKey ? elems[selKey] : null;
      // 若正在編輯且水平靠近中線 (50%)，繪製柔和垂直置中輔助線
      if (selEl && selEl.visible && Math.abs(Number(selEl.x) - 0.5) <= 0.012) {
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.beginPath();
        ctx.moveTo(cx, 24);
        ctx.lineTo(cx, H - 24);
        ctx.stroke();
        ctx.restore();
      }

      CERT_CUSTOM_ELEMENTS.forEach((meta) => {
        const el = elems[meta.key];
        if (!el || !el.visible) return;
        const px = W * Number(el.x ?? 0.5);
        const py = H * Number(el.y ?? 0.5);
        const sz = Math.max(meta.minSize, Math.min(meta.maxSize, Number(el.size || 32)));

        if (meta.isLogo) {
          const logoH = sz;
          const logoW = Math.round(logoH * 4.1);
          const lx = Math.round(px - logoW / 2);
          const ly = Math.round(py - logoH / 2);
          drawTurLogoBadge(ctx, lx, ly, logoW, logoH, el.color || pal.accent);
          hitBoxes.push({ key: meta.key, label: meta.label, x: lx - 8, y: ly - 8, w: logoW + 16, h: logoH + 16, cx: px, cy: py });
          return;
        }

        const spec = textValues[meta.key];
        if (!spec || !spec.text) return;
        ctx.save();
        ctx.font = `${spec.weight} ${Math.round(sz)}px ${spec.font}`;
        ctx.textAlign = el.align || 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = el.color || '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.52)';
        ctx.shadowBlur = 10;
        ctx.fillText(spec.text, px, py, W - 80);

        const tw = Math.min(W - 80, Math.max(80, ctx.measureText(spec.text).width));
        const th = Math.max(28, sz * 1.18);
        let bx = px - tw / 2;
        if (el.align === 'left') bx = px;
        else if (el.align === 'right') bx = px - tw;
        hitBoxes.push({ key: meta.key, label: meta.label, x: bx - 12, y: py - th / 2 - 6, w: tw + 24, h: th + 12, cx: px, cy: py });
        ctx.restore();
      });

      if (isCustomRunner && cfg.allowPublicPhotoQuote && String(userOpts.quote || '').trim()) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fde68a';
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 8;
        ctx.font = `italic 700 28px ${FF}`;
        ctx.fillText(`「${String(userOpts.quote).trim().slice(0, 40)}」`, cx, H * 0.74, W - 120);
        ctx.restore();
      }

      // 編輯模式高亮目前選中欄位的虛線框與座標標籤（匯出 PNG/PDF/ZIP 不帶 selectedElementKey 故完全乾淨）
      if (selKey) {
        const hb = hitBoxes.find((b) => b.key === selKey);
        if (hb && selEl) {
          ctx.save();
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 3;
          ctx.setLineDash([10, 6]);
          ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
          ctx.setLineDash([]);
          const tagTxt = `${hb.label} · X:${Math.round(selEl.x * 100)}% Y:${Math.round(selEl.y * 100)}% · ${Math.round(selEl.size)}px`;
          ctx.font = '700 18px "Noto Sans TC", sans-serif';
          const tagW = ctx.measureText(tagTxt).width + 20;
          const tagX = Math.max(12, Math.min(W - tagW - 12, hb.x));
          const tagY = Math.max(12, hb.y - 34);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
          roundRectPath(ctx, tagX, tagY, tagW, 28, 6);
          ctx.fill();
          ctx.fillStyle = '#38bdf8';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tagTxt, tagX + 10, tagY + 14);
          ctx.restore();
        }
      }

      canvas._customHitBoxes = hitBoxes;
      return hitBoxes;
    }

    canvas._customHitBoxes = [];

    // 2. 內建 6 種底圖（漸層＋質感紋理）與 6 種樣式（版型）
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, pal.bg1);
    grad.addColorStop(1, pal.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 細緻底圖裝飾線條
    ctx.save();
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.06;
    ctx.lineWidth = 2;
    for (let x = -H; x < W + H; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H, H); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    if (cfg.layoutId === 'classic') {
      ctx.strokeStyle = pal.accent; ctx.lineWidth = 10; ctx.strokeRect(40, 40, W - 80, H - 80);
      ctx.lineWidth = 2; ctx.strokeRect(58, 58, W - 116, H - 116);
    } else if (cfg.layoutId === 'diagonal') {
      ctx.fillStyle = pal.accent; ctx.globalAlpha = 0.16;
      ctx.beginPath(); ctx.moveTo(W * 0.56, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(W * 0.36, H); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillRect(0, 0, 24, H);
    } else if (cfg.layoutId === 'minimal') {
      ctx.fillStyle = pal.accent; ctx.fillRect(cx - 100, 62, 200, 8); ctx.fillRect(90, H - 60, W - 180, 3);
    } else if (cfg.layoutId === 'trail') {
      ctx.fillStyle = pal.accent; ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, H * 0.72); ctx.lineTo(W * 0.25, H * 0.54);
      ctx.lineTo(W * 0.5, H * 0.74); ctx.lineTo(W * 0.75, H * 0.46); ctx.lineTo(W, H * 0.62); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    } else if (cfg.layoutId === 'neon') {
      ctx.shadowColor = pal.accent2; ctx.shadowBlur = 24;
      ctx.strokeStyle = pal.accent2; ctx.lineWidth = 6; ctx.strokeRect(46, 46, W - 92, H - 92);
      ctx.shadowBlur = 0;
    } else if (cfg.layoutId === 'podium') {
      ctx.fillStyle = pal.accent; ctx.fillRect(0, 0, W, 222);
      ctx.fillStyle = pal.accent2; ctx.fillRect(0, 222, W, 10);
    }
    ctx.restore();

    // 3. 選手個人照片框：僅「選手客製化證書」顯示，官方證書絕對不加入個人照片
    const showPhoto = isCustomRunner && (userOpts.photoImg || userOpts.showPhotoPlaceholder);
    const photoBox = isPortrait
      ? { x: Math.round(cx - 165), y: 246, w: 330, h: 350 }
      : { x: 1040, y: 246, w: 465, h: 575 };

    if (showPhoto) {
      drawRunnerPhotoFrame(ctx, photoBox, pal, userOpts);
    }

    // 4. 置中標題與活動名稱（預設字體大幅放大，清晰易讀）
    const isPodium = cfg.layoutId === 'podium';
    ctx.textAlign = 'center';
    let curY = isPortrait ? 114 : 104;

    ctx.fillStyle = isPodium ? '#0f172a' : pal.accent;
    ctx.font = `900 ${isPortrait ? 28 : 29}px ${FF}`;
    ctx.fillText(isCustomRunner ? 'PERSONAL FINISHER CERTIFICATE · 個人客製化完賽證明' : 'OFFICIAL FINISHER CERTIFICATE · 官方完賽證明', cx, curY, W - 160);
    curY += isPortrait ? 60 : 58;

    if (cfg.showEventName) {
      ctx.fillStyle = isPodium ? '#0f172a' : pal.text;
      ctx.font = `900 ${isPortrait ? 48 : 54}px ${FF}`;
      ctx.fillText(ev.nameZh || '', cx, curY, W - 160);
      curY += isPortrait ? 44 : 42;
      ctx.fillStyle = isPodium ? '#334155' : pal.sub;
      ctx.font = `600 ${isPortrait ? 23 : 24}px ${FF}`;
      ctx.fillText(ev.nameEn || '', cx, curY, W - 180);
      curY += isPortrait ? 22 : 20;
    } else {
      curY += 16;
    }

    // 置中金線分隔
    if (!isPodium) {
      ctx.save();
      ctx.fillStyle = pal.accent;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(cx - 110, curY, 220, 4);
      ctx.restore();
    }

    // 5. 內容主區中心點（官方全幅置中；客製化橫式左欄置中、直式全幅置中於照片下方）
    const contentLeft = isPortrait ? 84 : 95;
    const contentW = (showPhoto && !isPortrait) ? 900 : (W - contentLeft * 2);
    const contentCx = contentLeft + contentW / 2;

    if (showPhoto && isPortrait) {
      curY = photoBox.y + photoBox.h + 88;
    } else {
      curY += isPortrait ? 102 : 94;
    }

    if (cfg.showRunnerName) {
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.text;
      const nameSize = (showPhoto && !isPortrait) ? 88 : (isPortrait ? 96 : 104);
      ctx.font = `900 ${nameSize}px ${FF}`;
      ctx.fillText(p.name || '-', contentCx, curY, contentW - 20);
      curY += isPortrait ? 62 : 56;
    }

    const metaParts = [];
    if (cfg.showBib) metaParts.push(`BIB ${p.bibNumber || '---'}`);
    metaParts.push(p.nationality || 'TWN');
    if (cfg.showCategory) metaParts.push(cat.name);
    if (cfg.enableWarrior800 && row?.isWarrior800) metaParts.push('★ 八百壯士 100K+ 完賽認證');
    if (metaParts.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.accent2;
      ctx.font = `800 ${(showPhoto && !isPortrait) ? 28 : 33}px ${NF}`;
      ctx.fillText(metaParts.join('  ·  '), contentCx, curY, contentW - 10);
      curY += isPortrait ? 44 : 38;
    }

    // 6. 動態成績卡片網格（置中文字、字體加大加粗）
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

    const cols = (!showPhoto && !isPortrait && cards.length === 4) ? 4 : Math.min(2, Math.max(1, cards.length));
    const gap = 20;
    const cardW = (contentW - gap * (cols - 1)) / cols;
    const cardH = isPortrait ? 132 : (showPhoto ? 116 : 132);

    cards.forEach((c, idx) => {
      const col = idx % cols;
      const r = Math.floor(idx / cols);
      const x = contentLeft + col * (cardW + gap);
      const y = curY + r * (cardH + 16);
      const cardCx = x + cardW / 2;
      ctx.fillStyle = pal.id === 'royal' ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.09)';
      roundRectPath(ctx, x, y, cardW, cardH, 16);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.sub;
      ctx.font = `700 ${cols === 4 ? 20 : 21}px ${FF}`;
      ctx.fillText(c.label, cardCx, y + 38, cardW - 20);
      ctx.fillStyle = pal.accent;
      ctx.font = `900 ${cols === 4 ? 44 : 48}px ${NF}`;
      ctx.fillText(c.val, cardCx, y + (cardH > 120 ? 102 : 92), cardW - 20);
    });

    curY += Math.ceil(cards.length / cols) * (cardH + 16) + 18;

    // 7. 感應點區段均速與綜合分析表（置中呈現，空間自動收斂不撞頁尾 Logo）
    const footerGuardY = H - 270;
    if (cfg.showSplitAnalysis && row?.splitDetails && row.splitDetails.length > 0 && curY + 95 < footerGuardY) {
      const quoteReserve = (isCustomRunner && cfg.allowPublicPhotoQuote && String(userOpts.quote || '').trim()) ? 70 : 0;
      const rowStep = isPortrait ? 40 : 38;
      const maxFitRows = Math.max(1, Math.floor((footerGuardY - quoteReserve - curY - 56) / rowStep));
      const splits = row.splitDetails.slice(0, Math.min(isPortrait ? 6 : 5, maxFitRows));
      const boxH = 54 + splits.length * rowStep;

      ctx.fillStyle = pal.id === 'royal' ? 'rgba(15,23,42,0.05)' : 'rgba(255,255,255,0.07)';
      roundRectPath(ctx, contentLeft, curY, contentW, boxH, 16);
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.fillStyle = pal.accent2;
      ctx.font = `800 22px ${FF}`;
      ctx.fillText('CHECKPOINT SPLIT ANALYSIS · 感應點區段均速分析', contentCx, curY + 35, contentW - 30);

      splits.forEach((sp, i) => {
        const sy = curY + 74 + i * rowStep;
        ctx.fillStyle = pal.text;
        ctx.font = `700 ${(showPhoto && !isPortrait) ? 21 : 24}px ${NF}`;
        ctx.fillText(`${sp.code}   通過 ${sp.time}   ｜   累計 ${formatDuration(sp.cumSec)}   ｜   區段均速 ${sp.segPace}`, contentCx, sy, contentW - 36);
      });
      curY += boxH + 18;
    }

    // 8. 選手 40 字完賽感言（僅客製化證書呈現，置中顯示）
    const quote = String(userOpts.quote || '').trim().slice(0, 40);
    if (isCustomRunner && cfg.allowPublicPhotoQuote && quote && curY + 42 < footerGuardY) {
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.text;
      ctx.font = `italic 700 26px ${FF}`;
      ctx.fillText(`「${quote}」`, contentCx, curY + 34, contentW - 30);
    }

    // 9. 下方官方 TUR LOGO ＋ 鋼印 ＋ 最下列（比賽日期 / 主辦單位 / 賽事總監姓名）平均置中
    drawBottomLogoAndFooter(false);
  }

  function drawOfficialStamp(ctx, cx, cy, color, radius = 56) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.18);
    ctx.strokeStyle = color; ctx.globalAlpha = 0.8; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, radius - 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(radius * 0.31)}px "Noto Sans TC", sans-serif`;
    ctx.fillText('TUR 官方認證', 0, -2);
    ctx.font = `700 ${Math.round(radius * 0.21)}px monospace`;
    ctx.fillText('OFFICIAL TIMING', 0, Math.round(radius * 0.28));
    ctx.restore();
  }

  /* --------------------------------------------------------------------------
   * 6F. 全站字體縮放、雙賽制流程檢視、與現場站點管制 SOP 輔助引擎
   * -------------------------------------------------------------------------- */
  const FONT_SCALE_MODES = [
    { id: 'normal', label: '標準', btn: 'A', pct: '100%' },
    { id: 'large', label: '放大', btn: 'A+', pct: '114%' },
    { id: 'xlarge', label: '特大', btn: 'A++', pct: '128%' }
  ];

  function applyFontScale(mode) {
    const picked = FONT_SCALE_MODES.find((m) => m.id === mode) || FONT_SCALE_MODES[0];
    try {
      if (global.document && global.document.documentElement) {
        global.document.documentElement.style.fontSize = picked.pct;
      }
      if (global.localStorage) global.localStorage.setItem('TUR_FONT_SCALE', picked.id);
    } catch (_) {}
    return picked.id;
  }

  function getSavedFontScale() {
    try {
      const saved = global.localStorage ? global.localStorage.getItem('TUR_FONT_SCALE') : 'normal';
      return FONT_SCALE_MODES.some((m) => m.id === saved) ? saved : 'normal';
    } catch (_) {
      return 'normal';
    }
  }

  function getRaceTypeWorkflow(ev, stations = [], categories = []) {
    const isLap = ev?.raceType === 'lap_timed';
    const evSts = stations.filter((s) => s.eventId === ev?.eventId).sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const evCats = categories.filter((c) => c.eventId === ev?.eventId);
    if (isLap) {
      return {
        raceType: 'lap_timed',
        badge: '🔁 繞圈賽',
        shortRule: `單圈 ${Number(ev?.lapDistanceKm || 1.0)} km · 限時累圈比總里程`,
        steps: [
          { no: 1, title: '分組設定', desc: `目前 ${evCats.length} 組，單圈 ${Number(ev?.lapDistanceKm || 1.0)} km`, ok: evCats.length > 0 && Number(ev?.lapDistanceKm || 0) > 0 },
          { no: 2, title: '對帳配號', desc: '入帳後配號與寫卡', ok: true },
          { no: 3, title: '報到檢錄', desc: '起跑前感應報到', ok: evSts.some((s) => String(s.stationCode).toUpperCase() === 'CHECKIN') },
          { no: 4, title: '繞圈感應', desc: 'LAP 拱門累圈，逾時自動過濾', ok: evSts.some((s) => String(s.stationCode).toUpperCase() === 'LAP') },
          { no: 5, title: '結案製證', desc: '依總里程排序並結案', ok: Boolean(ev?.raceStart) }
        ]
      };
    }
    const routeText = evSts.map((s) => s.stationCode).join(' → ') || 'CHECKIN → CP1 → FINISH';
    return {
      raceType: 'distance',
      badge: '🏃 距離賽',
      shortRule: `節點：${routeText} · 比完賽時間`,
      steps: [
        { no: 1, title: '分組設定', desc: `目前 ${evCats.length} 組`, ok: evCats.length > 0 },
        { no: 2, title: '對帳配號', desc: '入帳後配號與寫卡', ok: true },
        { no: 3, title: '報到檢錄', desc: '起跑前感應報到', ok: evSts.some((s) => String(s.stationCode).toUpperCase() === 'CHECKIN') },
        { no: 4, title: '各站計時', desc: `依序感應 ${routeText}`, ok: evSts.some((s) => String(s.stationCode).toUpperCase() === 'FINISH') },
        { no: 5, title: '結案製證', desc: '核對成績與罰時後結案', ok: Boolean(ev?.raceStart) }
      ]
    };
  }

  function getStationSopInfo(ev, stationCode, stations = []) {
    const code = String(stationCode || '').toUpperCase();
    const evSts = stations.filter((s) => s.eventId === ev?.eventId).sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const stObj = evSts.find((s) => String(s.stationCode).toUpperCase() === code);
    const isLap = ev?.raceType === 'lap_timed';
    const map = {
      WRITER: {
        roleLabel: '發卡寫入站',
        action: '寫入 NDEF「姓名|身分證」、綁定 UID 或核准舊卡',
        guard: '攔截未繳費 / 未配號 / 已結案活動',
        fallback: '晶片異常請換新卡重新寫入'
      },
      CHECKIN: {
        roleLabel: stObj?.name || '報到檢錄站',
        action: '感應確認選手報到（不計入成績）',
        guard: '攔截未繳費與重複報到',
        fallback: '異常時用下方手動補登'
      },
      LAP: {
        roleLabel: `${stObj?.name || '繞圈主拱門'} (${Number(ev?.lapDistanceKm || 1.0)}km)`,
        action: '每圈刷卡累圈，逾限時標註超時圈',
        guard: '未鳴槍鎖定；防 15 秒連點',
        fallback: '漏感應請用下方手動補圈'
      },
      FINISH: {
        roleLabel: `${stObj?.name || '終點站'}${stObj?.distanceKm ? ` (${stObj.distanceKm}km)` : ''}`,
        action: '感應衝線計算完賽時間與配速',
        guard: '未鳴槍鎖定；不覆蓋首次衝線',
        fallback: '漏感應請用下方手動補登'
      }
    };
    const info = map[code] || {
      roleLabel: `${stObj ? stObj.name : code}${stObj?.distanceKm ? ` (${stObj.distanceKm}km)` : ''}`,
      action: '記錄通過時間與區段均速',
      guard: '未鳴槍鎖定；防 15 秒連點',
      fallback: '漏感應請用下方手動補登'
    };
    return {
      code,
      stationName: stObj ? stObj.name : code,
      distanceKm: stObj ? Number(stObj.distanceKm || 0) : 0,
      raceTypeLabel: isLap ? '🔁 計時繞圈賽' : '🏃 一般距離賽',
      routeNodes: evSts.map((s) => s.stationCode),
      ...info
    };
  }
    // Re-add section 8 header right after getStationSopInfo
  /* --------------------------------------------------------------------------
   * 6H. 多場活動聯合報名合併訂單引擎 (Multi-Event Bundle Engine)
   * -------------------------------------------------------------------------- */
  function isBundleOrderCode(code) {
    return /^TURM-[A-Z0-9-]+$/i.test(String(code || '').trim());
  }

  function generateBundleOrderCode() {
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const rnd = Math.floor(1000 + Math.random() * 9000);
    return `TURM-${yy}${mm}${dd}-${rnd}`;
  }

  function summarizeBundleOrders({ participants = [], events = [], categories = [] }) {
    const evMap = new Map(events.map((e) => [e.eventId, e]));
    const catMap = new Map(categories.map((c) => [c.catId, c]));
    const map = new Map();

    participants.forEach((p) => {
      const code = String(p.merTradeNo || '').trim().toUpperCase();
      if (!isBundleOrderCode(code)) return;
      const st = String(p.payStatus || 'UNPAID').toUpperCase();
      if (st === 'CANCELLED') return;

      if (!map.has(code)) {
        map.set(code, {
          bundleCode: code,
          runnerName: p.name || '',
          idCard: p.idCard || '',
          phone: p.phone || '',
          email: p.email || '',
          payMethod: p.payMethod || 'MANUAL_ATM',
          remittanceLast5: p.remittanceLast5 || '',
          createdAt: p.createdAt || '',
          items: [],
          eventIds: [],
          totalAmount: 0,
          paidCount: 0,
          unpaidCount: 0,
          allPaid: false
        });
      }
      const b = map.get(code);
      const ev = evMap.get(p.eventId) || null;
      const cat = catMap.get(p.catId) || null;
      const amt = Number(p.totalAmount || 0);
      if (!b.remittanceLast5 && p.remittanceLast5) b.remittanceLast5 = p.remittanceLast5;
      if (!b.eventIds.includes(p.eventId)) b.eventIds.push(p.eventId);
      b.items.push({
        participant: p,
        event: ev,
        category: cat,
        eventId: p.eventId,
        eventName: ev?.nameZh || p.eventId,
        catName: cat?.name || p.catId,
        amount: amt,
        payStatus: st,
        bibNumber: p.bibNumber || ''
      });
      b.totalAmount += amt;
      if (st === 'PAID') b.paidCount++;
      else b.unpaidCount++;
    });

    const list = [...map.values()].map((b) => ({
      ...b,
      allPaid: b.items.length > 0 && b.unpaidCount === 0
    }));
    list.sort((a, b) => (b.unpaidCount > 0 ? 1 : 0) - (a.unpaidCount > 0 ? 1 : 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  /* --------------------------------------------------------------------------
   * 6G. 前端極速效能工具：中文組字防抖輸入 (bindFastInput) + 外部大套件/字型按需延遲載入
   * -------------------------------------------------------------------------- */
  function bindFastInput(el, handler, delay = 150) {
    if (!el || typeof handler !== 'function') return;
    let timer = null;
    let composing = false;
    const fire = (e) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; handler(e); }, delay);
    };
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', (e) => { composing = false; fire(e); });
    el.addEventListener('input', (e) => { if (!composing) fire(e); });
  }

  const _extLibPromises = {};
  const EXT_LIB_URLS = {
    xlsx: { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', ready: () => Boolean(global.XLSX) },
    jszip: { url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', ready: () => Boolean(global.JSZip) },
    jspdf: { url: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', ready: () => Boolean(global.jspdf?.jsPDF) }
  };

  function ensureExternalLib(name) {
    const spec = EXT_LIB_URLS[name];
    if (!spec) return Promise.resolve(false);
    if (spec.ready()) return Promise.resolve(true);
    if (_extLibPromises[name]) return _extLibPromises[name];
    _extLibPromises[name] = new Promise((resolve) => {
      if (!global.document) return resolve(false);
      const s = global.document.createElement('script');
      s.src = spec.url;
      s.async = true;
      s.onload = () => resolve(spec.ready());
      s.onerror = () => { delete _extLibPromises[name]; resolve(false); };
      global.document.head.appendChild(s);
    });
    return _extLibPromises[name];
  }

  let _certFontsLoaded = false;
  function ensureCertFonts() {
    if (_certFontsLoaded || !global.document) return;
    _certFontsLoaded = true;
    const l = global.document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@600;800&family=Noto+Serif+TC:wght@600;900&family=Oswald:wght@600;700&family=Zen+Maru+Gothic:wght@500;700;900&display=swap';
    global.document.head.appendChild(l);
  }

  /* --------------------------------------------------------------------------
   * 8. 全情境 5 場豐富測試資料（38 位涵蓋報名→繳費→報到→各管制站進行中→完賽→DNF→取消）
   * -------------------------------------------------------------------------- */
  function buildFull5EventsSeed() {
    const now = formatDateTime();
    const mkCertJson = (director) => JSON.stringify({ ...defaultCertConfig(), raceDirectorName: director });
    const certJson = mkCertJson('林政宏');
    const formJson = JSON.stringify(defaultFormSchema('MANUAL_ATM'));
    const formJsonPayuni = JSON.stringify(defaultFormSchema('ONLINE_PAYUNi'));
    const formJsonWithCustom = JSON.stringify({
      paymentMode: 'MANUAL_ATM',
      addons: defaultFormSchema('MANUAL_ATM').addons,
      customFields: [
        { key: 'shirt_size', label: '紀念衣尺寸', type: 'select', required: true, options: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'], placeholder: '請選擇紀念衣尺寸' },
        { key: 'shuttle_wave', label: '接駁車搭乘梯次', type: 'radio', required: false, options: ['不需接駁', '04:00 台北車站東三門', '04:30 捷運新店站'], placeholder: '' },
        { key: 'past_formats', label: '曾參與賽制經驗', type: 'checkbox', required: false, options: ['全馬 42K', '50K 超馬', '100K 八百壯士', '12H/24H 繞圈'], placeholder: '' },
        { key: 'est_hours', label: '預估完賽小時數', type: 'number', required: false, options: [], placeholder: '例如：8' }
      ]
    });

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

    const formJsonW800 = JSON.stringify({
      paymentMode: 'MANUAL_ATM',
      earlyBirdEnabled: true,
      earlyBirdEnd: '2026-12-31 23:59:59',
      addons: defaultFormSchema('MANUAL_ATM').addons,
      customFields: [
        { key: 'shirt_size', label: '百K 專屬紀念衣尺寸', type: 'select', required: true, options: ['XS', 'S', 'M', 'L', 'XL', '2XL'], placeholder: '請選擇尺寸' },
        { key: 'headlamp_check', label: '是否自備夜間強制頭燈', type: 'radio', required: true, options: ['已自備雙頭燈', '現場租借'], placeholder: '' },
        { key: 'dropbag_note', label: '轉換袋寄放需求', type: 'text', required: false, options: [], placeholder: '例如：CP2 需寄放替換跑鞋' }
      ]
    });

    const events = [
      {
        eventId: 'TUR-2026-50K', ownerUsername: 'org_north',
        nameZh: '2026 TUR 台灣超級馬拉松挑戰賽', nameEn: '2026 TUR Taiwan Ultra Marathon Challenge',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '新北市烏來區',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-10-01 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2026-11-26 05:00:00',
        maxQuota: 800, bannerUrl: 'dyn-trail', brochureText: '', formSchemaJson: formJsonWithCustom, certConfigJson: certJson
      },
      {
        eventId: 'TUR-2026-12H', ownerUsername: 'org_north',
        nameZh: '2026 TUR 台北 12H 繞圈超馬賽', nameEn: '2026 TUR Taipei 12H Lap Ultra',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '台北田徑暖身場',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-01 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2026-11-26 06:00:00',
        maxQuota: 400, bannerUrl: 'dyn-track', brochureText: '', formSchemaJson: formJsonPayuni, certConfigJson: mkCertJson('郭志明')
      },
      {
        eventId: 'TUR-2026-W800', ownerUsername: 'org_south',
        nameZh: '2026 高雄八百壯士 100K 超馬賽', nameEn: '2026 Kaohsiung 800 Warriors 100K Ultra',
        organizerZh: '南區超馬聯盟', organizerEn: 'South Taiwan Ultra Alliance', location: '高雄市旗山區',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-12-01 00:00:00', regEnd: '2027-01-31 23:59:59', raceStart: '',
        maxQuota: 300, bannerUrl: 'dyn-warrior', brochureText: '', formSchemaJson: formJsonW800, certConfigJson: mkCertJson('陳文龍')
      },
      {
        eventId: 'TUR-2026-EARLY6H', ownerUsername: 'org_south',
        nameZh: '2026 花蓮海濱 6H 體驗繞圈賽（賽前晶片整備）', nameEn: '2026 Hualien Coastal 6H Lap Ultra',
        organizerZh: '南區超馬聯盟', organizerEn: 'South Taiwan Ultra Alliance', location: '花蓮太平洋公園海濱環道',
        raceType: 'lap_timed', lapDistanceKm: 0.8, debounceSeconds: 15, status: 'closed',
        regStart: '2026-09-01 00:00:00', regEnd: '2026-11-20 23:59:59', raceStart: '2026-12-19 07:00:00',
        maxQuota: 200, bannerUrl: 'dyn-coast', brochureText: '', formSchemaJson: formJsonPayuni, certConfigJson: mkCertJson('吳家豪')
      },
      {
        eventId: 'TUR-2026-FIN100', ownerUsername: 'org_north',
        nameZh: '2026 TUR 春季陽明山 100K 八百壯士賽', nameEn: '2026 TUR Spring Yangmingshan 100K 800 Warriors',
        organizerZh: 'TUR 台灣超馬協會', organizerEn: 'TUR Taiwan Ultra Runners', location: '台北陽明山國家公園',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'finished',
        regStart: '2026-01-01 00:00:00', regEnd: '2026-03-31 23:59:59', raceStart: '2026-04-18 05:00:00',
        maxQuota: 500, bannerUrl: 'dyn-coast', brochureText: '', formSchemaJson: formJson, certConfigJson: mkCertJson('林政宏')
      },
      {
        eventId: 'TUR-2026-FIN24H', ownerUsername: 'org_south',
        nameZh: '2026 台南 24H 跨夜繞圈錦標賽', nameEn: '2026 Tainan 24H Overnight Lap Championship',
        organizerZh: '南區超馬聯盟', organizerEn: 'South Taiwan Ultra Alliance', location: '台南市立田徑場',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'finished',
        regStart: '2026-02-01 00:00:00', regEnd: '2026-05-01 23:59:59', raceStart: '2026-05-23 18:00:00',
        maxQuota: 300, bannerUrl: 'dyn-night', brochureText: '', formSchemaJson: formJsonPayuni, certConfigJson: mkCertJson('黃建民')
      }
    ];

    const categories = [
      { catId: 'CAT-50K', eventId: 'TUR-2026-50K', name: '50K 超馬組', distanceKm: 50, timeLimitHours: 8, fee: 1800, bibPrefix: 'A', bibStartNum: '001', quota: 300, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-100K', eventId: 'TUR-2026-50K', name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2600, bibPrefix: 'U', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: true },
      { catId: 'CAT-12H', eventId: 'TUR-2026-12H', name: '12H 繞圈組', distanceKm: 1.0, timeLimitHours: 12, fee: 2200, bibPrefix: 'L', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-6H', eventId: 'TUR-2026-12H', name: '6H 繞圈組', distanceKm: 1.0, timeLimitHours: 6, fee: 1500, bibPrefix: 'S', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-W800', eventId: 'TUR-2026-W800', name: '100K 八百壯士菁英組', distanceKm: 100, timeLimitHours: 15, fee: 2500, earlyBirdFee: 2100, bibPrefix: 'W', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: true },
      { catId: 'CAT-W50', eventId: 'TUR-2026-W800', name: '50K 南區挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1700, earlyBirdFee: 1400, bibPrefix: 'G', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-E6H', eventId: 'TUR-2026-EARLY6H', name: '6H 海濱繞圈組', distanceKm: 0.8, timeLimitHours: 6, fee: 1400, bibPrefix: 'H', bibStartNum: '001', quota: 120, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-E3H', eventId: 'TUR-2026-EARLY6H', name: '3H 體驗繞圈組', distanceKm: 0.8, timeLimitHours: 3, fee: 950, bibPrefix: 'C', bibStartNum: '001', quota: 80, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-FIN100', eventId: 'TUR-2026-FIN100', name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2600, bibPrefix: 'K', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: true },
      { catId: 'CAT-FIN50', eventId: 'TUR-2026-FIN100', name: '50K 挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1800, bibPrefix: 'F', bibStartNum: '001', quota: 300, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-FIN24H', eventId: 'TUR-2026-FIN24H', name: '24H 繞圈組', distanceKm: 1.0, timeLimitHours: 24, fee: 2800, bibPrefix: 'T', bibStartNum: '001', quota: 200, customRaceStart: '', isWarrior800: false },
      { catId: 'CAT-FIN12H', eventId: 'TUR-2026-FIN24H', name: '12H 夜間組', distanceKm: 1.0, timeLimitHours: 12, fee: 2100, bibPrefix: 'N', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false }
    ];

    const stations = [
      { stationId: 'ST-50K-0', eventId: 'TUR-2026-50K', stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-50K-1', eventId: 'TUR-2026-50K', stationCode: 'CP1', name: 'CP1 水庫折返站', distanceKm: 25, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'ST-50K-2', eventId: 'TUR-2026-50K', stationCode: 'CP2', name: 'CP2 山脊補給站', distanceKm: 50, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'ST-50K-3', eventId: 'TUR-2026-50K', stationCode: 'FINISH', name: '終點衝線拱門', distanceKm: 100, stationType: 'finish', orderIndex: 3 },
      { stationId: 'ST-12H-0', eventId: 'TUR-2026-12H', stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-12H-1', eventId: 'TUR-2026-12H', stationCode: 'LAP', name: '主會場繞圈拱門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 },
      { stationId: 'ST-W800-0', eventId: 'TUR-2026-W800', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-W800-1', eventId: 'TUR-2026-W800', stationCode: 'CP1', name: 'CP1 旗山溪橋', distanceKm: 35, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'ST-W800-2', eventId: 'TUR-2026-W800', stationCode: 'CP2', name: 'CP2 美濃折返', distanceKm: 70, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'ST-W800-3', eventId: 'TUR-2026-W800', stationCode: 'FINISH', name: '終點衝線', distanceKm: 100, stationType: 'finish', orderIndex: 3 },
      { stationId: 'ST-E6H-0', eventId: 'TUR-2026-EARLY6H', stationCode: 'CHECKIN', name: '海濱報到帳篷', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-E6H-1', eventId: 'TUR-2026-EARLY6H', stationCode: 'LAP', name: '海濱繞圈感應門', distanceKm: 0.8, stationType: 'lap', orderIndex: 1 },
      { stationId: 'ST-F100-0', eventId: 'TUR-2026-FIN100', stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-F100-1', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', name: 'CP1 小油坑', distanceKm: 30, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'ST-F100-2', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', name: 'CP2 擎天崗', distanceKm: 65, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'ST-F100-3', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', name: '終點拱門', distanceKm: 100, stationType: 'finish', orderIndex: 3 },
      { stationId: 'ST-F24-0', eventId: 'TUR-2026-FIN24H', stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'ST-F24-1', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', name: '田徑場繞圈門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 }
    ];

    const mkP = (o) => {
      const sp = splitFullName(o.name);
      return {
        participantId: o.pid, eventId: o.ev, catId: o.cat, bibNumber: o.bib || '',
        groupCode: o.gc || '', groupName: o.gn || '',
        name: o.name, lastName: sp.lastName, firstName: sp.firstName,
        idCard: o.id, gender: o.g || 'M', birthday: o.dob || '1988-05-12', age: calcAge(o.dob || '1988-05-12') || 38,
        nationality: o.nat || 'TWN', phone: o.ph || '0912345678', email: o.em || 'runner@tur.tw',
        city: o.city || '台北市', emergencyName: o.eName || '家屬聯絡人', emergencyPhone: o.ePh || '0988111222',
        diet: o.diet || '葷', remark: o.rem || '', totalAmount: o.amt || 1800, addonsDetail: o.addons || '[]',
        customFieldsJson: o.cf ? JSON.stringify(o.cf) : '{}',
        payMethod: o.pm || 'MANUAL_ATM', remittanceLast5: o.l5 || '', merTradeNo: o.mtn || '',
        payStatus: o.ps || 'PAID', paymentType: o.pt || (o.pm === 'ONLINE_PAYUNi' ? 'CREDIT' : 'MANUAL'),
        tradeNo: o.tn || '', payInfo: o.pi || '', paidAt: o.ps === 'PAID' ? (o.paidAt || '2026-10-02 10:00:00') : '',
        chipUid: o.uid || '', checkinStatus: o.chk || 'pending', raceStatus: o.rs || 'dns',
        penaltySeconds: o.pen || 0, createdAt: o.ca || '2026-10-01 09:00:00'
      };
    };

    const participants = [
      // ========= 活動 1: TUR-2026-50K（進行中開賽，16 位涵蓋全階段） =========
      // 已完賽 (4 位：100K 2位 + 50K 2位)
      mkP({ pid: 'TUR-20260001', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A001', name: '陳志明', id: 'A123456789', g: 'M', dob: '1988-05-12', nat: 'TWN', ph: '0912345678', em: 'chen@tur.tw', city: '台北市', eName: '陳美玲', amt: 2480, addons: '["紀念防風外套"]', l5: '88123', ps: 'PAID', uid: '04:A1:2B:99:10', chk: 'checked_in', rs: 'finished', cf: { shirt_size: 'L', shuttle_wave: '04:00 台北車站東三門', past_formats: ['全馬 42K', '50K 超馬'], est_hours: '5' } }),
      mkP({ pid: 'TUR-20260002', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U001', name: '歐陽晴', id: 'F223456786', g: 'F', dob: '1991-09-20', nat: 'TWN', ph: '0922334455', em: 'ouyang@tur.tw', city: '新北市', eName: '歐陽明', diet: '素', rem: '素食便當', amt: 2750, addons: '["獎牌雷射刻字"]', pm: 'ONLINE_PAYUNi', mtn: 'PU2026100201', tn: '26100299182', ps: 'PAID', uid: '04:B2:3C:88:20', chk: 'checked_in', rs: 'finished', cf: { shirt_size: 'S', shuttle_wave: '04:30 捷運新店站', past_formats: ['50K 超馬', '100K 八百壯士'], est_hours: '10' } }),
      mkP({ pid: 'TUR-20260006', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U002', gc: 'GRP26-7701', gn: '台北野跑聯隊', name: '司馬青雲', id: 'E121234565', g: 'M', dob: '1982-07-08', nat: 'TWN', ph: '0919888777', em: 'sima@tur.tw', city: '高雄市', amt: 2600, pm: 'ONLINE_PAYUNi', mtn: 'PU2026100302', ps: 'PAID', uid: '04:C3:4D:77:30', chk: 'checked_in', rs: 'finished', cf: { shirt_size: 'XL', shuttle_wave: '不需接駁', past_formats: ['100K 八百壯士', '12H/24H 繞圈'], est_hours: '11' } }),
      mkP({ pid: 'TUR-20260007', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A002', gc: 'GRP26-7701', gn: '台北野跑聯隊', name: '林雅婷', id: 'A223456781', g: 'F', dob: '1993-04-15', nat: 'TWN', ph: '0932112233', em: 'linyt@tur.tw', city: '桃園市', amt: 1800, l5: '66102', ps: 'PAID', uid: '04:D4:5E:66:41', chk: 'checked_in', rs: 'finished', cf: { shirt_size: 'M', shuttle_wave: '04:00 台北車站東三門', past_formats: ['全馬 42K'], est_hours: '6' } }),
      // 賽道進行中 (4 位：2位已過CP2往終點，2位已過CP1往CP2)
      mkP({ pid: 'TUR-20260008', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U003', gc: 'GRP26-7701', gn: '台北野跑聯隊', name: '黃冠宇', id: 'B123456780', g: 'M', dob: '1986-12-03', nat: 'TWN', ph: '0933556677', em: 'huang@tur.tw', city: '台中市', amt: 2850, addons: '["會場接駁專車"]', pm: 'ONLINE_PAYUNi', mtn: 'PU2026100405', ps: 'PAID', uid: '04:E5:6F:55:50', chk: 'checked_in', rs: 'on_track', cf: { shirt_size: 'L', shuttle_wave: '04:00 台北車站東三門', est_hours: '12' } }),
      mkP({ pid: 'TUR-20260009', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A003', name: 'Sarah Miller', id: 'US44556677', g: 'F', dob: '1990-02-18', nat: 'USA', ph: '0988776655', em: 'sarah@ultra.us', city: '台北市', diet: '素', amt: 1800, pm: 'ONLINE_PAYUNi', mtn: 'PU2026100409', ps: 'PAID', uid: '04:F6:7A:44:60', chk: 'checked_in', rs: 'on_track', cf: { shirt_size: 'M', shuttle_wave: '04:30 捷運新店站', est_hours: '6' } }),
      mkP({ pid: 'TUR-20260010', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U004', name: '吳承翰', id: 'H123456787', g: 'M', dob: '1989-08-22', nat: 'TWN', ph: '0918445566', em: 'wu@tur.tw', city: '新竹市', amt: 2600, l5: '33901', ps: 'PAID', uid: '04:11:22:33:70', chk: 'checked_in', rs: 'on_track', cf: { shirt_size: 'XL', shuttle_wave: '不需接駁', est_hours: '13' } }),
      mkP({ pid: 'TUR-20260011', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A004', name: 'Kim Min-Jae', id: 'KR88221100', g: 'M', dob: '1992-01-30', nat: 'KOR', ph: '0972334411', em: 'minjae@kr-run.kr', city: '離島 / 海外', amt: 1950, addons: '["獎牌雷射刻字"]', pm: 'ONLINE_PAYUNi', mtn: 'PU2026100511', ps: 'PAID', uid: '04:22:33:44:80', chk: 'checked_in', rs: 'on_track', cf: { shirt_size: 'L', shuttle_wave: '04:00 台北車站東三門', est_hours: '7' } }),
      // 已報到待出發 / 尚未通過 CP1 (2 位)
      mkP({ pid: 'TUR-20260012', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A005', name: '許佩珊', id: 'D223456788', g: 'F', dob: '1994-06-11', nat: 'TWN', ph: '0966221188', em: 'hsu@tur.tw', city: '台南市', amt: 1800, l5: '51234', ps: 'PAID', uid: '04:33:44:55:90', chk: 'checked_in', rs: 'dns', cf: { shirt_size: 'S', shuttle_wave: '04:30 捷運新店站', est_hours: '7' } }),
      mkP({ pid: 'TUR-20260013', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U005', name: '蔡宗翰', id: 'E123456789', g: 'M', dob: '1984-10-05', nat: 'TWN', ph: '0911778899', em: 'tsai@tur.tw', city: '高雄市', amt: 2600, pm: 'ONLINE_PAYUNi', mtn: 'PU2026100612', ps: 'PAID', uid: '04:44:55:66:01', chk: 'checked_in', rs: 'dns', cf: { shirt_size: 'L', shuttle_wave: '不需接駁', est_hours: '14' } }),
      // 已繳費已配號、尚未現場報到 (2 位)
      mkP({ pid: 'TUR-20260014', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A006', name: '鄭宇軒', id: 'C123456788', g: 'M', dob: '1996-03-19', nat: 'TWN', ph: '0928990011', em: 'cheng@tur.tw', city: '基隆市', amt: 1800, l5: '20498', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns', cf: { shirt_size: 'M', shuttle_wave: '不需接駁' } }),
      mkP({ pid: 'TUR-20260015', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U006', name: 'Wong Mei Ling', id: 'HK66778899', g: 'F', dob: '1987-11-28', nat: 'HKG', ph: '0987654321', em: 'meiling@hk.run', city: '離島 / 海外', amt: 2600, pm: 'ONLINE_PAYUNi', mtn: 'PU2026100715', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns', cf: { shirt_size: 'S', shuttle_wave: '04:00 台北車站東三門' } }),
      // 已報名待繳費 (2 位：團體報名 GRP26-8801)
      mkP({ pid: 'TUR-20260003', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: '', gc: 'GRP26-8801', gn: '東京超馬團', name: 'Tanaka Kenji', id: 'JP99887766', g: 'M', dob: '1985-03-14', nat: 'JPN', ph: '0911223344', em: 'kenji@jp-run.jp', city: '離島 / 海外', eName: 'Tanaka Yuko', amt: 1800, l5: '77654', ps: 'UNPAID', chk: 'pending', rs: 'dns', ca: '2026-10-05 14:20:00', cf: { shirt_size: 'L', shuttle_wave: '04:00 台北車站東三門' } }),
      mkP({ pid: 'TUR-20260004', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: '', gc: 'GRP26-8801', gn: '東京超馬團', name: '張家豪', id: 'B120123453', g: 'M', dob: '1995-11-02', nat: 'TWN', ph: '0955667788', em: 'chang@tur.tw', city: '台中市', eName: '張媽媽', amt: 2050, l5: '77654', ps: 'UNPAID', chk: 'pending', rs: 'dns', ca: '2026-10-05 14:21:00', cf: { shirt_size: 'XL', shuttle_wave: '04:00 台北車站東三門' } }),
      // 中途棄賽 DNF (1 位：已過 CP1 後抽筋棄賽)
      mkP({ pid: 'TUR-20260016', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U007', name: '周柏諺', id: 'F123456789', g: 'M', dob: '1983-07-14', nat: 'TWN', ph: '0939112244', em: 'chou@tur.tw', city: '新北市', rem: 'CP1 後右小腿拉傷申請棄賽', amt: 2600, l5: '90812', ps: 'PAID', uid: '04:55:66:77:11', chk: 'checked_in', rs: 'dnf', cf: { shirt_size: 'L', shuttle_wave: '不需接駁' } }),
      // 已取消報名 CANCELLED (1 位)
      mkP({ pid: 'TUR-20260017', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: '', name: '謝佳蓉', id: 'A221122334', g: 'F', dob: '1992-09-09', nat: 'TWN', ph: '0921556677', em: 'hsieh@tur.tw', city: '台北市', rem: '因行程衝突已申請退費取消', amt: 1800, ps: 'CANCELLED', chk: 'pending', rs: 'dns' }),
      // 外部名單匯入範例 (2 位：非系統報名、賽中匯入加入計時)
      mkP({ pid: 'EXT-20260018', ev: 'TUR-2026-50K', cat: 'CAT-50K', bib: 'A007', name: '林大為', id: 'A128877669', g: 'M', dob: '1986-04-22', nat: 'TWN', ph: '0916223344', em: 'dawei@ext.tw', city: '新竹市', rem: '外部報名平台匯入（中途加入執行）', amt: 0, pm: 'EXTERNAL_IMPORT', pt: 'EXTERNAL', ps: 'PAID', uid: '04:66:77:88:12', chk: 'checked_in', rs: 'on_track', cf: { shirt_size: 'L', shuttle_wave: '不需接駁' } }),
      mkP({ pid: 'EXT-20260019', ev: 'TUR-2026-50K', cat: 'CAT-100K', bib: 'U008', name: '端木晴', id: 'F229900112', g: 'F', dob: '1990-07-07', nat: 'TWN', ph: '0923445566', em: 'duanmu@ext.tw', city: '宜蘭縣', rem: '外部協會邀請選手匯入', amt: 0, pm: 'EXTERNAL_IMPORT', pt: 'EXTERNAL', ps: 'PAID', uid: '04:66:77:88:13', chk: 'checked_in', rs: 'finished', cf: { shirt_size: 'M', shuttle_wave: '不需接駁' } }),

      // ========= 活動 2: TUR-2026-12H（12H 繞圈進行中・PAYUNi 專屬管制，12 位全階段） =========
      mkP({ pid: 'TUR-20260005', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: 'L001', name: '王超馬', id: 'E121234565', g: 'M', dob: '1982-07-08', nat: 'TWN', ph: '0919888777', em: 'wang@tur.tw', city: '高雄市', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110101', tn: '26110100101', ps: 'PAID', uid: '04:C3:4D:77:30', chk: 'checked_in', rs: 'on_track' }),
      mkP({ pid: 'TUR-12H-002', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: 'L002', name: '陳怡君', id: 'F221234561', g: 'F', dob: '1989-04-21', nat: 'TWN', ph: '0922113355', em: 'yichun@tur.tw', city: '新北市', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110102', tn: '26110100102', ps: 'PAID', uid: '04:AA:11:22:33', chk: 'checked_in', rs: 'on_track' }),
      mkP({ pid: 'TUR-12H-003', ev: 'TUR-2026-12H', cat: 'CAT-6H', bib: 'S001', name: '劉哲維', id: 'A129876541', g: 'M', dob: '1991-01-12', nat: 'TWN', ph: '0936778899', em: 'liu@tur.tw', city: '台北市', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110103', tn: '26110100103', ps: 'PAID', uid: '04:BB:22:33:44', chk: 'checked_in', rs: 'finished' }),
      mkP({ pid: 'TUR-12H-004', ev: 'TUR-2026-12H', cat: 'CAT-6H', bib: 'S002', name: 'Sato Yuki', id: 'JP55443322', g: 'F', dob: '1993-08-08', nat: 'JPN', ph: '0915223344', em: 'yuki@jp.run', city: '離島 / 海外', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110104', tn: '26110100104', ps: 'PAID', uid: '04:CC:33:44:55', chk: 'checked_in', rs: 'finished' }),
      mkP({ pid: 'TUR-12H-005', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: 'L003', name: '郭俊宏', id: 'H121122338', g: 'M', dob: '1980-12-19', nat: 'TWN', ph: '0933887766', em: 'kuo@tur.tw', city: '桃園市', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110105', ps: 'PAID', uid: '04:DD:44:55:66', chk: 'checked_in', rs: 'dns' }),
      mkP({ pid: 'TUR-12H-006', ev: 'TUR-2026-12H', cat: 'CAT-6H', bib: 'S003', name: '楊雅雯', id: 'B223344551', g: 'F', dob: '1995-05-03', nat: 'TWN', ph: '0955112233', em: 'yang@tur.tw', city: '台中市', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110106', ps: 'PAID', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-12H-007', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: '', gc: 'GRP26-1209', gn: '大安晨跑團', name: '何宗霖', id: 'A125566773', g: 'M', dob: '1987-02-25', nat: 'TWN', ph: '0920445566', em: 'ho@tur.tw', city: '台北市', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110107', ps: 'UNPAID', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-12H-008', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: 'L004', name: '徐國華', id: 'J123456786', g: 'M', dob: '1978-09-14', nat: 'TWN', ph: '0910998877', em: 'hsu2@tur.tw', city: '新竹縣', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110108', ps: 'PAID', uid: '04:EE:55:66:77', chk: 'checked_in', rs: 'dnf' }),
      mkP({ pid: 'TUR-12H-009', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: 'L005', name: '馬克思', id: 'DE77112233', g: 'M', dob: '1984-11-11', nat: 'DEU', ph: '0971112233', em: 'markus@de.run', city: '離島 / 海外', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110109', ps: 'PAID', uid: '04:FF:66:77:88', chk: 'checked_in', rs: 'on_track' }),
      mkP({ pid: 'TUR-12H-010', ev: 'TUR-2026-12H', cat: 'CAT-6H', bib: 'S004', name: '呂佩蓉', id: 'F224455667', g: 'F', dob: '1992-03-08', nat: 'TWN', ph: '0925667788', em: 'lupr@tur.tw', city: '新北市', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110110', ps: 'PAID', uid: '04:10:20:30:40', chk: 'checked_in', rs: 'finished' }),
      mkP({ pid: 'TUR-12H-011', ev: 'TUR-2026-12H', cat: 'CAT-12H', bib: '', gc: 'GRP26-1209', gn: '大安晨跑團', name: '范姜宇', id: 'H124455661', g: 'M', dob: '1988-08-19', nat: 'TWN', ph: '0931223344', em: 'fanjiang@tur.tw', city: '桃園市', amt: 2200, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110111', ps: 'PENDING_PAY', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-12H-012', ev: 'TUR-2026-12H', cat: 'CAT-6H', bib: '', name: '賴怡婷', id: 'B226677882', g: 'F', dob: '1996-06-30', nat: 'TWN', ph: '0952334455', em: 'lai@tur.tw', city: '台中市', rem: '線上申請取消退費', amt: 1500, pm: 'ONLINE_PAYUNi', ps: 'CANCELLED', chk: 'pending', rs: 'dns' }),

      // ========= 活動 3: TUR-2026-W800（高雄八百壯士 100K 報名階段・雙因子查改與對帳示範，8 位） =========
      mkP({ pid: 'TUR-W800-001', ev: 'TUR-2026-W800', cat: 'CAT-W800', bib: 'W001', name: '葉志豪', id: 'E123344552', g: 'M', dob: '1985-06-18', nat: 'TWN', ph: '0918776655', em: 'yeh@tur.tw', city: '高雄市', amt: 2500, l5: '10293', ps: 'PAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'L', headlamp_check: '已自備雙頭燈', dropbag_note: 'CP2 放能量膠' } }),
      mkP({ pid: 'TUR-W800-002', ev: 'TUR-2026-W800', cat: 'CAT-W800', bib: 'W002', name: '洪佳玲', id: 'S223456784', g: 'F', dob: '1990-10-10', nat: 'TWN', ph: '0927889900', em: 'hung@tur.tw', city: '屏東縣', amt: 2500, l5: '65432', ps: 'PAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'S', headlamp_check: '已自備雙頭燈' } }),
      mkP({ pid: 'TUR-W800-003', ev: 'TUR-2026-W800', cat: 'CAT-W800', bib: '', gc: 'GRP26-9901', gn: '高雄港都超馬隊', name: '潘威廷', id: 'E126677884', g: 'M', dob: '1988-03-03', nat: 'TWN', ph: '0938112299', em: 'pan@tur.tw', city: '高雄市', amt: 2500, l5: '77123', ps: 'UNPAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'XL', headlamp_check: '現場租借' } }),
      mkP({ pid: 'TUR-W800-004', ev: 'TUR-2026-W800', cat: 'CAT-W800', bib: '', gc: 'GRP26-9901', gn: '高雄港都超馬隊', name: '蘇婉瑜', id: 'E227788995', g: 'F', dob: '1992-07-29', nat: 'TWN', ph: '0963223344', em: 'su@tur.tw', city: '高雄市', amt: 2500, l5: '77123', ps: 'UNPAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'M', headlamp_check: '已自備雙頭燈' } }),
      mkP({ pid: 'TUR-W800-005', ev: 'TUR-2026-W800', cat: 'CAT-W50', bib: 'G001', name: '鍾明憲', id: 'D125544339', g: 'M', dob: '1983-01-15', nat: 'TWN', ph: '0911445566', em: 'chung@tur.tw', city: '台南市', amt: 1700, l5: '54329', ps: 'PAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'L', headlamp_check: '已自備雙頭燈' } }),
      mkP({ pid: 'TUR-W800-006', ev: 'TUR-2026-W800', cat: 'CAT-W50', bib: '', name: '江品潔', id: 'T221133557', g: 'F', dob: '1994-11-22', nat: 'TWN', ph: '0929334455', em: 'chiang@tur.tw', city: '屏東縣', amt: 1950, addons: '["會場接駁專車"]', l5: '88001', ps: 'UNPAID', chk: 'pending', rs: 'dns', cf: { shirt_size: 'S', headlamp_check: '現場租借' } }),
      mkP({ pid: 'TUR-W800-007', ev: 'TUR-2026-W800', cat: 'CAT-W800', bib: 'W003', name: '歐陽鋒', id: 'E129988771', g: 'M', dob: '1979-09-09', nat: 'TWN', ph: '0932889911', em: 'oyf@tur.tw', city: '高雄市', amt: 2650, addons: '["獎牌雷射刻字"]', l5: '33219', ps: 'PAID', chk: 'pending', rs: 'dns', cf: { shirt_size: '2XL', headlamp_check: '已自備雙頭燈' } }),
      mkP({ pid: 'TUR-W800-008', ev: 'TUR-2026-W800', cat: 'CAT-W50', bib: '', name: '蕭博仁', id: 'E124433221', g: 'M', dob: '1991-05-05', nat: 'TWN', ph: '0958112233', em: 'hsiao@tur.tw', city: '嘉義市', rem: '待轉帳填報末五碼', amt: 1700, l5: '', ps: 'UNPAID', chk: 'pending', rs: 'dns' }),

      // ========= 活動 4: TUR-2026-EARLY6H（花蓮 6H 報名截止・晶片發卡與報到整備示範，8 位） =========
      mkP({ pid: 'TUR-E6H-001', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E6H', bib: 'H001', name: '游智翔', id: 'U123456781', g: 'M', dob: '1987-02-14', nat: 'TWN', ph: '0912111222', em: 'yu@tur.tw', city: '花蓮縣', amt: 1400, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091001', ps: 'PAID', uid: '04:A0:01:02:03', chk: 'checked_in', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-002', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E6H', bib: 'H002', name: '彭郁婷', id: 'U223456782', g: 'F', dob: '1992-08-25', nat: 'TWN', ph: '0922333444', em: 'peng@tur.tw', city: '花蓮縣', amt: 1400, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091002', ps: 'PAID', uid: '04:A0:01:02:04', chk: 'checked_in', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-003', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E6H', bib: 'H003', name: '林聖傑', id: 'V123456783', g: 'M', dob: '1985-11-30', nat: 'TWN', ph: '0933555666', em: 'linsj@tur.tw', city: '台東縣', amt: 1400, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091003', ps: 'PAID', uid: '04:A0:01:02:05', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-004', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E6H', bib: 'H004', name: '曾雅琪', id: 'G223456784', g: 'F', dob: '1993-04-12', nat: 'TWN', ph: '0955777888', em: 'tsengyq@tur.tw', city: '宜蘭縣', amt: 1400, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091004', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-005', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E3H', bib: 'C001', name: '柯宇倫', id: 'A127766554', g: 'M', dob: '1996-07-04', nat: 'TWN', ph: '0966888999', em: 'ko@tur.tw', city: '台北市', amt: 950, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091005', ps: 'PAID', uid: '04:A0:01:02:06', chk: 'checked_in', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-006', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E3H', bib: 'C002', name: '莊惠雯', id: 'F226655443', g: 'F', dob: '1990-12-20', nat: 'TWN', ph: '0977999000', em: 'chuang@tur.tw', city: '新北市', amt: 950, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091006', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-007', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E3H', bib: 'C003', name: 'David Chen', id: 'CA33445566', g: 'M', dob: '1988-09-18', nat: 'CAN', ph: '0988000111', em: 'david@ca.run', city: '離島 / 海外', amt: 950, pm: 'ONLINE_PAYUNi', mtn: 'PU2026091007', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns' }),
      mkP({ pid: 'TUR-E6H-008', ev: 'TUR-2026-EARLY6H', cat: 'CAT-E6H', bib: '', name: '傅家豪', id: 'U128899776', g: 'M', dob: '1984-03-27', nat: 'TWN', ph: '0919001122', em: 'fu@tur.tw', city: '花蓮縣', rem: '逾期未付款', amt: 1400, pm: 'ONLINE_PAYUNi', ps: 'UNPAID', chk: 'pending', rs: 'dns' }),

      // ========= 活動 5: TUR-2026-FIN100（已結案陽明山 100K 八百壯士賽，10 位：7 完賽開放印證書 / 2 DNF / 1 DNS） =========
      mkP({ pid: 'TUR-FIN-001', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN100', bib: 'K001', name: '陳志明', id: 'A123456789', g: 'M', dob: '1988-05-12', nat: 'TWN', ph: '0912345678', em: 'chen@tur.tw', city: '台北市', amt: 2600, l5: '88123', ps: 'PAID', uid: '04:A1:2B:99:10', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-01 12:00:00' }),
      mkP({ pid: 'TUR-FIN-002', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN100', bib: 'K002', name: '司馬青雲', id: 'E121234565', g: 'M', dob: '1982-07-08', nat: 'TWN', ph: '0919888777', em: 'sima@tur.tw', city: '高雄市', amt: 2600, l5: '45678', ps: 'PAID', uid: '04:C3:4D:77:30', chk: 'checked_in', rs: 'finished', pen: 120, paidAt: '2026-02-05 15:00:00' }),
      mkP({ pid: 'TUR-FIN-004', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN100', bib: 'K003', name: '諸葛明', id: 'A124455668', g: 'M', dob: '1986-08-18', nat: 'TWN', ph: '0912998811', em: 'zhuge@tur.tw', city: '新北市', amt: 2600, l5: '66778', ps: 'PAID', uid: '04:99:88:77:66', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-08 10:00:00' }),
      mkP({ pid: 'TUR-FIN-007', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN100', bib: 'K005', name: '上官婉兒', id: 'A228877665', g: 'F', dob: '1990-06-06', nat: 'TWN', ph: '0928112233', em: 'shangguan@tur.tw', city: '台北市', amt: 2600, l5: '77889', ps: 'PAID', uid: '04:88:77:66:55', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-09 09:00:00' }),
      mkP({ pid: 'TUR-FIN-003', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN50', bib: 'F001', name: '歐陽晴', id: 'F223456786', g: 'F', dob: '1991-09-20', nat: 'TWN', ph: '0922334455', em: 'ouyang@tur.tw', city: '新北市', diet: '素', amt: 1800, l5: '54321', ps: 'PAID', uid: '04:B2:3C:88:20', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-06 09:30:00' }),
      mkP({ pid: 'TUR-FIN-008', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN50', bib: 'F003', name: '林雅婷', id: 'A223456781', g: 'F', dob: '1993-04-15', nat: 'TWN', ph: '0932112233', em: 'linyt@tur.tw', city: '桃園市', amt: 1800, l5: '33441', ps: 'PAID', uid: '04:B2:3C:88:21', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-07 10:15:00' }),
      mkP({ pid: 'TUR-FIN-009', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN50', bib: 'F004', name: 'Tanaka Kenji', id: 'JP99887766', g: 'M', dob: '1985-03-14', nat: 'JPN', ph: '0911223344', em: 'kenji@jp-run.jp', city: '離島 / 海外', amt: 1800, l5: '99112', ps: 'PAID', uid: '04:B2:3C:88:22', chk: 'checked_in', rs: 'finished', paidAt: '2026-02-08 11:20:00' }),
      mkP({ pid: 'TUR-FIN-005', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN100', bib: 'K004', name: '高志強', id: 'B127788990', g: 'M', dob: '1981-04-04', nat: 'TWN', ph: '0931667788', em: 'kao@tur.tw', city: '台中市', amt: 2600, l5: '22334', ps: 'PAID', uid: '04:77:66:55:44', chk: 'checked_in', rs: 'dnf', paidAt: '2026-02-09 11:00:00' }),
      mkP({ pid: 'TUR-FIN-010', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN50', bib: 'F005', name: '吳俊傑', id: 'C126655442', g: 'M', dob: '1987-07-17', nat: 'TWN', ph: '0915667788', em: 'wujj@tur.tw', city: '基隆市', rem: 'CP1 扭傷退賽', amt: 1800, l5: '44332', ps: 'PAID', uid: '04:77:66:55:45', chk: 'checked_in', rs: 'dnf', paidAt: '2026-02-09 16:00:00' }),
      mkP({ pid: 'TUR-FIN-006', ev: 'TUR-2026-FIN100', cat: 'CAT-FIN50', bib: 'F002', name: '曾詩涵', id: 'F228899002', g: 'F', dob: '1994-12-01', nat: 'TWN', ph: '0926554433', em: 'tseng@tur.tw', city: '台北市', amt: 1800, l5: '88990', ps: 'PAID', chk: 'pending', rs: 'dns', paidAt: '2026-02-10 14:00:00' }),

      // ========= 活動 6: TUR-2026-FIN24H（已結案台南 24H 跨夜繞圈，8 位：6 完賽 / 1 DNF / 1 DNS） =========
      mkP({ pid: 'TUR-F24-001', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN24H', bib: 'T001', name: 'Sarah Miller', id: 'US44556677', g: 'F', dob: '1990-02-18', nat: 'USA', ph: '0988776655', em: 'sarah@ultra.us', city: '台北市', diet: '素', amt: 2800, pm: 'ONLINE_PAYUNi', mtn: 'PU20260401', ps: 'PAID', uid: '04:D4:5E:66:40', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-01 08:00:00' }),
      mkP({ pid: 'TUR-F24-002', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN24H', bib: 'T002', name: '林宏達', id: 'D123456783', g: 'M', dob: '1983-05-20', nat: 'TWN', ph: '0917223344', em: 'linhd@tur.tw', city: '台南市', amt: 2800, pm: 'ONLINE_PAYUNi', mtn: 'PU20260402', ps: 'PAID', uid: '04:D4:5E:66:42', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-02 09:00:00' }),
      mkP({ pid: 'TUR-F24-003', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN24H', bib: 'T003', name: '王淑芬', id: 'D224567891', g: 'F', dob: '1987-11-11', nat: 'TWN', ph: '0928334455', em: 'wangsf@tur.tw', city: '台南市', amt: 2800, pm: 'ONLINE_PAYUNi', mtn: 'PU20260403', ps: 'PAID', uid: '04:D4:5E:66:43', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-03 10:00:00' }),
      mkP({ pid: 'TUR-F24-005', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN12H', bib: 'N001', name: '謝明哲', id: 'D129988112', g: 'M', dob: '1986-02-28', nat: 'TWN', ph: '0913445566', em: 'hsiehmz@tur.tw', city: '台南市', amt: 2100, pm: 'ONLINE_PAYUNi', mtn: 'PU20260405', ps: 'PAID', uid: '04:D4:5E:66:45', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-05 10:00:00' }),
      mkP({ pid: 'TUR-F24-006', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN12H', bib: 'N002', name: '許芳瑜', id: 'E221122339', g: 'F', dob: '1991-07-19', nat: 'TWN', ph: '0924556677', em: 'hsufy@tur.tw', city: '高雄市', amt: 2100, pm: 'ONLINE_PAYUNi', mtn: 'PU20260406', ps: 'PAID', uid: '04:D4:5E:66:46', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-06 11:00:00' }),
      mkP({ pid: 'TUR-F24-007', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN12H', bib: 'N003', name: 'Kim Min-Jae', id: 'KR88221100', g: 'M', dob: '1992-01-30', nat: 'KOR', ph: '0972334411', em: 'minjae@kr-run.kr', city: '離島 / 海外', amt: 2100, pm: 'ONLINE_PAYUNi', mtn: 'PU20260407', ps: 'PAID', uid: '04:D4:5E:66:47', chk: 'checked_in', rs: 'finished', paidAt: '2026-04-07 12:00:00' }),
      mkP({ pid: 'TUR-F24-004', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN24H', bib: 'T004', name: '張哲銘', id: 'E128899001', g: 'M', dob: '1979-03-27', nat: 'TWN', ph: '0937445566', em: 'changzm@tur.tw', city: '高雄市', amt: 2800, pm: 'ONLINE_PAYUNi', mtn: 'PU20260404', ps: 'PAID', uid: '04:D4:5E:66:44', chk: 'checked_in', rs: 'dnf', paidAt: '2026-04-04 11:00:00' }),
      mkP({ pid: 'TUR-F24-008', ev: 'TUR-2026-FIN24H', cat: 'CAT-FIN12H', bib: 'N004', name: '蔡宜蓁', id: 'D229900118', g: 'F', dob: '1995-09-02', nat: 'TWN', ph: '0961223344', em: 'tsaiyz@tur.tw', city: '台南市', amt: 2100, pm: 'ONLINE_PAYUNi', mtn: 'PU20260408', ps: 'PAID', chk: 'pending', rs: 'dns', paidAt: '2026-04-08 15:00:00' })
    ];

    const timingLogs = [
      // === 活動 1: TUR-2026-50K（2026-11-26 05:00:00 起跑，完整展現各管制節點動態進度） ===
      // A001 陳志明 (50K 已完賽)
      { logId: 'LOG-50K-01', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'A001', idCardHash: '', sensedTime: '2026-11-26 07:18:15', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-02', eventId: 'TUR-2026-50K', stationCode: 'FINISH', bibNumber: 'A001', idCardHash: '', sensedTime: '2026-11-26 09:42:30', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      // A002 林雅婷 (50K 已完賽)
      { logId: 'LOG-50K-03', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'A002', idCardHash: '', sensedTime: '2026-11-26 07:35:40', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-04', eventId: 'TUR-2026-50K', stationCode: 'FINISH', bibNumber: 'A002', idCardHash: '', sensedTime: '2026-11-26 10:28:12', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      // U001 歐陽晴 (100K 八百壯士 已完賽)
      { logId: 'LOG-50K-05', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U001', idCardHash: '', sensedTime: '2026-11-26 07:22:08', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-06', eventId: 'TUR-2026-50K', stationCode: 'CP2', bibNumber: 'U001', idCardHash: '', sensedTime: '2026-11-26 10:05:45', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-07', eventId: 'TUR-2026-50K', stationCode: 'FINISH', bibNumber: 'U001', idCardHash: '', sensedTime: '2026-11-26 15:18:20', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      // U002 司馬青雲 (100K 八百壯士 已完賽)
      { logId: 'LOG-50K-08', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U002', idCardHash: '', sensedTime: '2026-11-26 07:29:50', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-09', eventId: 'TUR-2026-50K', stationCode: 'CP2', bibNumber: 'U002', idCardHash: '', sensedTime: '2026-11-26 10:24:10', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-10', eventId: 'TUR-2026-50K', stationCode: 'FINISH', bibNumber: 'U002', idCardHash: '', sensedTime: '2026-11-26 15:54:05', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      // U003 黃冠宇 (100K 賽道進行中 — 已過 CP2 往終點)
      { logId: 'LOG-50K-11', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U003', idCardHash: '', sensedTime: '2026-11-26 07:48:11', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-12', eventId: 'TUR-2026-50K', stationCode: 'CP2', bibNumber: 'U003', idCardHash: '', sensedTime: '2026-11-26 10:56:32', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      // A003 Sarah Miller (50K 賽道進行中 — 已過 CP1 往終點)
      { logId: 'LOG-50K-13', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'A003', idCardHash: '', sensedTime: '2026-11-26 07:52:44', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      // U004 吳承翰 (100K 賽道進行中 — 已過 CP2)
      { logId: 'LOG-50K-14', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U004', idCardHash: '', sensedTime: '2026-11-26 08:04:19', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-15', eventId: 'TUR-2026-50K', stationCode: 'CP2', bibNumber: 'U004', idCardHash: '', sensedTime: '2026-11-26 11:31:05', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      // A004 Kim Min-Jae (50K 賽道進行中 — 剛過 CP1)
      { logId: 'LOG-50K-16', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'A004', idCardHash: '', sensedTime: '2026-11-26 08:19:02', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      // U007 周柏諺 (100K DNF — 過 CP1 後抽筋棄賽)
      { logId: 'LOG-50K-17', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U007', idCardHash: '', sensedTime: '2026-11-26 08:28:40', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '於 CP1 後回報退賽' },
      // A007 林大為 (外部名單匯入中途加入，手動補登 CP1)
      { logId: 'LOG-50K-18', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'A007', idCardHash: '', sensedTime: '2026-11-26 08:11:25', lapCount: 0, operator: 'cp1', source: 'manual', isValid: true, note: '外部匯入選手・晶片異常由站長手動補登' },
      // U008 端木晴 (外部名單匯入已完賽)
      { logId: 'LOG-50K-19', eventId: 'TUR-2026-50K', stationCode: 'CP1', bibNumber: 'U008', idCardHash: '', sensedTime: '2026-11-26 07:38:00', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-20', eventId: 'TUR-2026-50K', stationCode: 'CP2', bibNumber: 'U008', idCardHash: '', sensedTime: '2026-11-26 10:42:15', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-50K-21', eventId: 'TUR-2026-50K', stationCode: 'FINISH', bibNumber: 'U008', idCardHash: '', sensedTime: '2026-11-26 16:12:30', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '外部匯入完賽' },

      // === 活動 2: TUR-2026-12H（2026-11-26 06:00:00 起跑，繞圈進行中、手動補登與超時圈範例） ===
      { logId: 'LOG-12H-01', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-26 06:06:12', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-02', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-26 06:12:30', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-03', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-26 06:18:55', lapCount: 3, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-04', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-26 06:25:18', lapCount: 4, operator: 'lap01', source: 'manual', isValid: true, note: '雨天晶片未感應手動補圈' },
      { logId: 'LOG-12H-05', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-26 06:31:40', lapCount: 5, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-06', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L002', idCardHash: '', sensedTime: '2026-11-26 06:07:05', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-07', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L002', idCardHash: '', sensedTime: '2026-11-26 06:14:15', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-08', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L002', idCardHash: '', sensedTime: '2026-11-26 06:21:30', lapCount: 3, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-15', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L005', idCardHash: '', sensedTime: '2026-11-26 06:06:50', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-16', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L005', idCardHash: '', sensedTime: '2026-11-26 06:13:40', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-09', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S001', idCardHash: '', sensedTime: '2026-11-26 06:05:40', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-10', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S001', idCardHash: '', sensedTime: '2026-11-26 09:12:15', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-11', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S001', idCardHash: '', sensedTime: '2026-11-26 11:54:20', lapCount: 3, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-17', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S001', idCardHash: '', sensedTime: '2026-11-26 12:04:10', lapCount: 4, operator: 'lap01', source: 'nfc', isValid: false, note: '6H 限時已過・超時圈不計入有效里程' },
      { logId: 'LOG-12H-12', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S002', idCardHash: '', sensedTime: '2026-11-26 06:06:30', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-13', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S002', idCardHash: '', sensedTime: '2026-11-26 11:48:10', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-18', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S004', idCardHash: '', sensedTime: '2026-11-26 06:08:10', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-19', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'S004', idCardHash: '', sensedTime: '2026-11-26 11:50:45', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-12H-14', eventId: 'TUR-2026-12H', stationCode: 'LAP', bibNumber: 'L004', idCardHash: '', sensedTime: '2026-11-26 06:08:50', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '膝蓋不適申請退賽' },

      // === 活動 5: 已結案陽明山 100K 完整各站紀錄（7 完賽開放印證書 + 2 DNF） ===
      { logId: 'LOG-F100-1', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 07:45:12', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-2', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 11:18:40', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-3', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K001', idCardHash: '', sensedTime: '2026-04-18 14:52:05', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-4', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 08:02:10', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-5', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 11:55:20', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-6', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K002', idCardHash: '', sensedTime: '2026-04-18 16:10:33', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-9', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K003', idCardHash: '', sensedTime: '2026-04-18 08:15:30', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-10', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K003', idCardHash: '', sensedTime: '2026-04-18 12:18:45', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-11', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K003', idCardHash: '', sensedTime: '2026-04-18 16:45:12', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-13', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K005', idCardHash: '', sensedTime: '2026-04-18 08:22:00', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-14', eventId: 'TUR-2026-FIN100', stationCode: 'CP2', bibNumber: 'K005', idCardHash: '', sensedTime: '2026-04-18 12:40:18', lapCount: 0, operator: 'cp2', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-15', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'K005', idCardHash: '', sensedTime: '2026-04-18 17:20:44', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '女子百K 冠軍' },
      { logId: 'LOG-F100-7', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'F001', idCardHash: '', sensedTime: '2026-04-18 08:12:00', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-8', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'F001', idCardHash: '', sensedTime: '2026-04-18 10:14:22', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-16', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'F003', idCardHash: '', sensedTime: '2026-04-18 08:24:15', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-17', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'F003', idCardHash: '', sensedTime: '2026-04-18 10:42:09', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-18', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'F004', idCardHash: '', sensedTime: '2026-04-18 08:05:30', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-19', eventId: 'TUR-2026-FIN100', stationCode: 'FINISH', bibNumber: 'F004', idCardHash: '', sensedTime: '2026-04-18 09:58:40', lapCount: 0, operator: 'finish01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F100-12', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'K004', idCardHash: '', sensedTime: '2026-04-18 08:45:00', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: 'DNF 棄賽' },
      { logId: 'LOG-F100-20', eventId: 'TUR-2026-FIN100', stationCode: 'CP1', bibNumber: 'F005', idCardHash: '', sensedTime: '2026-04-18 08:52:10', lapCount: 0, operator: 'cp1', source: 'nfc', isValid: true, note: '扭傷棄賽' },

      // === 活動 6: 已結案台南 24H 跨夜（18:00 起跑 -> 隔日刷圈，6 完賽 + 1 DNF） ===
      { logId: 'LOG-F24-1', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T001', idCardHash: '', sensedTime: '2026-05-23 18:06:10', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-2', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T001', idCardHash: '', sensedTime: '2026-05-24 02:15:30', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '跨夜測試圈' },
      { logId: 'LOG-F24-3', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T001', idCardHash: '', sensedTime: '2026-05-24 17:42:10', lapCount: 3, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-4', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T002', idCardHash: '', sensedTime: '2026-05-23 18:05:50', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-5', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T002', idCardHash: '', sensedTime: '2026-05-24 16:50:00', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-6', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T003', idCardHash: '', sensedTime: '2026-05-23 18:07:30', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-8', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N001', idCardHash: '', sensedTime: '2026-05-23 18:06:40', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-9', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N001', idCardHash: '', sensedTime: '2026-05-24 05:32:10', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-10', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N002', idCardHash: '', sensedTime: '2026-05-23 18:07:15', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-11', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N002', idCardHash: '', sensedTime: '2026-05-24 05:45:20', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-12', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N003', idCardHash: '', sensedTime: '2026-05-23 18:05:30', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-13', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'N003', idCardHash: '', sensedTime: '2026-05-24 05:18:55', lapCount: 2, operator: 'lap01', source: 'nfc', isValid: true, note: '' },
      { logId: 'LOG-F24-7', eventId: 'TUR-2026-FIN24H', stationCode: 'LAP', bibNumber: 'T004', idCardHash: '', sensedTime: '2026-05-23 21:10:00', lapCount: 1, operator: 'lap01', source: 'nfc', isValid: true, note: '夜間退賽' }
    ];

    const historyResults = [
      { historyId: 'HIS-2022-001', eventDate: '2022-11-19', eventName: '2022 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'W005', name: '陳志明', nationality: 'TWN', idCardHash: 'demo-hash-chen', finishTime: '11:15:30', distanceKm: 100, lapCount: 0, overallRank: 9, catRank: 5, status: 'FINISHED', isWarrior800: true, remark: '首登百K 殿堂' },
      { historyId: 'HIS-2022-002', eventDate: '2022-11-19', eventName: '2022 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'W008', name: '司馬青雲', nationality: 'TWN', idCardHash: 'demo-hash-sima', finishTime: '10:22:10', distanceKm: 100, lapCount: 0, overallRank: 3, catRank: 3, status: 'FINISHED', isWarrior800: true, remark: '男總三' },
      { historyId: 'HIS-2022-003', eventDate: '2022-06-12', eventName: '2022 TUR 花蓮 6H 海濱繞圈賽', categoryName: '6H 組', bibNumber: 'H015', name: '林宏達', nationality: 'TWN', idCardHash: 'demo-hash-linhd', finishTime: '05:54:20', distanceKm: 64.0, lapCount: 64, overallRank: 4, catRank: 2, status: 'FINISHED', isWarrior800: false, remark: '分組第二' },
      { historyId: 'HIS-2023-001', eventDate: '2023-11-18', eventName: '2023 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'W012', name: '陳志明', nationality: 'TWN', idCardHash: 'demo-hash-chen', finishTime: '10:48:20', distanceKm: 100, lapCount: 0, overallRank: 5, catRank: 3, status: 'FINISHED', isWarrior800: true, remark: '二星達標' },
      { historyId: 'HIS-2023-002', eventDate: '2023-11-18', eventName: '2023 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'W018', name: '司馬青雲', nationality: 'TWN', idCardHash: 'demo-hash-sima', finishTime: '09:58:15', distanceKm: 100, lapCount: 0, overallRank: 2, catRank: 2, status: 'FINISHED', isWarrior800: true, remark: '男總二' },
      { historyId: 'HIS-2023-003', eventDate: '2023-05-14', eventName: '2023 TUR 日月潭 50K 環湖超馬', categoryName: '50K 組', bibNumber: 'B022', name: '歐陽晴', nationality: 'TWN', idCardHash: 'demo-hash-ouyang', finishTime: '05:24:10', distanceKm: 50, lapCount: 0, overallRank: 8, catRank: 2, status: 'FINISHED', isWarrior800: false, remark: '女總二' },
      { historyId: 'HIS-2023-004', eventDate: '2023-11-18', eventName: '2023 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'W031', name: '上官婉兒', nationality: 'TWN', idCardHash: 'demo-hash-shangguan', finishTime: '12:08:40', distanceKm: 100, lapCount: 0, overallRank: 11, catRank: 2, status: 'FINISHED', isWarrior800: true, remark: '女子百K 亞軍' },
      { historyId: 'HIS-2024-001', eventDate: '2024-11-16', eventName: '2024 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'A101', name: '陳志明', nationality: 'TWN', idCardHash: 'demo-hash-chen', finishTime: '10:12:45', distanceKm: 100, lapCount: 0, overallRank: 3, catRank: 2, status: 'FINISHED', isWarrior800: true, remark: '個人 PB' },
      { historyId: 'HIS-2024-002', eventDate: '2024-11-16', eventName: '2024 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'A109', name: 'Sarah Miller', nationality: 'USA', idCardHash: 'demo-hash-sarah', finishTime: '11:05:30', distanceKm: 100, lapCount: 0, overallRank: 7, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '女總一' },
      { historyId: 'HIS-2024-003', eventDate: '2024-03-24', eventName: '2024 TUR 台中 12H 繞圈超馬賽', categoryName: '12H 組', bibNumber: 'L044', name: '王超馬', nationality: 'TWN', idCardHash: 'demo-hash-wang', finishTime: '11:56:40', distanceKm: 112.0, lapCount: 112, overallRank: 2, catRank: 2, status: 'FINISHED', isWarrior800: true, remark: '繞圈破百K' },
      { historyId: 'HIS-2024-004', eventDate: '2024-09-08', eventName: '2024 TUR 墾丁 50K 海岸挑戰賽', categoryName: '50K 組', bibNumber: 'S088', name: '林雅婷', nationality: 'TWN', idCardHash: 'demo-hash-linyt', finishTime: '05:42:18', distanceKm: 50, lapCount: 0, overallRank: 12, catRank: 3, status: 'FINISHED', isWarrior800: false, remark: '分組前三' },
      { historyId: 'HIS-2024-005', eventDate: '2024-11-16', eventName: '2024 TUR 東吳八百壯士 100K 超馬賽', categoryName: '100K 組', bibNumber: 'A118', name: 'Tanaka Kenji', nationality: 'JPN', idCardHash: 'demo-hash-kenji', finishTime: '10:35:12', distanceKm: 100, lapCount: 0, overallRank: 4, catRank: 3, status: 'FINISHED', isWarrior800: true, remark: '日本國際跑者' },
      { historyId: 'HIS-2025-002', eventDate: '2025-04-20', eventName: '2025 台北 24H 超級馬拉松', categoryName: '24H 組', bibNumber: 'B208', name: '司馬青雲', nationality: 'TWN', idCardHash: 'demo-hash-sima', finishTime: '23:54:10', distanceKm: 148.5, lapCount: 148, overallRank: 1, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '破場地紀錄' },
      { historyId: 'HIS-2025-003', eventDate: '2025-10-12', eventName: '2025 TUR 宜蘭 50K 海岸超馬', categoryName: '50K 組', bibNumber: 'C055', name: '歐陽晴', nationality: 'TWN', idCardHash: 'demo-hash-ouyang', finishTime: '05:08:30', distanceKm: 50, lapCount: 0, overallRank: 5, catRank: 1, status: 'FINISHED', isWarrior800: false, remark: '女總一' },
      { historyId: 'HIS-2025-004', eventDate: '2025-12-07', eventName: '2025 TUR 花蓮太魯閣 100K 越野超馬', categoryName: '100K 組', bibNumber: 'W019', name: '諸葛明', nationality: 'TWN', idCardHash: 'demo-hash-zhuge', finishTime: '11:45:22', distanceKm: 100, lapCount: 0, overallRank: 6, catRank: 4, status: 'FINISHED', isWarrior800: true, remark: '八百壯士達標' },
      { historyId: 'HIS-2025-005', eventDate: '2025-12-07', eventName: '2025 TUR 花蓮太魯閣 100K 越野超馬', categoryName: '100K 組', bibNumber: 'W027', name: '歐陽晴', nationality: 'TWN', idCardHash: 'demo-hash-ouyang', finishTime: '11:20:05', distanceKm: 100, lapCount: 0, overallRank: 4, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '初百K 女總一' },
      { historyId: 'HIS-2025-006', eventDate: '2025-04-20', eventName: '2025 台北 24H 超級馬拉松', categoryName: '24H 組', bibNumber: 'B215', name: '林宏達', nationality: 'TWN', idCardHash: 'demo-hash-linhd', finishTime: '23:40:12', distanceKm: 126.0, lapCount: 126, overallRank: 4, catRank: 3, status: 'FINISHED', isWarrior800: true, remark: '跨夜百K' },
      { historyId: 'HIS-2025-007', eventDate: '2025-04-20', eventName: '2025 台北 24H 超級馬拉松', categoryName: '24H 組', bibNumber: 'B220', name: 'Sarah Miller', nationality: 'USA', idCardHash: 'demo-hash-sarah', finishTime: '23:51:00', distanceKm: 135.0, lapCount: 135, overallRank: 2, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '24H 女子冠軍' }
    ];

    return { users, globalConfig, events, categories, stations, participants, timingLogs, historyResults };
  }

  /* --------------------------------------------------------------------------
   * 8B. 10 大全情境獨立測試資料包（TEST-* 隔離前綴，可留存測試並一鍵單獨清除不影響正式資料）
   * -------------------------------------------------------------------------- */
  const TEST_SUITE_PREFIX = 'TEST-';

  function isTestSuiteId(val) {
    return /^TEST-/i.test(String(val || '').trim());
  }

  function isTestSuiteRecord(storeName, rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (storeName === 'events') return isTestSuiteId(rec.eventId);
    if (storeName === 'categories') return isTestSuiteId(rec.catId) || isTestSuiteId(rec.eventId);
    if (storeName === 'stations') return isTestSuiteId(rec.stationId) || isTestSuiteId(rec.eventId);
    if (storeName === 'participants') return isTestSuiteId(rec.participantId) || isTestSuiteId(rec.eventId) || /^TURM-TEST-/i.test(String(rec.merTradeNo || ''));
    if (storeName === 'timingLogs') return isTestSuiteId(rec.logId) || isTestSuiteId(rec.eventId);
    if (storeName === 'historyResults') return isTestSuiteId(rec.historyId);
    if (storeName === 'users') return /^test_/i.test(String(rec.username || '')) || isTestSuiteId(rec.allowedEventId);
    return false;
  }

  function countTestSuiteStats(state) {
    const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users'];
    const counts = {};
    let total = 0;
    stores.forEach((s) => {
      const c = (state[s] || []).filter((r) => isTestSuiteRecord(s, r)).length;
      counts[s] = c;
      total += c;
    });
    return { ...counts, total };
  }

  function buildTestSuite10Scenarios() {
    const mkCert = (director, extra = {}) => JSON.stringify({ ...defaultCertConfig(), raceDirectorName: director, ...extra });
    const sampleCustomBgSvg = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1131"><defs><linearGradient id="tbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="50%" stop-color="#1e3a5f"/><stop offset="100%" stop-color="#0f766e"/></linearGradient></defs><rect width="1600" height="1131" fill="url(#tbg)"/><rect x="38" y="38" width="1524" height="1055" fill="none" stroke="#f59e0b" stroke-width="8"/><rect x="56" y="56" width="1488" height="1019" fill="none" stroke="#fde68a" stroke-width="2" stroke-opacity="0.6"/><path d="M0 900 Q400 780 800 880 T1600 820 L1600 1131 L0 1131 Z" fill="#020617" fill-opacity="0.35"/></svg>`);
    const certWithCustomBg = mkCert('林測試總監', {
      customBgDataUrl: sampleCustomBgSvg,
      customBgElements: defaultCustomBgElements('landscape')
    });

    const mkSchema = (paymentMode, opts = {}) => JSON.stringify({
      ...defaultFormSchema(paymentMode),
      earlyBirdEnabled: opts.ebOn !== undefined ? Boolean(opts.ebOn) : true,
      earlyBirdEnd: opts.ebEnd !== undefined ? opts.ebEnd : '2026-12-31 23:59:59',
      customFields: [{ ...DEFAULT_ADDONS_NOTE_FIELD }, ...(opts.cf || [])]
    });

    const users = [
      { username: 'test_org_a', passwordHash: 'test1234', displayName: '🧪 測試承辦人 A（北區）', role: 'organizer', parentOrganizer: '', allowedEventId: 'ALL', allowedStation: 'ALL', enabled: 1 },
      { username: 'test_org_b', passwordHash: 'test1234', displayName: '🧪 測試承辦人 B（南區獨立收款）', role: 'organizer', parentOrganizer: '', allowedEventId: 'ALL', allowedStation: 'ALL', enabled: 1 },
      { username: 'test_op_writer', passwordHash: '1234', displayName: '🧪 測試晶片寫卡員', role: 'operator', parentOrganizer: 'test_org_a', allowedEventId: 'TEST-S07-CHIP', allowedStation: 'WRITER', enabled: 1 },
      { username: 'test_op_cp1', passwordHash: '1234', displayName: '🧪 測試 CP1 站長', role: 'operator', parentOrganizer: 'test_org_a', allowedEventId: 'TEST-S07-CHIP', allowedStation: 'CP1', enabled: 1 },
      { username: 'test_op_lap', passwordHash: '1234', displayName: '🧪 測試繞圈主拱門', role: 'operator', parentOrganizer: 'test_org_a', allowedEventId: 'TEST-S08-LAPRUN', allowedStation: 'LAP', enabled: 1 },
      { username: 'test_op_finish', passwordHash: '1234', displayName: '🧪 測試終點衝線站', role: 'operator', parentOrganizer: 'test_org_b', allowedEventId: 'TEST-S09-NOCHIP', allowedStation: 'FINISH', enabled: 1 }
    ];

    const events = [
      {
        eventId: 'TEST-S01-EBOPEN', ownerUsername: 'test_org_a',
        nameZh: '【測試01】早鳥開放中＋自訂欄位超馬賽', nameEn: 'TEST01 Early Bird Open Ultra',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '新北市坪林區',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-01 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-01-17 05:00:00',
        maxQuota: 300, bannerUrl: 'dyn-road',
        brochureText: '【測試情境 01】驗證早鳥價進行中、自訂擴充欄位、加購與各繳費狀態（未繳／已繳／取消）。\n' + DEFAULT_BROCHURE_TEMPLATE,
        formSchemaJson: mkSchema('MANUAL_ATM', {
          ebOn: true, ebEnd: '2026-12-31 23:59:59',
          cf: [
            { key: 'shirt_size', label: '紀念衣尺寸', type: 'select', required: true, options: ['S', 'M', 'L', 'XL', '2XL'], placeholder: '請選尺寸' },
            { key: 'shuttle_wave', label: '接駁車梯次', type: 'radio', required: false, options: ['自行前往', '04:00 台北車站'], placeholder: '' }
          ]
        }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S02-EBEXP', ownerUsername: 'test_org_a',
        nameZh: '【測試02】早鳥已截止切一般價＋額滿防呆賽', nameEn: 'TEST02 Early Bird Expired Quota Guard',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '台北市大佳河濱',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-02 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-01-24 06:00:00',
        maxQuota: 50, bannerUrl: 'dyn-trail',
        brochureText: '【測試情境 02】早鳥截止設為過去驗證自動切回一般價；50K 組設限額 2 人且已滿額，測試額滿防呆攔截，21K 仍可報名。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: true, ebEnd: '2026-01-01 23:59:59' }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S03-UNIA', ownerUsername: 'test_org_a',
        nameZh: '【測試03】同承辦人統報 A 場・山徑挑戰賽', nameEn: 'TEST03 Unified Reg A Trail',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '陽明山冷水坑',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-03 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-02-07 05:30:00',
        maxQuota: 200, bannerUrl: 'dyn-coast',
        brochureText: '【測試情境 03】與【測試04】同屬承辦人 test_org_a 且同為轉帳，內含跨場統報合併單 TURM-TEST-001（待對帳）與 TURM-TEST-002（已入帳）。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: false }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S04-UNIB', ownerUsername: 'test_org_a',
        nameZh: '【測試04】同承辦人統報 B 場・早鳥繞圈賽', nameEn: 'TEST04 Unified Reg B Lap EarlyBird',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '板橋第一運動場',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-04 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-02-21 06:00:00',
        maxQuota: 200, bannerUrl: 'dyn-track',
        brochureText: '【測試情境 04】與【測試03】同承辦人且享早鳥價，可於多場統報勾選兩場一次結帳並於專區 1 合併整單入帳。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: true, ebEnd: '2026-12-31 23:59:59' }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S05-ORGB', ownerUsername: 'test_org_b',
        nameZh: '【測試05】承辦人 B 獨立收款＋團報含取消防呆', nameEn: 'TEST05 Organizer B Isolated Group',
        organizerZh: '南區測試B聯盟', organizerEn: 'South Test B', location: '高雄市澄清湖',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-05 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-03-07 05:00:00',
        maxQuota: 200, bannerUrl: 'dyn-warrior',
        brochureText: '【測試情境 05】由承辦人 test_org_b 獨立承辦，驗證統報跨承辦人自動隔離，並內含團報 GRP26-T01（2待繳＋1已取消）驗證整團入帳不復活取消者。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: false }),
        certConfigJson: mkCert('陳南區總監')
      },
      {
        eventId: 'TEST-S06-PAYUNI', ownerUsername: 'test_org_a',
        nameZh: '【測試06】PAYUNi 統一金流秒級配號賽', nameEn: 'TEST06 PAYUNi Auto Checkout',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '桃園石門水庫',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'open',
        regStart: '2026-11-06 00:00:00', regEnd: '2026-12-31 23:59:59', raceStart: '2027-03-14 05:30:00',
        maxQuota: 200, bannerUrl: 'banner-2',
        brochureText: '【測試情境 06】採 PAYUNi 線上金流管制，送出即自動轉 PAID 與秒級配號，且禁止與轉帳活動混單統報。',
        formSchemaJson: mkSchema('ONLINE_PAYUNi', { ebOn: true, ebEnd: '2026-12-31 23:59:59' }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S07-CHIP', ownerUsername: 'test_org_a',
        nameZh: '【測試07】賽前晶片寫卡・檢錄報到整備場', nameEn: 'TEST07 PreRace Chip Checkin Prep',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '宜蘭冬山河親水公園',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'closed',
        regStart: '2026-09-01 00:00:00', regEnd: '2026-11-20 23:59:59', raceStart: '2026-12-12 05:00:00',
        maxQuota: 150, bannerUrl: 'banner-5',
        brochureText: '【測試情境 07】報名已截止（驗證 /lookup 鎖定費用但可改聯絡資料），專供測試晶片寫入、讀取查看、報到檢錄與鳴槍開跑。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: false }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S08-LAPRUN', ownerUsername: 'test_org_a',
        nameZh: '【測試08】12H 計時繞圈賽進行中（晶片刷圈）', nameEn: 'TEST08 Live 12H Lap Timed Race',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '台北田徑場暖身區',
        raceType: 'lap_timed', lapDistanceKm: 1.0, debounceSeconds: 15, status: 'closed',
        regStart: '2026-09-10 00:00:00', regEnd: '2026-11-15 23:59:59', raceStart: '2026-11-27 05:00:00',
        maxQuota: 120, bannerUrl: 'dyn-night',
        brochureText: '【測試情境 08】繞圈限時賽已鳴槍進行中，內含多圈有效感應、手動補圈與 1 筆逾限時超時無效圈，可立即測試 LAP 刷圈與排行榜。',
        formSchemaJson: mkSchema('ONLINE_PAYUNi', { ebOn: false }),
        certConfigJson: mkCert('林測試總監')
      },
      {
        eventId: 'TEST-S09-NOCHIP', ownerUsername: 'test_org_b',
        nameZh: '【測試09】外部已繳名單匯入＆無晶片手動計時場', nameEn: 'TEST09 External Roster & Manual Timing',
        organizerZh: '南區測試B聯盟', organizerEn: 'South Test B', location: '台南安平海濱',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'closed',
        regStart: '2026-09-15 00:00:00', regEnd: '2026-11-18 23:59:59', raceStart: '2026-11-27 06:00:00',
        maxQuota: 150, bannerUrl: 'banner-4',
        brochureText: '【測試情境 09】涵蓋外部已繳名單 (EXTERNAL_IMPORT)、手動補登成績與匯出已完成報名繳費名單 (PAID Excel/CSV) 功能。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: false }),
        certConfigJson: mkCert('陳南區總監')
      },
      {
        eventId: 'TEST-S10-CLOSED', ownerUsername: 'test_org_a',
        nameZh: '【測試10】已結案封存・八百壯士＋自訂底圖證書', nameEn: 'TEST10 Closed 800 Warriors Custom Cert',
        organizerZh: 'TUR 測試A協會', organizerEn: 'TUR Test A', location: '花蓮太魯閣峽谷',
        raceType: 'distance', lapDistanceKm: 0, debounceSeconds: 15, status: 'finished',
        regStart: '2026-01-10 00:00:00', regEnd: '2026-03-20 23:59:59', raceStart: '2026-04-12 05:00:00',
        maxQuota: 200, bannerUrl: 'banner-6',
        brochureText: '【測試情境 10】已通過 5 階段結案封存於專區 2，含 4 位完賽（2 位八百壯士 100K）、1 DNF、1 DNS，並預設套用官方自訂底圖與 10 圖層排版。',
        formSchemaJson: mkSchema('MANUAL_ATM', { ebOn: false }),
        certConfigJson: certWithCustomBg
      }
    ];

    const categories = [
      { catId: 'TEST-CAT-01A', eventId: 'TEST-S01-EBOPEN', name: '100K 八百壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2600, earlyBirdFee: 2200, bibPrefix: 'W', bibStartNum: '001', quota: 150, customRaceStart: '', isWarrior800: true },
      { catId: 'TEST-CAT-01B', eventId: 'TEST-S01-EBOPEN', name: '50K 早鳥挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 1400, bibPrefix: 'A', bibStartNum: '001', quota: 150, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-02A', eventId: 'TEST-S02-EBEXP', name: '50K 限量滿額組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 1400, bibPrefix: 'M', bibStartNum: '001', quota: 2, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-02B', eventId: 'TEST-S02-EBEXP', name: '21K 一般開放組', distanceKm: 21.1, timeLimitHours: 4, fee: 1200, earlyBirdFee: 950, bibPrefix: 'N', bibStartNum: '001', quota: 40, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-03A', eventId: 'TEST-S03-UNIA', name: '50K 山徑統報組', distanceKm: 50, timeLimitHours: 9, fee: 1900, earlyBirdFee: 0, bibPrefix: 'U', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-03B', eventId: 'TEST-S03-UNIA', name: '30K 體驗統報組', distanceKm: 30, timeLimitHours: 6, fee: 1300, earlyBirdFee: 0, bibPrefix: 'V', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-04A', eventId: 'TEST-S04-UNIB', name: '6H 繞圈早鳥組', distanceKm: 1.0, timeLimitHours: 6, fee: 1600, earlyBirdFee: 1250, bibPrefix: 'R', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-04B', eventId: 'TEST-S04-UNIB', name: '12H 繞圈早鳥組', distanceKm: 1.0, timeLimitHours: 12, fee: 2200, earlyBirdFee: 1850, bibPrefix: 'Q', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-05A', eventId: 'TEST-S05-ORGB', name: '50K 南區挑戰組', distanceKm: 50, timeLimitHours: 8, fee: 1700, earlyBirdFee: 0, bibPrefix: 'S', bibStartNum: '001', quota: 120, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-05B', eventId: 'TEST-S05-ORGB', name: '100K 南區壯士組', distanceKm: 100, timeLimitHours: 16, fee: 2500, earlyBirdFee: 0, bibPrefix: 'K', bibStartNum: '001', quota: 80, customRaceStart: '', isWarrior800: true },
      { catId: 'TEST-CAT-06A', eventId: 'TEST-S06-PAYUNI', name: '50K 金流極速組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 1500, bibPrefix: 'P', bibStartNum: '001', quota: 120, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-06B', eventId: 'TEST-S06-PAYUNI', name: '25K 金流體驗組', distanceKm: 25, timeLimitHours: 5, fee: 1100, earlyBirdFee: 900, bibPrefix: 'J', bibStartNum: '001', quota: 80, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-07A', eventId: 'TEST-S07-CHIP', name: '50K 晶片測試組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 0, bibPrefix: 'C', bibStartNum: '001', quota: 150, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-08A', eventId: 'TEST-S08-LAPRUN', name: '12H 繞圈組', distanceKm: 1.0, timeLimitHours: 12, fee: 2200, earlyBirdFee: 0, bibPrefix: 'L', bibStartNum: '001', quota: 60, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-08B', eventId: 'TEST-S08-LAPRUN', name: '6H 繞圈組', distanceKm: 1.0, timeLimitHours: 6, fee: 1500, earlyBirdFee: 0, bibPrefix: 'H', bibStartNum: '001', quota: 60, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-09A', eventId: 'TEST-S09-NOCHIP', name: '42K 外部匯入組', distanceKm: 42.2, timeLimitHours: 7, fee: 1600, earlyBirdFee: 0, bibPrefix: 'E', bibStartNum: '001', quota: 150, customRaceStart: '', isWarrior800: false },
      { catId: 'TEST-CAT-10A', eventId: 'TEST-S10-CLOSED', name: '100K 八百壯士結案組', distanceKm: 100, timeLimitHours: 16, fee: 2600, earlyBirdFee: 0, bibPrefix: 'Z', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: true },
      { catId: 'TEST-CAT-10B', eventId: 'TEST-S10-CLOSED', name: '50K 峽谷結案組', distanceKm: 50, timeLimitHours: 8, fee: 1800, earlyBirdFee: 0, bibPrefix: 'Y', bibStartNum: '001', quota: 100, customRaceStart: '', isWarrior800: false }
    ];

    const stations = [
      { stationId: 'TEST-ST-01-0', eventId: 'TEST-S01-EBOPEN', stationCode: 'CHECKIN', name: '起點報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-01-1', eventId: 'TEST-S01-EBOPEN', stationCode: 'CP1', name: 'CP1 茶鄉折返', distanceKm: 50, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-01-2', eventId: 'TEST-S01-EBOPEN', stationCode: 'FINISH', name: '終點拱門', distanceKm: 100, stationType: 'finish', orderIndex: 2 },
      { stationId: 'TEST-ST-02-0', eventId: 'TEST-S02-EBEXP', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-02-1', eventId: 'TEST-S02-EBEXP', stationCode: 'FINISH', name: '終點拱門', distanceKm: 50, stationType: 'finish', orderIndex: 1 },
      { stationId: 'TEST-ST-03-0', eventId: 'TEST-S03-UNIA', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-03-1', eventId: 'TEST-S03-UNIA', stationCode: 'CP1', name: 'CP1 擎天崗', distanceKm: 25, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-03-2', eventId: 'TEST-S03-UNIA', stationCode: 'FINISH', name: '終點拱門', distanceKm: 50, stationType: 'finish', orderIndex: 2 },
      { stationId: 'TEST-ST-04-0', eventId: 'TEST-S04-UNIB', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-04-1', eventId: 'TEST-S04-UNIB', stationCode: 'LAP', name: '繞圈主拱門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 },
      { stationId: 'TEST-ST-05-0', eventId: 'TEST-S05-ORGB', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-05-1', eventId: 'TEST-S05-ORGB', stationCode: 'CP1', name: 'CP1 湖濱站', distanceKm: 50, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-05-2', eventId: 'TEST-S05-ORGB', stationCode: 'FINISH', name: '終點拱門', distanceKm: 100, stationType: 'finish', orderIndex: 2 },
      { stationId: 'TEST-ST-06-0', eventId: 'TEST-S06-PAYUNI', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-06-1', eventId: 'TEST-S06-PAYUNI', stationCode: 'FINISH', name: '終點拱門', distanceKm: 50, stationType: 'finish', orderIndex: 1 },
      { stationId: 'TEST-ST-07-0', eventId: 'TEST-S07-CHIP', stationCode: 'CHECKIN', name: '起點晶片檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-07-1', eventId: 'TEST-S07-CHIP', stationCode: 'CP1', name: 'CP1 河岸折返', distanceKm: 25, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-07-2', eventId: 'TEST-S07-CHIP', stationCode: 'FINISH', name: '終點拱門', distanceKm: 50, stationType: 'finish', orderIndex: 2 },
      { stationId: 'TEST-ST-08-0', eventId: 'TEST-S08-LAPRUN', stationCode: 'CHECKIN', name: '起點報到', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-08-1', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', name: '主會場繞圈計時門', distanceKm: 1.0, stationType: 'lap', orderIndex: 1 },
      { stationId: 'TEST-ST-09-0', eventId: 'TEST-S09-NOCHIP', stationCode: 'CHECKIN', name: '人工檢錄桌', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-09-1', eventId: 'TEST-S09-NOCHIP', stationCode: 'CP1', name: 'CP1 手動檢查站', distanceKm: 21, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-09-2', eventId: 'TEST-S09-NOCHIP', stationCode: 'FINISH', name: '人工終點線', distanceKm: 42.2, stationType: 'finish', orderIndex: 2 },
      { stationId: 'TEST-ST-10-0', eventId: 'TEST-S10-CLOSED', stationCode: 'CHECKIN', name: '報到檢錄', distanceKm: 0, stationType: 'checkin', orderIndex: 0 },
      { stationId: 'TEST-ST-10-1', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', name: 'CP1 長春祠', distanceKm: 35, stationType: 'checkpoint', orderIndex: 1 },
      { stationId: 'TEST-ST-10-2', eventId: 'TEST-S10-CLOSED', stationCode: 'CP2', name: 'CP2 天祥折返', distanceKm: 70, stationType: 'checkpoint', orderIndex: 2 },
      { stationId: 'TEST-ST-10-3', eventId: 'TEST-S10-CLOSED', stationCode: 'FINISH', name: '太魯閣終點拱門', distanceKm: 100, stationType: 'finish', orderIndex: 3 }
    ];

    const mkTP = (o) => {
      const sp = splitFullName(o.name);
      return {
        participantId: o.pid, eventId: o.ev, catId: o.cat, bibNumber: o.bib || '',
        groupCode: o.gc || '', groupName: o.gn || '',
        name: o.name, lastName: sp.lastName, firstName: sp.firstName,
        idCard: o.id, gender: o.g || 'M', birthday: o.dob || '1989-05-15', age: calcAge(o.dob || '1989-05-15') || 37,
        nationality: o.nat || 'TWN', phone: o.ph || '0912000111', email: o.em || 'test@tur.tw',
        city: o.city || '台北市', emergencyName: o.eName || '測試家屬', emergencyPhone: o.ePh || '0988000222',
        diet: o.diet || '葷', remark: o.rem || '', totalAmount: Number(o.amt ?? 1800), addonsDetail: o.addons || '[]',
        customFieldsJson: o.cf ? JSON.stringify(o.cf) : '{}',
        payMethod: o.pm || 'MANUAL_ATM', remittanceLast5: o.l5 || '', merTradeNo: o.mtn || '',
        payStatus: o.ps || 'PAID', paymentType: o.pt || (o.pm === 'ONLINE_PAYUNi' ? 'CREDIT' : 'MANUAL'),
        tradeNo: o.tn || '', payInfo: o.pi || '', paidAt: o.ps === 'PAID' ? (o.paidAt || '2026-11-10 10:00:00') : '',
        chipUid: o.uid || '', checkinStatus: o.chk || 'pending', raceStatus: o.rs || 'dns',
        penaltySeconds: o.pen || 0, createdAt: o.ca || '2026-11-05 09:00:00'
      };
    };

    const participants = [
      // 情境 01：早鳥開放中（UNPAID 未填末五碼 / UNPAID 已報末五碼 / PAID 鎖早鳥 / CANCELLED）
      mkTP({ pid: 'TEST-P-0101', ev: 'TEST-S01-EBOPEN', cat: 'TEST-CAT-01A', bib: 'W001', name: '測試早鳥一', id: 'A123456789', g: 'M', amt: 3180, addons: '["晶片採購","運動用品加購價"]', l5: '11223', ps: 'PAID', rem: '[早鳥價] 100K 早鳥含晶片與用品', cf: { addons_note: '運動用品請給 L 號深藍', shirt_size: 'L', shuttle_wave: '04:00 台北車站' } }),
      mkTP({ pid: 'TEST-P-0102', ev: 'TEST-S01-EBOPEN', cat: 'TEST-CAT-01B', bib: '', name: '測試待對帳', id: 'F223456786', g: 'F', amt: 1400, l5: '44556', ps: 'UNPAID', rem: '[早鳥價] 已匯款待核對', cf: { addons_note: '', shirt_size: 'M', shuttle_wave: '自行前往' } }),
      mkTP({ pid: 'TEST-P-0103', ev: 'TEST-S01-EBOPEN', cat: 'TEST-CAT-01B', bib: '', name: '測試未填碼', id: 'B120123453', g: 'M', amt: 2900, addons: '["住宿預訂價"]', l5: '', ps: 'UNPAID', rem: '[早鳥價] 尚未回報末五碼', cf: { addons_note: '雙人房一大床，與家人同住', shirt_size: 'XL', shuttle_wave: '自行前往' } }),
      mkTP({ pid: 'TEST-P-0104', ev: 'TEST-S01-EBOPEN', cat: 'TEST-CAT-01A', bib: '', name: '測試已取消', id: 'A223456781', g: 'F', amt: 2200, ps: 'CANCELLED', rem: '[早鳥價] 取消報名不佔名額' }),

      // 情境 02：早鳥已截止＋50K 限量滿額 (2/2 滿額，1位早鳥鎖價 / 1位截止後一般價)
      mkTP({ pid: 'TEST-P-0201', ev: 'TEST-S02-EBEXP', cat: 'TEST-CAT-02A', bib: 'M001', name: '早鳥期鎖價者', id: 'A123456789', g: 'M', amt: 1400, l5: '20001', ps: 'PAID', rem: '[早鳥價] 截止前報名維持早鳥價' }),
      mkTP({ pid: 'TEST-P-0202', ev: 'TEST-S02-EBEXP', cat: 'TEST-CAT-02A', bib: '', name: '截止後一般價', id: 'F223456786', g: 'F', amt: 1800, l5: '20002', ps: 'UNPAID', rem: '早鳥截止後依一般價收費（本組已滿2/2）' }),
      mkTP({ pid: 'TEST-P-0203', ev: 'TEST-S02-EBEXP', cat: 'TEST-CAT-02B', bib: 'N001', name: '半馬測試者', id: 'E121234565', g: 'M', amt: 1200, l5: '20003', ps: 'PAID' }),

      // 情境 03 & 04：同承辦人多場統報合併單 TURM-TEST-001 (待對帳) & TURM-TEST-002 (已整單入帳)
      mkTP({ pid: 'TEST-P-0301', ev: 'TEST-S03-UNIA', cat: 'TEST-CAT-03A', bib: '', name: '統報待核對', id: 'A123456789', g: 'M', em: 'bundle1@tur.tw', amt: 1900, l5: '55678', mtn: 'TURM-TEST-001', ps: 'UNPAID', rem: '[合併單 TURM-TEST-001｜共2場 總額NT$3150]' }),
      mkTP({ pid: 'TEST-P-0401', ev: 'TEST-S04-UNIB', cat: 'TEST-CAT-04A', bib: '', name: '統報待核對', id: 'A123456789', g: 'M', em: 'bundle1@tur.tw', amt: 1250, l5: '55678', mtn: 'TURM-TEST-001', ps: 'UNPAID', rem: '[合併單 TURM-TEST-001｜共2場 總額NT$3150] [早鳥價]' }),
      mkTP({ pid: 'TEST-P-0302', ev: 'TEST-S03-UNIA', cat: 'TEST-CAT-03B', bib: 'V001', name: '統報已入帳', id: 'F223456786', g: 'F', em: 'bundle2@tur.tw', amt: 1300, l5: '66789', mtn: 'TURM-TEST-002', ps: 'PAID', rem: '[合併單 TURM-TEST-002｜共2場 總額NT$3150]' }),
      mkTP({ pid: 'TEST-P-0402', ev: 'TEST-S04-UNIB', cat: 'TEST-CAT-04B', bib: 'Q001', name: '統報已入帳', id: 'F223456786', g: 'F', em: 'bundle2@tur.tw', amt: 1850, l5: '66789', mtn: 'TURM-TEST-002', ps: 'PAID', rem: '[合併單 TURM-TEST-002｜共2場 總額NT$3150] [早鳥價]' }),

      // 情境 05：承辦人 B 獨立收款＋團報 GRP26-T01（2待繳＋1已取消，測試整團入帳防誤復活）
      mkTP({ pid: 'TEST-P-0501', ev: 'TEST-S05-ORGB', cat: 'TEST-CAT-05A', bib: '', gc: 'GRP26-T01', gn: '南區測試跑團', name: '團員甲待繳', id: 'E121234565', g: 'M', amt: 1700, l5: '77001', ps: 'UNPAID' }),
      mkTP({ pid: 'TEST-P-0502', ev: 'TEST-S05-ORGB', cat: 'TEST-CAT-05A', bib: '', gc: 'GRP26-T01', gn: '南區測試跑團', name: '團員乙待繳', id: 'B120123453', g: 'M', amt: 1700, l5: '77001', ps: 'UNPAID' }),
      mkTP({ pid: 'TEST-P-0503', ev: 'TEST-S05-ORGB', cat: 'TEST-CAT-05A', bib: '', gc: 'GRP26-T01', gn: '南區測試跑團', name: '團員丙已取消', id: 'A223456781', g: 'F', amt: 1700, ps: 'CANCELLED', rem: '測試整團入帳不可復活此筆' }),
      mkTP({ pid: 'TEST-P-0504', ev: 'TEST-S05-ORGB', cat: 'TEST-CAT-05B', bib: 'K001', name: '南區壯士已繳', id: 'A123456789', g: 'M', amt: 2500, l5: '77009', ps: 'PAID' }),

      // 情境 06：PAYUNi 統一金流秒級配號
      mkTP({ pid: 'TEST-P-0601', ev: 'TEST-S06-PAYUNI', cat: 'TEST-CAT-06A', bib: 'P001', name: '金流秒配一', id: 'A123456789', g: 'M', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110601', tn: 'TR88001101', ps: 'PAID', rem: '[早鳥價]' }),
      mkTP({ pid: 'TEST-P-0602', ev: 'TEST-S06-PAYUNI', cat: 'TEST-CAT-06A', bib: 'P002', name: '金流秒配二', id: 'F223456786', g: 'F', amt: 1500, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110602', tn: 'TR88001102', ps: 'PAID', rem: '[早鳥價]' }),
      mkTP({ pid: 'TEST-P-0603', ev: 'TEST-S06-PAYUNI', cat: 'TEST-CAT-06B', bib: 'J001', name: '金流體驗三', id: 'E121234565', g: 'M', amt: 900, pm: 'ONLINE_PAYUNi', mtn: 'PU2026110603', tn: 'TR88001103', ps: 'PAID', rem: '[早鳥價]' }),

      // 情境 07：賽前晶片寫卡・讀取・報到檢錄整備
      mkTP({ pid: 'TEST-P-0701', ev: 'TEST-S07-CHIP', cat: 'TEST-CAT-07A', bib: 'C001', name: '晶片完成一', id: 'A123456789', g: 'M', amt: 1800, ps: 'PAID', uid: '04:TE:57:01:01', chk: 'checked_in', rs: 'dns' }),
      mkTP({ pid: 'TEST-P-0702', ev: 'TEST-S07-CHIP', cat: 'TEST-CAT-07A', bib: 'C002', name: '晶片完成二', id: 'F223456786', g: 'F', amt: 1800, ps: 'PAID', uid: '04:TE:57:01:02', chk: 'checked_in', rs: 'dns' }),
      mkTP({ pid: 'TEST-P-0703', ev: 'TEST-S07-CHIP', cat: 'TEST-CAT-07A', bib: 'C003', name: '綁卡未報到', id: 'E121234565', g: 'M', amt: 1800, ps: 'PAID', uid: '04:TE:57:01:03', chk: 'pending', rs: 'dns' }),
      mkTP({ pid: 'TEST-P-0704', ev: 'TEST-S07-CHIP', cat: 'TEST-CAT-07A', bib: 'C004', name: '待寫卡選手', id: 'B120123453', g: 'M', amt: 1800, ps: 'PAID', uid: '', chk: 'pending', rs: 'dns' }),
      mkTP({ pid: 'TEST-P-0705', ev: 'TEST-S07-CHIP', cat: 'TEST-CAT-07A', bib: '', name: '逾期未繳費', id: 'A223456781', g: 'F', amt: 1800, ps: 'UNPAID', uid: '', chk: 'pending', rs: 'dns', rem: '測試鎖定費用仍可改手機' }),

      // 情境 08：12H/6H 計時繞圈賽進行中（晶片刷圈＋手動補圈＋超時無效圈）
      mkTP({ pid: 'TEST-P-0801', ev: 'TEST-S08-LAPRUN', cat: 'TEST-CAT-08A', bib: 'L001', name: '繞圈領先者', id: 'A123456789', g: 'M', amt: 2200, pm: 'ONLINE_PAYUNi', ps: 'PAID', uid: '04:TE:58:01:01', chk: 'checked_in', rs: 'on_track' }),
      mkTP({ pid: 'TEST-P-0802', ev: 'TEST-S08-LAPRUN', cat: 'TEST-CAT-08A', bib: 'L002', name: '繞圈追趕者', id: 'F223456786', g: 'F', amt: 2200, pm: 'ONLINE_PAYUNi', ps: 'PAID', uid: '04:TE:58:01:02', chk: 'checked_in', rs: 'on_track' }),
      mkTP({ pid: 'TEST-P-0803', ev: 'TEST-S08-LAPRUN', cat: 'TEST-CAT-08B', bib: 'H001', name: '六小完賽含超時圈', id: 'E121234565', g: 'M', amt: 1500, pm: 'ONLINE_PAYUNi', ps: 'PAID', uid: '04:TE:58:01:03', chk: 'checked_in', rs: 'finished' }),
      mkTP({ pid: 'TEST-P-0804', ev: 'TEST-S08-LAPRUN', cat: 'TEST-CAT-08A', bib: 'L003', name: '繞圈中途退賽', id: 'B120123453', g: 'M', amt: 2200, pm: 'ONLINE_PAYUNi', ps: 'PAID', uid: '04:TE:58:01:04', chk: 'checked_in', rs: 'dnf' }),

      // 情境 09：外部已繳名單匯入＆無晶片手動計時
      mkTP({ pid: 'TEST-P-0901', ev: 'TEST-S09-NOCHIP', cat: 'TEST-CAT-09A', bib: 'E001', name: '外場匯入一', id: 'A123456789', g: 'M', amt: 0, pm: 'EXTERNAL_IMPORT', pt: 'EXTERNAL', ps: 'PAID', chk: 'checked_in', rs: 'finished', gn: '外部平台名單' }),
      mkTP({ pid: 'TEST-P-0902', ev: 'TEST-S09-NOCHIP', cat: 'TEST-CAT-09A', bib: 'E002', name: '外場匯入二', id: 'F223456786', g: 'F', amt: 0, pm: 'EXTERNAL_IMPORT', pt: 'EXTERNAL', ps: 'PAID', chk: 'checked_in', rs: 'on_track', gn: '外部平台名單' }),
      mkTP({ pid: 'TEST-P-0903', ev: 'TEST-S09-NOCHIP', cat: 'TEST-CAT-09A', bib: 'E003', name: '站內已繳三', id: 'E121234565', g: 'M', amt: 1600, l5: '90003', ps: 'PAID', chk: 'pending', rs: 'dns' }),

      // 情境 10：已結案封存・八百壯士＋官方自訂底圖證書
      mkTP({ pid: 'TEST-P-1001', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10A', bib: 'Z001', name: '諸葛測試冠軍', id: 'A123456789', g: 'M', amt: 2600, l5: '10001', ps: 'PAID', uid: '04:TE:10:00:01', chk: 'checked_in', rs: 'finished' }),
      mkTP({ pid: 'TEST-P-1002', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10A', bib: 'Z002', name: '歐陽百K亞軍', id: 'F223456786', g: 'F', amt: 2600, l5: '10002', ps: 'PAID', uid: '04:TE:10:00:02', chk: 'checked_in', rs: 'finished', pen: 60 }),
      mkTP({ pid: 'TEST-P-1003', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10B', bib: 'Y001', name: '司馬峽谷完賽', id: 'E121234565', g: 'M', amt: 1800, l5: '10003', ps: 'PAID', uid: '04:TE:10:00:03', chk: 'checked_in', rs: 'finished' }),
      mkTP({ pid: 'TEST-P-1004', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10B', bib: 'Y002', name: '上官五十完賽', id: 'A223456781', g: 'F', amt: 1800, l5: '10004', ps: 'PAID', uid: '04:TE:10:00:04', chk: 'checked_in', rs: 'finished' }),
      mkTP({ pid: 'TEST-P-1005', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10A', bib: 'Z003', name: '測試退賽DNF', id: 'B120123453', g: 'M', amt: 2600, l5: '10005', ps: 'PAID', uid: '04:TE:10:00:05', chk: 'checked_in', rs: 'dnf' }),
      mkTP({ pid: 'TEST-P-1006', ev: 'TEST-S10-CLOSED', cat: 'TEST-CAT-10B', bib: 'Y003', name: '測試缺席DNS', id: 'C123456788', g: 'M', amt: 1800, l5: '10006', ps: 'PAID', uid: '', chk: 'pending', rs: 'dns' })
    ];

    const timingLogs = [
      // 情境 08：繞圈進行中（有效圈、手動補圈與 1 筆逾 6H 超時無效圈）
      { logId: 'TEST-LOG-0801', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-27 05:06:10', lapCount: 1, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0802', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-27 05:12:25', lapCount: 2, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0803', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-27 05:18:40', lapCount: 3, operator: 'test_op_lap', source: 'manual', isValid: true, note: '測試手動補圈' },
      { logId: 'TEST-LOG-0804', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L001', idCardHash: '', sensedTime: '2026-11-27 05:25:00', lapCount: 4, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0805', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L002', idCardHash: '', sensedTime: '2026-11-27 05:06:55', lapCount: 1, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0806', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L002', idCardHash: '', sensedTime: '2026-11-27 05:13:50', lapCount: 2, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0807', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'H001', idCardHash: '', sensedTime: '2026-11-27 05:05:50', lapCount: 1, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0808', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'H001', idCardHash: '', sensedTime: '2026-11-27 10:52:10', lapCount: 2, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-0809', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'H001', idCardHash: '', sensedTime: '2026-11-27 11:05:30', lapCount: 3, operator: 'test_op_lap', source: 'nfc', isValid: false, note: '逾 6H 限時之超時無效圈' },
      { logId: 'TEST-LOG-0810', eventId: 'TEST-S08-LAPRUN', stationCode: 'LAP', bibNumber: 'L003', idCardHash: '', sensedTime: '2026-11-27 05:08:20', lapCount: 1, operator: 'test_op_lap', source: 'nfc', isValid: true, note: '一圈後棄賽' },

      // 情境 09：手動補登成績
      { logId: 'TEST-LOG-0901', eventId: 'TEST-S09-NOCHIP', stationCode: 'CP1', bibNumber: 'E001', idCardHash: '', sensedTime: '2026-11-27 08:05:12', lapCount: 0, operator: 'test_op_finish', source: 'manual', isValid: true, note: '人工記錄' },
      { logId: 'TEST-LOG-0902', eventId: 'TEST-S09-NOCHIP', stationCode: 'FINISH', bibNumber: 'E001', idCardHash: '', sensedTime: '2026-11-27 10:18:45', lapCount: 0, operator: 'test_op_finish', source: 'manual', isValid: true, note: '人工終點補登' },
      { logId: 'TEST-LOG-0903', eventId: 'TEST-S09-NOCHIP', stationCode: 'CP1', bibNumber: 'E002', idCardHash: '', sensedTime: '2026-11-27 08:22:30', lapCount: 0, operator: 'test_op_finish', source: 'manual', isValid: true, note: '在途中' },

      // 情境 10：已結案封存完整分段成績
      { logId: 'TEST-LOG-1001', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', bibNumber: 'Z001', idCardHash: '', sensedTime: '2026-04-12 08:10:00', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1002', eventId: 'TEST-S10-CLOSED', stationCode: 'CP2', bibNumber: 'Z001', idCardHash: '', sensedTime: '2026-04-12 11:32:15', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1003', eventId: 'TEST-S10-CLOSED', stationCode: 'FINISH', bibNumber: 'Z001', idCardHash: '', sensedTime: '2026-04-12 14:48:20', lapCount: 0, operator: 'test_op_finish', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1004', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', bibNumber: 'Z002', idCardHash: '', sensedTime: '2026-04-12 08:22:10', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1005', eventId: 'TEST-S10-CLOSED', stationCode: 'CP2', bibNumber: 'Z002', idCardHash: '', sensedTime: '2026-04-12 12:05:40', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1006', eventId: 'TEST-S10-CLOSED', stationCode: 'FINISH', bibNumber: 'Z002', idCardHash: '', sensedTime: '2026-04-12 15:40:10', lapCount: 0, operator: 'test_op_finish', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1007', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', bibNumber: 'Y001', idCardHash: '', sensedTime: '2026-04-12 08:15:30', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1008', eventId: 'TEST-S10-CLOSED', stationCode: 'FINISH', bibNumber: 'Y001', idCardHash: '', sensedTime: '2026-04-12 09:56:12', lapCount: 0, operator: 'test_op_finish', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1009', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', bibNumber: 'Y002', idCardHash: '', sensedTime: '2026-04-12 08:30:05', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1010', eventId: 'TEST-S10-CLOSED', stationCode: 'FINISH', bibNumber: 'Y002', idCardHash: '', sensedTime: '2026-04-12 10:25:44', lapCount: 0, operator: 'test_op_finish', source: 'nfc', isValid: true, note: '' },
      { logId: 'TEST-LOG-1011', eventId: 'TEST-S10-CLOSED', stationCode: 'CP1', bibNumber: 'Z003', idCardHash: '', sensedTime: '2026-04-12 08:50:00', lapCount: 0, operator: 'test_op_cp1', source: 'nfc', isValid: true, note: '抽筋退賽' }
    ];

    const historyResults = [
      { historyId: 'TEST-HIS-01', eventDate: '2025-11-08', eventName: '【測試歷屆】2025 八百壯士測試邀請賽', categoryName: '100K 八百壯士組', bibNumber: 'TW01', name: '諸葛測試冠軍', nationality: 'TWN', idCardHash: 'test-hash-01', finishTime: '09:55:10', distanceKm: 100, lapCount: 0, overallRank: 1, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '測試歷屆資料（一鍵可清）' },
      { historyId: 'TEST-HIS-02', eventDate: '2025-11-08', eventName: '【測試歷屆】2025 八百壯士測試邀請賽', categoryName: '100K 八百壯士組', bibNumber: 'TW02', name: '歐陽百K亞軍', nationality: 'TWN', idCardHash: 'test-hash-02', finishTime: '10:38:22', distanceKm: 100, lapCount: 0, overallRank: 2, catRank: 1, status: 'FINISHED', isWarrior800: true, remark: '測試歷屆資料（一鍵可清）' },
      { historyId: 'TEST-HIS-03', eventDate: '2025-11-08', eventName: '【測試歷屆】2025 八百壯士測試邀請賽', categoryName: '50K 測試組', bibNumber: 'TB01', name: '司馬峽谷完賽', nationality: 'TWN', idCardHash: 'test-hash-03', finishTime: '05:10:05', distanceKm: 50, lapCount: 0, overallRank: 3, catRank: 1, status: 'FINISHED', isWarrior800: false, remark: '測試歷屆資料（一鍵可清）' }
    ];

    return { users, events, categories, stations, participants, timingLogs, historyResults };
  }

  function mergeTestSuiteIntoState(state) {
    const suite = buildTestSuite10Scenarios();
    const kfMap = {
      events: 'eventId', categories: 'catId', stations: 'stationId',
      participants: 'participantId', timingLogs: 'logId', historyResults: 'historyId', users: 'username'
    };
    const merged = {};
    Object.keys(kfMap).forEach((store) => {
      const kf = kfMap[store];
      // 先保留全部非測試資料，再以最新的 TEST-* 測試套件覆寫對應鍵，確保不重複也不影響正式資料
      const map = new Map();
      (state[store] || []).forEach((item) => {
        if (!isTestSuiteRecord(store, item) && item && item[kf]) {
          map.set(String(item[kf]), item);
        }
      });
      (suite[store] || []).forEach((item) => {
        if (item && item[kf]) map.set(String(item[kf]), item);
      });
      merged[store] = [...map.values()];
    });
    return { suite, merged };
  }

  function stripTestSuiteFromState(state) {
    const stores = ['events', 'categories', 'stations', 'participants', 'timingLogs', 'historyResults', 'users'];
    const cleaned = {};
    const removedCounts = {};
    let totalRemoved = 0;
    stores.forEach((store) => {
      const before = Array.isArray(state[store]) ? state[store] : [];
      const after = before.filter((item) => !isTestSuiteRecord(store, item));
      cleaned[store] = after;
      removedCounts[store] = before.length - after.length;
      totalRemoved += removedCounts[store];
    });
    return { cleaned, removedCounts, totalRemoved };
  }

  /* --------------------------------------------------------------------------
   * Group Registration Helpers (第 1 位為團長、其餘為組員，統一匯款與單一管理窗口)
   * -------------------------------------------------------------------------- */
  function getGroupMembers(participants, groupCode, eventId = '') {
    const gc = String(groupCode || '').trim().toUpperCase();
    if (!gc) return [];
    return (participants || []).filter((p) => {
      if (!p) return false;
      if (String(p.groupCode || '').trim().toUpperCase() !== gc) return false;
      if (eventId && String(p.eventId || '') !== String(eventId)) return false;
      return String(p.payStatus || '').toUpperCase() !== 'CANCELLED';
    });
  }

  function getGroupLeader(participants, groupCode, eventId = '') {
    const members = getGroupMembers(participants, groupCode, eventId);
    if (!members.length) return null;
    const explicit = members.find((p) => String(p.groupRole || '').toLowerCase() === 'leader');
    return explicit || members[0];
  }

  function getParticipantGroupRole(p, participants) {
    if (!p || !String(p.groupCode || '').trim()) return '';
    const explicit = String(p.groupRole || '').toLowerCase();
    if (explicit === 'leader' || explicit === 'member') return explicit;
    const leader = getGroupLeader(participants, p.groupCode, p.eventId);
    if (!leader) return '';
    return leader.participantId === p.participantId ? 'leader' : 'member';
  }

  function summarizeGroupOrders({ participants = [], categories = [], eventId = '' }) {
    const catMap = new Map((categories || []).map((c) => [c.catId, c.name]));
    const scoped = (participants || []).filter((p) => {
      if (!p || !String(p.groupCode || '').trim()) return false;
      if (eventId && String(p.eventId || '') !== String(eventId)) return false;
      return String(p.payStatus || '').toUpperCase() !== 'CANCELLED';
    });
    const map = new Map();
    scoped.forEach((p) => {
      const gc = String(p.groupCode).trim().toUpperCase();
      const key = `${p.eventId}::${gc}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    });
    const out = [];
    map.forEach((members) => {
      const leader = members.find((m) => String(m.groupRole || '').toLowerCase() === 'leader') || members[0];
      const ordered = [leader, ...members.filter((m) => m.participantId !== leader.participantId)];
      const unpaid = ordered.filter((m) => ['UNPAID', 'PENDING_PAY'].includes(String(m.payStatus || '').toUpperCase()));
      const paid = ordered.filter((m) => String(m.payStatus || '').toUpperCase() === 'PAID');
      const totalAmount = ordered.reduce((s, m) => s + Number(m.totalAmount || 0), 0);
      const last5 = leader.remittanceLast5 || (ordered.find((m) => m.remittanceLast5)?.remittanceLast5 || '');
      out.push({
        eventId: leader.eventId,
        groupCode: String(leader.groupCode || '').trim().toUpperCase(),
        groupName: leader.groupName || '團體報名',
        leader,
        members: ordered.map((m) => ({
          ...m,
          role: m.participantId === leader.participantId ? 'leader' : 'member',
          catName: catMap.get(m.catId) || m.catId
        })),
        memberCount: ordered.length,
        totalAmount,
        paidCount: paid.length,
        unpaidCount: unpaid.length,
        allPaid: unpaid.length === 0 && paid.length > 0,
        payMethod: leader.payMethod || 'MANUAL_ATM',
        remittanceLast5: last5
      });
    });
    return out.sort((a, b) => Number(a.allPaid) - Number(b.allPaid) || a.groupCode.localeCompare(b.groupCode));
  }

  /* --------------------------------------------------------------------------
   * 10. Web NFC v3.1 雙模讀寫與音效核心（移植自路跑晶片計時系統）
   * -------------------------------------------------------------------------- */
  const TurNFC = (() => {
    class SoundFX {
      constructor() { this.ctx = null; this.enabled = true; }
      _ensureCtx() {
        if (!this.enabled) return null;
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!this.ctx) this.ctx = new AudioCtx();
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return this.ctx;
      }
      _tone(freq, durationMs, type = 'sine', gainVal = 0.25, delaySec = 0) {
        const ctx = this._ensureCtx();
        if (!ctx) return;
        const now = ctx.currentTime + delaySec;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(gainVal, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now); osc.stop(now + durationMs / 1000 + 0.02);
      }
      beepSuccess() { this._tone(1046.5, 90, 'sine', 0.28, 0); this._tone(1568.0, 140, 'sine', 0.30, 0.09); this.vibrate([80]); }
      beepWriteVerified() { this._tone(880, 80, 'triangle', 0.25, 0); this._tone(1174.6, 80, 'triangle', 0.25, 0.09); this._tone(1760, 180, 'triangle', 0.30, 0.18); this.vibrate([60, 50, 120]); }
      beepWarning() { this._tone(520, 110, 'square', 0.18, 0); this._tone(420, 160, 'square', 0.18, 0.13); this.vibrate([120, 60, 120]); }
      beepError() { this._tone(260, 260, 'sawtooth', 0.22, 0); this.vibrate([220]); }
      beepGun() { this._tone(180, 180, 'sawtooth', 0.35, 0); this._tone(900, 320, 'triangle', 0.32, 0.05); this.vibrate([200, 80, 200]); }
      vibrate(pattern) { if (global.navigator?.vibrate) { try { global.navigator.vibrate(pattern); } catch (_) {} } }
    }

    function translateError(err) {
      if (!err) return '未知的 NFC 錯誤';
      const name = err.name || 'Error';
      const rawMsg = err.message || String(err);
      const rawTag = ` [${name}: ${rawMsg}]`;
      if (name === 'NotAllowedError') return 'NFC 權限遭拒或未開啟：請開啟手機 NFC 並允許 Chrome 使用 NFC 裝置。' + rawTag;
      if (name === 'NotSupportedError') return '此晶片不支援標準 NDEF 寫入（可能為唯讀卡或 MIFARE Classic），請改點「🔗 僅綁定晶片 UID」。' + rawTag;
      if (name === 'NetworkError' || name === 'IOError') return '晶片傳輸中斷：請緊貼手機背面 NFC 天線靜止 1～2 秒；若反覆失敗請改用「🔗 僅綁定晶片 UID」。' + rawTag;
      if (name === 'NotReadableError') return '無法讀取晶片（移開太快或晶片損壞），請緊貼天線停留 1 秒重試。' + rawTag;
      if (name === 'AbortError') return '已取消或等待逾時，請重新點擊按鈕後再貼近晶片。';
      if (name === 'InvalidStateError') return '手機 NFC 正忙線中，請稍候 1 秒重試。' + rawTag;
      return rawMsg + rawTag;
    }

    class NFCManager {
      constructor() {
        this.reader = null;
        this.scanAbortController = null;
        this.opAbortController = null;
        this.isScanning = false;
        this.isBusy = false;
        this.sound = new SoundFX();
      }
      getDiagnostics() {
        const isSecure = Boolean(global.isSecureContext || global.location?.hostname === 'localhost' || global.location?.hostname === '127.0.0.1');
        const hasNDEF = 'NDEFReader' in global;
        const ua = global.navigator?.userAgent || '';
        const isAndroid = /Android/i.test(ua);
        let statusMessage = '🟢 Web NFC 就緒（支援寫入、回讀驗證與 UID 綁定）';
        if (!isSecure) statusMessage = '🔴 非 HTTPS 連線，Web NFC 已停用';
        else if (!hasNDEF) statusMessage = isAndroid ? '🟡 請改用 Android Chrome 開啟（勿用 LINE/FB 內建瀏覽器）' : '🟡 電腦／iPhone 模擬模式（實機寫卡請用 Android Chrome）';
        return { supported: isSecure && hasNDEF, isSecure, hasNDEF, isAndroid, statusMessage };
      }
      encodeChipPayload({ name, idNumber }) {
        const cleanName = String(name || '').replace(/\|/g, ' ').trim();
        const cleanId = String(idNumber || '').replace(/\|/g, '').trim().toUpperCase();
        return `${cleanName}|${cleanId}`;
      }
      decodeNdefMessage(message) {
        const records = (message && message.records) || [];
        for (const record of records) {
          if (!record || !record.data || record.data.byteLength === 0) continue;
          let text = '';
          try { text = new TextDecoder(record.encoding || 'utf-8').decode(record.data).trim(); }
          catch (_) { try { text = new TextDecoder('utf-8').decode(record.data).trim(); } catch (_) { continue; } }
          if (!text) continue;
          if (text.startsWith('{')) {
            try {
              const obj = JSON.parse(text);
              const idNumber = String(obj.id || obj.idNumber || '').trim().toUpperCase();
              const name = String(obj.name || '').trim();
              if (idNumber || name) return { name, idNumber, bib: String(obj.bib || '').trim(), raw: text, recordType: record.recordType };
            } catch (_) {}
          }
          if (text.includes('|')) {
            const parts = text.split('|').map((s) => s.trim());
            if (parts.length === 2) return { name: parts[0], idNumber: parts[1].toUpperCase(), bib: '', raw: text, recordType: record.recordType };
            if (parts.length >= 3) return { bib: parts[0], name: parts[1], idNumber: parts[2].toUpperCase(), raw: text, recordType: record.recordType };
          }
          if (record.recordType === 'text' || record.recordType === 'mime' || record.recordType === 'unknown') {
            const looksLikeId = /^[A-Z][0-9A-Z]{6,12}$/i.test(text);
            return { name: looksLikeId ? '' : text, idNumber: looksLikeId ? text.toUpperCase() : '', bib: '', raw: text, recordType: record.recordType };
          }
        }
        return null;
      }
      cancelActiveOperation() {
        if (this.opAbortController) { this.opAbortController.abort(); this.opAbortController = null; }
        this.isBusy = false;
      }
      stopScanning() {
        if (this.scanAbortController) { this.scanAbortController.abort(); this.scanAbortController = null; }
        this.reader = null;
        this.isScanning = false;
      }
      async startScanning(onTagRead, onError) {
        const diag = this.getDiagnostics();
        if (!diag.supported) throw new Error(diag.statusMessage);
        this.cancelActiveOperation();
        this.stopScanning();
        this.scanAbortController = new AbortController();
        const ndef = new global.NDEFReader();
        this.reader = ndef;
        ndef.addEventListener('readingerror', () => {
          this.sound.beepError();
          if (onError) onError(new Error('無法讀取晶片，請緊貼手機背面 NFC 天線 1 秒重試'));
        });
        ndef.addEventListener('reading', (event) => {
          const uid = String(event.serialNumber || '').trim().toUpperCase();
          const parsed = this.decodeNdefMessage(event.message);
          if (parsed && (parsed.idNumber || parsed.name || parsed.bib)) {
            onTagRead({ ...parsed, nfcUid: uid, uidOnly: false, source: 'nfc' });
            return;
          }
          if (uid) {
            onTagRead({ name: '', idNumber: '', bib: '', raw: '', nfcUid: uid, uidOnly: true, source: 'nfc' });
            return;
          }
          this.sound.beepError();
          if (onError) onError(new Error('感應到空白晶片且無可辨識 UID，請先寫入晶片或綁定 UID'));
        });
        try {
          await ndef.scan({ signal: this.scanAbortController.signal });
          this.isScanning = true;
        } catch (err) {
          this.stopScanning();
          throw new Error(translateError(err));
        }
      }
      async writeChip({ name, idNumber }, { onStep } = {}) {
        const diag = this.getDiagnostics();
        if (!diag.supported) throw new Error(diag.statusMessage);
        this.stopScanning();
        this.cancelActiveOperation();
        const targetId = String(idNumber || '').trim().toUpperCase();
        const targetName = String(name || '').trim();
        const payloadStr = this.encodeChipPayload({ name: targetName, idNumber: targetId });
        const ac = new AbortController();
        this.opAbortController = ac;
        this.isBusy = true;
        const ndef = new global.NDEFReader();
        this.reader = ndef;
        if (onStep) onStep(`📡 請將晶片緊貼手機背面靜止 1～2 秒…（寫入：${maskNdefPayload(payloadStr)}）`);
        const timer = setTimeout(() => ac.abort(), 30000);
        try {
          await ndef.write(
            { records: [{ recordType: 'text', encoding: 'utf-8', lang: 'zh', data: payloadStr }] },
            { overwrite: true, signal: ac.signal }
          );
          clearTimeout(timer);
          this.opAbortController = null; this.reader = null; this.isBusy = false;
          this.sound.beepWriteVerified();
          return { written: true, name: targetName, idNumber: targetId, raw: payloadStr };
        } catch (err) {
          clearTimeout(timer);
          this.opAbortController = null; this.reader = null; this.isBusy = false;
          const translated = new Error(translateError(err));
          translated.originalName = err?.name || '';
          throw translated;
        }
      }
      async readSingleTag(onStep, timeoutMs = 25000) {
        const diag = this.getDiagnostics();
        if (!diag.supported) throw new Error(diag.statusMessage);
        this.stopScanning();
        this.cancelActiveOperation();
        const ac = new AbortController();
        this.opAbortController = ac;
        this.isBusy = true;
        if (onStep) onStep('📡 請將 NFC 晶片緊貼手機背面感應區…');
        const ndef = new global.NDEFReader();
        this.reader = ndef;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error('等待讀取逾時（25 秒），請重試。')); }, timeoutMs);
          const cleanup = () => { clearTimeout(timer); if (!ac.signal.aborted) ac.abort(); this.opAbortController = null; this.reader = null; this.isBusy = false; };
          ac.signal.addEventListener('abort', () => { clearTimeout(timer); this.isBusy = false; });
          ndef.addEventListener('reading', (event) => {
            const uid = String(event.serialNumber || '').trim().toUpperCase();
            const parsed = this.decodeNdefMessage(event.message);
            const recordTypes = ((event.message && event.message.records) || []).map((r) => r.recordType);
            cleanup();
            this.sound.beepSuccess();
            resolve({ nfcUid: uid, parsed, recordTypes, raw: parsed ? parsed.raw : '' });
          }, { once: true });
          ndef.addEventListener('readingerror', () => {
            cleanup();
            this.sound.beepError();
            reject(new Error('讀取晶片失敗：請緊貼天線停留 1 秒重試。'));
          }, { once: true });
          ndef.scan({ signal: ac.signal }).catch((err) => { cleanup(); reject(new Error(translateError(err))); });
        });
      }
      async mockWriteChip({ name, idNumber }, { onStep } = {}) {
        const targetId = String(idNumber || '').trim().toUpperCase();
        const targetName = String(name || '').trim();
        const payloadStr = this.encodeChipPayload({ name: targetName, idNumber: targetId });
        if (onStep) onStep(`[模擬] 寫入中：${maskNdefPayload(payloadStr)}…`);
        await new Promise((r) => setTimeout(r, 220));
        this.sound.beepWriteVerified();
        return { written: true, verified: true, nfcUid: '04:' + Math.random().toString(16).slice(2, 4).toUpperCase() + ':' + Math.random().toString(16).slice(2, 4).toUpperCase() + ':88', name: targetName, idNumber: targetId, raw: payloadStr };
      }
    }

    return new NFCManager();
  })();

  global.TurCore = {
    DEFAULT_GAS_URL,
    PAYUNi_FEATURE_ENABLED,
    NFC: TurNFC,
    onLogoReady,
    pad2, formatDateTime, parseDateTime, formatDuration, formatPace, escapeHtml, maskIdCard, maskNdefPayload,
    COMPOUND_SURNAMES_28, splitFullName, mergeNameParts, zhToEnEventName,
    verifyTaiwanIdChecksum, inferGenderFromId, calcAge, sha256Hex,
    CURATED_BANNERS, DEFAULT_BROCHURE_TEMPLATE, DEFAULT_TUR_ADDONS, DEFAULT_ADDONS_NOTE_FIELD, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_PRESETS, DEFAULT_REG_FIELDS, getEffectiveRegFieldOrder, HISTORY_IMPORT_SPEC, EXTERNAL_IMPORT_SPEC, PAYMENT_MODES,
    getBannerStyle, sanitizeBrochureText, normalizeEventData, defaultFormSchema, getEventPaymentMode, normalizeEarlyBirdEnd, getEventEarlyBirdConfig, isEarlyBirdActive, getEffectiveCategoryPrice, defaultCertConfig, parseJsonSafe,
    TurDB, validateGasUrl, buildGasQueryUrl, gasGet, gasPost,
    isCategoryWarrior800, isWarrior800Eligible, computeLeaderboard, computeEventProgressAnalytics, evaluateEventStageGates,
    isCertEligible, buildUnifiedHistoryRecords, parseExternalRosterRows,
    isBundleOrderCode, generateBundleOrderCode, summarizeBundleOrders,
    getGroupMembers, getGroupLeader, getParticipantGroupRole, summarizeGroupOrders,
    FONT_SCALE_MODES, applyFontScale, getSavedFontScale, getRaceTypeWorkflow, getStationSopInfo,
    bindFastInput, ensureExternalLib, ensureCertFonts,
    CERT_LAYOUTS, CERT_PALETTES, CERT_FONTS, CERT_CUSTOM_ELEMENTS, defaultCustomBgElements, getMergedCustomBgElements, compressCustomBgImage, renderCertificateCanvas,
    buildFull5EventsSeed,
    TEST_SUITE_PREFIX, isTestSuiteId, isTestSuiteRecord, countTestSuiteStats, buildTestSuite10Scenarios, mergeTestSuiteIntoState, stripTestSuiteFromState
  };
})(window);
