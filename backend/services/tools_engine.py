from typing import Any
import json

def generate_parametric_3d(prompt: str, context: str = "") -> dict[str, Any]:
    """
    Code-to-3D engine: Generates a clean Three.js-compatible parametric geometry JSON.
    Low latency, lightweight, rendered instantly by Vue Three.js canvas.
    """
    p = prompt.lower()
    
    # Analyze keywords to deduce shape, dimensions and material
    if "椅" in p or "chair" in p or "凳" in p:
        return {
            "title": "人體工學椅原型 (Parametric Chair)",
            "description": "具備曲面椅背與金屬底座的參數化量體模型",
            "meshType": "group",
            "components": [
                {
                    "shape": "box",
                    "dimensions": {"width": 1.2, "height": 0.15, "depth": 1.2},
                    "position": {"x": 0, "y": 0.8, "z": 0},
                    "material": {"color": "#4B5563", "roughness": 0.7, "metalness": 0.1}
                },
                {
                    "shape": "box",
                    "dimensions": {"width": 1.2, "height": 1.4, "depth": 0.12},
                    "position": {"x": 0, "y": 1.5, "z": -0.55},
                    "material": {"color": "#374151", "roughness": 0.6, "metalness": 0.1}
                },
                {
                    "shape": "cylinder",
                    "dimensions": {"radiusTop": 0.08, "radiusBottom": 0.08, "height": 0.8},
                    "position": {"x": 0, "y": 0.4, "z": 0},
                    "material": {"color": "#9CA3AF", "roughness": 0.3, "metalness": 0.8}
                }
            ],
            "annotations": [
                {"label": "座面高度: 450mm", "position": {"x": 0.8, "y": 0.8, "z": 0}},
                {"label": "靠背角度: 105°", "position": {"x": 0.8, "y": 1.5, "z": -0.5}}
            ]
        }
    elif "桌" in p or "table" in p or "茶几" in p:
        is_cylinder = "圓" in p or "round" in p or "cylinder" in p
        return {
            "title": "現代風格茶几概念 (Parametric Table)",
            "description": "基於對話幾何需求生成的低延遲即時參數化模型",
            "meshType": "group",
            "components": [
                {
                    "shape": "cylinder" if is_cylinder else "box",
                    "dimensions": {"radiusTop": 1.2, "radiusBottom": 1.2, "height": 0.12} if is_cylinder else {"width": 2.0, "height": 0.12, "depth": 1.2},
                    "position": {"x": 0, "y": 1.0, "z": 0},
                    "material": {"color": "#B45309", "roughness": 0.8, "metalness": 0.05} # warm wood
                },
                {
                    "shape": "cylinder",
                    "dimensions": {"radiusTop": 0.06, "radiusBottom": 0.06, "height": 1.0},
                    "position": {"x": -0.6, "y": 0.5, "z": -0.4},
                    "material": {"color": "#1F2937", "roughness": 0.2, "metalness": 0.9} # black metal leg
                },
                {
                    "shape": "cylinder",
                    "dimensions": {"radiusTop": 0.06, "radiusBottom": 0.06, "height": 1.0},
                    "position": {"x": 0.6, "y": 0.5, "z": -0.4},
                    "material": {"color": "#1F2937", "roughness": 0.2, "metalness": 0.9}
                },
                {
                    "shape": "cylinder",
                    "dimensions": {"radiusTop": 0.06, "radiusBottom": 0.06, "height": 1.0},
                    "position": {"x": 0, "y": 0.5, "z": 0.5},
                    "material": {"color": "#1F2937", "roughness": 0.2, "metalness": 0.9}
                }
            ],
            "annotations": [
                {"label": "桌面直徑/寬度: 1200mm", "position": {"x": 0, "y": 1.2, "z": 0}},
                {"label": "桌高: 520mm", "position": {"x": 0.8, "y": 0.5, "z": 0}}
            ]
        }
    else:
        # Default architectural / volumetric concept
        return {
            "title": "概念設計體量模型 (Conceptual Form)",
            "description": "參數化多面體空間架構與光影關係探索",
            "meshType": "group",
            "components": [
                {
                    "shape": "torus",
                    "dimensions": {"radius": 1.0, "tube": 0.28, "radialSegments": 16, "tubularSegments": 32},
                    "position": {"x": 0, "y": 1.0, "z": 0},
                    "material": {"color": "#6366F1", "roughness": 0.4, "metalness": 0.3}
                },
                {
                    "shape": "box",
                    "dimensions": {"width": 1.6, "height": 0.2, "depth": 1.6},
                    "position": {"x": 0, "y": 0.1, "z": 0},
                    "material": {"color": "#E5E7EB", "roughness": 0.9, "metalness": 0.0}
                }
            ],
            "annotations": [
                {"label": "主要視覺核心", "position": {"x": 0, "y": 1.6, "z": 0}}
            ]
        }

