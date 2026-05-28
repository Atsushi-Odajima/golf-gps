import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 30;

export interface ImportedHole {
  number: number;
  par: number;
  imageUrl: string | null;
  yardages?: { Blue?: number; White?: number; Green?: number; Red?: number };
}

export interface ImportedCourse {
  name: string;
  source: string;
  holes: ImportedHole[];
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return Response.json({ error: "url が指定されていません" }, { status: 400 });
  }
  try {
    new URL(url);
  } catch {
    return Response.json({ error: "URLの形式が不正です" }, { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        "Accept-Language": "ja,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return Response.json(
        { error: `ページの取得に失敗しました (${res.status})` },
        { status: 502 },
      );
    }
    const html = await res.text();
    const parsed = parseCourse(html, url);
    if (parsed.holes.length === 0) {
      return Response.json(
        {
          error:
            "ホール情報を抽出できませんでした。サイト構造が想定と異なる可能性があります。",
          name: parsed.name,
        },
        { status: 422 },
      );
    }
    return Response.json(parsed);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

function parseCourse(html: string, sourceUrl: string): ImportedCourse {
  const $ = cheerio.load(html);
  const origin = new URL(sourceUrl).origin;

  // ---------- Course name ----------
  let name = "";
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) name = ogTitle;
  if (!name) name = $("h1").first().text().trim();
  if (!name) {
    name = $("title").text().trim();
    name = name.split(/[|｜\-―]/)[0].trim();
  }
  name = name.replace(/コースレイアウト|レイアウト|コース紹介/g, "").trim();
  if (!name) name = "インポートしたコース";

  // ---------- Collect candidate hole sections ----------
  // We look for elements whose text contains BOTH "HOLE" and "PAR" near a hole number.
  const holes = new Map<number, ImportedHole>();

  const scanElement = ($el: cheerio.Cheerio<any>) => {
    const text = $el.text();
    const holeMatch = text.match(/HOLE\s*[:：]?\s*(\d{1,2})\b/i);
    if (!holeMatch) return;
    const number = parseInt(holeMatch[1], 10);
    if (number < 1 || number > 36) return;

    const parMatch = text.match(/PAR\s*[:：]?\s*(\d)/i);
    const par = parMatch ? parseInt(parMatch[1], 10) : 4;

    // Find a representative image (skip icons/logos/tiny assets)
    let imageUrl: string | null = null;
    $el.find("img").each((_, im) => {
      if (imageUrl) return;
      const src =
        $(im).attr("src") ||
        $(im).attr("data-src") ||
        $(im).attr("data-original") ||
        $(im).attr("data-lazy") ||
        "";
      if (!src) return;
      const low = src.toLowerCase();
      if (
        low.includes("icon") ||
        low.includes("logo") ||
        low.includes("spacer") ||
        low.includes(".svg")
      )
        return;
      try {
        imageUrl = new URL(src, sourceUrl).href;
      } catch {
        imageUrl = null;
      }
    });

    // Yardages
    const yardages: ImportedHole["yardages"] = {};
    const yardRegex = /(Blue|White|Green|Red|BLACK|GOLD)[^\d]{0,20}(\d{2,3})/gi;
    let m: RegExpExecArray | null;
    while ((m = yardRegex.exec(text)) !== null) {
      const key = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const yd = parseInt(m[2], 10);
      if (yd > 50 && yd < 800 && !(key in yardages)) {
        (yardages as Record<string, number>)[key] = yd;
      }
    }

    // Only add if hole isn't already populated or if this one has an image and the existing doesn't
    const existing = holes.get(number);
    if (
      !existing ||
      (!existing.imageUrl && imageUrl) ||
      (existing.par === 4 && parMatch && par !== 4 && existing.imageUrl === imageUrl)
    ) {
      holes.set(number, {
        number,
        par,
        imageUrl,
        yardages: Object.keys(yardages).length ? yardages : undefined,
      });
    }
  };

  // Strategy 1: descend through structural elements (sections, divs with hole-related classes)
  $(
    'section, article, div[class*="hole" i], div[class*="layout" i], li[class*="hole" i], li[class*="layout" i]',
  ).each((_, el) => {
    scanElement($(el));
  });

  // Strategy 2: if nothing found, sweep all divs/list items (slower but resilient)
  if (holes.size < 9) {
    $("div, li, td").each((_, el) => {
      const $el = $(el);
      // skip very deep wrappers - require the element to be reasonably small
      if ($el.find("div, li, td").length > 50) return;
      scanElement($el);
    });
  }

  // Strategy 3: if STILL nothing, look for headings like "HOLE 1" and walk up to nearest container
  if (holes.size < 9) {
    $("h1, h2, h3, h4, h5").each((_, el) => {
      const $el = $(el);
      const t = $el.text();
      if (!/HOLE\s*[:：]?\s*\d/i.test(t)) return;
      // walk up to find a container with an img
      let parent = $el.parent();
      for (let i = 0; i < 4 && parent.length; i++) {
        if (parent.find("img").length) {
          scanElement(parent);
          break;
        }
        parent = parent.parent();
      }
    });
  }

  const finalHoles = Array.from(holes.values()).sort((a, b) => a.number - b.number);

  return {
    name,
    source: sourceUrl,
    holes: finalHoles,
  };
}
