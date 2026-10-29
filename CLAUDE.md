# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 最完整的現況說明在 `docs/HANDOVER_LOG.md`（2026-10-25 由前任 AI 撰寫：資料模型、互動流程、白板引擎、安全稽核、待辦）。但寫於 P2 之前，AI／金鑰相關段落已過時，以本檔為準。`README.md` 同樣過時。

## 指令

全部在 Windows PowerShell 5.1 下執行，串接用 `;`，不要用 `&&`。

```powershell
cd frontend; npm install
cd frontend; npm run dev       # http://localhost:5173（host: true，可用區網 IP 多裝置測試）
cd frontend; npm run build     # = vue-tsc && vite build，輸出 frontend/dist；型別檢查只靠這一步
cd functions; npm install

# 部署（在專案根目錄）— 一律用這個，不要手動 firebase deploy
npm run deploy             # 版本 patch+1 → build → deploy hosting/rules/storage（functions 有變才部署）→ git commit + tag
npm run deploy -- --minor  # 或 --major；--functions 強制部署 functions
npm run deploy:dry         # 只 build 驗證，不部署、不改版本
```

- 右下角版本號與時間戳由 `vite.config.ts` 在 build 時注入（`__APP_VERSION__` = `frontend/package.json` version、`__BUILD_TIME__` = 台北時間），不要手改 `App.vue`。
- 存檔點：git tag `savepoint-0`（改版前的原始碼基準）；當時線上版的實際檔案備份在 `../_savepoints/savepoint-0/live-site/`。

- 沒有 lint、沒有任何自動化測試。驗證方式＝`npm run build` 零錯誤＋用 2~3 個瀏覽器（含無痕）實測入會審核、AI 回覆、白板分享／關閉／踢出。
- Firebase 專案：`ai-mentor-web`；本 repo 同時部署到 https://ai-mentor-design.web.app 與 https://ai-mentor-web.web.app（P5 起舊站 v5.8.0 被覆蓋，firebase.json `hosting` 為兩個 site 的陣列）

## 架構重點

- **AI 全在 Cloud Functions**（`functions/index.js` 入口，邏輯在 `functions/src/`）：前端只透過 `services/ai.ts` 的 `httpsCallable` 呼叫，不持有任何金鑰。金鑰為 Functions secrets（`ANTHROPIC_API_KEY`、`FAL_KEY`、`MESHY_API_KEY`、`TRIPO_API_KEY`，不用的可設 `none`）。Firestore 仍是唯一的即時同步匯流排。
  - `onRoomMessage`（messages 觸發）→ `src/engine.js` 的 `handleNewMessage`：每房一個決策者，計數存 `roomAi/{roomId}.state`；@mention 立即回覆，否則在停頓／達最多則數／停滯時檢查；非 proactive 或冷卻中的檢查以「影子判斷」只寫研究紀錄。Claude 呼叫在 `src/mentor.js`、`src/claude.js`，提示詞在 `src/prompts.js`（`PROMPT_VERSION`），呼叫紀錄 `src/log.js`。
  - 其他 callable：`mentorRespond`（重試）、`assignRoomProfile`、`adminDeleteRoom`（後台刪房＝標 `deletedAt`，資料保留；進行中須先結束）、`whiteboardVision`、`generateSvg`／`sketchToSvg`、`refineModel3D`（3D 生成在 engine 內；上色結果由伺服器發 AI 訊息）、`proxyGlb`（Hosting rewrite `/api/proxy`，只代抓 https 的 3D 模型網域）。AI 類 callable 一律先 `requireRoomMember`（房主／已核准參與者／觀察員）；瀏覽器不能發 AI 或系統訊息（改暱稱／頭貼走 `updateRoomProfile`、改房名走 `updateStudyRoomDetails`，由伺服器寫入並發通知）。
