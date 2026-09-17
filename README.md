# AI Mentor 協作平台 (AI Mentor Collaboration Platform)

> **定位**：融合 Google AI 生態與 GCA（Group Conversational Agent）理論的群體對話中介平台。以「讓未知的設計關係現形」為核心目標，將 AI 作為背景調解與可視化資產生成者，在群體認知出現落差或進程停滯時介入引導。

---

## 系統架構與流程

```mermaid
graph TD
    UserGuest[訪客 / Google 帳號] -->|1. 建立房間| HostRoom[主持人建立房間 (產生 6 位 PIN / 網址)]
    UserInvited[受邀成員] -->|2. 輸入 PIN 進入| WaitingRoom[等候室 (狀態: pending)]
    WaitingRoom -->|即時監聽 Firestore / WebSocket| HostNotify[主持人接收 Toast 通知]
    HostNotify -->|3. 主持人於側邊 Drawer 點擊核准| HostApprove[狀態更新為 approved]
    HostApprove -->|自動跳轉進入| MainRoom[協作聊天室 (Messages 串流)]
    
    MainRoom -->|群體對話流| MentorEngine[AI Mentor 監聽引擎 (FastAPI + Gemini)]
    MentorEngine -->|讀取 Mentor 控制面板設定| SensitivityRule{敏感度判斷: Strict / Conservative / Exploratory}
    SensitivityRule -->|觸發介入時| PublicIntervene[全體公開去衝突發言 + 生成可視化資產]
    
    PublicIntervene -->|Code-to-3D| ThreeJSViewer[Three.js 參數化幾何 JSON 即時渲染]
    PublicIntervene -->|External Mesh| ModelViewer[<model-viewer> GLB 3D 渲染]
    PublicIntervene -->|Mood Board| MoodBoard[視覺意向板 / 色彩材質標註]
    PublicIntervene -->|進程交付| DocViewer[Markdown 會議紀錄與合約草案]
```

---

## 核心規格與功能模組

### 1. 登入與等候室審核 (Host Approval Flow)
- **混合式無感身分驗證 (Progressive Onboarding)**：訪客輸入暱稱與選擇頭像即可快速加入；可一鍵升級 Google 帳號解鎖跨裝置「專案大廳 (Dashboard)」。
- **等候室機制**：受邀者進入顯示「等待主持人核准中...」並具備動態呼吸指示。
- **主持人抽屜審核**：側邊 Drawer 分組顯示「已加入」與「待審核」清單，提供即時 Toast 提示與允許／婉拒審核按鈕。

### 2. 群體互動與張力控管 (GCA Mediation)
- **主持人 Mentor 控制面板**：
  - `Strict`：僅在被 `@Mentor` 標記時回覆。
  - `Conservative` (預設)：偵測連續 3 次分歧、長時間停滯或明確視覺需求時介入。
  - `Exploratory`：主動提供變體提案與參考資產。
- **中立去衝突原則**：System Prompt 嚴格約束 AI 發言，以客觀設計資產導向（「為促進概念具象化，提供以下參考」），禁止評判人際爭端。

### 3. 核心功能模組與工具介面
- **雙軌 3D 原型引擎**：
  - `Code-to-3D`：Gemini 輸出 Three.js 參數化幾何 JSON，前端即時零延遲渲染。
  - `External Mesh API`：高精有機形體調用 GLB 模型，封裝 `<model-viewer>` 呈現。
- **視覺意向板 (Mood Board)**：提取抽象風格關鍵詞，生成對比切片、色彩調色盤（支援點選複製 HEX）與材質標註。
- **結構化交付文件**：依對話脈絡自動產出 Markdown 會議紀要與合約草案，支援一鍵下載。

### 4. Firestore 資料庫安全規則 (`firestore.rules`)
- `participants` 集合：任何人皆可寫入 `status: "pending"` 申請；僅 `hostUid` 可將狀態更新為 `approved`。
- `messages` 集合：嚴格限制讀寫權限，僅當請求者的 `uid` 在 `participants` 中且 `status == "approved"` 時，方可存取。

---

## 目錄結構

```text
ai-mentor-platform/
├── .gemini/
│   └── rules.md             # 團隊 Antigravity AI 協作規範
├── .gitignore               # Git 忽略配置
├── .env.example             # 環境變數範本
├── README.md                # 專案技術文件
├── firestore.rules          # Firestore 安全規則
├── backend/                 # Google Cloud Run + FastAPI 服務
│   ├── main.py              # 路由與 API 入口
│   ├── config.py            # 配置管理
│   ├── Dockerfile           # 容器定義
│   ├── requirements.txt     # Python 依賴
│   ├── models/schemas.py    # Pydantic 資料模型
│   └── services/
│       ├── mentor_agent.py  # GCA 調解引擎
│       └── tools_engine.py  # 3D, 意向板, 交付物工具
└── frontend/                # Vue 3 + TypeScript + Tailwind CSS
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── stores/          # Pinia 狀態庫 (auth, room, mentor)
        ├── router/          # Vue Router (Home, Waiting, Room, Dashboard)
        ├── components/      # 3D 畫布、模型檢視器、意向板、抽屜、Toast
        └── views/           # 首頁、等候室、協作會議室、專案大廳
```

---

## 本地快速啟動 (Quick Start)

### 1. 後端 (FastAPI)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```
> 後端服務啟動於 `http://localhost:8000`，提供 API 文檔於 `http://localhost:8000/docs`。

### 2. 前端 (Vue 3 + Vite)
```powershell
cd frontend
npm install
npm run dev
```
> 前端開發伺服器啟動於 `http://localhost:5173`。

---

## 團隊 GitHub 協作流程 (Team Git Workflow)

1. **取得最新代碼**：
   ```powershell
   git pull origin main
   ```
2. **開立功能分支**：
   ```powershell
   git checkout -b feature/waiting-room-enhancement
   ```
3. **提交與推送**：
   ```powershell
   git add .
   git commit -m "feat: add real-time host approval notification"
   git push origin feature/waiting-room-enhancement
   ```
4. 至 GitHub Organization 倉庫開立 Pull Request 進行代碼審查與合併。
