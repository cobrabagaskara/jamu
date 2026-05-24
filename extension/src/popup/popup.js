// ============================================================
// Jamu Loader — Popup Script
// ============================================================

"use strict";

function $(id) { return document.getElementById(id); }

function send(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
      res(resp);
    });
  });
}

let toastTimer = null;
function showToast(msg, type = "info") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 2200);
}

function formatTime(ts) {
  if (!ts) return "Never synced";
  const d = new Date(ts);
  const now = Date.now();
  const diff = Math.round((now - ts) / 1000);
  if (diff < 60) return "Synced just now";
  if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
  return `Synced ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function matchesCurrentUrl(patterns, currentUrl) {
  if (!currentUrl || !patterns?.length) return false;
  return patterns.some((p) => {
    if (p === "<all_urls>" || p === "*") return true;
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try { return new RegExp(`^${escaped}$`).test(currentUrl); } catch { return currentUrl.includes(p); }
  });
}

// ── State ────────────────────────────────────────────────────

let state = {
  modules: [],
  moduleStates: {},
  pendingUpdates: [],
  lastManifestFetch: null,
  manifestUrl: "",
  currentTabUrl: "",
  versionBlocked: false,
  versionRequired: null,
  // TAMBAHAN: status custom manifest
  // customManifestEnabled: boolean — apakah custom manifest diaktifkan user
  // hasCustomManifest: boolean — apakah URL custom manifest sudah diisi
  // lastManifestError: boolean — apakah fetch default manifest terakhir gagal
  customManifestEnabled: true,
  hasCustomManifest: false,
  lastManifestError: false,
};

// ── Render ───────────────────────────────────────────────────

function render() {
  const {
    modules, moduleStates, pendingUpdates, currentTabUrl,
    versionBlocked, versionRequired,
    customManifestEnabled, hasCustomManifest, lastManifestError,
  } = state;

  // Jumlah modul
  $("module-count").textContent =
    modules.length > 0 ? `${modules.length} module${modules.length !== 1 ? "s" : ""}` : "No modules";

  // ── Indikator custom manifest di header ──
  // Hanya muncul jika URL custom manifest sudah diisi DAN aktif.
  // Letaknya di samping jumlah modul — subtle, hanya terlihat jika tahu.
  const showIndicator = hasCustomManifest && customManifestEnabled;
  $("custom-manifest-indicator").classList.toggle("hidden", !showIndicator);

  // ── Info versi di settings ──
  // Dibaca langsung dari manifest.json via chrome API — selalu akurat,
  // tidak perlu hardcode atau sinkronisasi manual.
  $("settings-version").textContent = `v${chrome.runtime.getManifest().version}`;

  // ── Badge status default manifest ──
  // Tiga kondisi: belum ada cache (NOT SET), error saat fetch (FAILED),
  // atau berhasil (CONNECTED). Badge berubah warna sesuai kondisi.
  const badge = $("manifest-status-badge");
  if (!state.lastManifestFetch && !lastManifestError) {
    badge.textContent = "NOT SET";
    badge.className = "status-badge not-set";
  } else if (lastManifestError) {
    badge.textContent = "FAILED";
    badge.className = "status-badge failed";
  } else {
    badge.textContent = "CONNECTED";
    badge.className = "status-badge connected";
  }

  // Waktu terakhir sync — tetap tampil di bawah input sebagai info tambahan
  $("last-fetched").textContent = formatTime(state.lastManifestFetch);

  // ── Toggle custom manifest di settings ──
  // Sinkronkan state toggle dengan nilai dari storage.
  // Input URL dan tombol Save dinonaktifkan jika custom manifest dimatikan
  // agar user tidak bisa save URL baru dalam kondisi nonaktif.
  const toggleEl = $("custom-manifest-toggle");
  toggleEl.checked = customManifestEnabled !== false;
  const inputEnabled = customManifestEnabled !== false;
  $("manifest-url-input").disabled = !inputEnabled;
  $("btn-save-url").disabled = !inputEnabled;

  // Version Blocked Banner
  if (versionBlocked) {
    $("version-blocked-banner").classList.remove("hidden");
    const installed = chrome.runtime.getManifest().version;
    // Ganti .textContent ke .innerHTML agar bisa menyisipkan tag <a>.
    // target="_blank" membuka link di tab baru karena popup extension
    // tidak bisa navigasi langsung seperti browser biasa.
    $("version-blocked-detail").innerHTML =
      `Versi Anda: ${installed} — Diperlukan: ${versionRequired || "?"}. Semua modul dinonaktifkan sementara. ` +
      `<a href="https://s.id/JamuLoader" target="_blank" style="color:#f87171;text-decoration:underline;">Download versi terbaru</a>`;
    
  } else {
    $("version-blocked-banner").classList.add("hidden");
  }

  // Update Banner
  if (pendingUpdates.length > 0) {
    $("update-banner").classList.remove("hidden");
    $("update-banner-text").textContent =
      `${pendingUpdates.length} update${pendingUpdates.length !== 1 ? "s" : ""} available`;
  } else {
    $("update-banner").classList.add("hidden");
  }

  // Status bar URL
  if (currentTabUrl) {
    try {
      const u = new URL(currentTabUrl);
      $("current-url").textContent = u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      $("current-url").textContent = currentTabUrl.slice(0, 40);
    }
  }

  // Jumlah modul aktif di tab ini
  const activeOnTab = versionBlocked ? [] : modules.filter(
    (m) => moduleStates[m.id] !== false && matchesCurrentUrl(m.matches, currentTabUrl)
  );
  $("active-count").textContent = activeOnTab.length > 0 ? `${activeOnTab.length} active` : "";

  // ── Module List ──
  const list = $("module-list");
  list.innerHTML = "";

  if (modules.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">◈</div>
        <p>No modules loaded</p>
        <p class="empty-sub">Check your manifest URL in ⚙ settings</p>
      </div>`;
    return;
  }

  modules.forEach((mod) => {
    const enabled   = moduleStates[mod.id] !== false;
    const hasUpdate = pendingUpdates.includes(mod.id);

    const card = document.createElement("div");
    card.className = [
      "module-card",
      enabled ? "enabled" : "",
      hasUpdate ? "has-update" : "",
      versionBlocked ? "version-blocked" : "",
    ].filter(Boolean).join(" ");

    const matchLabel =
      mod.matches?.length > 0
        ? mod.matches.length === 1
          ? mod.matches[0].replace("https://", "").replace("http://", "")
          : `${mod.matches.length} URLs`
        : "All pages";

    card.innerHTML = `
      <div class="module-icon">${mod.icon || "◈"}</div>
      <div class="module-body">
        <div class="module-name" title="${mod.name || mod.id}">${mod.name || mod.id}</div>
        <div class="module-meta">
          <span class="module-version ${hasUpdate ? "has-update" : ""}" title="${hasUpdate ? "Update available" : "Current version"}">
            v${mod.version}${hasUpdate ? " ↑" : ""}
          </span>
          <span class="module-matches" title="${mod.matches?.join(', ') || 'All pages'}">${matchLabel}</span>
        </div>
      </div>
      <div class="module-actions">
        ${hasUpdate ? `<button class="update-module-btn" data-id="${mod.id}">UPDATE</button>` : ""}
        <label class="toggle">
          <input type="checkbox" ${enabled ? "checked" : ""} data-id="${mod.id}" />
          <span class="toggle-track"></span>
        </label>
      </div>
    `;

    card.querySelector(".toggle input").addEventListener("change", async (e) => {
      const newState = e.target.checked;
      moduleStates[mod.id] = newState;
      card.classList.toggle("enabled", newState);
      await send({ type: "SET_MODULE_STATE", moduleId: mod.id, enabled: newState });
    });

    const updateBtn = card.querySelector(".update-module-btn");
    if (updateBtn) {
      updateBtn.addEventListener("click", async () => {
        updateBtn.textContent = "...";
        updateBtn.disabled = true;
        try {
          await send({ type: "UPDATE_MODULE", moduleId: mod.id });
          state.pendingUpdates = state.pendingUpdates.filter((id) => id !== mod.id);
          showToast(`✓ ${mod.name || mod.id} updated`, "success");
          render();
        } catch {
          showToast("Update failed", "error");
          updateBtn.textContent = "UPDATE";
          updateBtn.disabled = false;
        }
      });
    }

    list.appendChild(card);
  });
}

