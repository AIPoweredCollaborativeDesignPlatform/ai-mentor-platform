# AI Mentor Collaboration Platform

這是一個 AI 輔助協作設計的研究平台（博士研究，預計送 IRB）。

- 兩人或小組在線上協作產品設計：聊天、在共用白板畫圖，並取得 AI 產生的發想草圖、意象圖與 3D 模型。
- AI 導師依實驗條件參與討論：無 AI、被動回應、主動介入。研究者在後台設定條件，事後可重播每一場討論，也能看到 AI 在背景的每一次判斷。

線上網址：https://ai-mentor-design.web.app（另有 https://ai-mentor-web.web.app）

## 技術架構

```
瀏覽器（Vue 3 + Pinia + Tailwind + Fabric.js v7）
   │  Firestore 即時同步（聊天、白板物件、房間狀態）
   ▼
Firebase Cloud Functions v2（Node 22）：所有 AI 都在伺服器端
   ├─ Anthropic Claude：導師判斷與記憶、白板視覺、SVG、草圖描述、設定檔填寫
   ├─ fal.ai FLUX：意象圖、文字轉草圖、圖生圖（草圖／渲染圖）
   └─ Meshy（Tripo 為備選）：文字轉 3D、圖片轉 3D
```

- 前端不持有任何 AI 金鑰。金鑰是 Functions secrets，也可在後台「系統設定」覆寫並測試。
- 每一次 AI 呼叫都寫進研究紀錄（`aiLogs`），房內每個操作都寫進事件紀錄（`rooms/{id}/events`）。

## 主要功能

**實驗流程**
- 建房時伺服器配發 4 位數 PIN；參與者填暱稱、同意書後進房。
- 人數到齊時自動開場。預設在剩 30、15、5 分鐘時由 AI 提醒，並對照預定的雙鑽石進度說明目前是超前還是落後。
- 時間到時 AI 會提醒，但聊天室不會鎖住，團隊可以繼續討論；所有人離線一段時間後房間自動結束，研究者與管理者也可手動結束。
- 設計題目可由後台指派，也可由 AI 在開場時出題，讓大家投票。

**AI 導師**
- 判斷時機：被 @ 時回應；主動模式會在停頓、冷場或長時間討論時自行判斷是否開口。
- 會依雙鑽石的階段引導討論，可發「接受建議／先不用」卡片，也會在方向確定後自動為房間命名。
- 聊天區左側的雙鑽石即時顯示 AI 判斷的階段與節點（寬螢幕才顯示）。
- 人設、語氣、專業能力都可在後台設定，也能用一句話讓 AI 幫忙填寫。

**視覺與 3D**
- 意象圖與發想草圖以拼貼呈現，可多人拖曳排列，也能放到白板上。
- 白板手繪可轉成乾淨草圖與渲染圖；上傳的圖片可延伸出新草圖。
- 草圖或照片可直接建立 3D 模型；圖片轉 3D 的白模之後也能按「上色」。
- 建立或修改 3D 前，如果還有其他人在線上，AI 會先問大家有沒有要補充，沒人回應 10 秒後才生成（有人在打字就再等），以便一次處理所有修改。

**後台**（`/#/admin`）
- 管理實驗條件設定檔，並記錄每個版本。
- 房間管理：指派條件、以唯讀身分進房、批次刪除、上傳研究資料到 Google Drive。
- 系統設定：模型、金鑰、Meshy 與草圖參數。
- 重播：聊天、白板與「AI 背景思考」依時間軸同步播放；白板預設跟隨正在使用的那張。
- 人工編碼（`/#/admin/coding`）與題庫管理（`/#/admin/coding-bank`）：專家對抽樣的對話切點編碼，題庫可凍結版本，答案可整批上傳到 Google Drive。

## 開發

```powershell
cd frontend; npm install; npm run dev     # http://localhost:5173（連到正式的 Firebase 專案）
cd frontend; npm run build                # 型別檢查（vue-tsc）＋建置
cd functions; npm install
npm run deploy                            # 在專案根目錄執行：升版號 → 建置 → 部署 → commit 與 tag
npm run deploy -- --functions             # 強制連同 Functions 一起部署
npm run deploy -- --web-only              # 只部署網站與 Firestore 規則
```

- 前端的 Firebase 設定已內建在 `frontend/src/firebase/config.ts`，只有要接其他 Firebase 專案時才需要設定 `.env`，可參考 `.env.example`。
- 部署需要 Firebase CLI 登入，以及專案 `ai-mentor-web` 的權限。

## 文件

| 檔案 | 內容 |
|---|---|
| `CLAUDE.md` | 完整架構說明與開發慣例（繁中，最新） |
| `AGENTS.md` | 給 Codex 等程式代理的規則與指令 |
| `docs/HANDOFF.md` | 目前進度、已決定事項、未驗證項目與接續方法 |
| `docs/HANDOVER_LOG.md` | 2026-10 改版前的舊交接日誌，僅供歷史參考 |
