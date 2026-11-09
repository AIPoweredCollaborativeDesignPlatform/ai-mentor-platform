## Coding load performance fix (2026-11-09)
- New staff-only getCodingBank callable returns field-projected room/messages/event data and caller-only progress in one response. No LLM calls, no persistent cache, fresh reads on each sync.
- Rooms load with bounded concurrency (4); progress is read via Admin SDK getAll with status field masks. AI prompts, raw model results and board object blobs are excluded.
- Client preserves the four-source round-robin builder, skips known completed cutoffs before per-question reads, and still reloads the actual selected answer/revision before editing.
- Tests: scripts/test-coding-bank.mjs, scripts/test-coding-sampling.mjs; full frontend build and backend import.
- Deploy: node scripts/deploy.mjs --coding-bank-only. Only the new getCodingBank function, hosting and Firestore rules are published.

## Annotation sampling update (2026-11-09)
Deployment status: v7.8.35 deployed successfully on 2026-11-09 (hosting, Firestore rules, prepareCodingSemantic callable). IAM blockers resolved. Build, sampling tests, backend syntax/index import passed. Live UI verified: 5 rooms / 88 eligible human-text cutoffs, human-only context and explicit future-message labels. User explicitly approved transmitting human room text to Anthropic/Claude and consuming platform AI quota after automatic review requested consent. First semantic analysis completed successfully in the live admin UI; status confirmed question bank updated. No real expert answers were created or changed for testing. Source refs deduplicate anchors so semantic extraction does not necessarily increase total question count. GitHub has NOT been pushed for this release.

- Four source round-robin, shuffled within sources, deduplicated by room/message ID. Empty sources skipped; not a fixed 25% stratified sample.
- Intervention anchors: aiLogs mentor + visible + shouldIntervene, anchored via triggerMessageId (never completion timestamp). Shadow/silent/error records excluded.
- Tool anchors: room events / legacy tool cards, latest human text at or before event; no preceding human means no candidate.
- Semantic generation: admin-only prepareCodingSemantic callable, batches of 30 targets with 5-message context, cached by input/model/detector version. Explicit researcher button uses AI budget. Results never feed live Mentor or autofill expert labels.
- Context: target plus up to 5 human text messages each side. Later messages marked as future information. Phase two includes only its chosen AI reply.
- Existing answer/source IDs preserved. New answers record event refs and context policy; resubmissions record viewContext. New policy changes what experts see; do not treat old/new judgments as identical experimental conditions.
- Test: node scripts/test-coding-sampling.mjs (Node 24; requires TypeScript stripping). Build: vue-tsc + vite runner.
- Deploy only new callable plus hosting/rules: node scripts/deploy.mjs --coding-only. Preserves full-functions hash so unrelated backend changes are not falsely marked deployed.

# 交接摘要與執行指南（2026-11-05，v7.8.25）

給接手的人或 AI 代理（Codex、Claude Code）：照本文件就能接續實作。

架構細節以 `CLAUDE.md` 為準，代理規則見 `AGENTS.md`；本文件只記錄進度、決策、未驗證項目與接續方法。

## 1. 研究背景

- 雙人（或小組）遠端協作做產品設計，任務預設 60 分鐘。
  - 例題：可變形的模組化家具，需交付概念說明、草圖或圖片、3D 模型與設計演進紀錄。
- 實驗比較 AI 的兩種介入方式：
  - Reactive：只在被 @ 時回應。
  - Proactive：依對話主動介入。
  - 兩組都有 AI，也有「無 AI」條件可用。
- 兩篇論文的方向：
  - Paper A（DIS 2027）：AI 何時介入、介入是幫助還是干擾、對自主性的影響。
  - Paper B（IASDR 2027）：多模態的共同表徵（文字、圖片、白板、3D）。
- 研究者事後會用自己的編碼表對聊天內容貼標籤，包括設計階段、思考模式、協作狀態、FBS、Linkography 與 AI 策略。
  - AI 的即時判斷刻意不使用這些標籤，以免循環論證。

