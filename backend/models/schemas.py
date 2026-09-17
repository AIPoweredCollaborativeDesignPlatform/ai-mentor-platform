from typing import Optional, Literal, Any
from pydantic import BaseModel, Field

# Participant & Role
class Participant(BaseModel):
    uid: str
    displayName: str
    avatar: str
    status: Literal["pending", "approved", "rejected"]
    joinedAt: Optional[int] = None

# Mentor Configuration Set by Host
class MentorConfig(BaseModel):
    sensitivity: Literal["Strict", "Conservative", "Exploratory"] = "Conservative"
    enable3D: bool = True
    enableMoodboard: bool = True
    enableFactRetrieval: bool = True
    enableProcessIntervention: bool = True

# Message Types
class MessageItem(BaseModel):
    id: Optional[str] = None
    senderUid: str
    senderName: str
    senderAvatar: str
    type: Literal["text", "file", "ai_asset"] = "text"
    content: str
    timestamp: int
    assetPayload: Optional[dict[str, Any]] = None

# Analysis Request
class AnalyzeRequest(BaseModel):
    roomId: str
    messages: list[MessageItem]
    mentorConfig: MentorConfig
    forcedTrigger: bool = False # e.g. @Mentor

# Analysis Response
class AnalyzeResponse(BaseModel):
    shouldIntervene: bool
    reason: Optional[str] = None
    aiMessage: Optional[str] = None
    assetType: Optional[Literal["parametric_3d", "mesh_3d", "moodboard", "summary", "contract"]] = None
    assetData: Optional[dict[str, Any]] = None
