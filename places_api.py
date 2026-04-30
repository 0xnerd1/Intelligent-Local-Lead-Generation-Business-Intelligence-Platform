"""Business discovery using real-time public APIs.

Primary data sources (no API keys required):
  * Nominatim (OpenStreetMap) — worldwide geocoding & reverse-geocoding
  * Overpass API (OpenStreetMap) — real, current business data
  * Wikidata SPARQL — enrichment for chain brands (official_website, image, etc.)

Optional:
  * Google Places — used automatically if GOOGLE_API_KEY is set

If the network call fails, falls back to a deterministic mock generator so
the demo never breaks. We never invent ratings or reviews — when OSM has
no real value for a field, we return None and the UI must reflect that
honestly ("not listed" rather than "no website").
"""
from __future__ import annotations
import json
import math
import random
import re
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from .lead_scorer import calculate_score


USER_AGENT = "LocalLeadFinderPro/1.0 (https://replit.com)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

# In-process Wikidata cache (process lifetime). Keyed by QID.
_WIKIDATA_CACHE: Dict[str, Dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Categories — friendly labels + OSM tag selectors
# ---------------------------------------------------------------------------

CATEGORY_LABELS: Dict[str, str] = {
    "restaurant": "Restaurant",
    "cafe": "Café",
    "bakery": "Bakery",
    "fast_food": "Fast Food",
    "lodging": "Hotel",
    "wedding_hall": "Wedding Hall",
    "gym": "Gym",
    "salon": "Salon & Spa",
    "pharmacy": "Pharmacy",
    "dentist": "Dental Clinic",
    "doctor": "Doctor's Clinic",
    "school": "School",
    "bank": "Bank",
    "supermarket": "Supermarket",
    "clothing": "Clothing Store",
    "electronics": "Electronics",
    "store": "Shop",
}


# Maps category → list of (osm_key, osm_value) selectors used by Overpass
OSM_FILTERS: Dict[str, List[Tuple[str, str]]] = {
    "restaurant": [("amenity", "restaurant")],
    "cafe": [("amenity", "cafe")],
    "bakery": [("shop", "bakery"), ("craft", "bakery")],
    "fast_food": [("amenity", "fast_food")],
    "lodging": [("tourism", "hotel"), ("tourism", "guest_house"), ("tourism", "motel")],
    "wedding_hall": [("amenity", "events_venue"), ("amenity", "community_centre")],
    "gym": [("leisure", "fitness_centre"), ("leisure", "sports_centre")],
    "salon": [("shop", "hairdresser"), ("shop", "beauty"), ("shop", "massage")],
    "pharmacy": [("amenity", "pharmacy")],
    "dentist": [("amenity", "dentist")],
    "doctor": [("amenity", "doctors"), ("amenity", "clinic")],
    "school": [("amenity", "school"), ("amenity", "college")],
    "bank": [("amenity", "bank")],
    "supermarket": [("shop", "supermarket"), ("shop", "convenience")],
    "clothing": [("shop", "clothes"), ("shop", "shoes")],
    "electronics": [("shop", "electronics"), ("shop", "mobile_phone"), ("shop", "computer")],
    "store": [("shop", "yes"), ("amenity", "marketplace")],
}


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _http_get_json(url: str, timeout: float = 12.0) -> Optional[Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _http_post_json(url: str, body: str, timeout: float = 25.0) -> Optional[Any]:
    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Geocoding (Nominatim → Google fallback)
# ---------------------------------------------------------------------------

def geocode_city(city: str, api_key: str = "") -> Optional[Tuple[float, float]]:
    """City/address → (lat, lng) via Nominatim. Optional Google fallback."""
    city = (city or "").strip()
    if not city:
        return None

    url = f"{NOMINATIM_URL}/search?" + urllib.parse.urlencode({
        "q": city, "format": "json", "limit": 1, "addressdetails": 0,
    })
    data = _http_get_json(url)
    if isinstance(data, list) and data:
        try:
            return (float(data[0]["lat"]), float(data[0]["lon"]))
        except (KeyError, ValueError, TypeError):
            pass

    if api_key:
        gurl = (
            "https://maps.googleapis.com/maps/api/geocode/json?"
            + urllib.parse.urlencode({"address": city, "key": api_key})
        )
        gdata = _http_get_json(gurl)
        if isinstance(gdata, dict) and gdata.get("status") == "OK" and gdata.get("results"):
            loc = gdata["results"][0]["geometry"]["location"]
            return (loc["lat"], loc["lng"])

    return None


def reverse_geocode(lat: float, lng: float) -> Dict[str, Any]:
    """Return {city, region, country, display_name} for a lat/lng."""
    url = f"{NOMINATIM_URL}/reverse?" + urllib.parse.urlencode({
        "lat": lat, "lon": lng, "format": "json", "zoom": 14, "addressdetails": 1,
    })
    data = _http_get_json(url) or {}
    addr = (data.get("address") or {}) if isinstance(data, dict) else {}
    city = (
        addr.get("city") or addr.get("town") or addr.get("village")
        or addr.get("suburb") or addr.get("county") or ""
    )
    return {
        "city": city,
        "region": addr.get("state") or addr.get("region") or "",
        "country": addr.get("country") or "",
        "display_name": (data.get("display_name") if isinstance(data, dict) else "") or "",
    }


# ---------------------------------------------------------------------------
# Distance + helpers
# ---------------------------------------------------------------------------

def haversine_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def _normalize_url(u: Optional[str]) -> Optional[str]:
    if not u:
        return None
    u = u.strip()
    if not u:
        return None
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def _social_handle(value: str, kind: str) -> str:
    """Turn an OSM contact:* value into a clickable URL when possible."""
    v = (value or "").strip()
    if not v:
        return ""
    if v.startswith(("http://", "https://")):
        return v
    v = v.lstrip("@/")
    bases = {
        "facebook": "https://www.facebook.com/",
        "instagram": "https://www.instagram.com/",
        "twitter": "https://twitter.com/",
        "youtube": "https://www.youtube.com/",
        "tiktok": "https://www.tiktok.com/@",
        "linkedin": "https://www.linkedin.com/in/",
        "whatsapp": "https://wa.me/",
    }
    return bases.get(kind, "") + v


# ---------------------------------------------------------------------------
# Overpass query
# ---------------------------------------------------------------------------

def _overpass_query(center: Tuple[float, float], radius_m: int, category: str) -> str:
    cats = list(CATEGORY_LABELS.keys()) if category in ("all", "") else [category]
    parts: List[str] = []
    for cat in cats:
        for k, v in OSM_FILTERS.get(cat, []):
            if v == "yes":
                parts.append(f'node["{k}"](around:{radius_m},{center[0]},{center[1]});')
                parts.append(f'way["{k}"](around:{radius_m},{center[0]},{center[1]});')
            else:
                parts.append(f'node["{k}"="{v}"](around:{radius_m},{center[0]},{center[1]});')
                parts.append(f'way["{k}"="{v}"](around:{radius_m},{center[0]},{center[1]});')
    body = "\n".join(parts)
    return f"[out:json][timeout:25];\n({body}\n);\nout center tags 80;"


def _osm_to_business(el: Dict[str, Any], center: Tuple[float, float]) -> Optional[Dict[str, Any]]:
    tags = el.get("tags") or {}
    name = tags.get("name") or tags.get("brand") or tags.get("operator")
    if not name:
        return None

    if el.get("type") == "node":
        lat, lng = el.get("lat"), el.get("lon")
    else:
        c = el.get("center") or {}
        lat, lng = c.get("lat"), c.get("lon")
    if lat is None or lng is None:
        return None

    # Determine category from tags (best effort)
    cat = "store"
    cat_label = "Shop"
    for key, label in CATEGORY_LABELS.items():
        for k, v in OSM_FILTERS.get(key, []):
            if tags.get(k) == v or (v == "yes" and k in tags):
                cat = key
                cat_label = label
                break
        else:
            continue
        break

    # Address composition
    addr_parts = [
        tags.get("addr:housenumber"),
        tags.get("addr:street"),
        tags.get("addr:suburb") or tags.get("addr:neighbourhood"),
        tags.get("addr:city"),
    ]
    address = ", ".join([p for p in addr_parts if p]) or tags.get("addr:full") or ""

    # Phone — try several keys, take first if multiple
    phone_raw = (
        tags.get("contact:phone")
        or tags.get("phone")
        or tags.get("contact:mobile")
        or tags.get("mobile")
        or tags.get("brand:phone")
        or ""
    )
    phone = phone_raw.split(";")[0].strip() if phone_raw else None

    # Website — many possible OSM keys + brand fallback
    website = _normalize_url(
        tags.get("contact:website")
        or tags.get("website")
        or tags.get("url")
        or tags.get("contact:url")
        or tags.get("brand:website")
    )

    # Email
    email = (
        tags.get("contact:email")
        or tags.get("email")
        or tags.get("brand:email")
    )

    # Social handles
    socials: Dict[str, str] = {}
    for net in ("facebook", "instagram", "twitter", "youtube", "tiktok", "linkedin", "whatsapp"):
        v = tags.get(f"contact:{net}") or tags.get(net) or tags.get(f"brand:{net}")
        if v:
            url = _social_handle(v, net)
            if url:
                socials[net] = url

    # Real rating — OSM only carries `stars` for hotels. Otherwise None (not invented).
    rating: Optional[float] = None
    if tags.get("stars"):
        try:
            rating = float(tags["stars"])
        except (TypeError, ValueError):
            rating = None

    # Wikidata IDs (used for batch enrichment after the loop)
    wikidata_qid = tags.get("wikidata") or tags.get("brand:wikidata")
    wikipedia = tags.get("wikipedia")

    # Image (very rare in OSM but some POIs have it)
    image = tags.get("image")

    distance_m = haversine_m(center, (lat, lng))

    biz: Dict[str, Any] = {
        "place_id": f"osm_{el.get('type', 'node')[0]}_{el.get('id')}",
        "osm_type": el.get("type"),
        "osm_id": el.get("id"),
        "business_name": name,
        "name_en": tags.get("name:en"),
        "name_local": tags.get("name:ur") or tags.get("name:hi") or tags.get("name:ar"),
        "alt_name": tags.get("alt_name") or tags.get("official_name"),
        "category": cat,
        "category_label": cat_label,
        "rating": rating,
        "total_reviews": None,  # OSM has none
        "address": address,
        "phone": phone,
        "email": email,
        "website": website,
        "socials": socials,
        "maps_link": f"https://www.openstreetmap.org/{el.get('type')}/{el.get('id')}",
        "lat": float(lat),
        "lng": float(lng),
        "distance_m": int(distance_m),
        "source": "openstreetmap",
        "opening_hours": tags.get("opening_hours"),
        "cuisine": tags.get("cuisine"),
        "brand": tags.get("brand"),
        "wikidata": wikidata_qid,
        "wikipedia": wikipedia,
        "image": image,
        "description": tags.get("description"),
        "delivery": tags.get("delivery"),
        "takeaway": tags.get("takeaway"),
        "wheelchair": tags.get("wheelchair"),
        # Provenance — what we know vs what we don't
        "data_completeness": _completeness(phone, website, email, address, tags.get("opening_hours"), socials),
    }
    biz["lead_score"], biz["score_breakdown"] = calculate_score(biz)
    return biz


def _completeness(phone, website, email, address, hours, socials) -> int:
    """0–100. How complete is this listing? Used to communicate confidence to the user."""
    score = 0
    if phone:   score += 22
    if website: score += 22
    if email:   score += 18
    if address: score += 14
    if hours:   score += 12
    if socials: score += 12
    return min(100, score)


# ---------------------------------------------------------------------------
# Wikidata enrichment — fills website / image for chain brands
# ---------------------------------------------------------------------------

def _wikidata_batch(qids: List[str]) -> Dict[str, Dict[str, Any]]:
    """Return {qid: {website, image, phone, email}} via one SPARQL query."""
    qids = [q for q in qids if q and q.startswith("Q") and q not in _WIKIDATA_CACHE]
    out: Dict[str, Dict[str, Any]] = {q: _WIKIDATA_CACHE[q] for q in qids if q in _WIKIDATA_CACHE}
    if not qids:
        return out

    values = " ".join(f"wd:{q}" for q in qids)
    query = f"""
    SELECT ?item ?website ?image ?phone ?email WHERE {{
      VALUES ?item {{ {values} }}
      OPTIONAL {{ ?item wdt:P856 ?website. }}
      OPTIONAL {{ ?item wdt:P18 ?image. }}
      OPTIONAL {{ ?item wdt:P1329 ?phone. }}
      OPTIONAL {{ ?item wdt:P968 ?email. }}
    }}
    """
    url = WIKIDATA_SPARQL + "?" + urllib.parse.urlencode({"query": query, "format": "json"})
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        # Wikidata down — return what we already had
        return out

    for binding in data.get("results", {}).get("bindings", []):
        item_url = binding.get("item", {}).get("value", "")
        qid = item_url.rsplit("/", 1)[-1]
        rec = out.setdefault(qid, {})
        for field in ("website", "image", "phone", "email"):
            v = binding.get(field, {}).get("value")
            if v and not rec.get(field):
                rec[field] = v

    # Cache and return
    for qid in qids:
        _WIKIDATA_CACHE[qid] = out.get(qid, {})
    return out


def _enrich_with_wikidata(businesses: List[Dict[str, Any]]) -> int:
    """Mutate businesses in-place: fill missing website/email/phone/image from Wikidata.
    Returns count of leads that were enriched."""
    qids = sorted({b.get("wikidata") for b in businesses if b.get("wikidata")})
    if not qids:
        return 0
    data = _wikidata_batch(list(qids)[:80])  # cap to keep query small
    enriched = 0
    for b in businesses:
        qid = b.get("wikidata")
        if not qid or qid not in data:
            continue
        record = data[qid]
        before = (b.get("website"), b.get("phone"), b.get("email"), b.get("image"))
        if not b.get("website") and record.get("website"):
            b["website"] = _normalize_url(record["website"])
        if not b.get("phone") and record.get("phone"):
            b["phone"] = record["phone"].split(";")[0].strip()
        if not b.get("email") and record.get("email"):
            b["email"] = record["email"]
        if not b.get("image") and record.get("image"):
            b["image"] = record["image"]
        if (b.get("website"), b.get("phone"), b.get("email"), b.get("image")) != before:
            b["enriched_from"] = "wikidata"
            enriched += 1
            # Recompute score & completeness now that fields changed
            b["data_completeness"] = _completeness(
                b.get("phone"), b.get("website"), b.get("email"),
                b.get("address"), b.get("opening_hours"), b.get("socials") or {},
            )
            b["lead_score"], b["score_breakdown"] = calculate_score(b)
    return enriched


def _query_overpass(center: Tuple[float, float], radius_m: int, category: str) -> Optional[List[Dict[str, Any]]]:
    q = _overpass_query(center, radius_m, category)
    body = "data=" + urllib.parse.quote(q)
    for endpoint in OVERPASS_ENDPOINTS:
        data = _http_post_json(endpoint, body, timeout=25.0)
        if not data or "elements" not in data:
            continue
        out: List[Dict[str, Any]] = []
        seen = set()
        for el in data["elements"]:
            biz = _osm_to_business(el, center)
            if biz and biz["place_id"] not in seen:
                seen.add(biz["place_id"])
                out.append(biz)
        # Enrich with Wikidata before returning
        try:
            _enrich_with_wikidata(out)
        except Exception:
            pass
        return out
    return None


# ---------------------------------------------------------------------------
# Mock fallback (used only if network fails)
# ---------------------------------------------------------------------------

_MOCK_NAME_PARTS = {
    "restaurant": (["Spice", "Royal", "Golden", "Urban", "Garden"], ["Kitchen", "Grill", "House", "Bistro", "Lounge"]),
    "cafe":       (["Brew", "Daily", "Mellow", "Bean", "Sunrise"], ["Café", "Coffee", "Roasters", "House", "Lab"]),
    "bakery":     (["Daily", "Sweet", "Crust", "Flour", "Hearth"], ["Bakery", "Bread", "Patisserie", "Bake", "Loaf"]),
    "fast_food":  (["Quick", "Express", "Crunch", "Burger", "Snap"], ["Bites", "Box", "Joint", "Stop", "House"]),
    "lodging":    (["Grand", "Royal", "Pearl", "Heritage", "Park"], ["Hotel", "Inn", "Suites", "Lodge", "Plaza"]),
    "wedding_hall": (["Royal", "Crystal", "Pearl", "Imperial", "Marquee"], ["Banquet", "Hall", "Palace", "Pavilion", "Venue"]),
    "gym":        (["Iron", "Power", "Flex", "Apex", "Atlas"], ["Fitness", "Gym", "Studio", "Box", "Club"]),
    "salon":      (["Glow", "Bliss", "Mirror", "Velvet", "Allure"], ["Salon", "Spa", "Studio", "Lounge", "Beauty"]),
    "pharmacy":   (["City", "Care", "Medi", "Plus", "Wellness"], ["Pharmacy", "Drugs", "Chemist", "Health", "Care"]),
    "dentist":    (["Smile", "Bright", "Pearl", "Family", "Care"], ["Dental", "Clinic", "Smiles", "Care", "Studio"]),
    "doctor":     (["City", "Health", "Care", "Family", "Prime"], ["Clinic", "Medical", "Health", "Centre", "Care"]),
    "school":     (["Bright", "City", "Future", "Crescent", "Pioneer"], ["Academy", "School", "Institute", "College", "Learning"]),
    "bank":       (["First", "City", "Premier", "United", "Allied"], ["Bank", "Trust", "Savings", "Credit", "Capital"]),
    "supermarket":(["Mega", "Daily", "Fresh", "Smart", "City"], ["Mart", "Market", "Bazaar", "Store", "Plaza"]),
    "clothing":   (["Style", "Modern", "Urban", "Trend", "Classic"], ["Wear", "Outlet", "Boutique", "Threads", "Apparel"]),
    "electronics":(["Tech", "Smart", "Digital", "Volt", "Pixel"], ["Hub", "Store", "World", "Galaxy", "Mart"]),
    "store":      (["City", "Family", "Daily", "Prime", "Modern"], ["Mart", "Shop", "Store", "Outlet", "Plaza"]),
}


def _generate_mock(center: Tuple[float, float], radius_m: int, category: str, count: int = 30) -> List[Dict[str, Any]]:
    seed = f"{center[0]:.4f}|{center[1]:.4f}|{radius_m}|{category}"
    rng = random.Random(seed)
    cats = [category] if category in CATEGORY_LABELS else list(CATEGORY_LABELS.keys())
    out: List[Dict[str, Any]] = []
    for i in range(count):
        cat = rng.choice(cats)
        firsts, lasts = _MOCK_NAME_PARTS.get(cat, _MOCK_NAME_PARTS["store"])
        name = f"{rng.choice(firsts)} {rng.choice(lasts)}"
        r = radius_m * math.sqrt(rng.random())
        theta = rng.uniform(0, 2 * math.pi)
        dlat = (r * math.cos(theta)) / 111_320
        dlon = (r * math.sin(theta)) / (111_320 * max(math.cos(math.radians(center[0])), 0.0001))
        lat, lng = center[0] + dlat, center[1] + dlon
        has_phone = rng.random() > 0.25
        biz = {
            "place_id": f"mock_{seed}_{i}",
            "business_name": name,
            "category": cat,
            "category_label": CATEGORY_LABELS.get(cat, "Shop"),
            "rating": None,
            "total_reviews": None,
            "address": f"{rng.randint(1, 999)} Sample St",
            "phone": (f"+1{rng.randint(2000000000, 9999999999)}" if has_phone else None),
            "email": None,
            "website": (None if rng.random() < 0.45 else f"https://www.{name.lower().replace(' ', '')}.example.com"),
            "socials": {},
            "maps_link": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=18/{lat}/{lng}",
            "lat": lat,
            "lng": lng,
            "distance_m": int(haversine_m(center, (lat, lng))),
            "source": "mock",
            "opening_hours": None,
            "cuisine": None,
            "brand": None,
            "data_completeness": _completeness(
                f"+1{rng.randint(2000000000, 9999999999)}" if has_phone else None,
                None, None, "yes", None, {},
            ),
        }
        biz["lead_score"], biz["score_breakdown"] = calculate_score(biz)
        out.append(biz)
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def search_places(
    city: str = "",
    radius_m: int = 5000,
    category: str = "all",
    api_key: str = "",
    min_rating: float = 0.0,
    min_reviews: int = 0,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
) -> Dict[str, Any]:
    """Search businesses around a location. Accepts either `city` or lat/lng."""
    center: Optional[Tuple[float, float]] = None
    used_demo = False
    location_label = city.strip() if city else ""

    if lat is not None and lng is not None:
        center = (float(lat), float(lng))
        if not location_label:
            rev = reverse_geocode(center[0], center[1])
            location_label = rev.get("city") or rev.get("display_name", "Selected location")
    if center is None and city:
        center = geocode_city(city, api_key)
    if center is None:
        center = (31.5497, 74.3436)
        location_label = location_label or "Lahore (default)"
        used_demo = True

    businesses: List[Dict[str, Any]] = []

    osm = _query_overpass(center, radius_m, category)
    if osm is not None and len(osm) > 0:
        businesses = osm
    elif api_key:
        try:
            params = {"location": f"{center[0]},{center[1]}", "radius": radius_m, "key": api_key}
            if category != "all":
                if category == "wedding_hall":
                    params["keyword"] = "wedding hall"
                else:
                    params["type"] = category
            url = (
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json?"
                + urllib.parse.urlencode(params)
            )
            data = _http_get_json(url, timeout=10) or {}
            for r in data.get("results", []):
                loc = r.get("geometry", {}).get("location", {})
                biz = {
                    "place_id": r.get("place_id"),
                    "business_name": r.get("name"),
                    "category": category if category != "all" else "store",
                    "category_label": CATEGORY_LABELS.get(category, "Shop"),
                    "rating": float(r.get("rating", 0) or 0) or None,
                    "total_reviews": int(r.get("user_ratings_total", 0) or 0) or None,
                    "address": r.get("vicinity") or "",
                    "phone": None,
                    "email": None,
                    "website": None,
                    "socials": {},
                    "maps_link": f"https://www.google.com/maps/place/?q=place_id:{r.get('place_id')}",
                    "lat": loc.get("lat"),
                    "lng": loc.get("lng"),
                    "distance_m": int(haversine_m(center, (loc.get("lat", center[0]), loc.get("lng", center[1])))),
                    "source": "google",
                    "opening_hours": None,
                    "cuisine": None,
                    "brand": None,
                    "data_completeness": 50,
                }
                biz["lead_score"], biz["score_breakdown"] = calculate_score(biz)
                businesses.append(biz)
        except Exception:
            businesses = []

    if not businesses:
        businesses = _generate_mock(center, radius_m, category)
        used_demo = True

    if min_rating > 0:
        businesses = [b for b in businesses if (b.get("rating") or 0) >= min_rating]
    if min_reviews > 0:
        businesses = [b for b in businesses if (b.get("total_reviews") or 0) >= min_reviews]

    businesses.sort(key=lambda b: (-b["lead_score"], b.get("distance_m", 0)))

    hot = sum(1 for b in businesses if b["lead_score"] >= 70)
    enriched = sum(1 for b in businesses if b.get("enriched_from"))
    return {
        "businesses": businesses,
        "total_count": len(businesses),
        "hot_leads": hot,
        "enriched_count": enriched,
        "center": {"lat": center[0], "lng": center[1]},
        "location_label": location_label,
        "demo_mode": used_demo,
        "source": "openstreetmap" if not used_demo else "mock",
    }


# ---------------------------------------------------------------------------
# Per-lead deep enrichment: fetch the business website's HTML and pull
# emails / phone numbers from the page (often a Contact page link too).
# Used by the "Refresh data" button in the modal.
# ---------------------------------------------------------------------------

_RX_EMAIL = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
_RX_PHONE = re.compile(r"\+?\d[\d\s().\-]{7,}\d")


def _fetch_text(url: str, timeout: float = 8.0) -> str:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                    "Accept": "text/html,*/*"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = resp.headers.get("Content-Type", "")
            if "text" not in ct and "html" not in ct:
                return ""
            raw = resp.read(800_000)
            try:
                return raw.decode("utf-8", errors="replace")
            except Exception:
                return raw.decode("latin-1", errors="replace")
    except Exception:
        return ""


def deep_enrich(biz: Dict[str, Any]) -> Dict[str, Any]:
    """Best-effort: scrape the business website + Wikidata for missing email/phone.
    Returns a partial dict of newly-discovered fields. Never overwrites real values."""
    out: Dict[str, Any] = {}

    # Wikidata first (cheap, structured)
    qid = biz.get("wikidata")
    if qid:
        try:
            data = _wikidata_batch([qid])
            rec = data.get(qid, {})
            if not biz.get("website") and rec.get("website"):
                out["website"] = _normalize_url(rec["website"])
            if not biz.get("phone") and rec.get("phone"):
                out["phone"] = rec["phone"].split(";")[0].strip()
            if not biz.get("email") and rec.get("email"):
                out["email"] = rec["email"]
            if not biz.get("image") and rec.get("image"):
                out["image"] = rec["image"]
        except Exception:
            pass

    # Brand-name → Wikidata search if we have a brand but no QID
    if not qid and biz.get("brand"):
        try:
            url = (
                "https://www.wikidata.org/w/api.php?"
                + urllib.parse.urlencode({
                    "action": "wbsearchentities", "search": biz["brand"],
                    "language": "en", "format": "json", "limit": 1,
                })
            )
            sr = _http_get_json(url, timeout=6)
            hits = (sr or {}).get("search") or []
            if hits:
                qid2 = hits[0].get("id")
                data = _wikidata_batch([qid2])
                rec = data.get(qid2, {})
                if not biz.get("website") and not out.get("website") and rec.get("website"):
                    out["website"] = _normalize_url(rec["website"])
                    out["wikidata"] = qid2
                if not biz.get("image") and not out.get("image") and rec.get("image"):
                    out["image"] = rec["image"]
        except Exception:
            pass

    # Scrape the business website (or the freshly-discovered one) for email/phone
    site = out.get("website") or biz.get("website")
    if site and (not biz.get("email") or not biz.get("phone")):
        html = _fetch_text(site, timeout=8)
        if html:
            if not biz.get("email") and not out.get("email"):
                m = _RX_EMAIL.search(html)
                if m:
                    candidate = m.group(0)
                    if not candidate.lower().endswith((".png", ".jpg", ".gif", ".webp")):
                        out["email"] = candidate
            if not biz.get("phone") and not out.get("phone"):
                m = _RX_PHONE.search(html)
                if m:
                    digits = re.sub(r"\D", "", m.group(0))
                    if 8 <= len(digits) <= 15:
                        out["phone"] = m.group(0).strip()
    return out


def place_details(place_id: str, api_key: str = "") -> Optional[Dict[str, Any]]:
    """Optional Google Place Details (only when GOOGLE_API_KEY is set)."""
    if not api_key or not place_id or place_id.startswith(("osm_", "mock_")):
        return None
    try:
        params = {
            "place_id": place_id,
            "fields": "name,formatted_phone_number,website,opening_hours,rating,user_ratings_total,formatted_address,geometry",
            "key": api_key,
        }
        url = (
            "https://maps.googleapis.com/maps/api/place/details/json?"
            + urllib.parse.urlencode(params)
        )
        data = _http_get_json(url, timeout=10) or {}
        return data.get("result")
    except Exception:
        return None