## 2. 系統總覽

```
瀏覽器（Vue 3）── Firestore（即時同步）── Cloud Functions（全部 AI）
                                         ├─ Claude：導師判斷、記憶、視覺、SVG、草圖描述、設定檔填寫
                                         ├─ fal.ai：意象圖、文字轉草圖、圖生圖（草圖／渲染）
                                         └─ Meshy：文字轉 3D、圖片轉 3D（Tripo 為備選）
```

### 後端模組（`functions/src/`）

| 檔案 | 職責 |
|---|---|
| `engine.js` | 每房一個決策者：計數、停頓／停滯觸發、冷卻、鎖、發 AI 訊息，以及寫入 `rooms.progress`（雙鑽石）、建議卡片、3D 排程、自動命名 |
| `mentor.js` | 一次導師判斷：組提示詞、呼叫 Claude、產生意象圖與草圖、寫研究紀錄；記憶更新 |
| `prompts.js` | 所有內建提示詞區塊（`PROMPT_DEFAULTS`）、逐字稿（圖片訊息標 `[image id=...]`）、語氣示範句、雙鑽石階段指引；另有草圖描述與設定檔填寫的提示詞 |
| `session.js` | 實驗流程：等人、開場（`taskMode`：指派題目或 AI 出 4 題投票）、提醒、時間到、結束與重開；入房 `joinRoom`（含唯讀 `viewOnly`） |
| `rooms.js` | 建房與 PIN、改名、AI 自動命名 `autoRenameRoom`／`revertAutoRoomName` |
| `images.js` | fal 文字轉圖與圖生圖；`generateSketches`、`refineSketch`、`sketchVariations`、`renderFromImage` |
| `sketchBrief.js` | 圖生圖之前，Claude 看圖並讀對話，寫出貼合主題的英文描述 |
| `imageTo3d.js` | 草圖或照片轉 3D：`sketchBrief` → fal 渲染圖 → Meshy 圖片轉 3D |
| `mesh3d.js` | Meshy 文字轉 3D 與上色、圖片轉 3D（`meshyImageTo3D`）、Tripo |
| `profiles.js` | 實驗條件設定檔的預設值，以及參與者可見的 `publicAiView` |
| `config.js` | 系統設定預設值：模型、Meshy 參數、草圖模型 |
| `log.js`、`events.js` | `aiLogs` 研究紀錄、房間事件紀錄 |

`functions/index.js` 是所有 callable 與觸發器的入口。下表列出近期新增的入口：

| 入口 | 用途 |
|---|---|
| `draftAiProfile` | 一句話讓 AI 填設定檔（固定用 Sonnet 5.5、effort medium） |
| `sketchFromBoard` | 白板手繪轉草圖與渲染圖 |
| `sketchFromImage` | 圖片延伸出 3 張草圖 |
| `model3DFromImage` | 圖片轉 3D |
| `revertRoomName` | 改回 AI 自動命名之前的房名 |
| `onPollVote` | 投票結果與建議卡片的「接受」 |

### 前端重點

| 位置 | 內容 |
|---|---|
| `views/MeetingRoomView.vue` | 只做編排 |
| `components/room/*` | 房內各元件，包括 `DesignProgress.vue`（雙鑽石圖） |
| `stores/room.ts` | 房間狀態的門面，實作在 `stores/room/{session,messages,whiteboard,mentor}.ts` |
| `components/MoodBoardViewer.vue` | 意象圖與草圖共用的拼貼檢視，可拖曳與縮放 |
| `components/whiteboard/WhiteboardBoard.vue` | 白板；Fabric v7，同步邏輯在 `src/whiteboard/*.ts` |
| `views/AdminView.vue`、`components/admin/ProfileEditor.vue` | 後台與設定檔編輯 |
| `views/ReplayView.vue` | 重播，含「AI 背景思考」 |

