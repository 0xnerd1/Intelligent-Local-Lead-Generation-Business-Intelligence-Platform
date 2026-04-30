// Local Lead Finder Pro – core utilities (toasts, fetch, shared state)

window.LeadFinder = (function () {
  // -------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------
  const MESSAGE_TEMPLATES = [
    "Hi! I noticed your business and have a quick idea that's helped similar {category} owners win more bookings — open to a 2-min chat?",
    "Hello! I help local {category} businesses get found online and turn more searches into customers. Can I share a free audit of your listing?",
    "Hi, I work with {category} businesses to set up Google reviews + WhatsApp campaigns. Could I send you one example of what we did for a similar place?",
    "Hi there! Quick question — would 10–15 extra walk-ins a week from your local area be useful right now?",
  ];

  const CATEGORY_LABELS = {
    restaurant: "Restaurant", cafe: "Café", bakery: "Bakery", fast_food: "Fast Food",
    lodging: "Hotel", wedding_hall: "Wedding Hall", gym: "Gym", salon: "Salon & Spa",
    pharmacy: "Pharmacy", dentist: "Dental Clinic", doctor: "Doctor's Clinic",
    school: "School", bank: "Bank", supermarket: "Supermarket",
    clothing: "Clothing Store", electronics: "Electronics", store: "Shop",
    all: "All", other: "Other",
  };

  const CATEGORY_ICONS = {
    restaurant: "bi-cup-hot-fill", cafe: "bi-cup-fill", bakery: "bi-egg-fried",
    fast_food: "bi-bag-heart-fill", lodging: "bi-building", wedding_hall: "bi-heart-fill",
    gym: "bi-trophy-fill", salon: "bi-scissors", pharmacy: "bi-capsule",
    dentist: "bi-emoji-smile-fill", doctor: "bi-heart-pulse-fill",
    school: "bi-mortarboard-fill", bank: "bi-bank2", supermarket: "bi-cart-fill",
    clothing: "bi-bag-fill", electronics: "bi-cpu-fill", store: "bi-shop",
  };

  const STATUSES = ["New", "Contacted", "Interested", "Won", "Not Interested"];

  // -------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------
  function toast(message, kind = "info") {
    const host = document.getElementById("toast-host");
    if (!host) return console.log(`[${kind}]`, message);
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    const icon = kind === "success" ? "bi-check-circle-fill"
               : kind === "error"   ? "bi-exclamation-triangle-fill"
               : "bi-info-circle-fill";
    el.innerHTML = `<i class="bi ${icon}"></i><span>${escape(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(10px)";
      el.style.transition = "all .3s ease";
      setTimeout(() => el.remove(), 300);
    }, 3400);
  }

  // -------------------------------------------------------------------
  // Fetch helpers
  // -------------------------------------------------------------------
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      ...opts,
    });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function logout() {
    try { await api("/api/logout", { method: "POST" }); } catch (_) {}
    window.location.href = "/login";
  }

  // -------------------------------------------------------------------
  // Geolocation
  // -------------------------------------------------------------------
  function getCurrentPosition(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000, ...opts },
      );
    });
  }

  // -------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------
  function escape(s) {
    if (s == null) return "";
    return String(s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function tier(score) {
    if (score >= 65) return "hot";
    if (score >= 35) return "medium";
    return "low";
  }

  // Map of OSM-style social network keys to brand icon + colour
  const SOCIAL_META = {
    facebook:  { icon: "bi-facebook",  color: "text-[#1877f2]", label: "Facebook"  },
    instagram: { icon: "bi-instagram", color: "text-pink-400",   label: "Instagram" },
    twitter:   { icon: "bi-twitter-x", color: "text-slate-200",  label: "X / Twitter" },
    youtube:   { icon: "bi-youtube",   color: "text-red-500",    label: "YouTube"   },
    tiktok:    { icon: "bi-tiktok",    color: "text-slate-200",  label: "TikTok"    },
    linkedin:  { icon: "bi-linkedin",  color: "text-[#0a66c2]",  label: "LinkedIn"  },
    whatsapp:  { icon: "bi-whatsapp",  color: "text-emerald-400",label: "WhatsApp"  },
  };

  function tierLabel(t) {
    return { hot: "🟢 Hot Lead", medium: "🟡 Medium", low: "🔴 Low" }[t] || t;
  }

  function statusPillClass(status) {
    const k = (status || "New").toLowerCase().replace(/\s+/g, "-");
    return `pill pill-status-${k}`;
  }

  function ratingStars(r) {
    if (!r) return "<span class='text-slate-500'>—</span>";
    const full = Math.floor(r);
    const half = (r - full) >= 0.5;
    let html = "";
    for (let i = 0; i < full; i++) html += '<i class="bi bi-star-fill text-amber-400"></i>';
    if (half) html += '<i class="bi bi-star-half text-amber-400"></i>';
    return `${html} <span class="text-slate-300 font-semibold ml-1">${r.toFixed(1)}</span>`;
  }

  function formatDistance(m) {
    if (m == null) return "—";
    if (m < 1000) return `${m} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function whatsAppLink(phone, message) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, "");
    if (!digits) return null;
    const text = message ? `?text=${encodeURIComponent(message)}` : "";
    return `https://wa.me/${digits}${text}`;
  }

  function downloadFile(filename, content, mime = "text/plain") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  }

  return {
    MESSAGE_TEMPLATES, CATEGORY_LABELS, CATEGORY_ICONS, STATUSES, SOCIAL_META,
    toast, api, logout, escape, tier, tierLabel,
    statusPillClass, ratingStars, formatDistance, formatTime,
    whatsAppLink, downloadFile, getCurrentPosition,
  };
})();
