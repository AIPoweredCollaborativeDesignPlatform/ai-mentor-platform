import os
import re
from typing import Optional
from models.schemas import AnalyzeRequest, AnalyzeResponse, MessageItem
from services.tools_engine import (
    generate_parametric_3d,
    generate_mesh_3d,
    generate_moodboard,
    generate_meeting_summary,
    generate_contract_draft
)
from config import settings

SYSTEM_INSTRUCTION = """
你是群體對話中介 AI Mentor，依據 GCA (Group Conversational Agent) 原則運作。
【核心定位】
1. 作為背景輔助與調解角色，全體公開可見，不作評審仲裁。
2. 保持客觀中立去衝突：嚴格禁止評判人際溝通狀態，禁止使用「意見不合」、「大家有分歧」、「爭執」等負面評判字眼。
3. 資產導向原則：一律將對話焦點轉化為客觀可見之設計物件（如 3D 幾何、結構圖、意向板），發言開頭固定為：「為促進概念具象化，提供以下參考：」。
"""

class MentorAgentService:
    def __init__(self):
        self.api_key = settings.GEMINI_API_KEY
        self.client = None
        if self.api_key:
            try:
                from google import genai
                self.client = genai.Client(api_key=self.api_key)
                print("[MentorAgentService] Real Google GenAI client successfully connected!")
            except Exception as e:
                print(f"[MentorAgentService] Failed to init google-genai client: {e}")

    def call_gemini_mediation(self, dialogue_context: str, user_intent: str) -> Optional[str]:
        """Calls real Gemini 2.5 Flash to generate constructive de-conflicting guidance."""
        if not self.client:
            return None
        try:
            prompt = f"""
{SYSTEM_INSTRUCTION}

【近期群體對話】
{dialogue_context}

【最新發言或指令】
{user_intent}

請嚴格遵循 GCA 去衝突與資產導向原則，以中立客觀、促進概念具象化的口吻回覆一句簡短話語（100字內），開頭統一使用「為促進概念具象化，提供以下參考：」。
"""
            response = self.client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt
            )
            return response.text.strip() if response.text else None
        except Exception as err:
            print(f"[MentorAgentService] Gemini API call error: {err}")
            return None

    def analyze_dialogue(self, request: AnalyzeRequest) -> AnalyzeResponse:
        messages = request.messages
        config = request.mentorConfig
        forced = request.forcedTrigger

        if not messages and not forced:
            return AnalyzeResponse(shouldIntervene=False)

        latest_content = messages[-1].content if messages else ""
        has_at_mentor = "@Mentor" in latest_content or "@mentor" in latest_content or forced

        # 1. Check Sensitivity Level: Strict
        if config.sensitivity == "Strict":
            if not has_at_mentor:
                return AnalyzeResponse(shouldIntervene=False, reason="Strict mode: only responds when @Mentor is mentioned.")

        # 2. Check Sensitivity Level: Conservative (Default)
        if config.sensitivity == "Conservative" and not has_at_mentor:
            # Check for stagnation or divergence or explicit visual requests
            divergence_indicators = ["不覺得", "反對", "但是", "不妥", "太小", "太大", "不行", "換個", "重做", "比較喜歡另一個"]
            visual_triggers = ["長怎樣", "看樣子", "3d", "模型", "草圖", "形狀", "尺寸", "意向", "風格", "材質", "總結", "合約"]
            
            # Count recent divergent messages
            recent_divergence_count = 0
            for m in messages[-4:]:
                if any(w in m.content for w in divergence_indicators):
                    recent_divergence_count += 1

            has_visual_demand = any(w in latest_content.lower() for w in visual_triggers)

            if recent_divergence_count < 2 and not has_visual_demand:
                return AnalyzeResponse(shouldIntervene=False, reason="Conservative mode: discourse within normal flow.")

        # If triggered, determine the best asset to generate
        # Generate dynamic Gemini speech if model client is online
        gemini_speech = self.call_gemini_mediation(full_text, latest_content)

        # Priority 1: Summary / Contract
        if any(k in latest_content for k in ["總結", "紀錄", "摘要", "summary"]):
            if config.enableProcessIntervention:
                data = generate_meeting_summary(full_text)
                return AnalyzeResponse(
                    shouldIntervene=True,
                    reason="總結需求介入",
                    aiMessage=gemini_speech or "為促進概念具象化，依據剛才的討論脈絡，為大家彙整以下會議紀要：",
                    assetType="summary",
                    assetData=data
                )
        if any(k in latest_content for k in ["合約", "草案", "條款", "contract"]):
            if config.enableProcessIntervention:
                data = generate_contract_draft(full_text)
                return AnalyzeResponse(
                    shouldIntervene=True,
                    reason="合約草案需求介入",
                    aiMessage=gemini_speech or "為促進概念具象化，提供設計協作之權益保護合約草案：",
                    assetType="contract",
                    assetData=data
                )

        # Priority 2: Visual Moodboard
        if any(k in latest_content for k in ["意向", "氛圍", "配色", "材質", "風格", "moodboard", "板"]):
            if config.enableMoodboard:
                data = generate_moodboard(latest_content, full_text)
                return AnalyzeResponse(
                    shouldIntervene=True,
                    reason="視覺意向提煉介入",
                    aiMessage=gemini_speech or "為促進概念具象化，提取關鍵視覺詞彙與材質配色，提供以下意向板參考：",
                    assetType="moodboard",
                    assetData=data
                )

        # Priority 3: Organic GLB 3D
        if any(k in latest_content for k in ["高精", "有機", "glb", "渲染", "mesh"]):
            if config.enable3D:
                data = generate_mesh_3d(latest_content)
                return AnalyzeResponse(
                    shouldIntervene=True,
                    reason="高精有機 3D 需求介入",
                    aiMessage=gemini_speech or "為促進概念具象化，建立高精有機 3D 幾何模型以利評估：",
                    assetType="mesh_3d",
                    assetData=data
                )

        # Priority 4: Code-to-3D Parametric Three.js (Default for 3D/geometry/furniture/spatial)
        if config.enable3D:
            data = generate_parametric_3d(latest_content or "概念量體", full_text)
            return AnalyzeResponse(
                shouldIntervene=True,
                reason="參數化 3D 幾何即時量體介入",
                aiMessage=gemini_speech or "為促進概念具象化，根據尺寸與空間討論，即時生成以下參數化 3D 幾何原型供全體同步預覽：",
                assetType="parametric_3d",
                assetData=data
            )

        # Fallback neutral statement
        return AnalyzeResponse(
            shouldIntervene=True,
            reason="中立發言",
            aiMessage="為促進概念具象化，已記錄當前關鍵要點，各位可隨時使用 `@Mentor` 或點擊控制項以調用 3D 量體或視覺意向板。",
            assetType=None,
            assetData=None
        )

mentor_service = MentorAgentService()