- **實驗條件設定檔**（`src/profiles.js`）：`aiProfiles/{id}` 由 `/#/admin`（`views/AdminView.vue`、`services/admin.ts`）編輯並版本化；指派時凍結快照到 `roomAi/{roomId}.profile`，之後修改不影響該房。`mode` = `none | reactive | proactive`；`none` 時前端完全隱藏 AI。`roomAi/*` 僅伺服器/管理者可讀，參與者只看 `rooms/{id}.ai`（`publicAiView`）。系統設定在 `src/config.js`。
- **角色**（`functions/src/roles.js`）：管理者＝固定帳號 bb900114@gmail.com；觀察員＝後台「系統設定」加入的 email，custom claim `role: 'observer'`（名單在 `roles/current`，僅伺服器）。瀏覽器登入後呼叫 `syncMyRole` 對齊 claim（`authStore.isAdmin／isObserver／waitForRole()`）。rules 的 `isObserver()`（含管理者）可讀所有房間、白板（含私人）、事件、上傳狀態、AI 紀錄。
  - 觀察員進房（`joinStudyRoom`）：participants 文件 `status: 'observer'`、`rooms.observerUids`；隱形、不計人數、唯讀，白板用 `LiveBoardViewer`（只聽不寫 presence）；匯出代號 O1…、事件 `role: observer`。加入頁可選「以參與者身分加入」，在該房參加過就一直是參與者。建房者在自己房間永遠是研究者 R。End／Reopen：研究者與管理者。
  - 房間文件只有成員／觀察員能讀（加入頁用 `peekStudyRoom`）；`session`、`ai`、`hostUid`、`observerUids` 只有 Functions 能寫；訪客登入 Google 後由 `claimGuestRooms`（驗證匿名 ID token）轉移 hostUid。參與者可改欄位見 rules `participantFields()`，前端新增寫入 rooms 的欄位時要一起改。
- **建房與 PIN**（`functions/src/rooms.js`）：房間只能由 `createStudyRoom` 建立（rules 禁止瀏覽器 create）；伺服器從未使用的 4 位數 PIN 隨機挑，登記在 `roomPins/{roomId}`（僅伺服器）。房間刪除後登記保留（`onRoomDeleted` 標 deletedAt），PIN 永不重用。管理者／觀察員可在首頁選條件、勾「Create as a participant」（`hostUid: ''`、`createdBy`，房間沒有研究者，建房者走加入流程，End／Reopen 由管理者在後台房間列操作）。後台 PIN 清單：`listRoomPins`。
- **Room store 是門面**：`stores/room.ts` 只組合 `stores/room/{session,messages,whiteboard,mentor}.ts`，元件一律透過 `useRoomStore()` 使用；`MeetingRoomView.vue` 只做編排，UI 拆在 `components/room/`，白板開關/私人公開狀態機在 `composables/useWhiteboardSession.ts`。
- AI 訊息以 `senderUid: 'ai_mentor'`／`ai_mentor_3d`／`system` 寫回 messages（engine 會忽略這些以免自我觸發）。`stores/room/mentor.ts` 只負責前端顯示與重試，不做觸發判斷。
- **路由為 Hash 模式**（`/#/room/room_123456`）；Room ID＝`room_${6位數PIN}`。
- **協作白板**（`components/CollaborativeWhiteboard.vue`，約 9.9k 行，Fabric.js **v7** API）有三條同步通道：
  - `rooms/{id}/cursors/{uid}`：高頻即時預覽（游標、liveStroke/liveShape/liveDrag/liveText/liveLock）
  - `rooms/{id}.whiteboardState`：共享 session 的權威 Fabric JSON（50ms debounce），他端 `watch` → `loadFromFirebase` 以物件 `id` 做 entity reconciliation（不是清空重載）
  - `rooms/{id}/messages/{assetId}`（`type: whiteboard_state`）：白板資產本體＋`isPrivate`，800ms 自動儲存
- `CollaborativeWhiteboard.vue`（約 9.9k 行，P3 將重寫）請先 grep 函式名再用行號範圍讀。HANDOVER_LOG §16.3 的行號對照表在 P1 重構後已失效。

## 常見陷阱（改動前必看）

