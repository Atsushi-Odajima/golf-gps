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

const COURSES_KEY = "golfgps.courses";
const ACTIVE_ROUND_KEY = "golfgps.activeRound";

// ---------- DB (IndexedDB for images, localStorage for metadata) ----------
// Images are big; we store image data URLs in IndexedDB and keep only metadata in localStorage.

const DB_NAME = "golfgps";
const DB_VERSION = 1;
const STORE_IMAGES = "images";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

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

export function imageKey(courseId: string, holeNumber: number): string {
  return `${courseId}:${holeNumber}`;
}

// ---------- Courses ----------
export function listCourses(): Course[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(COURSES_KEY);
    return raw ? (JSON.parse(raw) as Course[]) : [];
  } catch {
    return [];
  }
}

export function getCourse(id: string): Course | null {
  return listCourses().find((c) => c.id === id) ?? null;
}

export function saveCourse(course: Course): void {
  const all = listCourses();
  const idx = all.findIndex((c) => c.id === course.id);
  if (idx >= 0) all[idx] = course;
  else all.push(course);
  localStorage.setItem(COURSES_KEY, JSON.stringify(all));
}

export async function deleteCourse(id: string): Promise<void> {
  const all = listCourses().filter((c) => c.id !== id);
  localStorage.setItem(COURSES_KEY, JSON.stringify(all));
  // best-effort: drop any images for hole numbers 1..36
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

// ---------- Active round ----------
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