## 3. 這一輪完成的功能（v7.8.12 → v7.8.25）

1. **AI 判斷改用 AI 自己的筆記**（提示詞 v12 起）
   - `assessment` 只有 `observation`、`teamNeed`、`decision`、`stage`、`milestones`、`participants`。
   - 何時開口由 `shouldIntervene` 加上冷卻時間決定。
2. **雙鑽石**
   - 每次判斷都寫入 `rooms/{id}.progress`，欄位有 `stage`、`milestones`、`history`、`reachedAt`。
   - 提示詞只放目前階段的「該做／不該做／離開訊號」。
   - 房內圖示顯示在聊天區左側空白處，只在寬螢幕出現，不能反白。
   - 往上捲動聊天時，圖示改顯示畫面中段那則訊息當時的階段。
3. **建議卡片**：AI 輸出 `offer: true` 時，訊息會附「接受建議／先不用」按鈕；有人接受，AI 就接著執行。
4. **人設**
   - 人設優先於預設語氣；內建文字已拿掉「AI 成員／導師」這類寫死的身分（v14）。
   - 隨性程度每一級附示範句，並新增「專業能力」欄位。
   - 「AI 幫我填」用一句話填寫名稱、人設、專業、語氣、開場、題目，並改寫角色與開場等提示詞區塊。
     - 只保留 `{{變數}}` 完全一致的改寫。
     - 中文內容強制使用全形標點。
5. **設計題目模式**：`session.taskMode` ＝ `assigned` 或 `ai_suggest`。
6. **AI 自動命名**：沒有命名的房間，在討論方向確定後由 AI 命名一次；聊天中有「改回原本的名稱」按鈕。
7. **意象圖與草圖**（fal）
   - 文字轉草圖（AI 資產 `sketch`）。
   - 白板手繪轉乾淨草圖與渲染圖。
   - 上傳的圖片或 AI 的草圖可延伸出 3 張新草圖。
   - 拼貼可多人拖曳排列；可「放到白板」。
   - 圖生圖之前一律先經過 `sketchBrief`，讓結果貼合討論主題。
8. **圖片轉 3D**
   - 流程：草圖 → 渲染圖 → Meshy 圖片轉 3D。
   - 模型下方顯示原圖、渲染圖與模型描述。
   - 後台開關「依草圖／照片建立的模型直接上色」預設開啟：上色 30 點、不上色 20 點；不上色的模型之後可按「上色」（Meshy Retexture，加 10 點）。
9. **後台**
   - 房間卡片可「進入（唯讀）」：已結束的房間也能進，返回會回到後台，房內可切換為參與者。
   - 批次刪除只在卡片旁加勾選框，失敗時顯示伺服器回傳的原因。
   - 新增草圖模型設定。
10. **重播**：「AI 背景思考」逐筆列出判斷（發言、沉默、影子判斷），也列出 3D 與草圖的呼叫和錯誤。
11. **清理**
    - 刪除舊的前端 AI 設定與入會申請流程；收緊 Firestore 規則。
    - `@` 改用後台指定的 AI 名稱。
    - 根網址改為不快取：`firebase.json` 的 `{/,**/index.html}`。

## 4. 已驗證與未驗證

已驗證：
- 每次改動都通過 `npm run build`、`node --check` 與 import 測試。
- 拼貼的拖曳與縮放，在本機測試頁檢查過桌機與手機寬度。
- 使用者已實測：
  - 上傳圖片後延伸出草圖：可用。
  - Meshy 圖片轉 3D：可用（金鑰換新之後）。

尚未在真實房間驗證，接手時請優先實測：

