# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 目前進度、未驗證項目與接續方法見 `docs/HANDOFF.md`；給 Codex 等代理的規則見 `AGENTS.md`。
>
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

- **AI 全在 Cloud Functions**（`functions/index.js` 入口，邏輯在 `functions/src/`）：前端只透過 `services/ai.ts` 的 `httpsCallable` 呼叫，不持有任何金鑰。金鑰為 Functions secrets（`ANTHROPIC_API_KEY`、`FAL_KEY`、`MESHY_API_KEY`、`TRIPO_API_KEY`，不用的可設 `none`）；後台「系統設定」可覆寫（`privateConfig/apiKeys`，僅伺服器，`src/apiKeys.js` 的 `resolveKeys`，30 秒快取）並一鍵測試。新增讀金鑰的程式要走 `engineSecrets()`／`anthropicKey()`，不要直接 `.value()`。Firestore 仍是唯一的即時同步匯流排。
  - `onRoomMessage`（messages 觸發）→ `src/engine.js` 的 `handleNewMessage`：每房一個決策者，計數存 `roomAi/{roomId}.state`；@mention 立即回覆，否則在停頓／達最多則數／停滯時檢查；非 proactive 的檢查以「影子判斷」只寫研究紀錄。Claude 呼叫在 `src/mentor.js`、`src/claude.js`，提示詞在 `src/prompts.js`：全部拆成 `PROMPT_DEFAULTS` 區塊（`{{變數}}` 於呼叫時帶入），設定檔 `prompts` 只存改過的區塊、隨設定檔凍結進房間；語氣 `style.casualness`（每級附示範句）／`maxSentences`、`persona`（優先於預設語氣）、`expertise` 也在設定檔；後台可用一句話讓 AI 填這些欄位（`draftAiProfile`）。改內建文字要升 `PROMPT_VERSION`，呼叫紀錄 `src/log.js`。
  - **判斷筆記（v12）**：`assessment` 只讓 AI 用自己的話寫 `observation`／`teamNeed`／`decision`，另有 `stage`（雙鑽石，供進度顯示與階段引導）與 `milestones`。**不要把研究編碼表的標籤（thinking_mode、collaboration_situation、intervention_level、策略名稱等）放進 AI 的判斷**：人工編碼要獨立於 AI 的框架，否則是先射箭再畫靶。何時開口＝模型的 `shouldIntervene`＋冷卻時間。提示詞只放目前雙鑽石階段的「該做／不該做／離開訊號」（`stageDiscover` 等區塊）。
  - **雙鑽石進度**：engine 依每次判斷寫 `rooms/{id}.progress`（unclear 時維持原階段，節點只會亮起；`model3d`＝房內出現過 3D 模型；`history` 記每次換階段、`reachedAt` 記節點達成時間，聊天往上捲時圖示顯示畫面中段訊息當時的階段），聊天區頂端 `components/room/DesignProgress.vue` 顯示，無 AI 條件不顯示也不寫入。
  - **建議卡片**：AI 輸出 `offer: true` 的訊息帶 `suggestion: { responses }`，參與者按「接受建議／先不用」寫入 `suggestion.responses.{uid}`（rules 白名單含 `suggestion`、`collage`）；第一個接受由 `onPollVote` 觸發 `handleSuggestionAnswer` 讓 AI 執行，拒絕只留在卡片上供下次判斷。
  - **設計題目**：設定檔 `session.taskMode` ＝ `assigned`（用任務說明，留白＝開放）或 `ai_suggest`（開場 `sessionKickoffTopics` 回 JSON，`session.js` 把 4 個題目變成投票）。
  - **AI 自動命名**：建房沒給名稱時 `rooms.nameIsDefault: true`；主動條件下 AI 在方向確定後於 JSON 加 `roomTitle`，`rooms.js autoRenameRoom` 只改一次（`autoNamedAt`）並發帶 `metadata.roomRename` 的系統訊息，聊天中的「改回原本的名稱」走 `revertRoomName`。手動改名會把 `nameIsDefault` 設為 false。
  - **發想草圖（fal.ai，`src/images.js`）**：模組 `modules.enableSketch`。AI 資產 `sketch`（`assetData.sketches[].prompt`，伺服器統一加上鉛筆草圖風格，模型 `config.sketchModel`，預設 flux/dev）；白板選取手繪按「草圖／渲染」→ `sketchFromBoard`（圖生圖 `config.sketchRefineModel`，產生乾淨草圖＋渲染圖，以 AI 訊息貼到聊天）；聊天中上傳的圖片（草圖或照片）下方「延伸成發想草圖」與草圖預覽的「以這張延伸更多草圖」→ `sketchFromImage`（接受聊天上傳的 data URL 或本專案 Storage 網址，產生 3 張延伸草圖）。圖生圖之前都先經 `src/sketchBrief.js`：Claude（`models.svg`）看圖＋任務、記憶摘要、最近 30 則對話，寫出貼合主題的英文描述再交給 fal（失敗時退回通用提示詞）；strength 0.7–0.82 以保留原圖構圖。
  - **圖片轉 3D（`src/imageTo3d.js`）**：草圖／照片 → sketchBrief → fal 產生乾淨渲染圖 → Meshy image-to-3D（`openapi/v1/image-to-3d`，依 `config.meshy.imageTexture`（預設 true）同步上色；不上色的模型帶 `refinable: false`，不顯示上色按鈕）；Tripo 無圖片路徑，退回以同一描述做文字轉 3D。入口：聊天圖片下方與草圖預覽的「依這張建立 3D」（`model3DFromImage`），以及 AI 的 `parametric_3d` 帶 `fromImage`（逐字稿中圖片訊息標 `[image id=...]`）。聊天中用與意象圖相同的拼貼卡片（`MoodBoardViewer kind="sketch"`），預覽視窗的「放到白板」經 `WhiteboardBoard.insertImageUrl` 放進開著的白板（沒開就開新草稿）。
  - **意象圖（moodboard）**：4–6 張圖、每張有 `size`（large／medium／small），`MoodBoardViewer.vue` 以拼貼方式擺放（非網格），參與者可拖曳／縮放，位置以 `collage.{圖片序號}` 存在訊息上、全房共用。
  - 其他 callable：`mentorRespond`（重試）、`assignRoomProfile`、`adminDeleteRoom`（後台刪房＝標 `deletedAt`，資料保留；進行中須先結束）、`whiteboardVision`、`generateSvg`／`sketchToSvg`、`refineModel3D`（3D 生成在 engine 內；上色結果由伺服器發 AI 訊息）、`proxyGlb`（Hosting rewrite `/api/proxy`，只代抓 https 的 3D 模型網域）。AI 類 callable 一律先 `requireRoomMember`（房主／已核准參與者／觀察員）；瀏覽器不能發 AI 或系統訊息（改暱稱／頭貼走 `updateRoomProfile`、改房名走 `updateStudyRoomDetails`，由伺服器寫入並發通知）。