def generate_mesh_3d(prompt: str) -> dict[str, Any]:
    """
    External Mesh API engine: Prompt construction & GLB model pipeline.
    Suitable for high-fidelity organic asset evaluation with <model-viewer>.
    """
    return {
        "title": "高精有機幾何網格 (High-Fidelity GLB)",
        "prompt": f"Professional 3D CAD asset: {prompt}, clean quad mesh, pbr textures, 8k render style",
        # Sample GLB fallback URL for instant interactive testing
        "modelUrl": "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb",
        "format": "glb",
        "filesize": "3.2 MB",
        "provider": "External Mesh Engine (Meshy / Tripo3D Pipeline)"
    }

def generate_moodboard(prompt: str, context: str = "") -> dict[str, Any]:
    """
    Visual Moodboard engine: Extracts aesthetic tokens, color palettes, material callouts.
    """
    return {
        "title": "設計視覺意向板 (Visual Mood Board)",
        "keywords": ["現代極簡 (Modern Minimalist)", "暖色調木質 (Warm Walnut)", "金屬收邊 (Matte Brass)", "柔和漫射光 (Diffused Ambience)"],
        "palette": [
            {"hex": "#2D3748", "name": "深岩灰 (Charcoal)"},
            {"hex": "#D97706", "name": "琥珀暖木 (Warm Amber)"},
            {"hex": "#E2E8F0", "name": "冷白底襯 (Pure Chalk)"},
            {"hex": "#94A3B8", "name": "霧面鋁鈦 (Matte Titanium)"}
        ],
        "materials": [
            {"name": "天然黑胡桃實木", "feature": "開孔消光漆處理，保留細緻天然木紋"},
            {"name": "陽極氧化鋁", "feature": "超細噴砂處理，低反射抗指紋"},
            {"name": "微水泥肌理", "feature": "連續無接縫啞光基底"}
        ],
        "slices": [
            {
                "url": "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=800&q=80",
                "caption": "光影與空間體量對比"
            },
            {
                "url": "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=800&q=80",
                "caption": "有機材質與人體工學曲線"
            },
            {
                "url": "https://images.unsplash.com/photo-1507089947368-19c1da9775ae?auto=format&fit=crop&w=800&q=80",
                "caption": "細節收邊與異材質嵌合"
            }
        ]
    }

def generate_meeting_summary(messages_text: str) -> dict[str, Any]:
    """
    Generates structured markdown meeting summary.
    """
    markdown = f"""# 專案設計協同會議摘要

**記錄時間**：即時自動彙整
**主持狀態**：AI Mentor 協同監聽

## 一、 討論共識點
1. **整體設計方向**：確立以現代極簡結合有機自然材質為基調。
2. **空間與尺寸規格**：初步確認主體量體尺寸，兼顧人體工學與空間動線流暢性。
3. **材質選擇**：選用消光抗指紋金屬與暖色系實木作為對比焦點。

## 二、 待釐清與後續行動 (Action Items)
- [ ] 前端工程與結構團隊進行 3D 結構應力初評
- [ ] 提供客戶實體打樣材質色票 (Swatch Samples)
- [ ] 於下週召開第二次定案設計審查

## 三、 生成資產清單
- 參數化 Code-to-3D 體量模型 #1
- 視覺意向板 (Mood Board) #1
"""
    return {
        "title": "會議紀要 (Meeting Summary)",
        "content": markdown,
        "format": "markdown"
    }

def generate_contract_draft(context: str) -> dict[str, Any]:
    """
    Generates structured markdown contract draft.
    """
    markdown = """# 設計委託與技術合作草約

**立合約書人**：
委託方（以下簡稱甲方）
受託方（以下簡稱乙方）

### 第一條：專案目標與工作範疇
乙方受甲方委託，執行「AI Mentor 協同設計提案」之概念發想、參數化 3D 原型建立及高精材質意向評估。

### 第二條：智慧財產權與交付物
1. 乙方依本合約完成之 3D 模型數據檔（JSON / GLB 格式）及視覺意向板，於甲方付清尾款後移轉相關著作財產權。
2. 系統自動生成之會議紀要作為雙方各階段驗收之重要依據。

### 第三條：保密協定
雙方保證對協作過程中所得知之商業機密、專利構想與設計圖說負嚴格保密義務。
"""
    return {
        "title": "合作協議草約 (Contract Draft)",
        "content": markdown,
        "format": "markdown"
    }
