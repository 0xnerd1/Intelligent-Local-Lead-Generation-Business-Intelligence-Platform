"""CSV and WhatsApp list export helpers."""
import csv
import io
from typing import Iterable, List, Dict
from urllib.parse import quote


CSV_FIELDS = [
    "business_name",
    "category",
    "rating",
    "total_reviews",
    "address",
    "phone",
    "website",
    "lead_score",
    "status",
    "maps_link",
]


def to_csv(rows: Iterable[Dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({k: row.get(k, "") for k in CSV_FIELDS})
    return buf.getvalue()


def whatsapp_list(rows: Iterable[Dict], message: str = "") -> List[Dict]:
    """Return wa.me links for every business that has a phone."""
    encoded = quote(message) if message else ""
    out: List[Dict] = []
    for r in rows:
        phone = (r.get("phone") or "").strip()
        if not phone:
            continue
        digits = "".join(c for c in phone if c.isdigit())
        if not digits:
            continue
        link = f"https://wa.me/{digits}"
        if encoded:
            link += f"?text={encoded}"
        out.append({
            "business_name": r.get("business_name"),
            "phone": phone,
            "wa_link": link,
        })
    return out
