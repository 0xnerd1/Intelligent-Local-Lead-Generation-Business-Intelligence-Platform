// Local Lead Finder Pro – Chart.js setup + saved leads page

window.Charts = (function () {
  const LF = window.LeadFinder;
  let catChart, tierChart, ratingChart;

  Chart.defaults.color = "#cbd5e1";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.borderColor = "rgba(148,163,184,0.12)";

  function ensureCharts() {
    if (catChart) return;

    catChart = new Chart(document.getElementById("chart-cat"), {
      type: "doughnut",
      data: { labels: [], datasets: [{ data: [], backgroundColor: ["#3b82f6","#a855f7","#22c55e","#eab308","#ef4444","#06b6d4","#f97316","#ec4899","#14b8a6","#f59e0b","#8b5cf6"], borderWidth: 0 }] },
      options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } }, cutout: "60%", maintainAspectRatio: false },
    });

    tierChart = new Chart(document.getElementById("chart-tiers"), {
      type: "bar",
      data: {
        labels: ["🟢 Hot (70-100)", "🟡 Medium (40-69)", "🔴 Low (0-39)"],
        datasets: [{
          label: "Businesses",
          data: [0, 0, 0],
          backgroundColor: ["rgba(34,197,94,0.7)", "rgba(234,179,8,0.7)", "rgba(239,68,68,0.7)"],
          borderRadius: 6,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        maintainAspectRatio: false,
      },
    });

    ratingChart = new Chart(document.getElementById("chart-ratings"), {
      type: "bar",
      data: {
        labels: ["<3.5", "3.5-4.2", "4.3-4.5", "4.6-5.0"],
        datasets: [{
          label: "Businesses",
          data: [0, 0, 0, 0],
          backgroundColor: "rgba(59,130,246,0.7)",
          borderRadius: 6,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        maintainAspectRatio: false,
      },
    });
  }

  function update(rows) {
    ensureCharts();
    const counts = {};
    rows.forEach(r => {
      const k = r.category_label || LF.CATEGORY_LABELS[r.category] || r.category || "Other";
      counts[k] = (counts[k] || 0) + 1;
    });
    const cats = Object.keys(counts);
    catChart.data.labels = cats;
    catChart.data.datasets[0].data = cats.map(k => counts[k]);
    catChart.update();

    const tiers = [0, 0, 0];
    rows.forEach(r => {
      if (r.lead_score >= 70) tiers[0]++;
      else if (r.lead_score >= 40) tiers[1]++;
      else tiers[2]++;
    });
    tierChart.data.datasets[0].data = tiers;
    tierChart.update();

    const ratings = [0, 0, 0, 0];
    rows.forEach(r => {
      const v = r.rating || 0;
      if (v < 3.5) ratings[0]++;
      else if (v <= 4.2) ratings[1]++;
      else if (v <= 4.5) ratings[2]++;
      else ratings[3]++;
    });
    ratingChart.data.datasets[0].data = ratings;
    ratingChart.update();
  }

  return { update };
})();

// -------------------------------------------------------------
// Saved Leads page
// -------------------------------------------------------------
window.LeadsPage = (function () {
  const LF = window.LeadFinder;
  let allLeads = [];
  let activeLead = null;

  async function init() {
    document.getElementById("status-filter").addEventListener("change", refresh);
    document.getElementById("search-filter").addEventListener("input", render);
    document.getElementById("csv-btn").addEventListener("click", () => {
      window.location.href = "/api/export/csv";
    });

    // Modal close handlers
    document.getElementById("m-close").addEventListener("click", closeModal);
    document.getElementById("lead-modal").addEventListener("click", (e) => {
      if (e.target.id === "lead-modal") closeModal();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    document.getElementById("m-save-notes").addEventListener("click", saveModalNotes);

    await refresh();
    await refreshPipeline();
  }

  async function refresh() {
    const status = document.getElementById("status-filter").value;
    const data = await LF.api(`/api/leads?status=${encodeURIComponent(status)}`);
    allLeads = data.leads || [];
    render();
    updateStats();
  }

  async function refreshPipeline() {
    try {
      const data = await LF.api("/api/analytics/pipeline");
      const stages = data.stages || [];
      const total = stages.reduce((s, x) => s + x.count, 0) || 1;
      const palette = {
        "New": "bg-blue-500/70", "Contacted": "bg-purple-500/70",
        "Interested": "bg-amber-500/70", "Won": "bg-emerald-500/70",
        "Not Interested": "bg-rose-500/70",
      };
      document.getElementById("pipeline-bars").innerHTML = stages.map(s => {
        const pct = Math.round((s.count / total) * 100);
        return `
          <div class="flex-1 min-w-[140px]">
            <div class="flex justify-between text-[11px] mb-1">
              <span class="font-semibold text-slate-200">${s.stage}</span>
              <span class="text-slate-400">${s.count}</span>
            </div>
            <div class="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full ${palette[s.stage] || "bg-slate-500"}" style="width:${Math.max(pct, s.count ? 6 : 0)}%"></div>
            </div>
          </div>
        `;
      }).join("");
    } catch (_) {}
  }

  function tierOf(score) {
    return score >= 70 ? "hot" : score >= 40 ? "medium" : "low";
  }

  function render() {
    const q = (document.getElementById("search-filter").value || "").toLowerCase();
    const rows = allLeads.filter(l =>
      (l.business_name || "").toLowerCase().includes(q) ||
      (l.address || "").toLowerCase().includes(q));
    const tbody = document.getElementById("leads-tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-slate-500">No saved leads yet. Run a search and click <i class="bi bi-bookmark-plus"></i> Save.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(l => {
      const tier = tierOf(l.lead_score);
      const wa = LF.whatsAppLink(l.phone, "");
      return `
        <tr data-id="${l.id}" class="hover:bg-slate-900/40 cursor-pointer">
          <td class="px-4 py-3" data-act="open">
            <div class="font-semibold flex items-center gap-1.5">
              <i class="bi ${LF.CATEGORY_ICONS[l.category] || 'bi-shop'} text-slate-400"></i>
              ${LF.escape(l.business_name)}
            </div>
            <div class="text-[11px] text-slate-400 truncate max-w-[260px]">${LF.escape(l.address || "")}</div>
          </td>
          <td class="px-4 py-3 text-slate-300" data-act="open">${LF.escape(LF.CATEGORY_LABELS[l.category] || l.category || "—")}</td>
          <td class="px-4 py-3 text-right" data-act="open">
            <div class="flex items-center justify-end gap-2">
              <span class="text-mono font-bold ${tier === 'hot' ? 'text-emerald-400' : tier === 'medium' ? 'text-amber-400' : 'text-rose-400'}">${l.lead_score}</span>
              <div class="score-bar w-16"><div class="score-fill-${tier}" style="width:${l.lead_score}%"></div></div>
            </div>
          </td>
          <td class="px-4 py-3 text-slate-300">${LF.escape(l.phone || "—")}</td>
          <td class="px-4 py-3">
            <select data-act="status" class="form-input !py-1 !text-xs w-36">
              ${LF.STATUSES.map(s => `<option ${s === l.status ? 'selected' : ''}>${s}</option>`).join("")}
            </select>
          </td>
          <td class="px-4 py-3">
            <input data-act="notes" value="${LF.escape(l.notes || "")}" placeholder="Add a note…" class="form-input !py-1 !text-xs w-44" />
          </td>
          <td class="px-4 py-3 text-right">
            <div class="flex items-center justify-end gap-1.5">
              ${wa ? `<a href="${wa}" target="_blank" class="btn-ghost" title="WhatsApp"><i class="bi bi-whatsapp text-emerald-400"></i></a>` : ""}
              ${l.maps_link ? `<a href="${LF.escape(l.maps_link)}" target="_blank" class="btn-ghost" title="Open map"><i class="bi bi-geo-alt-fill text-blue-400"></i></a>` : ""}
              <button data-act="del" class="btn-ghost hover:!border-rose-500/50 hover:!text-rose-300" title="Delete"><i class="bi bi-trash3"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("tr").forEach(tr => {
      const id = Number(tr.dataset.id);
      tr.querySelectorAll("[data-act='open']").forEach(td => {
        td.addEventListener("click", () => openModal(id));
      });
      tr.querySelector("[data-act='status']")?.addEventListener("change", (e) => {
        e.stopPropagation();
        updateLead(id, { status: e.target.value });
      });
      const notes = tr.querySelector("[data-act='notes']");
      let t;
      notes?.addEventListener("input", (e) => {
        e.stopPropagation();
        clearTimeout(t);
        t = setTimeout(() => updateLead(id, { notes: e.target.value }), 600);
      });
      notes?.addEventListener("click", (e) => e.stopPropagation());
      tr.querySelector("[data-act='del']")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteLead(id);
      });
      tr.querySelectorAll("a").forEach(a => a.addEventListener("click", (e) => e.stopPropagation()));
    });
  }

  // ----- Modal -----
  async function openModal(id) {
    const lead = allLeads.find(l => l.id === id);
    if (!lead) return;
    activeLead = lead;
    const tier = tierOf(lead.lead_score);
    document.getElementById("m-cat").textContent = LF.CATEGORY_LABELS[lead.category] || lead.category || "—";
    document.getElementById("m-name").textContent = lead.business_name;
    document.getElementById("m-addr").textContent = lead.address || "Address not listed";
    document.getElementById("m-score").textContent = lead.lead_score;
    document.getElementById("m-score").className = `text-2xl font-black ${tier === 'hot' ? 'text-emerald-400' : tier === 'medium' ? 'text-amber-400' : 'text-rose-400'}`;
    document.getElementById("m-rating").textContent = (lead.rating != null) ? Number(lead.rating).toFixed(1) : "—";
    document.getElementById("m-reviews").textContent = (lead.total_reviews != null) ? Number(lead.total_reviews).toLocaleString() : "—";
    document.getElementById("m-notes").value = lead.notes || "";

    const wa = LF.whatsAppLink(lead.phone, "");
    document.getElementById("m-contacts").innerHTML = `
      ${lead.phone ? `<a href="tel:${LF.escape(lead.phone)}" class="contact-link"><i class="bi bi-telephone-fill text-blue-400"></i> ${LF.escape(lead.phone)}</a>` :
        `<div class="contact-link text-slate-500"><i class="bi bi-telephone"></i> No phone</div>`}
      ${wa ? `<a href="${wa}" target="_blank" class="contact-link"><i class="bi bi-whatsapp text-emerald-400"></i> WhatsApp</a>` :
        `<div class="contact-link text-slate-500"><i class="bi bi-whatsapp"></i> No WhatsApp</div>`}
      ${lead.website ? `<a href="${LF.escape(lead.website)}" target="_blank" class="contact-link col-span-2"><i class="bi bi-globe text-blue-400"></i> ${LF.escape(lead.website)}</a>` :
        `<div class="contact-link text-slate-500 col-span-2"><i class="bi bi-globe"></i> No website</div>`}
      ${lead.maps_link ? `<a href="${LF.escape(lead.maps_link)}" target="_blank" class="contact-link col-span-2"><i class="bi bi-geo-alt-fill text-blue-400"></i> Open in maps</a>` : ""}
    `;

    document.getElementById("m-status-buttons").innerHTML = LF.STATUSES.map(s => `
      <button data-status="${s}" class="status-btn ${s === lead.status ? 'is-active' : ''}">${s}</button>
    `).join("");
    document.querySelectorAll("#m-status-buttons [data-status]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await updateLead(lead.id, { status: btn.dataset.status });
        document.querySelectorAll("#m-status-buttons [data-status]").forEach(b =>
          b.classList.toggle("is-active", b === btn));
        await refreshPipeline();
      });
    });

    // Outreach history
    const hist = document.getElementById("m-outreach");
    hist.innerHTML = '<div class="text-slate-500">Loading…</div>';
    try {
      const data = await LF.api(`/api/leads/${lead.id}/outreach`);
      if (!data.logs.length) {
        hist.innerHTML = '<div class="text-slate-500 italic">No outreach logged yet.</div>';
      } else {
        hist.innerHTML = data.logs.map(l => `
          <div class="flex items-start gap-2 p-2 rounded-md bg-slate-800/40 border border-slate-700/50">
            <i class="bi ${l.contact_method === 'WhatsApp' ? 'bi-whatsapp text-emerald-400' : 'bi-telephone-fill text-blue-400'}"></i>
            <div class="flex-1 min-w-0">
              <div class="flex justify-between text-[11px] text-slate-400">
                <span>${LF.escape(l.contact_method)}</span>
                <span>${LF.formatTime(l.contacted_at)}</span>
              </div>
              ${l.message_template ? `<div class="text-xs text-slate-300 mt-0.5 truncate">${LF.escape(l.message_template)}</div>` : ""}
            </div>
          </div>
        `).join("");
      }
    } catch (_) { hist.innerHTML = '<div class="text-rose-400">Could not load history.</div>'; }

    const m = document.getElementById("lead-modal");
    m.classList.remove("hidden");
    m.classList.add("flex");
  }

  function closeModal() {
    const m = document.getElementById("lead-modal");
    m.classList.add("hidden");
    m.classList.remove("flex");
    activeLead = null;
  }

  async function saveModalNotes() {
    if (!activeLead) return;
    const notes = document.getElementById("m-notes").value;
    await updateLead(activeLead.id, { notes });
  }

  async function updateLead(id, payload) {
    try {
      await LF.api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      const lead = allLeads.find(l => l.id === id);
      if (lead) Object.assign(lead, payload);
      LF.toast("Saved.", "success");
      updateStats();
      if (payload.status) await refreshPipeline();
    } catch (e) { LF.toast(e.message, "error"); }
  }

  async function deleteLead(id) {
    if (!confirm("Delete this lead?")) return;
    try {
      await LF.api(`/api/leads/${id}`, { method: "DELETE" });
      allLeads = allLeads.filter(l => l.id !== id);
      render();
      updateStats();
      await refreshPipeline();
      LF.toast("Lead deleted.", "info");
    } catch (e) { LF.toast(e.message, "error"); }
  }

  function updateStats() {
    const total = allLeads.length;
    const hot = allLeads.filter(l => l.lead_score >= 70).length;
    const medium = allLeads.filter(l => l.lead_score >= 40 && l.lead_score < 70).length;
    const low = total - hot - medium;
    const contacted = allLeads.filter(l => (l.status || "New") !== "New").length;
    const won = allLeads.filter(l => l.status === "Won").length;
    document.getElementById("s-total").textContent = total;
    document.getElementById("s-hot").textContent = hot;
    document.getElementById("s-medium").textContent = medium;
    document.getElementById("s-low").textContent = low;
    document.getElementById("s-contacted").textContent = contacted;
    document.getElementById("s-won").textContent = won;
  }

  return { init };
})();