- **實驗條件設定檔**（`src/profiles.js`）：`aiProfiles/{id}` 由 `/#/admin`（`views/AdminView.vue`、`services/admin.ts`）編輯並版本化；指派時凍結快照到 `roomAi/{roomId}.profile`，之後修改不影響該房。`mode` = `none | reactive | proactive`；`none` 時前端完全隱藏 AI。`roomAi/*` 僅伺服器/管理者可讀，參與者只看 `rooms/{id}.ai`（`publicAiView`）。系統設定在 `src/config.js`。
- **角色**（`functions/src/roles.js`）：主管理者＝固定帳號 bb900114@gmail.com；主管理者可在後台「系統設定」加其他管理者（claim `role: 'admin'`，同權限但不能管理管理者名單；移除時撤銷其登入）；觀察員＝後台「系統設定」加入的 email，custom claim `role: 'observer'`（名單在 `roles/current`，僅伺服器）。瀏覽器登入後呼叫 `syncMyRole` 對齊 claim（`authStore.isAdmin／isObserver／waitForRole()`）。rules 的 `isObserver()`（含管理者）可讀所有房間、白板（含私人）、事件、上傳狀態、AI 紀錄。
  - 觀察員進房（`joinStudyRoom`）：participants 文件 `status: 'observer'`、`rooms.observerUids`；隱形、不計人數、唯讀，白板用 `LiveBoardViewer`（只聽不寫 presence）；匯出代號 O1…、事件 `role: observer`。加入頁可選「以參與者身分加入」，在該房參加過就一直是參與者。後台房間指派的「進入（唯讀）」走 `/waiting/:id?as=observer` → `joinStudyRoom({ viewOnly })`：已結束的房間也能進，曾參加過的人保留參與者紀錄但前端以 `roomStore.viewOnly`（網址 `?view=readonly`）顯示為觀察者、不寫在線狀態；房內可「切換為參與者」，左上角返回回到後台。建房者在自己房間永遠是研究者 R。End／Reopen：研究者與管理者。
  - 房間文件只有成員／觀察員能讀（加入頁用 `peekStudyRoom`）；`session`、`ai`、`hostUid`、`observerUids` 只有 Functions 能寫；訪客登入 Google 後由 `claimGuestRooms`（驗證匿名 ID token）轉移 hostUid。參與者可改欄位見 rules `participantFields()`，前端新增寫入 rooms 的欄位時要一起改。
