"""Local Lead Finder Pro – main Flask application."""
from __future__ import annotations
import json
import os
from datetime import datetime, timedelta

from flask import (
    Flask, render_template, request, jsonify, redirect, url_for,
    Response, abort,
)
from flask_cors import CORS
from flask_login import (
    LoginManager, login_user, logout_user, login_required, current_user,
)
from sqlalchemy.exc import IntegrityError

from config import Config
from models import db, User, SavedLead, OutreachLog, SearchHistory, CacheEntry
from utils.places_api import (
    search_places, place_details, geocode_city, reverse_geocode, deep_enrich,
    CATEGORY_LABELS,
)
from utils.lead_scorer import calculate_score, lead_tier, score_breakdown
from utils import export as export_utils


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config.from_object(Config)
    CORS(app, supports_credentials=True)
    db.init_app(app)

    login_manager = LoginManager(app)
    login_manager.login_view = "login_page"

    @login_manager.user_loader
    def load_user(user_id: str):
        return db.session.get(User, int(user_id))

    @app.context_processor
    def inject_globals():
        return {
            "GOOGLE_API_KEY": Config.GOOGLE_API_KEY,
            "DEMO_MODE": Config.DEMO_MODE,
            "APP_NAME": "Local Lead Finder Pro",
            "CATEGORIES": CATEGORY_LABELS,
        }

    with app.app_context():
        db.create_all()
        _seed_demo_user()

    register_routes(app)
    return app


def _seed_demo_user() -> None:
    demo = User.query.filter_by(email="demo@leadfinder.com").first()
    if demo is None:
        demo = User(username="demo", email="demo@leadfinder.com")
        demo.set_password("demo123")
        db.session.add(demo)
        db.session.commit()


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _cache_get(key: str):
    entry = db.session.get(CacheEntry, key)
    if entry and entry.expires_at > datetime.utcnow():
        try:
            return json.loads(entry.value)
        except Exception:
            return None
    if entry:
        db.session.delete(entry)
        db.session.commit()
    return None


