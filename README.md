# TUR 一體化賽事管理與計時系統 v3.0（全權責與六階段治理版）

單一前端入口 ＋ 單一 Google 試算表 8 表資料庫 ＋ 四層 RBAC 權責隔離 ＋ 雙軌金流 ＋ 離線優先 Web NFC 計時 ＋ 最高管理直通控制台 ＋ 承辦人動態完賽證書引擎。

---

## 專案檔案架構

| 檔案 | 功能說明 |
| :--- | :--- |
| `Code.gs` | Google Apps Script 後端（8 張工作表 `setupSheets`、最高管理直通 `adminBatchUpdateSheet`、PAYUNi 自動銷帳配號、歷屆匯入、JSON + JSONP 雙協議） |
| `index.html` | 單一入口主系統（公開前台報名、零紀錄登入、作業員鎖定站點、五大治理專區） |
| `js/tur-core.js` | 共用核心（IndexedDB 9 Stores、GAS JSONP 備援、28 複姓拆併、SHA-256、雙賽制計時引擎、動態證書畫布引擎、5 場全情境測試資料） |
| `js/tur-zones.js` | 專區 1~5 完整業務（3 表 Excel `.xlsx`、DUV 送審、800 壯士分流、批次 `.zip`/多頁 `.pdf`、歷屆金框清洗、最高管理直通 Data Grid） |
| `js/tur-app.js` | 四層 RBAC、零紀錄登入與三步驟作業員登錄、14 項防呆、雙軌金流（`MANUAL_ATM` / `ONLINE_PAYUNi`）、離線 Web NFC 感應 |
| `public.html` | 免登入公開平台（即時與結案成績、歷年查詢、八百壯士 100K+ 英雄榜、聯動承辦人開關之動態證書中心） |
| `lib/payuni.js` | PAYUNi 統一金流 AES-256-GCM 加解密與 SHA-256 `HashInfo` 工具模組 |
| `api/payuni-webhook.js` | Vercel / Node.js Serverless Webhook（背景驗簽解密並觸發 GAS 秒級自動 `PAID` + 配號） |

---

## 四層角色預設測試帳號（零紀錄安全模式，不自動填入）

| 角色 | 帳號 | 密碼 | 權限範圍 |
| :--- | :--- | :--- | :--- |
| **最高管理員 (`super_admin`)** | `superadmin` | `tur2026` | 全平台專區 1~5、直通 Google 試算表控制台、歷屆清洗匯入、全機備份還原與清空 |
| **活動承辦人 (`organizer`)** | `org_north` / `org_south` | `org2026` | 僅限本人名下活動（專區 1、專區 2、精簡版專區 5）；自動隔離他人資料與專區 3/4 |
| **現場作業員 (`operator`)** | `writer01`、`checkin01`、`cp1`、`finish01`、`lap01` | `1234` | 三步驟快速登錄，嚴格鎖定各自單一站點（支援戶外高對比與離線刷卡） |
| **民眾 / 跑者 (`public`)** | 免登入 | - | 開放報名首頁、`/lookup` 45 分鐘雙因子查改、`public.html` 成績與證書下載 |

---

## Google 試算表 3 分鐘串接部署

1. 建立空白 Google 試算表 → **擴充功能 → Apps Script** → 貼入 `Code.gs` 並儲存。
2. 執行函式 **`setupSheets`**（自動建立 8 張核心工作表與預設設定）。
3. 點 **部署 → 新增部署作業 → 網頁應用程式**：執行身分選 **「我」**、誰可以存取選 **「所有人」**。
4. 以 `superadmin` 登入系統 → 進入 **專區 5：🗄️ 最高管理直通控制台** → 貼入 `/exec` 網址 → 按 **「測試並儲存連線」** 即可雙向同步與雲端直修試算表！
