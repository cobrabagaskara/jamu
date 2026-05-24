// ============================================================
// Jamu Loader — Background Service Worker
// ============================================================

const DEFAULT_CHECK_INTERVAL = 60; // minutes
const ALARM_NAME = "jamuloader-version-check";

// Versi extension dibaca langsung dari manifest.json agar tidak perlu
// update manual setiap kali naik versi — cukup update manifest.json saja.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// URL default manifest — hardcode dan tidak bisa diubah user.
// Ini adalah sumber kebenaran utama: menentukan modul global, minVersion,
// whitelist, dan tracking config.
const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/cobrabagaskara/centralized-userscript-manager/refs/heads/main/global-manifest.json";

// Tracking config — dibaca dari default manifest, tidak hardcode
let TRACKING_ENDPOINT = "";
let TRACKING_KEY      = "";

// Whitelist cache — di-fetch dari URL di manifest
let whitelistCache    = null;
let whitelistSelector = "#menu_user .label-default";

function log(...args) { console.log("[JamuLoader BG]", ...args); }
async function getStorage(keys) { return new Promise((res) => chrome.storage.local.get(keys, res)); }
async function setStorage(obj)  { return new Promise((res) => chrome.storage.local.set(obj, res)); }

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(timer); }
}

// ── Default Manifest ──────────────────────────────────────────
// Di-refresh setiap alarm 60 menit. Bertanggung jawab atas:
// - Konfigurasi tracking
// - Konfigurasi whitelist
// - Pengecekan minExtensionVersion
// - Modul-modul global

async function refreshDefaultManifest() {
  try {
    const res      = await fetchWithTimeout(DEFAULT_MANIFEST_URL);
    const manifest = await res.json();
    await setStorage({
      cachedManifest:    manifest,
      lastManifestFetch: Date.now(),
      lastManifestError: false, // fetch berhasil, reset flag error
    });
    log("Default manifest refreshed:", manifest);
    loadConfigFromManifest(manifest);
    await checkMinVersion(manifest);
    await checkForUpdates(manifest);
    return manifest;
  } catch (err) {
    // Simpan flag error agar popup bisa menampilkan badge FAILED
    await setStorage({ lastManifestError: true });
    log("Error fetching default manifest:", err.message);
    return null;
  }
}

// ── Custom Manifest ───────────────────────────────────────────
// Di-refresh hanya saat:
// - Extension di-install / restart browser
// - User klik tombol refresh manual di popup
// Tidak ikut alarm 60 menit agar lebih ringan dan tidak spam request.
// Custom manifest HANYA menyumbang modul tambahan — tidak mempengaruhi
// minVersion, tracking, atau whitelist (semua itu dari default manifest).

async function refreshCustomManifest() {
  const { manifestUrl, customManifestEnabled } = await getStorage(["manifestUrl", "customManifestEnabled"]);

  // Jika URL belum diisi atau custom manifest dinonaktifkan, skip
  if (!manifestUrl || customManifestEnabled === false) {
    log("Custom manifest skipped (not set or disabled).");
    return null;
  }

  try {
    const res      = await fetchWithTimeout(manifestUrl);
    const manifest = await res.json();
    await setStorage({ cachedCustomManifest: manifest });
    log("Custom manifest refreshed:", manifest);
    return manifest;
  } catch (err) {
    log("Error fetching custom manifest:", err.message);
    return null;
  }
}

// Refresh keduanya sekaligus — dipakai saat onInstalled, onStartup,
// dan saat user klik refresh manual di popup.
async function refreshAllManifests() {
  const [def, custom] = await Promise.all([
    refreshDefaultManifest(),
    refreshCustomManifest(),
  ]);
  return { default: def, custom };
}

function loadConfigFromManifest(manifest) {
  // Tracking dan whitelist hanya dibaca dari default manifest
  if (manifest.tracking?.endpoint) {
    TRACKING_ENDPOINT = manifest.tracking.endpoint;
    TRACKING_KEY      = manifest.tracking.key || "";
    log("Tracking config loaded from manifest");
  } else {
    TRACKING_ENDPOINT = "";
    TRACKING_KEY      = "";
  }

  if (manifest.whitelist?.selector) {
    whitelistSelector = manifest.whitelist.selector;
  }

  whitelistCache = null;
}

// ── Min Version Check ─────────────────────────────────────────
// Hanya menggunakan default manifest — custom manifest tidak mempengaruhi
// pengecekan versi. Admin pusat yang mengontrol kebijakan versi minimum.