- **建房與 PIN**（`functions/src/rooms.js`）：房間只能由 `createStudyRoom` 建立（rules 禁止瀏覽器 create）；伺服器從未使用的 4 位數 PIN 隨機挑，登記在 `roomPins/{roomId}`（僅伺服器）。房間刪除後登記保留（`onRoomDeleted` 標 deletedAt），PIN 永不重用。一般使用者建房一律以參與者身分加入（伺服器強制；`createdBy` 可改房名／頭貼，前端 `roomStore.canEditRoomDetails`）。管理者／觀察員可在首頁選條件、勾「Create as a participant」（`hostUid: ''`、`createdBy`，房間沒有研究者，建房者走加入流程，End 由管理者在後台房間列操作；Reopen 也開放給該房已核准的參與者，房內結束橫幅有按鈕）。後台 PIN 清單：`listRoomPins`。
- **已移除的舊機制**（不要加回）：前端 AI 設定 `mentorStore`／`mentorConfig`（AI 只讀伺服器設定檔）、入會申請／核准（`pending`，入會一律由 `joinStudyRoom` 核准）、v1 白板欄位與 `cursors` 的寫入權限。participants 文件一律由 Functions 建立，瀏覽器只能改自己的在線／白板欄位。
- **Room store 是門面**：`stores/room.ts` 只組合 `stores/room/{session,messages,whiteboard,mentor}.ts`，元件一律透過 `useRoomStore()` 使用；`MeetingRoomView.vue` 只做編排，UI 拆在 `components/room/`，白板開關/私人公開狀態機在 `composables/useWhiteboardSession.ts`。
- AI 訊息以 `senderUid: 'ai_mentor'`／`ai_mentor_3d`／`system` 寫回 messages（engine 會忽略這些以免自我觸發）。`stores/room/mentor.ts` 只負責前端顯示與重試，不做觸發判斷。
- **房內暱稱 vs 帳號名稱**：`authStore.displayName` 是房內暱稱（進房時被參與者紀錄覆寫）；房外頁面顯示 Google 帳號名稱一律用 `authStore.accountName`。重播以每次重新開始切成多段（`segmentsOf`），每段停在該段最後一筆聊天／白板活動（`lastActivityAt`），之後的離開／結束事件只留在事件清單。重播頁的「AI 背景思考」讀 `aiLogs`（`where roomId ==`，前端排序、免複合索引；`utils/replay.ts` 的 `loadAiThoughts`），列出每次判斷（發言／沉默／影子判斷）與 AI 的判斷筆記，跟著播放時間走。後台分頁存在網址 `?tab=`，清單先顯示瀏覽器快取（`ai_mentor_admin_cache`）再背景更新。
- **路由為 Hash 模式**（`/#/room/room_123456`）；Room ID＝`room_${6位數PIN}`。
- **協作白板 v2**（P3 重寫，設計見 `../_claude工作區/P3白板設計.md`；Fabric.js **v7** API）：UI 在 `components/whiteboard/WhiteboardBoard.vue`（觀察員／重播用唯讀的 `LiveBoardViewer.vue`、`admin/BoardReplayCanvas.vue`），邏輯拆在 `src/whiteboard/*.ts`。
  - 身分與私人旗標＝聊天卡片 `rooms/{id}/messages/{boardId}`（`type: whiteboard_state`，`stores/room/whiteboard.ts`）；沒有全房共用的「live session」，公開白板都可多人編輯，私人白板只有建立者能開。
  - 物件逐一存在 `rooms/{id}/boards/{boardId}/objects/{objId}`（`{ z, fabric, updatedBy, updatedAt }`，`whiteboard/sync.ts`），每個物件有穩定 `id`（`whiteboard/objects.ts`）；游標與進行中的筆畫／拖曳在同層 `presence/{uid}`（15 秒過期）。
  - 其他模組：`history.ts`（復原／重做以物件快照為單位）、`connectors.ts`、`quickshape.ts`（停住轉規則形狀）、`touch.ts`（雙指縮放／平移）、`exporting.ts`、`legacy.ts`（v1 單一 JSON 白板轉 v2）。
  - `rooms/{id}.whiteboardState` 與 HANDOVER_LOG 的白板章節（`CollaborativeWhiteboard.vue`）都是 v1 遺留，已不使用。

## 常見陷阱（改動前必看）

