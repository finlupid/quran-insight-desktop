import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Metode 11 sama dengan /api/prayer-times di repo quran-next
const API_METHOD = 11;
const FETCH_TIMEOUT_MS = 10_000;
const TICK_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 400;
const GEO_TIMEOUT_MS = 8_000;

const PRAYERS = [
  { key: "Fajr", label: "Subuh" },
  { key: "Dhuhr", label: "Dzuhur" },
  { key: "Asr", label: "Ashar" },
  { key: "Maghrib", label: "Maghrib" },
  { key: "Isha", label: "Isya" },
] as const;

type PrayerKey = (typeof PRAYERS)[number]["key"];
type Timings = Record<PrayerKey, string>;
interface PrayerTime { label: string; at: Date }
interface Location { lat: number; lng: number; name: string; source: "auto" | "manual" }
interface PlaceResult { name: string; lat: number; lng: number }

const DEFAULT_LOCATION: Location = { lat: -6.2088, lng: 106.8456, name: "Jakarta", source: "manual" };

let location: Location = loadLocation();
let timings: Timings | null = null;
let timingsKey = "";
let notified = new Set<string>();
let searchTimer: number | undefined;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function loadLocation(): Location {
  try {
    const raw = localStorage.getItem("location");
    if (raw) return JSON.parse(raw) as Location;
  } catch {
    // data rusak: pakai default
  }
  return DEFAULT_LOCATION;
}

function saveLocation(loc: Location) {
  location = loc;
  localStorage.setItem("location", JSON.stringify(loc));
  $("#location-label").textContent = `Lokasi: ${loc.name}${loc.source === "auto" ? " (otomatis)" : ""}`;
  // Paksa ambil ulang jadwal untuk lokasi baru
  timingsKey = "";
}

function setStatus(msg: string) {
  $("#status").textContent = msg;
}

function todayId(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Aladhan membaca path sebagai DD-MM-YYYY (lihat /api/prayer-times di quran-next) */
function aladhanDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

/** fetch dengan timeout. AbortSignal.timeout() tidak ada di WebKit macOS 12 (Safari 15). */
async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Timeout + 1x retry untuk gangguan jaringan sesaat */
async function fetchJsonRetry(url: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchTimings(loc: Location): Promise<Timings> {
  const url =
    `https://api.aladhan.com/v1/timings/${aladhanDate(new Date())}` +
    `?latitude=${loc.lat}&longitude=${loc.lng}&method=${API_METHOD}`;
  const json = await fetchJsonRetry(url);
  const t = json?.data?.timings;
  if (!t) throw new Error("format respons tidak dikenal");
  // Nilai Aladhan bisa berbentuk "04:35 (WIB)", ambil jam saja
  const clean = (v: string) => v.split(" ")[0];
  return {
    Fajr: clean(t.Fajr),
    Dhuhr: clean(t.Dhuhr),
    Asr: clean(t.Asr),
    Maghrib: clean(t.Maghrib),
    Isha: clean(t.Isha),
  };
}

// ---------- Pencarian kota (manual) ----------

async function searchPlaces(q: string): Promise<PlaceResult[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=id` +
    `&q=${encodeURIComponent(q)}`;
  const data: any[] = await fetchJsonRetry(url);
  return data.map((item) => ({
    name: String(item.display_name).split(",").slice(0, 2).join(",").trim(),
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
  }));
}

function renderSearchResults(results: PlaceResult[]) {
  const ul = $("#search-results");
  ul.innerHTML = "";
  for (const r of results) {
    const li = document.createElement("li");
    li.textContent = r.name;
    li.addEventListener("click", () => {
      saveLocation({ lat: r.lat, lng: r.lng, name: r.name, source: "manual" });
      ($("#search-input") as HTMLInputElement).value = "";
      ul.innerHTML = "";
      setStatus("");
      render();
    });
    ul.appendChild(li);
  }
  if (results.length === 0) setStatus("Kota tidak ditemukan. Coba nama lain.");
}

// ---------- Deteksi otomatis ----------

async function reverseName(lat: number, lng: number): Promise<string> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=id` +
    `&lat=${lat}&lon=${lng}`;
  const json = await fetchJsonRetry(url);
  const a = json?.address ?? {};
  return a.city || a.town || a.county || a.village || a.state || "Lokasi saat ini";
}

function browserPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("geolocation tidak tersedia"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: GEO_TIMEOUT_MS, maximumAge: 10 * 60_000 },
    );
  });
}

/**
 * Cadangan jika GPS/izin lokasi tidak tersedia: perkirakan dari IP.
 * Perkiraan IP bisa meleset ke kota terdekat dari ISP, jadi pencarian manual tetap disediakan.
 */