// ── Load State ───────────────────────────────────────────────

async function loadState() {
  const [resp, tabs] = await Promise.all([
    send({ type: "GET_STATE" }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const { data } = resp;
  const manifest = data.cachedManifest;

  state.modules            = manifest?.modules || [];
  state.moduleStates       = data.moduleStates || {};
  state.pendingUpdates     = data.pendingUpdates || [];
  state.lastManifestFetch  = data.lastManifestFetch || null;
  state.manifestUrl        = data.manifestUrl || "";
  state.currentTabUrl      = tabs[0]?.url || "";
  state.versionBlocked     = data.versionBlocked || false;
  state.versionRequired    = data.versionRequired || null;
  state.lastManifestError  = data.lastManifestError || false;

  // customManifestEnabled default ke true jika belum pernah diset
  state.customManifestEnabled = data.customManifestEnabled !== false;

  // hasCustomManifest: true jika URL sudah diisi dan ada cache-nya
  state.hasCustomManifest = !!(data.manifestUrl && data.cachedCustomManifest);

  if (state.manifestUrl) {
    $("manifest-url-input").value = state.manifestUrl;
  }

  render();
}

// ── Event Listeners ──────────────────────────────────────────

// Refresh — refresh keduanya sekaligus, lalu reload state popup
$("btn-refresh").addEventListener("click", async () => {
  const btn = $("btn-refresh");
  btn.classList.add("spinning");
  try {
    const resp = await send({ type: "REFRESH_MANIFEST" });
    if (resp.ok) {
      showToast("✓ Manifest refreshed", "success");
      await loadState();
    } else {
      showToast("Failed to fetch manifest", "error");
    }
  } catch {
    showToast("Error refreshing", "error");
  } finally {
    btn.classList.remove("spinning");
  }
});

// Settings toggle
let settingsOpen = false;
$("btn-settings").addEventListener("click", () => {
  settingsOpen = !settingsOpen;
  $("settings-panel").classList.toggle("hidden", !settingsOpen);
  $("btn-settings").style.color = settingsOpen ? "var(--accent)" : "";
  $("btn-settings").style.borderColor = settingsOpen ? "var(--accent)" : "";
});

// Toggle custom manifest on/off
// Mengirim pesan SET_CUSTOM_MANIFEST_ENABLED ke background untuk disimpan
// ke storage, lalu render ulang agar input URL ikut disable/enable.
$("custom-manifest-toggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  state.customManifestEnabled = enabled;
  render(); // langsung update UI dulu
  await send({ type: "SET_CUSTOM_MANIFEST_ENABLED", enabled });
});

// Save custom manifest URL
$("btn-save-url").addEventListener("click", async () => {
  const url = $("manifest-url-input").value.trim();
  if (!url) { showToast("Enter a manifest URL", "error"); return; }

  $("btn-save-url").textContent = "...";
  $("btn-save-url").disabled = true;

  try {
    const resp = await send({ type: "SET_MANIFEST_URL", url });
    if (resp.ok) {
      showToast("✓ Custom manifest saved & loaded", "success");
      settingsOpen = false;
      $("settings-panel").classList.add("hidden");
      await loadState();
    } else {
      showToast("Could not fetch custom manifest", "error");
    }
  } catch {
    showToast("Error saving", "error");
  } finally {
    $("btn-save-url").textContent = "Save";
    $("btn-save-url").disabled = false;
  }
});

// Update all
$("btn-update-all").addEventListener("click", async () => {
  $("btn-update-all").textContent = "...";
  $("btn-update-all").disabled = true;
  try {
    await send({ type: "UPDATE_ALL_MODULES" });
    showToast("✓ All modules updated", "success");
    await loadState();
  } catch {
    showToast("Update failed", "error");
  } finally {
    $("btn-update-all").textContent = "Update All";
    $("btn-update-all").disabled = false;
  }
});

// ── Init ─────────────────────────────────────────────────────

loadState();
