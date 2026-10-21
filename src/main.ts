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

let timings: Timings | null = null;
let timingsDate = "";
let notified = new Set<string>();

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function getLocation(): { city: string; country: string } {
  return {
    city: localStorage.getItem("city") || "Jakarta",
    country: localStorage.getItem("country") || "Indonesia",
  };
}

function todayId(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function fetchTimings(): Promise<Timings> {
  const { city, country } = getLocation();
  const url =
    `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}` +
    `&country=${encodeURIComponent(country)}&method=${API_METHOD}`;

  // Timeout + 1x retry untuk gangguan jaringan sesaat.
  // AbortSignal.timeout() tidak ada di WebKit macOS 12 (Safari 15), jadi pakai AbortController.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
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
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

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

  // Ganti hari: ambil jadwal baru
  if (todayId(now) !== timingsDate) {
    try {
      timings = await fetchTimings();
      timingsDate = todayId(now);
      notified = new Set();
      // Waktu yang sudah lewat saat jadwal dimuat tidak perlu dinotifikasi
      for (const p of todayPrayers(timings, now)) {
        if (p.at.getTime() <= now.getTime()) notified.add(`${timingsDate}-${p.label}`);
      }
      $("#status").textContent = "";
    } catch (e) {
      $("#status").textContent = "Jadwal belum bisa dimuat. Coba lagi nanti.";
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
    const key = `${timingsDate}-${p.label}`;
    if (p.at.getTime() <= now.getTime() && !notified.has(key)) {
      notified.add(key);
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
  const { city, country } = getLocation();
  ($("#city-input") as HTMLInputElement).value = city;
  ($("#country-input") as HTMLInputElement).value = country;

  $("#city-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = ($("#city-input") as HTMLInputElement).value.trim();
    const n = ($("#country-input") as HTMLInputElement).value.trim();
    if (!c || !n) return;
    localStorage.setItem("city", c);
    localStorage.setItem("country", n);
    // Paksa ambil ulang jadwal untuk lokasi baru
    timingsDate = "";
    render();
  });

  setupNotifications().finally(() => {
    render();
    setInterval(render, TICK_MS);
  });
});
