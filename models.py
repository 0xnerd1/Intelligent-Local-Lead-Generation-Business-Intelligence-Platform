"""SQLAlchemy database models."""
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
import bcrypt

db = SQLAlchemy()


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    saved_leads = db.relationship("SavedLead", backref="user", lazy=True, cascade="all, delete-orphan")
    searches = db.relationship("SearchHistory", backref="user", lazy=True, cascade="all, delete-orphan")

    def set_password(self, raw: str) -> None:
        self.password_hash = bcrypt.hashpw(raw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    def check_password(self, raw: str) -> bool:
        try:
            return bcrypt.checkpw(raw.encode("utf-8"), self.password_hash.encode("utf-8"))
        except Exception:
            return False


class SearchHistory(db.Model):
    __tablename__ = "search_history"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    city = db.Column(db.String(120), nullable=False)
    radius = db.Column(db.Integer, nullable=False)
    category = db.Column(db.String(60), nullable=False)
    searched_at = db.Column(db.DateTime, default=datetime.utcnow)


class SavedLead(db.Model):
    __tablename__ = "saved_leads"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    place_id = db.Column(db.String(120), nullable=False)
    business_name = db.Column(db.String(200), nullable=False)
    category = db.Column(db.String(60))
    rating = db.Column(db.Float, default=0.0)
    total_reviews = db.Column(db.Integer, default=0)
    address = db.Column(db.String(300))
    phone = db.Column(db.String(40))
    website = db.Column(db.String(300))
    maps_link = db.Column(db.String(400))
    lead_score = db.Column(db.Integer, default=0)
    lat = db.Column(db.Float)
    lng = db.Column(db.Float)
    status = db.Column(db.String(40), default="New")  # New / Contacted / Interested / Not Interested
    notes = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    outreach_logs = db.relationship("OutreachLog", backref="lead", lazy=True, cascade="all, delete-orphan")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "place_id": self.place_id,
            "business_name": self.business_name,
            "category": self.category,
            "rating": self.rating,
            "total_reviews": self.total_reviews,
            "address": self.address,
            "phone": self.phone,
            "website": self.website,
            "maps_link": self.maps_link,
            "lead_score": self.lead_score,
            "lat": self.lat,
            "lng": self.lng,
            "status": self.status,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class OutreachLog(db.Model):
    __tablename__ = "outreach_logs"

    id = db.Column(db.Integer, primary_key=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("saved_leads.id"), nullable=False)
    contact_method = db.Column(db.String(40), nullable=False)  # WhatsApp / Phone / Email
    message_template = db.Column(db.Text)
    contacted_at = db.Column(db.DateTime, default=datetime.utcnow)
    response_status = db.Column(db.String(40), default="Sent")


class CacheEntry(db.Model):
    """Simple key/value cache for Places API responses."""
    __tablename__ = "cache_entries"

    key = db.Column(db.String(255), primary_key=True)
    value = db.Column(db.Text, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)