1. Firestore 查詢前要 `await authStore.waitForAuthReady()`，否則 rules 回 `permission-denied` 會被誤判為「房間不存在」。
2. 白板遠端變更的套用必須冪等：自己的寫入也會從 `onSnapshot` 回來；正在拖曳／繪圖／編輯的物件要跳過。任何白板修改都要考慮多人最終收斂一致。分享既有私人草稿要原地更新該卡片訊息，不可複製。
3. Fabric v7 `enlivenObjects` 後圖片非同步載入，要等 `load` 再 `requestRenderAll()`。
4. 單一白板物件文件仍受 Firestore 1 MiB 上限（大圖片要先壓縮或存 Storage）。
5. 修改 `firestore.rules` 時注意：rooms 的 update 依欄位白名單（`participantFields()`／`hostFields()`）；前端寫入新的 room 欄位前要先加進白名單，否則會 permission-denied。HANDOVER_LOG §12 的金鑰外洩問題已因 AI 移到 Functions 而解除。
6. `onRoomMessage` 會等待停頓／停滯（timeout 540s、concurrency 80），改 engine 時要保持 `lockUntil` 鎖與冪等，避免同房重複回覆。

## 專案慣例

- 溝通用繁體中文。**UI 文字一律放字典**：`frontend/src/i18n/en.ts`（key 來源）與 `zh-TW.ts`（型別檢查必須有每個 key），元件用 `t('key', { 參數 })`；不要在 .vue 寫死文字。預設語言繁中。UX 參考標準是 Canva。
- **語言規則（P6）**：房間語言由設定檔 `language` 決定（指派時寫入 `rooms.language`，開場後不再變）；房內與加入頁介面、AI 回覆、伺服器系統訊息（`functions/src/i18n.js`）、同意書（`config/system.consentText`＝英文、`consentTextZh`＝中文）都跟房間語言。房外頁面與後台用右上角 `LocaleSwitch`（存在瀏覽器）。設定檔的開場文字／任務說明是 `{ 'zh-TW', en }`（舊設定檔的字串兩種語言都用）。
- **日夜主題（P7）**：`tailwind.config.js` 把所有色階接到 `src/style.css` 的 CSS 變數；元件照舊寫「深色設計」的 class（slate-950 底、slate-100 字），日間自動反轉。只用 slate（中性灰）、sky（＝唯一強調藍；indigo／violet 等也對應到藍）、amber（警告）、emerald（成功）、rose（錯誤）。最深文字色用 `text-ink`，`text-white` 只用在實心彩色按鈕上。不要用漸層、毛玻璃、彩色陰影、裝飾 emoji。切換：`src/theme.ts`＋`ThemeSwitch.vue`，`index.html` 在載入前套用；切換時用 View Transition 整頁交叉淡化（期間關掉元件自己的 transition），不要再對個別元素加顏色過渡。白板畫布固定淺色（不跟主題）。首頁／我的房間／後台右上角一律用 `components/PageNav.vue`（頁面自己的按鈕放 slot，class `page-nav-btn`）。日夜都不變的強調塊（如首頁建立房間）用 `sky-500/600`＋`text-white`（這兩階在兩種主題同值）。
- **手機／平板（響應式）**：斷點用 Tailwind 預設（sm 640／md 768／lg 1024）加自訂 `xs`（400px）；觸控裝置用自訂變體 `pointer-coarse:` 放大點擊範圍；瀏海／底部橫條用 `style.css` 的 `pt-safe`／`pb-safe`／`px-safe`（`index.html` 已設 `viewport-fit=cover`），觸控裝置的輸入框強制 16px，避免 iOS 自動放大。會議室在手機與直向平板（`composables/useStackedLayout.ts`，方向依螢幕而非視窗判斷，鍵盤彈出不會切版面）以「聊天｜白板」分頁切換，橫向平板與桌機左右並排（分隔線用 pointer 事件，可用手指拖）。白板依自身寬度（< 640px）把工具列移到底部。沒有 hover 的地方：聊天訊息長按開表情／回覆列（`composables/useLongPress.ts`），房內頂列在手機把邀請／音效／主題收進「⋯」選單。
- Commit 訊息格式：`feat|fix(scope): 描述`；發佈 commit 由 deploy 腳本自動產生（`release: vX.Y.Z`）。
- 研究用途（預計送 IRB）：任何讓 AI 讀到使用者 Gmail／Google 帳號資料的改動都禁止；成員剖析（Team Dynamics）只供 AI 內部參考，不可原樣輸出到聊天。
- 只在本機 commit，未經使用者同意不 push 到 remote `AIPoweredCollaborativeDesignPlatform/ai-mentor-platform`。
