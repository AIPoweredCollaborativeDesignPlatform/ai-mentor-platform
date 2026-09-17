import os
from pydantic_settings import BaseSettings if False else object
from dotenv import load_dotenv

load_dotenv()

class Settings:
    PROJECT_NAME: str = "AI Mentor Collaboration Platform"
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    PORT: int = int(os.getenv("PORT", 8000))
    CORS_ORIGINS: list[str] = os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173"
    ).split(",")
    FIREBASE_SERVICE_ACCOUNT_PATH: str = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "")

settings = Settings()
