"use client";

import type { LatLng, Pixel } from "./geo";

export interface Hole {
  number: number;
  par: number;
  imageDataUrl: string | null;
  tee: LatLng | null;
  green: LatLng | null;
  teePx: Pixel | null;
  greenPx: Pixel | null;
  yardages?: Record<string, number>;
}

export interface Course {
  id: string;
  name: string;
  holes: Hole[];
}

export interface TrackPoint {
  lat: number;
  lng: number;
  t: number;
}

export interface Round {
  courseId: string;
  startedAt: number;
  strokes: Record<number, number>;
  tracks: Record<number, TrackPoint[]>;
}

const DB_NAME = "golfgps";
const DB_VERSION = 2;
const STORE_IMAGES = "images";
const STORE_COURSES = "courses";

const LEGACY_COURSES_KEY = "golfgps.courses";
const ACTIVE_ROUND_KEY = "golfgps.activeRound";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES);
      }
      if (!db.objectStoreNames.contains(STORE_COURSES)) {
        db.createObjectStore(STORE_COURSES, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

// ---------- Persistent storage request ----------
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  if (!navigator.storage?.persist) return false;
  try {
    const already = await navigator.storage.persisted();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageStatus {
  persistent: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  courses: number;
  images: number;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const courses = await listCourses();
  const images = await countImages();
  let persistent = false;
  let usageBytes: number | undefined;
  let quotaBytes: number | undefined;
  if (typeof navigator !== "undefined") {
    try {
      persistent = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        usageBytes = est.usage;
        quotaBytes = est.quota;
      }
    } catch {
      // ignore
    }
  }
  return { persistent, usageBytes, quotaBytes, courses: courses.length, images };
}

// ---------- Image storage ----------
export async function saveImage(key: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, "readwrite");
    tx.objectStore(STORE_IMAGES).put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadImage(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, "readonly");
    const req = tx.objectStore(STORE_IMAGES).get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteImage(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, "readwrite");
    tx.objectStore(STORE_IMAGES).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function countImages(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, "readonly");
    const req = tx.objectStore(STORE_IMAGES).count();
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export function imageKey(courseId: string, holeNumber: number): string {
  return `${courseId}:${holeNumber}`;
}

// ---------- Course storage (async, IndexedDB) ----------
let legacyMigrated = false;

async function migrateLegacyIfNeeded(): Promise<void> {
  if (legacyMigrated) return;
  legacyMigrated = true;
  if (typeof localStorage === "undefined") return;
  const legacy = localStorage.getItem(LEGACY_COURSES_KEY);
  if (!legacy) return;
  try {
    const courses = JSON.parse(legacy) as Course[];
    if (!Array.isArray(courses) || courses.length === 0) {
      localStorage.removeItem(LEGACY_COURSES_KEY);
      return;
    }
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_COURSES, "readwrite");
      const store = tx.objectStore(STORE_COURSES);
      for (const c of courses) store.put(c);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    localStorage.removeItem(LEGACY_COURSES_KEY);
  } catch {
    // leave legacy in place on error
  }
}

export async function listCourses(): Promise<Course[]> {
  await migrateLegacyIfNeeded();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_COURSES, "readonly");
    const req = tx.objectStore(STORE_COURSES).getAll();
    req.onsuccess = () => resolve((req.result as Course[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getCourse(id: string): Promise<Course | null> {
  await migrateLegacyIfNeeded();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_COURSES, "readonly");
    const req = tx.objectStore(STORE_COURSES).get(id);
    req.onsuccess = () => resolve((req.result as Course) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCourse(course: Course): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_COURSES, "readwrite");
    tx.objectStore(STORE_COURSES).put(course);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCourse(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_COURSES, "readwrite");
    tx.objectStore(STORE_COURSES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  for (let n = 1; n <= 36; n++) {
    try {
      await deleteImage(imageKey(id, n));
    } catch {
      // ignore
    }
  }
}

export function createBlankCourse(name: string, holeCount: number): Course {
  const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const holes: Hole[] = Array.from({ length: holeCount }, (_, i) => ({
    number: i + 1,
    par: 4,
    imageDataUrl: null,
    tee: null,
    green: null,
    teePx: null,
    greenPx: null,
  }));
  return { id, name, holes };
}

// ---------- Active round (sync, localStorage — small ephemeral data) ----------
export function getActiveRound(): Round | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACTIVE_ROUND_KEY);
    return raw ? (JSON.parse(raw) as Round) : null;
  } catch {
    return null;
  }
}

export function saveActiveRound(round: Round): void {
  localStorage.setItem(ACTIVE_ROUND_KEY, JSON.stringify(round));
}

export function clearActiveRound(): void {
  localStorage.removeItem(ACTIVE_ROUND_KEY);
}

export function startRound(courseId: string): Round {
  const round: Round = {
    courseId,
    startedAt: Date.now(),
    strokes: {},
    tracks: {},
  };
  saveActiveRound(round);
  return round;
}

// ---------- Backup / Restore (JSON file) ----------
export interface BackupBundle {
  version: 1;
  exportedAt: number;
  courses: Course[];
  images: { key: string; dataUrl: string }[];
}

export async function exportAll(): Promise<BackupBundle> {
  const courses = await listCourses();
  const db = await openDb();
  const images: { key: string; dataUrl: string }[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, "readonly");
    const store = tx.objectStore(STORE_IMAGES);
    const out: { key: string; dataUrl: string }[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ key: String(cursor.key), dataUrl: cursor.value as string });
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
  return { version: 1, exportedAt: Date.now(), courses, images };
}

export async function importAll(bundle: BackupBundle, mode: "merge" | "replace" = "merge"): Promise<void> {
  if (bundle.version !== 1) throw new Error("非対応のバックアップ形式です");
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_COURSES, STORE_IMAGES], "readwrite");
    const courseStore = tx.objectStore(STORE_COURSES);
    const imageStore = tx.objectStore(STORE_IMAGES);
    if (mode === "replace") {
      courseStore.clear();
      imageStore.clear();
    }
    for (const c of bundle.courses) courseStore.put(c);
    for (const img of bundle.images) imageStore.put(img.dataUrl, img.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function downloadBackup(bundle: BackupBundle): void {
  const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date(bundle.exportedAt).toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `kabenokyorikei-backup-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
