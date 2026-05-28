"use client";

import { Course, Hole, imageKey, saveCourse, saveImage } from "./storage";

export interface ImportedHole {
  number: number;
  par: number;
  imageUrl: string | null;
  imageCandidates?: string[];
  yardages?: Record<string, number>;
}

export interface ImportedCourse {
  name: string;
  source: string;
  holes: ImportedHole[];
  diagnostics?: {
    htmlBytes: number;
    totalImages: number;
    holeSectionsTried: number;
    notes: string[];
  };
}

export interface ImportProgress {
  total: number;
  completed: number;
  current?: string;
  failures: { hole: number; reason: string }[];
}

export async function fetchImportedCourse(url: string): Promise<ImportedCourse> {
  const res = await fetch(`/api/import-course?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `インポート失敗 (${res.status})`);
  }
  return data as ImportedCourse;
}

async function downsampleImageBlob(blob: Blob, maxDim: number): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveImportedCourse(
  imported: ImportedCourse,
  onProgress?: (p: ImportProgress) => void,
): Promise<Course> {
  const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const holes: Hole[] = imported.holes.map((h) => ({
    number: h.number,
    par: h.par,
    imageDataUrl: null,
    tee: null,
    green: null,
    teePx: null,
    greenPx: null,
    yardages: h.yardages,
  }));
  const course: Course = { id, name: imported.name, holes };

  const total = imported.holes.length;
  const failures: ImportProgress["failures"] = [];
  let completed = 0;
  onProgress?.({ total, completed, failures });

  // Download images sequentially (gentle on the source server, easier progress UI)
  for (let i = 0; i < imported.holes.length; i++) {
    const ih = imported.holes[i];
    if (ih.imageUrl) {
      try {
        onProgress?.({
          total,
          completed,
          current: `Hole ${ih.number} の画像を取得中`,
          failures,
        });
        const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(ih.imageUrl)}`);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 80)}`);
        }
        const blob = await res.blob();
        if (blob.size < 200) {
          throw new Error(`画像サイズが小さすぎる (${blob.size}B)`);
        }
        const dataUrl = await downsampleImageBlob(blob, 1600);
        await saveImage(imageKey(course.id, ih.number), dataUrl);
        const holeIdx = course.holes.findIndex((h) => h.number === ih.number);
        if (holeIdx >= 0) course.holes[holeIdx].imageDataUrl = "stored";
      } catch (e) {
        failures.push({
          hole: ih.number,
          reason: `${e instanceof Error ? e.message : String(e)} (${ih.imageUrl})`,
        });
      }
    } else {
      failures.push({ hole: ih.number, reason: "画像URLが見つからず" });
    }
    completed++;
    onProgress?.({ total, completed, failures });
  }

  await saveCourse(course);
  return course;
}
