"""Application configuration."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


class Config:
    SECRET_KEY = os.environ.get("SESSION_SECRET", "dev-only-change-me")
    SQLALCHEMY_DATABASE_URI = f"sqlite:///{BASE_DIR / 'lead_finder.db'}"
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "").strip()
    DEMO_MODE = not bool(GOOGLE_API_KEY)

    BASE_PATH = os.environ.get("BASE_PATH", "/").rstrip("/") or ""
    PORT = int(os.environ.get("PORT", "8080"))

    CACHE_TTL_SECONDS = 60 * 60  # 1 hour