1. Firestore 查詢前要 `await authStore.waitForAuthReady()`，否則 rules 回 `permission-denied` 會被誤判為「房間不存在」。
2. 白板 reconciliation 必須冪等：自己的 `syncToFirebase` 也會觸發自己的 `watch(whiteboardState)`；使用者拖曳／繪圖／編輯中要跳過。任何白板修改都要考慮多人最終收斂一致。
3. `emit('save-state', json, dataUrl, assetId, isPrivate)` 的 `isPrivate` 優先於元件內部狀態；改動時要一併檢查 `MeetingRoomView.handleSaveWhiteboardState`、`room.startWhiteboardSession`、`makeWhiteboardPrivate`。分享既有私人草稿要原地更新該訊息，不可複製。
4. `STICKY_NOTE_CONST_SIZE`（180）只能當初始尺寸，不能放進 `Math.max` 當下限。
5. Fabric v7 `enlivenObjects` 後圖片非同步載入，要等 `load` 再 `requestRenderAll()`。
6. `whiteboardState` 存在 room doc 內，受 Firestore 1 MiB 上限限制。
7. 修改 `firestore.rules` 時注意：rooms 的 update 依欄位白名單（`participantFields()`／`hostFields()`）；前端寫入新的 room 欄位前要先加進白名單，否則會 permission-denied。HANDOVER_LOG §12 的金鑰外洩問題已因 AI 移到 Functions 而解除。
8. `onRoomMessage` 會等待停頓／停滯（timeout 540s、concurrency 80），改 engine 時要保持 `lockUntil` 鎖與冪等，避免同房重複回覆。

## 專案慣例

- 溝通用繁體中文。**UI 文字一律放字典**：`frontend/src/i18n/en.ts`（key 來源）與 `zh-TW.ts`（型別檢查必須有每個 key），元件用 `t('key', { 參數 })`；不要在 .vue 寫死文字。預設語言繁中。UX 參考標準是 Canva。
- **語言規則（P6）**：房間語言由設定檔 `language` 決定（指派時寫入 `rooms.language`，開場後不再變）；房內與加入頁介面、AI 回覆、伺服器系統訊息（`functions/src/i18n.js`）、同意書（`config/system.consentText`＝英文、`consentTextZh`＝中文）都跟房間語言。房外頁面與後台用右上角 `LocaleSwitch`（存在瀏覽器）。設定檔的開場文字／任務說明是 `{ 'zh-TW', en }`（舊設定檔的字串兩種語言都用）。
- **日夜主題（P7）**：`tailwind.config.js` 把所有色階接到 `src/style.css` 的 CSS 變數；元件照舊寫「深色設計」的 class（slate-950 底、slate-100 字），日間自動反轉。只用 slate（中性灰）、sky（＝唯一強調藍；indigo／violet 等也對應到藍）、amber（警告）、emerald（成功）、rose（錯誤）。最深文字色用 `text-ink`，`text-white` 只用在實心彩色按鈕上。不要用漸層、毛玻璃、彩色陰影、裝飾 emoji。切換：`src/theme.ts`＋`ThemeSwitch.vue`，`index.html` 在載入前套用；切換時用 View Transition 整頁交叉淡化（期間關掉元件自己的 transition），不要再對個別元素加顏色過渡。白板畫布固定淺色（不跟主題）。首頁／我的房間／後台右上角一律用 `components/PageNav.vue`（頁面自己的按鈕放 slot，class `page-nav-btn`）。日夜都不變的強調塊（如首頁建立房間）用 `sky-500/600`＋`text-white`（這兩階在兩種主題同值）。
- Commit 訊息格式：`feat|fix(scope): 描述`；發佈 commit 由 deploy 腳本自動產生（`release: vX.Y.Z`）。
- 研究用途（預計送 IRB）：任何讓 AI 讀到使用者 Gmail／Google 帳號資料的改動都禁止；成員剖析（Team Dynamics）只供 AI 內部參考，不可原樣輸出到聊天。
- 只在本機 commit，未經使用者同意不 push 到 remote `AIPoweredCollaborativeDesignPlatform/ai-mentor-platform`。
