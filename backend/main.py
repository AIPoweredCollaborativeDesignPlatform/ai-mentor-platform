import random
import string
import time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from models.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    MentorConfig,
    Participant
)
from services.mentor_agent import mentor_service

app = FastAPI(title=settings.PROJECT_NAME, version="1.0.0")

# Setup CORS for Vue Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In development allow all for quick prototyping
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for quick prototyping and local fallback
ROOMS_DB: dict[str, dict] = {}

def generate_pin() -> str:
    """Generate a unique 6-digit room PIN"""
    return "".join(random.choices(string.digits, k=6))

@app.get("/")
def root():
    return {"message": "AI Mentor Platform API Service is running.", "env": settings.ENVIRONMENT}

@app.get("/api/health")
def health():
    return {"status": "ok", "timestamp": int(time.time())}

@app.post("/api/rooms/create")
def create_room(payload: dict):
    host_uid = payload.get("hostUid")
    host_name = payload.get("hostName", "Host")
    host_avatar = payload.get("hostAvatar", "👑")
    
    if not host_uid:
        raise HTTPException(status_code=400, detail="hostUid is required")

    pin = generate_pin()
    room_id = f"room_{pin}"

    room_data = {
        "roomId": room_id,
        "pin": pin,
        "hostUid": host_uid,
        "createdAt": int(time.time()),
        "mentorConfig": MentorConfig().model_dump(),
        "participants": {
            host_uid: {
                "uid": host_uid,
                "displayName": host_name,
                "avatar": host_avatar,
                "status": "approved", # Host is approved by default
                "isHost": True,
                "joinedAt": int(time.time())
            }
        },
        "messages": []
    }
    ROOMS_DB[room_id] = room_data
    ROOMS_DB[pin] = room_data # Index by PIN as well
    return room_data

@app.get("/api/rooms/{identifier}")
def get_room(identifier: str):
    room = ROOMS_DB.get(identifier)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room

@app.post("/api/rooms/{identifier}/mentor-config")
def update_mentor_config(identifier: str, config: MentorConfig):
    room = ROOMS_DB.get(identifier)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    room["mentorConfig"] = config.model_dump()
    return {"status": "success", "mentorConfig": room["mentorConfig"]}

@app.post("/api/mentor/analyze", response_model=AnalyzeResponse)
def analyze_dialogue(request: AnalyzeRequest):
    """
    Evaluates current conversation stream against Mentor sensitivity and rules.
    """
    response = mentor_service.analyze_dialogue(request)
    return response

@app.post("/api/mentor/invoke", response_model=AnalyzeResponse)
def force_invoke_mentor(request: AnalyzeRequest):
    """
    Forces immediate AI Mentor intervention (e.g. when @Mentor is triggered).
    """
    request.forcedTrigger = True
    response = mentor_service.analyze_dialogue(request)
    return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
