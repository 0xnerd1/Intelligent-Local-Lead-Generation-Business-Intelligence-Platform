// Local Lead Finder Pro – Dashboard map + search orchestration

window.Dashboard = (function () {
  const LF = window.LeadFinder;
  let map, cluster, heatLayer, baseLight, baseDark, currentBase;
  let userMarker = null;
  let markersByPlaceId = {};
  let lastResults = [];
  let lastCenter = null;
  let activePlaceId = null;
  let tierFilter = "all";
  let mapStyle = "dark";

  function init() {
    initMap();
    bindForm();
    bindResultControls();
    bindTierChips();
    bindMisc();
    bindModal();
    refreshSavedCount();
    // Auto-run a default search so the dashboard isn't empty on first load
    runSearch({ city: "Lahore", radius: 5000, category: "all" });
  }

  // --------------------------------------------------------------
  // Map
  // --------------------------------------------------------------
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true })
      .setView([31.5497, 74.3436], 12);

    baseDark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: "© OpenStreetMap, © CARTO",
    });
    baseLight = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: "© OpenStreetMap, © CARTO",
    });
    currentBase = baseDark.addTo(map);

    cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50 });
    map.addLayer(cluster);
  }

  function clearMarkers() {
    cluster.clearLayers();
    markersByPlaceId = {};
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }
  }

  function addMarker(b) {
    if (b.lat == null || b.lng == null) return;
    const tier = b.tier || LF.tier(b.lead_score);
    const icon = L.divIcon({
      className: "",
      html: `<div class="lf-marker lf-marker-${tier}${b.saved ? ' is-saved' : ''}"><span>${b.lead_score}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
    const m = L.marker([b.lat, b.lng], { icon });
    m.bindPopup(popupHtml(b), { maxWidth: 280 });
    m.on("click", () => selectBusiness(b.place_id));
    cluster.addLayer(m);
    markersByPlaceId[b.place_id] = m;
  }

  function popupHtml(b) {
    const ratingPart = (b.rating != null)
      ? `${LF.ratingStars(b.rating)}${b.total_reviews ? ` <span class="text-slate-400">(${b.total_reviews})</span>` : ""}`
      : `<span class="text-slate-500">No rating in source</span>`;
    return `
      <div class="font-semibold text-sm">${LF.escape(b.business_name)}</div>
      <div class="text-xs text-slate-500 mb-1">${LF.escape(b.category_label || b.category || "")}</div>
      <div class="text-xs">${ratingPart}</div>
      <div class="text-[11px] text-slate-500 mt-1">${LF.formatDistance(b.distance_m)} away</div>
      <div class="mt-1.5 text-xs"><span class="pill pill-${b.tier}">Score ${b.lead_score}</span></div>
    `;
  }

  function buildHeatmap() {
    if (!lastResults.length || !window.L.heatLayer) return;
    const points = lastResults
      .filter(b => b.lat != null && b.lng != null)
      .map(b => [b.lat, b.lng, Math.max(0.3, b.lead_score / 100)]);
    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.heatLayer(points, {
      radius: 28, blur: 22, maxZoom: 17,
      gradient: { 0.2: "#3b82f6", 0.5: "#fbbf24", 0.85: "#ef4444" },
    }).addTo(map);
  }

  function setUserMarker(lat, lng) {
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: '<div class="lf-user-marker"><div class="lf-user-pulse"></div></div>',
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
    }).addTo(map).bindPopup("Your location");
  }

  // --------------------------------------------------------------
  // Search
  // --------------------------------------------------------------
  function bindForm() {
    const form = document.getElementById("search-form");
    const radius = document.getElementById("radius-input");
    const radiusLabel = document.getElementById("radius-label");
    radius.addEventListener("input", () => {
      radiusLabel.textContent = `${(radius.value / 1000).toFixed(1)} km`;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      runSearch({
        city: fd.get("city"),
        radius: Number(fd.get("radius")),
        category: fd.get("category"),
        min_rating: Number(fd.get("min_rating") || 0),
        min_reviews: Number(fd.get("min_reviews") || 0),
        no_cache: form.querySelector("#no-cache-toggle")?.checked,
      });
    });

    document.getElementById("locate-me").addEventListener("click", useMyLocation);
  }

  async function useMyLocation() {
    const btn = document.getElementById("locate-me");
    btn.innerHTML = '<div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>';
    try {
      const pos = await LF.getCurrentPosition();
      setUserMarker(pos.lat, pos.lng);
      map.setView([pos.lat, pos.lng], 14);
      const radius = Number(document.querySelector("[name='radius']").value || 5000);
      const category = document.querySelector("[name='category']").value || "all";
      runSearch({ lat: pos.lat, lng: pos.lng, radius, category });
    } catch (e) {
      LF.toast(e.message || "Could not get your location", "error");
    } finally {
      btn.innerHTML = '<i class="bi bi-geo-alt-fill text-blue-400"></i>';
    }
  }

  async function runSearch(payload) {
    showLoading(true, payload.lat ? "Finding businesses near you…" : "Searching live businesses…");
    try {
      const data = await LF.api("/api/search", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      lastResults = data.businesses || [];
      lastCenter = data.center;
      clearMarkers();
      lastResults.forEach(addMarker);
      if (data.center) map.setView([data.center.lat, data.center.lng], lastResults.length ? 13 : 12);
      renderTable(applyTierFilter(lastResults));
      updateStats(lastResults);
      Charts.update(lastResults);
      updateSourceBadge(data);
      updateResolvedLabel(data);

      const sourceTxt = data.demo_mode ? " (demo fallback)"
        : (data.source === "openstreetmap" ? " · live OSM" : (data.source === "google" ? " · Google" : ""));
      LF.toast(
        `Found ${lastResults.length} businesses · ${data.hot_leads} hot${sourceTxt}`,
        data.demo_mode ? "info" : "success"
      );
    } catch (e) {
      LF.toast(e.message, "error");
    } finally {
      showLoading(false);
    }
  }

  function showLoading(yes, text) {
    document.getElementById("map-loading").classList.toggle("hidden", !yes);
    document.getElementById("map-loading").classList.toggle("flex", yes);
    if (text) document.getElementById("map-loading-text").textContent = text;
  }

  function updateSourceBadge(data) {
    const badge = document.getElementById("data-source-badge");
    if (!badge) return;
    badge.classList.remove("hidden");
    if (data.demo_mode) {
      badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold uppercase tracking-wider";
      badge.innerHTML = '<i class="bi bi-cone-striped"></i> Demo';
    } else {
      badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold uppercase tracking-wider";
      badge.innerHTML = '<i class="bi bi-broadcast"></i> Live OSM';
    }
  }

  function updateResolvedLabel(data) {
    const el = document.getElementById("resolved-location");
    if (!el) return;
    const loc = data.location_label;
    const center = data.center;
    if (loc || center) {
      el.textContent = `📍 ${loc || ""}${center ? `  ·  ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}` : ""}`;
    }
  }

  // --------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------
  function updateStats(rows) {
    document.getElementById("stat-found").textContent = rows.length;
    document.getElementById("stat-hot").textContent = rows.filter(r => r.lead_score >= 70).length;
    const ratings = rows.filter(r => r.rating).map(r => r.rating);
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "–";
    document.getElementById("stat-rating").textContent = avg;
    const dists = rows.filter(r => r.distance_m != null).map(r => r.distance_m);
    const avgD = dists.length ? Math.round(dists.reduce((a, b) => a + b, 0) / dists.length) : null;
    document.getElementById("stat-distance").textContent = avgD == null ? "–" : LF.formatDistance(avgD);
  }

  async function refreshSavedCount() {
    try {
      const s = await LF.api("/api/analytics/summary");
      document.getElementById("stat-saved").textContent = s.total_leads || 0;
    } catch (_) {}
  }

  // --------------------------------------------------------------
  // Table
  // --------------------------------------------------------------
  function bindResultControls() {
    document.getElementById("results-filter").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = applyTierFilter(lastResults).filter(r =>
        (r.business_name || "").toLowerCase().includes(q) ||
        (r.address || "").toLowerCase().includes(q) ||
        (r.category_label || r.category || "").toLowerCase().includes(q)
      );
      renderTable(filtered);
    });
    document.getElementById("export-csv").addEventListener("click", () => exportCsv());
    document.getElementById("export-wa").addEventListener("click", () => exportWa());
  }

  function bindTierChips() {
    document.querySelectorAll("[data-tier-filter]").forEach(btn => {
      btn.addEventListener("click", () => {
        tierFilter = btn.dataset.tierFilter;
        document.querySelectorAll("[data-tier-filter]").forEach(b => b.classList.toggle("is-active", b === btn));
        renderTable(applyTierFilter(lastResults));
      });
    });
  }

  function applyTierFilter(rows) {
    if (tierFilter === "all") return rows;
    return rows.filter(r => (r.tier || LF.tier(r.lead_score)) === tierFilter);
  }

  function bindMisc() {
    document.getElementById("toggle-heatmap").addEventListener("click", () => {
      if (heatLayer) {
        map.removeLayer(heatLayer); heatLayer = null;
        LF.toast("Heatmap off", "info");
      } else {
        buildHeatmap();
        LF.toast("Heatmap on", "info");
      }
    });
    document.getElementById("bulk-save-hot").addEventListener("click", bulkSaveHot);
    document.getElementById("map-style-btn").addEventListener("click", toggleMapStyle);
  }

  function toggleMapStyle() {
    const btn = document.getElementById("map-style-btn");
    map.removeLayer(currentBase);
    if (mapStyle === "dark") {
      currentBase = baseLight.addTo(map);
      mapStyle = "light";
      btn.innerHTML = '<i class="bi bi-sun-fill"></i> Light';
    } else {
      currentBase = baseDark.addTo(map);
      mapStyle = "dark";
      btn.innerHTML = '<i class="bi bi-moon-stars-fill"></i> Dark';
    }
  }

  async function bulkSaveHot() {
    const hot = lastResults.filter(b => b.lead_score >= 70 && !b.saved);
    if (!hot.length) return LF.toast("No new hot leads to save.", "info");
    try {
      const res = await LF.api("/api/leads/bulk-save", {
        method: "POST",
        body: JSON.stringify({ leads: hot.map(serializeLead) }),
      });
      hot.forEach(b => b.saved = true);
      LF.toast(`Saved ${res.added} hot lead${res.added === 1 ? "" : "s"}.`, "success");
      renderTable(applyTierFilter(lastResults));
      refreshSavedCount();
    } catch (e) {
      LF.toast(e.message, "error");
    }
  }

  function renderTable(rows) {
    const tbody = document.getElementById("results-tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-slate-500">No results match your filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(b => `
      <tr class="result-row${activePlaceId === b.place_id ? " is-active" : ""}" data-id="${LF.escape(b.place_id)}">
        <td class="px-4 py-3">
          <div class="font-semibold flex items-center gap-1.5">
            <i class="bi ${LF.CATEGORY_ICONS[b.category] || 'bi-shop'} text-slate-400"></i>
            ${LF.escape(b.business_name)}
          </div>
          <div class="text-[11px] text-slate-400 truncate max-w-[280px]">${LF.escape(b.address || "—")}</div>
        </td>
        <td class="px-4 py-3 text-slate-300">${LF.escape(b.category_label || b.category || "—")}</td>
        <td class="px-4 py-3 text-right">${LF.ratingStars(b.rating)}</td>
        <td class="px-4 py-3 text-right text-slate-300">${LF.formatDistance(b.distance_m)}</td>
        <td class="px-4 py-3 text-right">
          <div class="flex items-center gap-2 justify-end">
            <span class="text-mono font-bold ${tierColor(b.tier)}">${b.lead_score}</span>
            <div class="score-bar w-20"><div class="score-fill-${b.tier}" style="width:${b.lead_score}%"></div></div>
          </div>
        </td>
        <td class="px-4 py-3 text-center"><span class="pill pill-${b.tier}">${LF.tierLabel(b.tier)}</span></td>
        <td class="px-4 py-3 text-right">
          <button data-act="save" data-id="${LF.escape(b.place_id)}" class="btn-ghost ${b.saved ? 'text-emerald-400 border-emerald-500/40' : ''}">
            <i class="bi ${b.saved ? 'bi-bookmark-check-fill' : 'bi-bookmark-plus'}"></i>
            ${b.saved ? 'Saved' : 'Save'}
          </button>
        </td>
      </tr>
    `).join("");
    tbody.querySelectorAll("tr.result-row").forEach(tr => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-act]")) return;
        selectBusiness(tr.dataset.id);
      });
    });
    tbody.querySelectorAll("[data-act='save']").forEach(btn => {
      btn.addEventListener("click", () => saveLead(btn.dataset.id));
    });
  }

  function tierColor(t) {
    return { hot: "text-emerald-400", medium: "text-amber-400", low: "text-rose-400" }[t] || "";
  }

  // --------------------------------------------------------------
  // Details panel
  // --------------------------------------------------------------
  function selectBusiness(placeId, opts = {}) {
    activePlaceId = placeId;
    const b = lastResults.find(r => r.place_id === placeId);
    if (!b) return;

    document.querySelectorAll("#results-tbody .result-row").forEach(r =>
      r.classList.toggle("is-active", r.dataset.id === placeId));

    if (markersByPlaceId[placeId]) {
      map.setView(markersByPlaceId[placeId].getLatLng(), Math.max(map.getZoom(), 15));
      markersByPlaceId[placeId].openPopup();
    }
    renderDetails(b);
    if (opts.openModal !== false) openLeadModal(b);
  }

  function renderDetails(b) {
    document.getElementById("details-empty").classList.add("hidden");
    const root = document.getElementById("details-content");
    root.classList.remove("hidden");
    const wa = LF.whatsAppLink(b.phone, "");
    const sb = b.score_breakdown || {};
    root.innerHTML = `
      <div class="space-y-3">
        <div>
          <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-400">
            <i class="bi ${LF.CATEGORY_ICONS[b.category] || 'bi-shop'} text-blue-400"></i>
            ${LF.escape(b.category_label || b.category || "")}
            ${b.brand ? `<span class="text-slate-500">· ${LF.escape(b.brand)}</span>` : ""}
          </div>
          <h3 class="text-lg font-black tracking-tight leading-snug">${LF.escape(b.business_name)}</h3>
          <div class="text-xs text-slate-400 mt-0.5">${LF.escape(b.address || "Address not listed")}</div>
        </div>

        <div class="flex items-center gap-3 text-sm flex-wrap">
          ${b.rating != null
            ? `${LF.ratingStars(b.rating)}${b.total_reviews ? `<span class="text-slate-400 text-xs">${b.total_reviews.toLocaleString()} reviews</span>` : ""}`
            : `<span class="text-slate-500 text-xs"><i class="bi bi-star"></i> No rating in source</span>`}
          <span class="text-slate-500 text-xs"><i class="bi bi-rulers"></i> ${LF.formatDistance(b.distance_m)}</span>
          ${typeof b.data_completeness === "number" ? `<span class="text-slate-500 text-xs"><i class="bi bi-bar-chart"></i> ${b.data_completeness}% complete</span>` : ""}
        </div>

        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="text-slate-400 font-semibold uppercase tracking-wider">Lead score</span>
            <span class="font-bold text-mono ${tierColor(b.tier)}">${b.lead_score}/100</span>
          </div>
          <div class="score-bar"><div class="score-fill-${b.tier}" style="width:${b.lead_score}%"></div></div>
          <div class="mt-2 flex items-center gap-1.5 flex-wrap">
            <span class="pill pill-${b.tier}">${LF.tierLabel(b.tier)}</span>
            ${sb.opportunity ? `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700" title="Sales gaps we can pitch on">+${sb.opportunity} opp</span>` : ""}
            ${sb.contactability ? `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700" title="How reachable they are today">+${sb.contactability} reach</span>` : ""}
            ${b.enriched_from ? `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" title="Filled in from external source"><i class="bi bi-stars"></i> ${LF.escape(b.enriched_from)}</span>` : ""}
          </div>
        </div>

        <div class="grid grid-cols-1 gap-2 text-sm">
          ${b.phone ? `<a href="tel:${LF.escape(b.phone)}" class="flex items-center gap-2 text-slate-300 hover:text-white"><i class="bi bi-telephone-fill text-blue-400"></i> ${LF.escape(b.phone)}</a>` :
            `<div class="flex items-center gap-2 text-slate-500"><i class="bi bi-telephone"></i> Phone not in source</div>`}
          ${b.website ? `<a href="${LF.escape(b.website)}" target="_blank" class="flex items-center gap-2 text-slate-300 hover:text-white truncate"><i class="bi bi-globe text-blue-400"></i> ${LF.escape(b.website.replace(/^https?:\/\//, '').slice(0, 36))}</a>` :
            `<div class="flex items-center gap-2 text-slate-500"><i class="bi bi-globe"></i> Website not in source</div>`}
          ${b.email ? `<a href="mailto:${LF.escape(b.email)}" class="flex items-center gap-2 text-slate-300 hover:text-white"><i class="bi bi-envelope-fill text-blue-400"></i> ${LF.escape(b.email)}</a>` : ""}
          ${b.opening_hours ? `<div class="flex items-start gap-2 text-slate-400 text-xs"><i class="bi bi-clock-fill text-blue-400"></i> <span class="truncate">${LF.escape(b.opening_hours)}</span></div>` : ""}
          ${b.maps_link ? `<a href="${LF.escape(b.maps_link)}" target="_blank" class="flex items-center gap-2 text-slate-300 hover:text-white"><i class="bi bi-geo-alt-fill text-blue-400"></i> Open in maps</a>` : ""}
        </div>

        <div class="grid grid-cols-2 gap-2 pt-2">
          <button data-act="wa" class="btn-ghost ${wa ? '' : 'opacity-40 cursor-not-allowed'}" ${wa ? '' : 'disabled'}>
            <i class="bi bi-whatsapp text-emerald-400"></i> WhatsApp
          </button>
          <button data-act="save" class="btn-primary !text-xs ${b.saved ? '!bg-slate-700' : ''}">
            <i class="bi ${b.saved ? 'bi-bookmark-check-fill' : 'bi-bookmark-plus'}"></i>
            ${b.saved ? 'Saved' : 'Save lead'}
          </button>
        </div>

        <details class="pt-1">
          <summary class="text-xs font-semibold text-slate-300 uppercase tracking-wider cursor-pointer">Pick a message template</summary>
          <div class="mt-2 space-y-2">
            ${LF.MESSAGE_TEMPLATES.map((t, i) => `
              <button data-act="wa-template" data-tpl="${i}" class="w-full text-left p-2 rounded-md bg-slate-800/60 border border-slate-700 hover:border-blue-500/60 transition text-xs leading-snug">
                <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Template ${i + 1}</div>
                ${LF.escape(t.replace("{category}", (b.category_label || "your").toLowerCase()))}
              </button>
            `).join("")}
          </div>
        </details>
      </div>
    `;

    root.querySelector("[data-act='wa']")?.addEventListener("click", () => sendWhatsApp(b, ""));
    root.querySelector("[data-act='save']")?.addEventListener("click", () => saveLead(b.place_id));
    root.querySelectorAll("[data-act='wa-template']").forEach(btn => {
      btn.addEventListener("click", () => {
        const tpl = LF.MESSAGE_TEMPLATES[Number(btn.dataset.tpl)]
          .replace("{category}", (b.category_label || "your").toLowerCase());
        sendWhatsApp(b, tpl);
      });
    });
  }

  function sendWhatsApp(b, message) {
    const link = LF.whatsAppLink(b.phone, message);
    if (!link) return LF.toast("This business has no phone number.", "error");
    window.open(link, "_blank");
    if (b.saved_id) {
      LF.api("/api/outreach", {
        method: "POST",
        body: JSON.stringify({
          lead_id: b.saved_id,
          contact_method: "WhatsApp",
          message_template: message,
        }),
      }).catch(() => {});
    }
  }

  // --------------------------------------------------------------
  // Save lead
  // --------------------------------------------------------------
  function serializeLead(b) {
    return {
      place_id: b.place_id,
      business_name: b.business_name,
      category: b.category,
      rating: b.rating,
      total_reviews: b.total_reviews,
      address: b.address,
      phone: b.phone,
      website: b.website,
      email: b.email,
      maps_link: b.maps_link,
      lat: b.lat, lng: b.lng,
      lead_score: b.lead_score,
    };
  }

  async function saveLead(placeId) {
    const b = lastResults.find(r => r.place_id === placeId);
    if (!b) return;
    try {
      const res = await LF.api("/api/leads/save", {
        method: "POST",
        body: JSON.stringify(serializeLead(b)),
      });
      b.saved = true;
      b.saved_id = res.lead.id;
      LF.toast(res.already_saved ? "Already in your saved leads." : "Lead saved!", "success");
      renderTable(applyTierFilter(lastResults));
      if (activePlaceId === placeId) renderDetails(b);
      refreshSavedCount();
    } catch (e) {
      LF.toast(e.message, "error");
    }
  }

  // --------------------------------------------------------------
  // Exports
  // --------------------------------------------------------------
  function exportCsv() {
    if (!lastResults.length) return LF.toast("Run a search first.", "info");
    const rows = lastResults.map(b => ({
      business_name: b.business_name,
      category: b.category_label || b.category,
      rating: b.rating,
      total_reviews: b.total_reviews,
      address: b.address,
      phone: b.phone || "",
      website: b.website || "",
      email: b.email || "",
      distance_m: b.distance_m ?? "",
      lead_score: b.lead_score,
      tier: b.tier,
      lat: b.lat, lng: b.lng,
      maps_link: b.maps_link,
    }));
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => csvEscape(r[h])).join(",")),
    ].join("\n");
    LF.downloadFile(`leads-${Date.now()}.csv`, csv, "text/csv");
    LF.toast(`Exported ${rows.length} rows.`, "success");
  }

  function exportWa() {
    const items = lastResults
      .filter(b => b.phone)
      .map(b => ({ name: b.business_name, phone: b.phone, link: LF.whatsAppLink(b.phone, "") }));
    if (!items.length) return LF.toast("No businesses with phone numbers.", "info");
    const text = items.map(i => `${i.name} — ${i.phone} — ${i.link}`).join("\n");
    LF.downloadFile(`whatsapp-leads-${Date.now()}.txt`, text, "text/plain");
    LF.toast(`Exported ${items.length} WhatsApp links.`, "success");
  }

  function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  }

  // --------------------------------------------------------------
  // Lead detail modal
  // --------------------------------------------------------------
  let modalBusiness = null;
  let modalMiniMap = null;
  let modalMiniMarker = null;
  let notesSaveTimer = null;

  function bindModal() {
    const modal = document.getElementById("lead-modal");
    if (!modal) return;
    modal.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act || !modalBusiness) return;
      const b = modalBusiness;
      switch (act) {
        case "close-modal": closeLeadModal(); break;
        case "lm-call":
          if (b.phone) window.location.href = `tel:${b.phone}`;
          else LF.toast("No phone number for this business.", "info");
          break;
        case "lm-wa": sendWhatsApp(b, ""); break;
        case "lm-email":
          if (b.email) window.location.href = `mailto:${b.email}`;
          else LF.toast("No email on record.", "info");
          break;
        case "lm-dir": {
          if (b.lat == null || b.lng == null) return LF.toast("No coordinates available.", "info");
          const url = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`;
          window.open(url, "_blank");
          break;
        }
        case "lm-save": saveLead(b.place_id); break;
        case "lm-share-link":
          copyText(b.maps_link || `https://www.google.com/maps?q=${b.lat},${b.lng}`, "Maps link copied");
          break;
        case "lm-share-summary":
          copyText(buildSummary(b), "Lead summary copied");
          break;
        case "lm-copy-coords":
          if (b.lat != null) copyText(`${b.lat}, ${b.lng}`, "Coordinates copied");
          break;
        case "lm-refresh":
          refreshLead(b);
          break;
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("lead-modal").classList.contains("hidden")) {
        closeLeadModal();
      }
    });
  }

  function buildSummary(b) {
    return [
      b.business_name,
      b.category_label || b.category,
      b.address,
      b.phone ? `Phone: ${b.phone}` : "",
      b.website ? `Web: ${b.website}` : "",
      `Score: ${b.lead_score}/100 (${LF.tierLabel(b.tier)})`,
      b.maps_link || "",
    ].filter(Boolean).join("\n");
  }

  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      LF.toast(msg || "Copied", "success");
    } catch (_) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); LF.toast(msg || "Copied", "success"); }
      catch (e) { LF.toast("Could not copy.", "error"); }
      finally { ta.remove(); }
    }
  }

  function openLeadModal(b) {
    modalBusiness = b;
    const modal = document.getElementById("lead-modal");
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    renderModal(b);
  }

  function closeLeadModal() {
    document.getElementById("lead-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    modalBusiness = null;
    if (modalMiniMap) {
      modalMiniMap.remove();
      modalMiniMap = null;
      modalMiniMarker = null;
    }
  }

  function renderModal(b) {
    const $ = (id) => document.getElementById(id);
    $("lm-icon").innerHTML = `<i class="bi ${LF.CATEGORY_ICONS[b.category] || 'bi-shop'}"></i>`;
    $("lm-cat").textContent = (b.category_label || b.category || "Business") + (b.brand ? ` · ${b.brand}` : "");
    $("lm-title").textContent = b.business_name || "Unknown";
    $("lm-address").textContent = b.address || "Address not listed";
    $("lm-score").textContent = b.lead_score;
    $("lm-score").className = `text-3xl font-black text-mono leading-none lm-tier-${b.tier}`;
    $("lm-tier").textContent = LF.tierLabel(b.tier);
    $("lm-tier").className = `text-[10px] uppercase tracking-wider mt-1 lm-tier-${b.tier}`;
    const fill = $("lm-score-fill");
    fill.style.width = `${b.lead_score}%`;
    fill.className = `score-fill-${b.tier}`;

    const ratingHtml = (b.rating != null)
      ? `<span>${LF.ratingStars(b.rating)}${b.total_reviews ? ` <span class="text-slate-400">${b.total_reviews.toLocaleString()} reviews</span>` : ""}</span>`
      : `<span class="text-slate-500"><i class="bi bi-star"></i> No rating in source</span>`;
    $("lm-meta").innerHTML = `
      ${ratingHtml}
      <span><i class="bi bi-rulers text-slate-400"></i> ${LF.formatDistance(b.distance_m)}</span>
      ${b.opening_hours ? `<span class="truncate max-w-[280px]"><i class="bi bi-clock text-slate-400"></i> ${LF.escape(b.opening_hours)}</span>` : ""}
      ${b.brand ? `<span><i class="bi bi-award text-amber-400"></i> ${LF.escape(b.brand)}</span>` : ""}
      ${b.enriched_from ? `<span class="text-emerald-400 text-[10px] uppercase tracking-wider"><i class="bi bi-stars"></i> Enriched · ${LF.escape(b.enriched_from)}</span>` : ""}
    `;

    // contact rows
    $("lm-contact").innerHTML = [
      contactRow("Phone",   b.phone,   b.phone   ? `tel:${b.phone}` : null),
      contactRow("Website", b.website, b.website),
      contactRow("Email",   b.email,   b.email ? `mailto:${b.email}` : null),
      contactRow("Address", b.address, null),
      contactRow("Hours",   b.opening_hours, null),
    ].filter(Boolean).join("");
    bindCopyRows($("lm-contact"));

    // socials chips + completeness bar + refresh button
    renderSocialsAndQuality(b);

    // score breakdown — honest signal-based labels
    const sb = b.score_breakdown || {};
    const items = [
      { label: "Sales opportunity (gaps to fix)", val: sb.opportunity ?? 0, max: 35 },
      { label: "Contactability (phone/email/social)", val: sb.contactability ?? 0, max: 20 },
      { label: "Recognition (named brand, hours, address)", val: sb.recognition ?? 0, max: 15 },
      { label: "Category fit", val: sb.category ?? 0, max: 14 },
      { label: "Proximity", val: sb.proximity ?? 0, max: 8 },
      { label: "Rating bonus (only if real rating)", val: sb.rating ?? 0, max: 8 },
    ];
    $("lm-breakdown").innerHTML = items.map(i => `
      <div class="lm-bd-row">
        <div class="lm-bd-label">${i.label}</div>
        <div class="lm-bd-bar"><div style="width:${Math.min(100, (i.val / i.max) * 100)}%"></div></div>
        <div class="lm-bd-val">+${i.val}</div>
      </div>
    `).join("");

    // save button label
    const saveBtn = document.querySelector('[data-act="lm-save"]');
    saveBtn.classList.toggle("is-saved", !!b.saved);
    saveBtn.querySelector('[data-slot="save-label"]').textContent = b.saved ? "Saved" : "Save lead";
    saveBtn.querySelector("i").className = `bi ${b.saved ? 'bi-bookmark-check-fill' : 'bi-bookmark-plus'}`;

    // disable empty actions
    document.querySelector('[data-act="lm-call"]').disabled = !b.phone;
    document.querySelector('[data-act="lm-email"]').disabled = !b.email;
    document.querySelector('[data-act="lm-wa"]').disabled = !b.phone;
    document.querySelector('[data-act="lm-dir"]').disabled = (b.lat == null);

    // templates
    $("lm-templates").innerHTML = LF.MESSAGE_TEMPLATES.map((t, i) => `
      <button data-tpl="${i}" class="w-full text-left p-2 rounded-md bg-slate-900/60 border border-slate-700 hover:border-blue-500/60 transition text-xs leading-snug">
        <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Template ${i + 1}</div>
        ${LF.escape(t.replace("{category}", (b.category_label || "your").toLowerCase()))}
      </button>
    `).join("");
    $("lm-templates").querySelectorAll("button[data-tpl]").forEach(btn => {
      btn.addEventListener("click", () => {
        const tpl = LF.MESSAGE_TEMPLATES[Number(btn.dataset.tpl)]
          .replace("{category}", (b.category_label || "your").toLowerCase());
        sendWhatsApp(b, tpl);
      });
    });

    // mini map
    setTimeout(() => initMiniMap(b), 60);

    // coords
    $("lm-coords").querySelector("span").textContent =
      (b.lat != null && b.lng != null) ? `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}` : "No coordinates";

    // notes/pipeline + outreach (only when saved)
    const notesCard = $("lm-notes-card");
    const outCard = $("lm-outreach-card");
    if (b.saved && b.saved_id) {
      notesCard.classList.remove("hidden");
      outCard.classList.remove("hidden");
      renderStatusChips(b);
      const ta = $("lm-notes");
      ta.value = b.notes || "";
      ta.oninput = () => scheduleNotesSave(b, ta.value);
      loadOutreachHistory(b.saved_id);
    } else {
      notesCard.classList.add("hidden");
      outCard.classList.add("hidden");
    }
  }

  function contactRow(label, value, href) {
    const empty = !value;
    const valHtml = empty
      ? `<span class="lm-value is-empty" title="Not present in OpenStreetMap — try Find more">Not in source</span>`
      : (href
          ? `<a href="${LF.escape(href)}"${href.startsWith("http") ? ' target="_blank"' : ''} class="lm-value">${LF.escape(value)}</a>`
          : `<span class="lm-value">${LF.escape(value)}</span>`);
    const copyBtn = empty ? "" : `<button class="lm-copy" data-copy="${LF.escape(value)}" title="Copy"><i class="bi bi-clipboard"></i></button>`;
    return `<div class="lm-copy-row"><span class="lm-label">${label}</span>${valHtml}${copyBtn}</div>`;
  }

  function renderSocialsAndQuality(b) {
    const socials = b.socials || {};
    const keys = Object.keys(socials);
    const socEl = document.getElementById("lm-socials");
    if (keys.length) {
      socEl.innerHTML = keys.map(k => {
        const meta = LF.SOCIAL_META[k] || { icon: "bi-link-45deg", color: "text-slate-300", label: k };
        return `<a href="${LF.escape(socials[k])}" target="_blank" rel="noopener"
                  class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-900/70 border border-slate-700 hover:border-blue-500/60 text-[11px] text-slate-200 transition"
                  title="${meta.label}">
                  <i class="bi ${meta.icon} ${meta.color}"></i> ${meta.label}
                </a>`;
      }).join("");
    } else {
      socEl.innerHTML = `<span class="text-[11px] text-slate-500"><i class="bi bi-share"></i> No social profiles in source</span>`;
    }

    const completeness = (typeof b.data_completeness === "number") ? b.data_completeness : null;
    const sourceLabel = b.source === "openstreetmap" ? "OpenStreetMap"
      : b.source === "google" ? "Google Places"
      : b.source === "mock" ? "Demo data"
      : (b.source || "Unknown");
    const sourceHref = b.maps_link || (b.lat != null ? `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=18/${b.lat}/${b.lng}` : null);
    const wikipediaLink = b.wikipedia ? wikipediaUrl(b.wikipedia) : null;
    const wikidataLink = b.wikidata ? `https://www.wikidata.org/wiki/${LF.escape(b.wikidata)}` : null;

    document.getElementById("lm-quality").innerHTML = `
      ${completeness != null ? `
        <div class="flex items-center gap-2 text-[11px] mb-1.5">
          <span class="text-slate-400 uppercase tracking-wider font-semibold">Listing completeness</span>
          <div class="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
            <div class="h-full ${completeness >= 70 ? 'bg-emerald-500' : completeness >= 40 ? 'bg-amber-500' : 'bg-rose-500'}"
                 style="width:${completeness}%"></div>
          </div>
          <span class="text-slate-300 font-mono">${completeness}%</span>
        </div>` : ""}
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-slate-400">
        <span><i class="bi bi-database text-slate-500"></i> Source:
          ${sourceHref ? `<a href="${LF.escape(sourceHref)}" target="_blank" rel="noopener" class="text-blue-300 hover:underline">${LF.escape(sourceLabel)}</a>` : LF.escape(sourceLabel)}
        </span>
        ${wikidataLink ? `<a href="${wikidataLink}" target="_blank" rel="noopener" class="text-blue-300 hover:underline"><i class="bi bi-link-45deg"></i> Wikidata ${LF.escape(b.wikidata)}</a>` : ""}
        ${wikipediaLink ? `<a href="${wikipediaLink}" target="_blank" rel="noopener" class="text-blue-300 hover:underline"><i class="bi bi-journal-text"></i> Wikipedia</a>` : ""}
      </div>
    `;
  }

  function wikipediaUrl(tag) {
    // OSM `wikipedia` tag is "lang:Article Title"
    if (!tag) return null;
    const idx = tag.indexOf(":");
    if (idx <= 0) return `https://en.wikipedia.org/wiki/${encodeURIComponent(tag)}`;
    const lang = tag.slice(0, idx);
    const title = tag.slice(idx + 1).trim().replace(/ /g, "_");
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  }

  async function refreshLead(b) {
    const btn = document.querySelector('[data-act="lm-refresh"]');
    const lbl = btn?.querySelector('[data-slot="refresh-label"]');
    if (btn) { btn.disabled = true; btn.classList.add("opacity-60"); }
    if (lbl) lbl.textContent = "Searching…";
    try {
      const payload = {
        place_id: b.place_id,
        business_name: b.business_name,
        brand: b.brand,
        website: b.website,
        phone: b.phone,
        email: b.email,
        wikidata: b.wikidata,
        image: b.image,
      };
      const res = await LF.api("/api/places/enrich", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const found = res.found || {};
      const newKeys = Object.keys(found).filter(k => found[k] && !b[k]);
      if (newKeys.length) {
        newKeys.forEach(k => { b[k] = found[k]; });
        b.enriched_from = "lookup";
        // Recompute completeness locally for instant feedback
        const filled = ["phone", "website", "email"].filter(k => b[k]).length;
        b.data_completeness = Math.max(b.data_completeness || 0, 30 + filled * 22);
        renderModal(b);
        // Update the side panel + table marker too
        const idx = lastResults.findIndex(r => r.place_id === b.place_id);
        if (idx >= 0) {
          Object.assign(lastResults[idx], b);
          renderTable(applyTierFilter(lastResults));
        }
        LF.toast(`Found: ${newKeys.join(", ")}`, "success");
      } else {
        LF.toast("No additional info found from public sources.", "info");
      }
    } catch (e) {
      LF.toast(`Lookup failed: ${e.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("opacity-60"); }
      if (lbl) lbl.textContent = "Find more";
    }
  }

  function bindCopyRows(root) {
    root.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await copyText(btn.dataset.copy, `Copied`);
        btn.classList.add("copied");
        btn.innerHTML = '<i class="bi bi-check2"></i>';
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = '<i class="bi bi-clipboard"></i>';
        }, 1400);
      });
    });
  }

  function initMiniMap(b) {
    const el = document.getElementById("lm-mini-map");
    if (!el || b.lat == null || b.lng == null) {
      if (el) el.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">No location data</div>';
      return;
    }
    if (modalMiniMap) { modalMiniMap.remove(); modalMiniMap = null; }
    modalMiniMap = L.map(el, { zoomControl: false, attributionControl: false, dragging: true, scrollWheelZoom: false })
      .setView([b.lat, b.lng], 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
    }).addTo(modalMiniMap);
    const tier = b.tier || LF.tier(b.lead_score);
    modalMiniMarker = L.marker([b.lat, b.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="lf-marker lf-marker-${tier}"><span>${b.lead_score}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 30],
      }),
    }).addTo(modalMiniMap);
    setTimeout(() => modalMiniMap && modalMiniMap.invalidateSize(), 120);
  }

  function renderStatusChips(b) {
    const wrap = document.getElementById("lm-status-chips");
    wrap.innerHTML = LF.STATUSES.map(s => `
      <button data-status="${s}" class="status-btn ${b.status === s ? 'is-active' : ''}">${s}</button>
    `).join("");
    wrap.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", async () => {
        const newStatus = btn.dataset.status;
        try {
          await LF.api(`/api/leads/${b.saved_id}`, {
            method: "PUT",
            body: JSON.stringify({ status: newStatus }),
          });
          b.status = newStatus;
          renderStatusChips(b);
          LF.toast(`Status set to ${newStatus}`, "success");
        } catch (e) {
          LF.toast(e.message, "error");
        }
      });
    });
  }

  function scheduleNotesSave(b, value) {
    const stateEl = document.getElementById("lm-save-state");
    stateEl.textContent = "Saving…";
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(async () => {
      try {
        await LF.api(`/api/leads/${b.saved_id}`, {
          method: "PUT",
          body: JSON.stringify({ notes: value }),
        });
        b.notes = value;
        stateEl.textContent = "Saved ✓";
        setTimeout(() => { if (stateEl.textContent === "Saved ✓") stateEl.textContent = ""; }, 1500);
      } catch (e) {
        stateEl.textContent = "Save failed";
      }
    }, 600);
  }

  async function loadOutreachHistory(leadId) {
    const wrap = document.getElementById("lm-outreach");
    wrap.innerHTML = '<div class="text-slate-500">Loading…</div>';
    try {
      const data = await LF.api(`/api/leads/${leadId}/outreach`);
      if (!data.logs || !data.logs.length) {
        wrap.innerHTML = '<div class="text-slate-500 italic">No outreach logged yet. Send a WhatsApp to start tracking.</div>';
        return;
      }
      wrap.innerHTML = data.logs.map(l => `
        <div class="flex items-start gap-2 p-2 rounded-md bg-slate-900/60 border border-slate-800">
          <i class="bi ${l.contact_method === 'WhatsApp' ? 'bi-whatsapp text-emerald-400' : 'bi-telephone-fill text-blue-400'}"></i>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-slate-200">${LF.escape(l.contact_method)}</div>
            ${l.message_template ? `<div class="text-slate-400 mt-0.5 line-clamp-2">${LF.escape(l.message_template.slice(0, 140))}${l.message_template.length > 140 ? '…' : ''}</div>` : ""}
            <div class="text-[10px] text-slate-500 mt-1">${l.contacted_at ? LF.formatTime(l.contacted_at) : ""}</div>
          </div>
        </div>
      `).join("");
    } catch (e) {
      wrap.innerHTML = `<div class="text-rose-400">Could not load history: ${LF.escape(e.message)}</div>`;
    }
  }

  return { init };
})();
