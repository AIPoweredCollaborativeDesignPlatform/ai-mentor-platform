# AI Mentor 協作平台 - 團隊 AI 規範 (Team Rules)

本專案為融合 Google AI 生態與 GCA（Group Conversational Agent）理論的群體對話中介平台。團隊成員在 Antigravity 進行協同開發時，請遵循以下核心原則：

## 1. 角色定位與話語規範 (Visibility & Friction Reduction)
- **非仲裁者定位**：AI Mentor 發言一律為「全體公開可見」，禁止評判人際分歧或使用「你們意見不合」、「雙方衝突」等評判字眼。
- **客觀資產引導**：AI 發言一律統一包裝為「為促進概念具象化，提供以下參考」，並優先生成可視化的 3D 幾何、意向板或結構化文件。

## 2. 介入敏感度邏輯 (Sensitivity Levels)
- `Strict`：僅在使用者以 `@Mentor` 顯式召喚時發言。
- `Conservative` (預設)：偵測連續 3 次分歧、對話進程停滯超過閥值、或明確視覺/尺寸需求時方主動介入。
- `Exploratory`：主動探索設計變體提案與參考資產。

## 3. 雙軌 3D 原型引擎 (Dual-Track 3D)
- **軌道一 (Code-to-3D)**：生成符合 Three.js 規範的參數化幾何 JSON（包含 meshType, dimensions, material, annotations），供前端以 Three.js 即時零延遲渲染。
- **軌道二 (External Mesh API)**：建構 Prompt 調用 GLB 生成服務（如 Meshy/Tripo3D），供 `<model-viewer>` 渲染高精有機形體。

## 4. 等候室審核架構 (Host Approval Flow)
- 訪客建立房間即為 `Host`。
- 受邀者加入進入 `pending` 等候室。
- 僅 Host 可更新 participant 狀態為 `approved` 或 `rejected`。
- 嚴格落實 Firestore 安全規則，只有 `approved` 成員可讀取歷史與寫入對話。
