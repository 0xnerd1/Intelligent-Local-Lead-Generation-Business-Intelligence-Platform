"""Honest lead scoring algorithm.

We score on REAL, observable signals only. We do not invent ratings or
review counts. When a value is missing in the source (OSM), we treat it
as missing — never as proof of absence.

Final score (0-100) = Opportunity + Contactability + Recognition
                      + CategoryFit + Proximity + RatingBonus

Each component returns 0 if its inputs are unknown, so the score
naturally degrades for sparsely-listed places without misleading the
user.
"""
from typing import Any, Dict, Tuple


# --------------------------------------------------------------------------
# Weights (sum to ~100 for a fully-listed, ideal lead)
# --------------------------------------------------------------------------

CATEGORY_BONUS = {
    "wedding_hall": 14,
    "lodging": 12, "hotel": 12,
    "restaurant": 11,
    "salon": 10,
    "dentist": 10,
    "gym": 9,
    "cafe": 9,
    "doctor": 8,
    "clothing": 8,
    "electronics": 7,
    "fast_food": 7,
    "bakery": 7,
    "school": 6,
    "supermarket": 5,
    "pharmacy": 5,
    "bank": 4,
    "store": 4, "shop": 4,
}


def _opportunity(b: Dict[str, Any]) -> int:
    """Sales opportunity = what's MISSING that we could help them fix.
    Capped to 35. Most weight on website (the typical SMB pitch)."""
    score = 0
    socials = b.get("socials") or {}
    if not b.get("website"):
        score += 18
    if not b.get("phone"):
        score += 8
    if not b.get("email"):
        score += 5
    if not socials:
        score += 4
    return min(score, 35)


def _contactability(b: Dict[str, Any]) -> int:
    """How easy is it for me to actually reach this lead today?
    Capped to 20."""
    score = 0
    if b.get("phone"):
        score += 10
    if b.get("email"):
        score += 4
    socials = b.get("socials") or {}
    if "whatsapp" in socials:
        score += 4
    elif socials:
        score += 2
    return min(score, 20)


def _recognition(b: Dict[str, Any]) -> int:
    """A real, named, verifiable business is worth more than an empty pin.
    Capped to 15."""
    score = 0
    if b.get("brand"):
        score += 6
    if b.get("wikidata"):
        score += 5
    if b.get("opening_hours"):
        score += 2
    if b.get("address"):
        score += 2
    return min(score, 15)


def _category_fit(category: str) -> int:
    if not category:
        return 0
    return CATEGORY_BONUS.get(category.lower().replace(" ", "_"), 3)


def _proximity(b: Dict[str, Any]) -> int:
    d = b.get("distance_m")
    if d is None:
        return 0
    if d < 1000:
        return 8
    if d < 3000:
        return 6
    if d < 6000:
        return 4
    if d < 10000:
        return 2
    return 0


def _rating_bonus(b: Dict[str, Any]) -> int:
    """Only awarded when we have a REAL rating (e.g. OSM `stars` for hotels,
    or a Google rating). Otherwise 0 — no fabrication."""
    r = b.get("rating")
    if r is None:
        return 0
    try:
        r = float(r)
    except (TypeError, ValueError):
        return 0
    if r >= 4.5:
        return 8
    if r >= 4.0:
        return 6
    if r >= 3.5:
        return 4
    return 2


def calculate_score(b: Dict[str, Any]) -> Tuple[int, Dict[str, int]]:
    breakdown = {
        "opportunity": _opportunity(b),
        "contactability": _contactability(b),
        "recognition": _recognition(b),
        "category": _category_fit(b.get("category", "") or ""),
        "proximity": _proximity(b),
        "rating": _rating_bonus(b),
    }
    score = sum(breakdown.values())
    score = max(0, min(int(score), 100))
    return score, breakdown


def lead_tier(score: int) -> str:
    if score >= 65:
        return "hot"
    if score >= 35:
        return "medium"
    return "low"


def score_breakdown(business: Dict[str, Any]) -> Dict[str, int]:
    _, bd = calculate_score(business)
    return bd