async function ipPosition(): Promise<{ lat: number; lng: number; name: string }> {
  const sources: { url: string; parse: (j: any) => { lat: number; lng: number; name: string } | null }[] = [
    {
      url: "https://ipapi.co/json/",
      parse: (j) => (typeof j?.latitude === "number" ? { lat: j.latitude, lng: j.longitude, name: j.city } : null),
    },
    {
      url: "https://ipwho.is/",
      parse: (j) => (j?.success && typeof j?.latitude === "number" ? { lat: j.latitude, lng: j.longitude, name: j.city } : null),
    },
  ];
  for (const s of sources) {
    try {
      const pos = s.parse(await fetchJsonRetry(s.url));
      if (pos) return { ...pos, name: pos.name || "Lokasi saat ini" };
    } catch {
      // coba sumber berikutnya
    }
  }
  throw new Error("lokasi dari IP tidak tersedia");
}

async function detectAutomatically() {
  setStatus("Mendeteksi lokasi...");
  try {
    const pos = await browserPosition();
    let name = "Lokasi saat ini";
    try {
      name = await reverseName(pos.lat, pos.lng);
    } catch {
      // nama kota gagal: tetap pakai koordinat
    }
    saveLocation({ ...pos, name, source: "auto" });
  } catch {
    try {
      const pos = await ipPosition();
      saveLocation({ lat: pos.lat, lng: pos.lng, name: pos.name, source: "auto" });
    } catch (e) {
      setStatus("Lokasi otomatis tidak bisa dideteksi. Cari kota secara manual.");
      console.error(e);
      return;
    }
  }
  setStatus("");
  render();
}

// ---------- Jadwal, tray, notifikasi ----------

function toDate(hhmm: string, base: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function todayPrayers(t: Timings, now: Date): PrayerTime[] {
  return PRAYERS.map((p) => ({ label: p.label, at: toDate(t[p.key], now) }));
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}j ${m}m` : `${m}m`;
}

async function render() {
  const now = new Date();
  const key = `${todayId(now)}|${location.lat},${location.lng}`;

  // Ganti hari atau lokasi: ambil jadwal baru
  if (key !== timingsKey) {
    try {
      timings = await fetchTimings(location);
      timingsKey = key;
      notified = new Set();
      // Waktu yang sudah lewat saat jadwal dimuat tidak perlu dinotifikasi
      for (const p of todayPrayers(timings, now)) {
        if (p.at.getTime() <= now.getTime()) notified.add(`${key}-${p.label}`);
      }
      setStatus("");
    } catch (e) {
      setStatus("Jadwal belum bisa dimuat. Coba lagi nanti.");
      console.error(e);
      return;
    }
  }
  if (!timings) return;

  const list = todayPrayers(timings, now);
  const next = list.find((p) => p.at.getTime() > now.getTime());

  $("#timings").innerHTML = list
    .map((p) => {
      const passed = p.at.getTime() <= now.getTime();
      return `<li class="${passed ? "passed" : ""}"><span>${p.label}</span><span>${
        p.at.toTimeString().slice(0, 5)
      }</span></li>`;
    })
    .join("");

  // Notifikasi saat waktu sholat tiba (sekali per waktu, per hari)
  for (const p of list) {
    const nkey = `${key}-${p.label}`;
    if (p.at.getTime() <= now.getTime() && !notified.has(nkey)) {
      notified.add(nkey);
      if (await isPermissionGranted()) {
        sendNotification({
          title: `Waktunya ${p.label}`,
          body: "Mari tunaikan sholat. Semoga Allah menerima ibadah kita.",
        });
      }
    }
  }

  if (next) {
    const time = next.at.toTimeString().slice(0, 5);
    const left = formatDuration(next.at.getTime() - now.getTime());
    $("#next-prayer").textContent = `Berikutnya: ${next.label} ${time} (${left} lagi)`;
    const short = `${next.label} ${time} · ${left}`;
    await invoke("update_tray", { text: short, tooltip: short }).catch(console.error);
  } else {
    $("#next-prayer").textContent = "Jadwal hari ini sudah selesai";
    await invoke("update_tray", { text: "", tooltip: "Quran Insight" }).catch(console.error);
  }
}

async function setupNotifications() {
  if (!(await isPermissionGranted())) {
    await requestPermission();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("#location-label").textContent = `Lokasi: ${location.name}${location.source === "auto" ? " (otomatis)" : ""}`;

  $("#auto-btn").addEventListener("click", () => {
    detectAutomatically();
  });

  $("#search-input").addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim();
    window.clearTimeout(searchTimer);
    if (q.length < 3) {
      $("#search-results").innerHTML = "";
      return;
    }
    searchTimer = window.setTimeout(async () => {
      setStatus("Mencari kota...");
      try {
        renderSearchResults(await searchPlaces(q));
        if (!$("#status").textContent?.startsWith("Kota tidak")) setStatus("");
      } catch (err) {
        setStatus("Pencarian kota gagal. Periksa koneksi internet.");
        console.error(err);
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  setupNotifications().finally(() => {
    render();
    setInterval(render, TICK_MS);
  });
});
