# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 最完整的現況說明在 `docs/HANDOVER_LOG.md`（2026-10-25 由前任 AI 撰寫：資料模型、互動流程、白板引擎、安全稽核、待辦）。`README.md` 部分過時（仍把 FastAPI 寫成 AI 引擎）。

## 指令

全部在 Windows PowerShell 5.1 下執行，串接用 `;`，不要用 `&&`。

```powershell
cd frontend; npm install
cd frontend; npm run dev       # http://localhost:5173（host: true，可用區網 IP 多裝置測試）
cd frontend; npm run build     # = vue-tsc && vite build，輸出 frontend/dist；型別檢查只靠這一步
cd functions; npm install

# 部署（在專案根目錄）
firebase deploy --only hosting,firestore:rules   # 最常用
firebase deploy --only storage
firebase deploy --only functions                 # 需 Blaze 方案
```

- 沒有 lint、沒有任何自動化測試。驗證方式＝`npm run build` 零錯誤＋用 2~3 個瀏覽器（含無痕）實測入會審核、AI 回覆、白板分享／關閉／踢出。
- Firebase 專案：`ai-mentor-web`；線上：https://ai-mentor-web.web.app

## 架構重點

- **無自有後端**：Vue 3 SPA 直接在瀏覽器呼叫 Gemini（`@google/generative-ai`）、Meshy、Tripo；Firestore 是唯一的即時同步匯流排。`backend/`（FastAPI）是遺留程式碼，前端沒有呼叫，不要改它來修功能。
- **Cloud Function** 只有 `functions/index.js` 的 `proxyGlb`（Hosting rewrite `/api/proxy`），用來繞過外部 GLB 的 CORS。
- **AI 由觸發者的瀏覽器執行**：`stores/room.ts` 的 `triggerMentorAgent` 決定是否呼叫（`@mentor` 強制；否則每 5 則訊息、8 秒冷卻、`isAnalyzing` 互斥；Strict 模式只回應 `@mentor`）→ `services/ai.ts` 的 `analyzeDialogueWithGemini` 回傳 JSON（`shouldIntervene / aiMessage / actionOptions / assetType / assetData`）→ 以 `senderUid: 'ai_mentor'` 寫回 messages。模型清單 `FLASH_CORE_MODELS` 依序 fallback。
- **路由為 Hash 模式**（`/#/room/room_123456`）；Room ID＝`room_${6位數PIN}`。
- **協作白板**（`components/CollaborativeWhiteboard.vue`，約 9.9k 行，Fabric.js **v7** API）有三條同步通道：
  - `rooms/{id}/cursors/{uid}`：高頻即時預覽（游標、liveStroke/liveShape/liveDrag/liveText/liveLock）
  - `rooms/{id}.whiteboardState`：共享 session 的權威 Fabric JSON（50ms debounce），他端 `watch` → `loadFromFirebase` 以物件 `id` 做 entity reconciliation（不是清空重載）
  - `rooms/{id}/messages/{assetId}`（`type: whiteboard_state`）：白板資產本體＋`isPrivate`，800ms 自動儲存
- 巨型檔案（白板元件、`MeetingRoomView.vue` 3.4k 行、`room.ts` 2k 行）請先 grep 函式名再用行號範圍讀；快速定位表見 HANDOVER_LOG §16.3。

## 常見陷阱（改動前必看）

1. Firestore 查詢前要 `await authStore.waitForAuthReady()`，否則 rules 回 `permission-denied` 會被誤判為「房間不存在」。
2. 白板 reconciliation 必須冪等：自己的 `syncToFirebase` 也會觸發自己的 `watch(whiteboardState)`；使用者拖曳／繪圖／編輯中要跳過。任何白板修改都要考慮多人最終收斂一致。
3. `emit('save-state', json, dataUrl, assetId, isPrivate)` 的 `isPrivate` 優先於元件內部狀態；改動時要一併檢查 `MeetingRoomView.handleSaveWhiteboardState`、`room.startWhiteboardSession`、`makeWhiteboardPrivate`。分享既有私人草稿要原地更新該訊息，不可複製。
4. `STICKY_NOTE_CONST_SIZE`（180）只能當初始尺寸，不能放進 `Math.max` 當下限。
5. Fabric v7 `enlivenObjects` 後圖片非同步載入，要等 `load` 再 `requestRenderAll()`。
6. `whiteboardState` 存在 room doc 內，受 Firestore 1 MiB 上限限制。
7. 修改 `firestore.rules` 時注意 HANDOVER_LOG §12 列出的 P0 問題（rooms 任何登入者可 update、`sharedApiKeys` 明文、Gemini key 會被打包進 bundle）。

## 專案慣例

- 溝通用繁體中文；**產品 UI 文字一律英文**（i18n 字串在 `src/i18n/index.ts`）。UX 參考標準是 Canva。
- 每次發佈更新 `frontend/src/App.vue` 第 16 行的版本號＋時間戳，格式 `vX.Y.Z (YYYY-MM-DD HH:mm:ss)`（目前停在過期的 v5.8.0）。
- Commit 訊息格式：`feat|fix(scope): 描述 (vX.Y.Z)`。
- 研究用途（預計送 IRB）：任何讓 AI 讀到使用者 Gmail／Google 帳號資料的改動都禁止；成員剖析（Team Dynamics）只供 AI 內部參考，不可原樣輸出到聊天。
- 本機 `.git` 不完整（缺 `refs/`，`git` 指令無法使用），且約 3 週的工作未 commit；需要版本控制前先和使用者確認如何從 remote `AIPoweredCollaborativeDesignPlatform/ai-mentor-platform` 修復。