| 項目 | 驗證方法 |
|---|---|
| Firestore 規則收緊 | 兩個瀏覽器實測：入房、聊天、表情、投票、建議卡片、拼貼拖曳、白板、改暱稱、踢人、靜音，都不應出現 permission-denied |
| 唯讀入房 | 已結束的房間、曾以參與者身分參加過的房間、重新整理後是否仍唯讀、切換為參與者 |
| 建議卡片 | 接受後 AI 是否執行；拒絕後 AI 不再提同一件事 |
| 雙鑽石 | 部署後新產生的 `history` 是否寫入；捲動聊天時圖示是否跟著變 |
| AI 自動命名與還原 | 建一個不填名稱的 Proactive 房間，等討論方向確定後檢查 |
| `ai_suggest` 開場 | 4 個題目是否以投票方式出現；投票結束後 AI 是否接續 |
| 「AI 幫我填」 | 霸道總裁這類角色在房內是否真的入戲；被改寫的區塊有沒有被丟棄 |
| 白板手繪轉草圖、文字轉草圖、AI 用 `fromImage` 建 3D | 實際產生一次，看結果與研究紀錄 |
| 後台刪房 | 之前「刪了重整又出現」的根本原因還沒確認；現在失敗時會顯示原因，請記下該訊息 |

## 5. 已決定的事（不要推翻）

- AI 的判斷不使用研究編碼表的標籤，但保留雙鑽石階段判斷，供顯示與階段引導使用。
- 雙鑽石圖示在 Reactive 與 Proactive 兩組都顯示；無 AI 條件不顯示，也不寫入。
- AI 自動命名只在 Proactive 條件下進行。
- 「AI 幫我填」固定使用 `claude-sonnet-5-5`、effort medium，與導師模型分開。
- 圖片轉 3D 預設上色，後台可以關閉。
- 只在本機 commit；推到遠端需要擁有者同意。部署由擁有者執行 `npm run deploy`。

## 6. 待辦與建議的下一步

1. 完成第 4 節的實測清單；特別是 Firestore 規則，有問題時先檢查 `participantFields()` 與訊息的 `hasOnly` 白名單。
2. 評分工具：在重播頁讓兩位評分者對每則 AI 發言打 1–5 分，共 7 個面向，資料存進 Firestore，方便計算評分者一致性。這是擱置中的需求。
3. 重播頁顯示建議卡片上誰接受、誰拒絕（資料已在 `messages.suggestion.responses`）。
4. 若導師模型 Haiku 撐不住角色，可評估把 `config.models.mentor` 換成 Sonnet。換之前要確認研究設計允許，而且研究期間模型要固定。
5. 後台費用估算還沒納入草圖（fal）與圖片轉 3D（30 點）。

## 7. 如何接續

```powershell
git clone https://github.com/AIPoweredCollaborativeDesignPlatform/ai-mentor-platform.git
cd ai-mentor-platform/frontend; npm install
cd ../functions; npm install
cd ../frontend; npm run dev     # 本機前端連的是正式的 Firebase 專案 ai-mentor-web
```

- 部署前需要 Firebase CLI 登入，以及專案 `ai-mentor-web` 的權限。
- Secrets（`ANTHROPIC_API_KEY`、`FAL_KEY`、`MESHY_API_KEY`、`TRIPO_API_KEY`）存在 Functions secrets；也可以在後台「系統設定」覆寫並測試。
- 修改提示詞時：
  1. 改 `functions/src/prompts.js`。
  2. 升 `PROMPT_VERSION`。
  3. 新增的區塊要同時加進：
     - `PROMPT_PLACEHOLDERS`；
     - 前端 `ProfileEditor.vue` 的 `PROMPT_BLOCKS`；
     - 兩份字典的 `pp.*` 標籤。
- 新增 AI 資產類型時要改這幾處：
  1. `prompts.js` 的 `outputFormat` 與規則。
  2. `mentor.js` 的 `allowed`，以及產生資產的步驟。
  3. `profiles.js` 的模組開關與 `publicAiView`。
  4. 前端 `ChatMessage.vue` 的呈現，以及 `ReplayView.vue` 的 `ASSET_KEYS`。
- 新增可寫入的 Firestore 欄位時：先改 `firestore.rules`，部署時要包含 rules。`npm run deploy` 會自動部署。