async function checkMinVersion(manifest) {
  if (!manifest.minExtensionVersion) {
    await setStorage({ versionBlocked: false, versionRequired: null });
    return;
  }

  const required = manifest.minExtensionVersion;
  const { versionBlocked: wasBlocked } = await getStorage(["versionBlocked"]);

  if (versionLessThan(EXTENSION_VERSION, required)) {
    log(`Extension version ${EXTENSION_VERSION} < required ${required} — blocking all modules`);
    await setStorage({ versionBlocked: true, versionRequired: required });

    // Notifikasi hanya dikirim sekali saat status BARU berubah menjadi blocked,
    // bukan setiap kali alarm 60 menit menyala — mencegah spam notifikasi.
    if (!wasBlocked) {
      chrome.notifications.create("jamuloader-version-blocked", {
        type:     "basic",
        iconUrl:  "icons/icon48.png",
        title:    "Jamu Loader — Update Diperlukan",
        message:  `Versi extension Anda (${EXTENSION_VERSION}) sudah tidak didukung. Silakan install versi terbaru (${required}).`,
        priority: 2,
      });
    }
  } else {
    await setStorage({ versionBlocked: false, versionRequired: required });
  }
}

function versionLessThan(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

// ── Whitelist ─────────────────────────────────────────────────

async function fetchWhitelist(url) {
  if (whitelistCache !== null) return whitelistCache;
  try {
    const res  = await fetchWithTimeout(url);
    whitelistCache = await res.json();
    log("Whitelist loaded:", whitelistCache);
    return whitelistCache;
  } catch (err) {
    log("Error fetching whitelist:", err.message);
    return null;
  }
}

function isEpuskesmasModule(mod) {
  return (mod.matches || []).some(p => p.includes("epuskesmas.id"));
}

async function readEpuskesmasInfoFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func: () => {
        const scripts = Array.from(document.querySelectorAll("script"));
        for (const s of scripts) {
          const src = s.textContent || "";
          if (!src.includes("openBantuan") && !src.includes("notif_wa")) continue;
          const urlMatch = src.match(/https:\/\/api\.whatsapp\.com\/send\/\?[^"'\s]+/);
          if (!urlMatch) continue;
          const waUrl = decodeURIComponent(urlMatch[0]);
          const m = waUrl.match(/ePuskesmas:\s*(.+?)\s*\(pkm[^)]*\)\s*-\s*(\d+)\s+([A-Z\s]+?)\s*-/i);
          if (m) {
            return { namaUser: m[1].trim(), kode: m[2].trim(), namaPkm: m[3].trim() };
          }
        }
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch { return null; }
}

// ── Version Checking ─────────────────────────────────────────

async function checkForUpdates(manifest) {
  const { installedVersions = {}, moduleStates = {} } = await getStorage(["installedVersions", "moduleStates"]);
  const modules = manifest.modules || [];
  const updatesFound = [];
  let moduleStatesChanged = false;

  for (const mod of modules) {
    const installed = installedVersions[mod.id];
    if (installed === undefined) {
      installedVersions[mod.id] = mod.version;
      log(`New module registered: ${mod.id} @ ${mod.version}`);
      if (mod.defaultEnabled === false) {
        moduleStates[mod.id] = false;
        moduleStatesChanged = true;
      }
    } else if (installed !== mod.version) {
      updatesFound.push(mod);
      log(`Update detected: ${mod.id}  installed=${installed}  latest=${mod.version}`);
    }
  }

  await setStorage({ installedVersions });
  if (moduleStatesChanged) await setStorage({ moduleStates });

  const { pendingUpdates: existing = [] } = await getStorage(["pendingUpdates"]);
  const merged = [...new Set([...existing, ...updatesFound.map((m) => m.id)])];
  await setStorage({ pendingUpdates: merged });

  if (merged.length > 0) await setBadge(merged.length.toString(), "#f59e0b");
  else await clearBadge();

  if (updatesFound.length > 0) {
    chrome.notifications.create("jamuloader-update-" + Date.now(), {
      type:     "basic",
      iconUrl:  "icons/icon48.png",
      title:    "Jamu Loader — Module Updates Available",
      message:  `${updatesFound.length} module(s) have new versions: ${updatesFound.map((m) => m.name).join(", ")}`,
      priority: 1,
    });
  }
}

async function setBadge(text, color = "#ef4444") {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
async function clearBadge() { chrome.action.setBadgeText({ text: "" }); }

// ── Script Cache ─────────────────────────────────────────────

async function fetchAndCacheScript(mod) {
  log(`Fetching script: ${mod.id} v${mod.version}`);
  const res  = await fetchWithTimeout(mod.scriptUrl);
  const code = await res.text();
  await setStorage({ [`script_${mod.id}`]: { code, version: mod.version, fetchedAt: Date.now() } });
  return code;
}

async function getModuleScript(mod) {
  const { [`script_${mod.id}`]: cached } = await getStorage([`script_${mod.id}`]);
  if (cached && cached.version === mod.version) return cached.code;
  return await fetchAndCacheScript(mod);
}

// ── Tracking ─────────────────────────────────────────────────

function todayDate() { return new Date().toISOString().slice(0, 10); }

async function shouldTrack(moduleId, username) {
  if (!TRACKING_ENDPOINT) return false;
  const { trackingLog = {} } = await getStorage(["trackingLog"]);
  return trackingLog[`${moduleId}::${username}`] !== todayDate();
}

async function markTracked(moduleId, username) {
  const { trackingLog = {} } = await getStorage(["trackingLog"]);
  trackingLog[`${moduleId}::${username}`] = todayDate();
  await setStorage({ trackingLog });
}

async function sendTracking(moduleId, moduleName, tabUrl, username, hostname) {
  if (!TRACKING_ENDPOINT) return;
  try {
    await fetch(TRACKING_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: TRACKING_KEY, timestamp: Date.now(),
        moduleId, moduleName, url: tabUrl, username, hostname
      })
    });
    log(`Tracking sent: ${moduleId} by ${username}`);
  } catch (err) { log(`Tracking failed (silent): ${err.message}`); }
}