def _cache_set(key: str, value) -> None:
    expires = datetime.utcnow() + timedelta(seconds=Config.CACHE_TTL_SECONDS)
    entry = db.session.get(CacheEntry, key)
    payload = json.dumps(value)
    if entry:
        entry.value = payload
        entry.expires_at = expires
    else:
        db.session.add(CacheEntry(key=key, value=payload, expires_at=expires))
    db.session.commit()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_routes(app: Flask) -> None:
    # ----- pages --------------------------------------------------------
    @app.route("/")
    def root():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        return redirect(url_for("login_page"))

    @app.route("/login")
    def login_page():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        return render_template("login.html")

    @app.route("/dashboard")
    @login_required
    def dashboard():
        return render_template("dashboard.html", page="dashboard")

    @app.route("/leads")
    @login_required
    def leads_page():
        return render_template("leads.html", page="leads")

    @app.route("/settings")
    @login_required
    def settings_page():
        return render_template("settings.html", page="settings")

    # ----- auth ---------------------------------------------------------
    @app.post("/api/register")
    def api_register():
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        if not (username and email and password):
            return jsonify(error="username, email and password are required"), 400
        if len(password) < 6:
            return jsonify(error="password must be at least 6 characters"), 400
        user = User(username=username, email=email)
        user.set_password(password)
        try:
            db.session.add(user)
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify(error="email or username already exists"), 409
        login_user(user)
        return jsonify(ok=True, user={"id": user.id, "email": user.email, "username": user.username})

    @app.post("/api/login")
    def api_login():
        data = request.get_json(silent=True) or {}
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password):
            return jsonify(error="Invalid email or password"), 401
        login_user(user, remember=True)
        return jsonify(ok=True, user={"id": user.id, "email": user.email, "username": user.username})

    @app.post("/api/logout")
    @login_required
    def api_logout():
        logout_user()
        return jsonify(ok=True)

    # ----- search -------------------------------------------------------
    @app.post("/api/search")
    @login_required
    def api_search():
        data = request.get_json(silent=True) or {}
        city = (data.get("city") or "").strip()
        radius = max(500, min(int(data.get("radius") or 5000), 50000))
        category = (data.get("category") or "all").strip().lower()
        min_rating = float(data.get("min_rating") or 0)
        min_reviews = int(data.get("min_reviews") or 0)
        lat = data.get("lat")
        lng = data.get("lng")
        no_cache = bool(data.get("no_cache"))

        # Cache key prefers lat/lng if supplied, else city
        if lat is not None and lng is not None:
            try:
                lat_f = float(lat); lng_f = float(lng)
            except (TypeError, ValueError):
                return jsonify(error="invalid lat/lng"), 400
            cache_key = f"search:geo:{lat_f:.4f},{lng_f:.4f}:{radius}:{category}:{min_rating}:{min_reviews}"
        else:
            if not city:
                return jsonify(error="city or lat/lng required"), 400
            cache_key = f"search:{city.lower()}:{radius}:{category}:{min_rating}:{min_reviews}"
            lat_f = lng_f = None

        cached = None if no_cache else _cache_get(cache_key)
        if cached:
            cached["from_cache"] = True
        else:
            cached = search_places(
                city=city,
                radius_m=radius,
                category=category,
                api_key=Config.GOOGLE_API_KEY,
                min_rating=min_rating,
                min_reviews=min_reviews,
                lat=lat_f, lng=lng_f,
            )
            cached["from_cache"] = False
            _cache_set(cache_key, cached)

        # Log the search history
        try:
            db.session.add(SearchHistory(
                user_id=current_user.id,
                city=cached.get("location_label") or city or "geo",
                radius=radius,
                category=category,
            ))
            db.session.commit()
        except Exception:
            db.session.rollback()

        # Mark which results are already saved by this user
        saved = {sl.place_id: sl for sl in SavedLead.query.filter_by(user_id=current_user.id).all()}
        for b in cached["businesses"]:
            sl = saved.get(b["place_id"])
            b["saved"] = sl is not None
            b["saved_id"] = sl.id if sl else None
            b["tier"] = lead_tier(b["lead_score"])
            # score_breakdown was already set by places_api.calculate_score;
            # only fill it in if missing (e.g. cached pre-upgrade payloads).
            if "score_breakdown" not in b:
                b["score_breakdown"] = score_breakdown(b)

        return jsonify(cached)

    @app.get("/api/business/<path:place_id>")
    @login_required
    def api_business(place_id: str):
        details = place_details(place_id, Config.GOOGLE_API_KEY)
        if details is None:
            sl = SavedLead.query.filter_by(place_id=place_id, user_id=current_user.id).first()
            if sl:
                d = sl.to_dict()
                d["lead_score"] = sl.lead_score
                return jsonify(d)
            return jsonify(error="Details not available"), 404
        score, breakdown = calculate_score({
            "rating": details.get("rating", 0),
            "total_reviews": details.get("user_ratings_total", 0),
            "phone": details.get("formatted_phone_number"),
            "website": details.get("website"),
            "category": "store",
        })
        details["lead_score"] = score
        details["score_breakdown"] = breakdown
        return jsonify(details)

    @app.post("/api/places/enrich")
    @login_required
    def api_enrich():
        """Best-effort enrichment of a single business — pulls Wikidata
        and (if a website is known) scrapes the homepage for email/phone.
        Body: {place_id, business_name, brand?, website?, phone?, email?,
               wikidata?, image?}. Returns only the NEWLY discovered fields."""
        data = request.get_json(silent=True) or {}
        if not data.get("business_name") and not data.get("place_id"):
            return jsonify(error="business_name or place_id required"), 400
        try:
            found = deep_enrich(data)
        except Exception as exc:
            app.logger.warning("deep_enrich failed: %s", exc)
            found = {}
        # If the lead is already saved, persist the new fields
        place_id = data.get("place_id")
        if place_id and found:
            sl = SavedLead.query.filter_by(
                user_id=current_user.id, place_id=place_id,
            ).first()
            if sl:
                if found.get("website") and not sl.website:
                    sl.website = found["website"]
                if found.get("phone") and not sl.phone:
                    sl.phone = found["phone"]
                if found.get("email") and not sl.email:
                    sl.email = found["email"]
                try:
                    db.session.commit()
                except Exception:
                    db.session.rollback()
        return jsonify({"found": found, "any": bool(found)})

    @app.get("/api/geocode")
    @login_required
    def api_geocode():
        city = request.args.get("city", "")
        coords = geocode_city(city, Config.GOOGLE_API_KEY)
        if not coords:
            return jsonify(error="Unable to geocode"), 404
        return jsonify(lat=coords[0], lng=coords[1])

    @app.get("/api/reverse-geocode")
    @login_required
    def api_reverse_geocode():
        try:
            lat = float(request.args.get("lat", ""))
            lng = float(request.args.get("lng", ""))
        except (TypeError, ValueError):
            return jsonify(error="lat and lng required"), 400
        return jsonify(reverse_geocode(lat, lng))

    # ----- saved leads --------------------------------------------------
    def _persist_lead(data: dict) -> tuple[SavedLead, bool]:
        place_id = data.get("place_id")
        existing = SavedLead.query.filter_by(
            user_id=current_user.id, place_id=place_id,
        ).first()
        if existing:
            return existing, True
        lead = SavedLead(
            user_id=current_user.id,
            place_id=place_id,
            business_name=data.get("business_name") or "Unknown",
            category=data.get("category"),
            rating=float(data.get("rating") or 0),
            total_reviews=int(data.get("total_reviews") or 0),
            address=data.get("address"),
            phone=data.get("phone"),
            website=data.get("website"),
            maps_link=data.get("maps_link"),
            lat=data.get("lat"),
            lng=data.get("lng"),
            lead_score=int(data.get("lead_score") or 0),
            status=data.get("status") or "New",
            notes=data.get("notes") or "",
        )
        db.session.add(lead)
        db.session.commit()
        return lead, False

    @app.post("/api/leads/save")
    @login_required
    def api_save_lead():
        data = request.get_json(silent=True) or {}
        if not data.get("place_id"):
            return jsonify(error="place_id required"), 400
        lead, already = _persist_lead(data)
        return jsonify(ok=True, lead=lead.to_dict(), already_saved=already)

    @app.post("/api/leads/bulk-save")
    @login_required
    def api_bulk_save():
        data = request.get_json(silent=True) or {}
        items = data.get("leads") or []
        if not isinstance(items, list):
            return jsonify(error="leads must be a list"), 400
        added = skipped = 0
        for item in items:
            if not item.get("place_id"):
                continue
            _, already = _persist_lead(item)
            if already:
                skipped += 1
            else:
                added += 1
        return jsonify(ok=True, added=added, skipped=skipped, total=len(items))

    @app.get("/api/leads")
    @login_required
    def api_list_leads():
        status = request.args.get("status")
        q = SavedLead.query.filter_by(user_id=current_user.id)
        if status and status != "all":
            q = q.filter_by(status=status)
        rows = q.order_by(SavedLead.lead_score.desc(), SavedLead.created_at.desc()).all()
        return jsonify(leads=[r.to_dict() for r in rows])

    @app.put("/api/leads/<int:lead_id>")
    @login_required
    def api_update_lead(lead_id: int):
        lead = SavedLead.query.filter_by(id=lead_id, user_id=current_user.id).first()
        if not lead:
            abort(404)
        data = request.get_json(silent=True) or {}
        for field in ("status", "notes"):
            if field in data:
                setattr(lead, field, data[field])
        db.session.commit()
        return jsonify(ok=True, lead=lead.to_dict())

    @app.delete("/api/leads/<int:lead_id>")
    @login_required
    def api_delete_lead(lead_id: int):
        lead = SavedLead.query.filter_by(id=lead_id, user_id=current_user.id).first()
        if not lead:
            abort(404)
        db.session.delete(lead)
        db.session.commit()
        return jsonify(ok=True)

    @app.get("/api/leads/<int:lead_id>/outreach")
    @login_required
    def api_lead_outreach(lead_id: int):
        lead = SavedLead.query.filter_by(id=lead_id, user_id=current_user.id).first()
        if not lead:
            abort(404)
        logs = OutreachLog.query.filter_by(lead_id=lead.id).order_by(OutreachLog.contacted_at.desc()).all()
        return jsonify(logs=[
            {
                "id": l.id,
                "contact_method": l.contact_method,
                "message_template": l.message_template,
                "response_status": l.response_status,
                "contacted_at": l.contacted_at.isoformat() if l.contacted_at else None,
            }
            for l in logs
        ])

    # ----- outreach -----------------------------------------------------
    @app.post("/api/outreach")
    @login_required
    def api_log_outreach():
        data = request.get_json(silent=True) or {}
        lead_id = data.get("lead_id")
        lead = SavedLead.query.filter_by(id=lead_id, user_id=current_user.id).first()
        if not lead:
            abort(404)
        log = OutreachLog(
            lead_id=lead.id,
            contact_method=data.get("contact_method") or "WhatsApp",
            message_template=data.get("message_template") or "",
            response_status=data.get("response_status") or "Sent",
        )
        if lead.status == "New":
            lead.status = "Contacted"
        db.session.add(log)
        db.session.commit()
        return jsonify(ok=True, lead=lead.to_dict())

    # ----- analytics ----------------------------------------------------
    @app.get("/api/analytics/summary")
    @login_required
    def api_summary():
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        total = len(leads)
        hot = sum(1 for l in leads if l.lead_score >= 70)
        medium = sum(1 for l in leads if 40 <= l.lead_score < 70)
        low = total - hot - medium
        contacted = sum(1 for l in leads if l.status != "New")
        won = sum(1 for l in leads if l.status == "Won")
        avg_score = round(sum(l.lead_score for l in leads) / total, 1) if total else 0
        return jsonify(
            total_leads=total, hot=hot, medium=medium, low=low,
            contacted=contacted, won=won, avg_score=avg_score,
        )

    @app.get("/api/analytics/category-breakdown")
    @login_required
    def api_category_breakdown():
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        counts: dict[str, int] = {}
        for l in leads:
            key = l.category or "other"
            counts[key] = counts.get(key, 0) + 1
        return jsonify(breakdown=[{"category": k, "count": v} for k, v in counts.items()])

    @app.get("/api/analytics/rating-distribution")
    @login_required
    def api_rating_distribution():
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        buckets = {"<3.5": 0, "3.5-4.2": 0, "4.3-4.5": 0, "4.6-5.0": 0}
        for l in leads:
            r = l.rating or 0
            if r < 3.5:
                buckets["<3.5"] += 1
            elif r <= 4.2:
                buckets["3.5-4.2"] += 1
            elif r <= 4.5:
                buckets["4.3-4.5"] += 1
            else:
                buckets["4.6-5.0"] += 1
        return jsonify(distribution=[{"bucket": k, "count": v} for k, v in buckets.items()])

    @app.get("/api/analytics/pipeline")
    @login_required
    def api_pipeline():
        order = ["New", "Contacted", "Interested", "Won", "Not Interested"]
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        counts = {s: 0 for s in order}
        for l in leads:
            counts[l.status] = counts.get(l.status, 0) + 1
        return jsonify(stages=[{"stage": s, "count": counts.get(s, 0)} for s in order])

    @app.get("/api/analytics/recent-searches")
    @login_required
    def api_recent_searches():
        rows = (SearchHistory.query
                .filter_by(user_id=current_user.id)
                .order_by(SearchHistory.searched_at.desc())
                .limit(15).all())
        return jsonify(searches=[
            {
                "city": r.city, "radius": r.radius, "category": r.category,
                "searched_at": r.searched_at.isoformat() if r.searched_at else None,
            } for r in rows
        ])

    # ----- export -------------------------------------------------------
    @app.get("/api/export/csv")
    @login_required
    def api_export_csv():
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        body = export_utils.to_csv([l.to_dict() for l in leads])
        return Response(
            body,
            mimetype="text/csv",
            headers={"Content-Disposition": 'attachment; filename="leads.csv"'},
        )

    @app.get("/api/export/whatsapp-list")
    @login_required
    def api_export_whatsapp():
        msg = request.args.get("message", "")
        leads = SavedLead.query.filter_by(user_id=current_user.id).all()
        return jsonify(items=export_utils.whatsapp_list([l.to_dict() for l in leads], msg))

    # ----- meta ---------------------------------------------------------
    @app.get("/healthz")
    def healthz():
        return jsonify(ok=True, demo_mode=Config.DEMO_MODE)

    @app.get("/api/categories")
    def api_categories():
        return jsonify(categories=[
            {"value": k, "label": v} for k, v in CATEGORY_LABELS.items()
        ])


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

app = create_app()


if __name__ == "__main__":
    port = Config.PORT
    print(f"Starting Local Lead Finder Pro on port {port} (demo_mode={Config.DEMO_MODE})")
    app.run(host="0.0.0.0", port=port, debug=False)