async function readUsernameFromTab(tabId, userSelector) {
  if (!userSelector) return "-";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func: (selector) => {
        const el = document.querySelector(selector);
        if (!el) return "-";
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) return text;
          }
        }
        return el.textContent.trim() || "-";
      },
      args: [userSelector]
    });
    return results?.[0]?.result || "-";
  } catch { return "-"; }
}

// ── First-Run Notice ─────────────────────────────────────────

async function maybeShowFirstRunNotice(tabId) {
  if (!TRACKING_ENDPOINT) return;
  const { firstRunNoticeSeen } = await getStorage(["firstRunNoticeSeen"]);
  if (firstRunNoticeSeen) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func: () => {
        if (document.getElementById("jamu-first-run-notice")) return;
        const overlay = document.createElement("div");
        overlay.id = "jamu-first-run-notice";
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif";
        const box = document.createElement("div");
        box.style.cssText = "background:#0d0f12;border:1px solid rgba(0,212,170,0.4);border-radius:12px;padding:28px 32px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.6);color:#c8d0db";
        box.innerHTML = `
          <div style="font-size:20px;font-weight:bold;color:#00d4aa;margin-bottom:6px;">🍵 Jamu Loader</div>
          <div style="font-size:14px;font-weight:600;color:#e8edf3;margin-bottom:14px;">Pemberitahuan Penggunaan Data</div>
          <p style="font-size:13px;line-height:1.8;color:#b8c5d3;margin-bottom:20px;">
            Extension ini mencatat <strong style="color:#fff">nama akun</strong> dan
            <strong style="color:#fff">modul yang dijalankan</strong> untuk keperluan
            monitoring penggunaan internal.<br><br>
            Pencatatan hanya dilakukan <strong style="color:#fff">1 kali per hari</strong>
            per modul. Data hanya diakses oleh administrator dan tidak disebarkan ke pihak lain.
          </p>
          <div style="display:flex;justify-content:flex-end">
            <button id="jamu-notice-btn" style="padding:10px 28px;background:#00d4aa;border:none;border-radius:8px;color:#000;font-size:14px;font-weight:700;cursor:pointer;">
              Saya Mengerti
            </button>
          </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.getElementById("jamu-notice-btn").addEventListener("click", () => {
          overlay.style.opacity = "0";
          overlay.style.transition = "opacity 0.3s";
          setTimeout(() => overlay.remove(), 300);
        });
      }
    });
    await setStorage({ firstRunNoticeSeen: true });
    log("First-run notice shown");
  } catch (err) {
    log("First-run notice failed:", err.message);
    await setStorage({ firstRunNoticeSeen: true });
  }
}

// ── Inject ───────────────────────────────────────────────────

async function injectModulesIntoTab(tabId, tabUrl) {
  const {
    versionBlocked,
    cachedManifest,
    cachedCustomManifest,
    customManifestEnabled,
    moduleStates = {}
  } = await getStorage([
    "versionBlocked", "cachedManifest", "cachedCustomManifest",
    "customManifestEnabled", "moduleStates"
  ]);

  if (versionBlocked) { log("Injection blocked — extension version too old"); return; }
  if (!cachedManifest) return;

  // Gabungkan modul dari default manifest dan custom manifest.
  // Custom manifest hanya disertakan jika tersedia di cache DAN tidak dinonaktifkan.
  // Jika ada modul dengan ID yang sama di kedua manifest, default manifest menang.
  const defaultModules = cachedManifest.modules || [];
  const customModules  = (customManifestEnabled !== false && cachedCustomManifest)
    ? (cachedCustomManifest.modules || [])
    : [];
  const defaultIds = new Set(defaultModules.map(m => m.id));
  const allModules = [...defaultModules, ...customModules.filter(m => !defaultIds.has(m.id))];

  const whitelistUrl = cachedManifest.whitelist?.url || null;

  let epuskesmasInfo        = null;
  let epuskesmasInfoFetched = false;
  let firstInjection        = true;

  for (const mod of allModules) {
    if (moduleStates[mod.id] === false) continue;
    const shouldInject = (mod.matches || []).some((p) => matchUrlPattern(p, tabUrl));
    if (!shouldInject) continue;

    if (isEpuskesmasModule(mod) && whitelistUrl) {
      if (!epuskesmasInfoFetched) {
        epuskesmasInfo        = await readEpuskesmasInfoFromTab(tabId);
        epuskesmasInfoFetched = true;
        log(`ePuskesmas info:`, epuskesmasInfo);
      }
      if (epuskesmasInfo) {
        const list = await fetchWhitelist(whitelistUrl);
        if (list !== null && !list.includes(epuskesmasInfo.kode)) {
          log(`Kode "${epuskesmasInfo.kode}" not in whitelist — skipping ${mod.id}`);
          continue;
        }
      }
    }

    log(`Injecting "${mod.id}" into tab ${tabId}`);
    try {
      const code = await getModuleScript(mod);
      const meta = { id: mod.id, version: mod.version, name: mod.name };

      await chrome.scripting.executeScript({
        target: { tabId },
        world:  "MAIN",
        func: (moduleCode, moduleId, moduleMeta) => {
          if (!window.__jamuloader_injected) window.__jamuloader_injected = {};
          if (window.__jamuloader_injected[moduleId]) return;
          window.__jamuloader_injected[moduleId] = true;
          const script = document.createElement("script");
          script.textContent = `(function(){
  var __meta__ = ${JSON.stringify(moduleMeta)};
  ${moduleCode}
})();`;
          (document.head || document.documentElement).appendChild(script);
          script.remove();
        },
        args: [code, mod.id, meta],
      });

      if (TRACKING_ENDPOINT) {
        if (firstInjection) {
          firstInjection = false;
          await maybeShowFirstRunNotice(tabId);
        }
        let username = "-";
        if (isEpuskesmasModule(mod) && epuskesmasInfo?.namaUser) {
          username = `${epuskesmasInfo.namaUser} (${epuskesmasInfo.namaPkm})`;
        } else if (mod.userSelector) {
          username = await readUsernameFromTab(tabId, mod.userSelector);
        }
        const hostname = new URL(tabUrl).hostname;
        if (await shouldTrack(mod.id, username)) {
          await sendTracking(mod.id, mod.name, tabUrl, username, hostname);
          await markTracked(mod.id, username);
        } else {
          log(`Tracking skipped (already tracked today): ${mod.id} by ${username}`);
        }
      }
    } catch (err) { log(`Failed to inject ${mod.id}:`, err.message); }
  }
}

function matchUrlPattern(pattern, url) {
  if (pattern === "<all_urls>" || pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try { return new RegExp(`^${escaped}$`).test(url); } catch { return url.includes(pattern); }
}

// ── Messages ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case "GET_STATE": {
        const data = await getStorage([
          "manifestUrl", "cachedManifest", "moduleStates", "pendingUpdates",
          "lastManifestFetch", "installedVersions", "versionBlocked", "versionRequired",
          "customManifestEnabled", "cachedCustomManifest", "lastManifestError"
        ]);
        sendResponse({ ok: true, data });
        break;
      }

      case "SET_MANIFEST_URL": {
        // Simpan custom manifest URL lalu langsung fetch — reset cache lama dulu
        await setStorage({ manifestUrl: msg.url, cachedCustomManifest: null });
        const manifest = await refreshCustomManifest();
        sendResponse({ ok: !!manifest, manifest });
        break;
      }

      case "SET_CUSTOM_MANIFEST_ENABLED": {
        // Toggle aktif/nonaktif custom manifest tanpa mengubah URL-nya
        await setStorage({ customManifestEnabled: msg.enabled });
        sendResponse({ ok: true });
        break;
      }

      case "REFRESH_MANIFEST": {
        // Refresh manual — refresh default dan custom sekaligus
        const result = await refreshAllManifests();
        sendResponse({ ok: !!result.default, ...result });
        break;
      }

      case "SET_MODULE_STATE": {
        const { moduleStates = {} } = await getStorage(["moduleStates"]);
        moduleStates[msg.moduleId] = msg.enabled;
        await setStorage({ moduleStates });
        sendResponse({ ok: true });
        break;
      }

      case "UPDATE_MODULE": {
        const { cachedManifest, installedVersions = {} } = await getStorage(["cachedManifest","installedVersions"]);
        const mod = (cachedManifest?.modules || []).find((m) => m.id === msg.moduleId);
        if (!mod) { sendResponse({ ok: false, error: "Module not found" }); break; }
        await setStorage({ [`script_${mod.id}`]: null });
        await fetchAndCacheScript(mod);
        installedVersions[mod.id] = mod.version;
        await setStorage({ installedVersions });
        const { pendingUpdates = [] } = await getStorage(["pendingUpdates"]);
        const newPending = pendingUpdates.filter((id) => id !== mod.id);
        await setStorage({ pendingUpdates: newPending });
        if (newPending.length === 0) await clearBadge();
        else await setBadge(newPending.length.toString(), "#f59e0b");
        sendResponse({ ok: true });
        break;
      }

      case "UPDATE_ALL_MODULES": {
        const { cachedManifest, pendingUpdates = [], installedVersions = {} } = await getStorage(["cachedManifest","pendingUpdates","installedVersions"]);
        for (const id of pendingUpdates) {
          const mod = (cachedManifest?.modules || []).find((m) => m.id === id);
          if (!mod) continue;
          await setStorage({ [`script_${mod.id}`]: null });
          await fetchAndCacheScript(mod);
          installedVersions[mod.id] = mod.version;
        }
        await setStorage({ installedVersions, pendingUpdates: [] });
        await clearBadge();
        sendResponse({ ok: true });
        break;
      }

      case "INJECT_CURRENT_TAB": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await injectModulesIntoTab(tab.id, tab.url);
        sendResponse({ ok: true });
        break;
      }

      case "RESET_FIRST_RUN": {
        await setStorage({ firstRunNoticeSeen: false });
        sendResponse({ ok: true });
        break;
      }

      case "RESET_TRACKING": {
        await setStorage({ trackingLog: {} });
        sendResponse({ ok: true });
        break;
      }

      case "DEBUG_STATE": {
        const all = await getStorage([
          "manifestUrl", "installedVersions", "pendingUpdates", "moduleStates",
          "trackingLog", "firstRunNoticeSeen", "versionBlocked", "versionRequired",
          "customManifestEnabled", "lastManifestError"
        ]);
        console.table(all.installedVersions);
        console.log("pendingUpdates:", all.pendingUpdates);
        console.log("trackingLog:", all.trackingLog);
        console.log("versionBlocked:", all.versionBlocked, "| required:", all.versionRequired);
        console.log("customManifestEnabled:", all.customManifestEnabled);
        console.log("lastManifestError:", all.lastManifestError);
        sendResponse({ ok: true, data: all });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) injectModulesIntoTab(tabId, tab.url);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Alarm hanya me-refresh default manifest.
  // Custom manifest tidak ikut alarm agar tidak terlalu sering request.
  if (alarm.name === ALARM_NAME) { log("Alarm fired."); await refreshDefaultManifest(); }
});

async function setupAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: DEFAULT_CHECK_INTERVAL });
    log(`Alarm set: every ${DEFAULT_CHECK_INTERVAL} minutes`);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  log("Jamu Loader installed.");
  await setupAlarm();
  await refreshAllManifests();
});

chrome.runtime.onStartup.addListener(async () => {
  log("Browser started.");
  await setupAlarm();
  await refreshAllManifests();
});

// Restore config dari cache saat service worker restart
(async () => {
  const { cachedManifest } = await getStorage(["cachedManifest"]);
  if (cachedManifest) loadConfigFromManifest(cachedManifest);
})();

setupAlarm();
