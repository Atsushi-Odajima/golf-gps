import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export const runtime = "nodejs";
export const maxDuration = 30;

export interface ImportedHole {
  number: number;
  par: number;
  imageUrl: string | null;
  imageCandidates?: string[];
  yardages?: { Blue?: number; White?: number; Green?: number; Red?: number };
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
          diagnostics: parsed.diagnostics,
        },
        { status: 422 },
      );
    }
    return Response.json(parsed);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// ---------- helpers ----------

const SRC_ATTRS = [
  "src",
  "data-src",
  "data-original",
  "data-lazy",
  "data-lazy-src",
  "data-image",
  "data-image-src",
  "data-bg",
  "data-srcset",
  "srcset",
];

const JUNK_PATTERNS = [
  /\b(icon|logo|btn|button|arrow|bullet|gnav|spacer|blank|transparent|pixel)\b/i,
  /1x1\.gif/i,
  /\.svg($|\?)/i,
];

const STRONG_HOLE_PATTERNS = [/hole/i, /layout/i, /course/i, /map/i];

function collectImageCandidates(
  $el: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI,
): string[] {
  const out: string[] = [];

  const pushFromSrcLike = (val: string | undefined) => {
    if (!val) return;
    // srcset: "url1 320w, url2 640w" — take ALL urls (we'll score later)
    if (val.includes(",") && /\d+[wx]/.test(val)) {
      for (const part of val.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url) out.push(url);
      }
    } else {
      out.push(val.trim());
    }
  };

  $el.find("img, source, picture > source").each((_, im) => {
    const el = im as Element;
    for (const attr of SRC_ATTRS) {
      const v = el.attribs?.[attr];
      if (v) pushFromSrcLike(v);
    }
  });

  // background-image styles
  $el.find("[style*='background']").each((_, im) => {
    const el = im as Element;
    const style = el.attribs?.style || "";
    const m = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
    if (m) out.push(m[1]);
  });

  // <noscript> often hides the real img tag for lazy-loaded pages
  $el.find("noscript").each((_, n) => {
    const inner = $(n).text();
    const m = inner.match(/src=['"]([^'"]+)['"]/i);
    if (m) out.push(m[1]);
  });

  return out;
}

function scoreImageUrl(url: string): number {
  let score = 0;
  for (const p of STRONG_HOLE_PATTERNS) if (p.test(url)) score += 10;
  if (/\.(jpe?g|png|webp)(\?|$)/i.test(url)) score += 5;
  if (/thumb|thumbnail|small|sp_|mini/i.test(url)) score -= 5;
  if (/large|big|full|original|pc_/i.test(url)) score += 3;
  // prefer longer paths (typically more specific) over short ones
  score += Math.min(5, Math.floor(url.length / 30));
  return score;
}

function bestImageUrl(candidates: string[], sourceUrl: string): string | null {
  const cleaned = candidates
    .map((c) => c?.trim())
    .filter((c) => c && c.length > 3 && !c.startsWith("data:"))
    .filter((c) => !JUNK_PATTERNS.some((p) => p.test(c)));
  if (!cleaned.length) return null;
  const scored = cleaned.map((url) => ({ url, score: scoreImageUrl(url) }));
  scored.sort((a, b) => b.score - a.score);
  try {
    return new URL(scored[0].url, sourceUrl).href;
  } catch {
    return null;
  }
}

function parseCourse(html: string, sourceUrl: string): ImportedCourse {
  const $ = cheerio.load(html);
  const notes: string[] = [];

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

  const holes = new Map<number, ImportedHole>();
  let scanned = 0;

  const scanElement = ($el: cheerio.Cheerio<AnyNode>) => {
    scanned++;
    const text = $el.text();
    const holeMatch = text.match(/HOLE\s*[:：]?\s*(\d{1,2})\b/i);
    if (!holeMatch) return;
    const number = parseInt(holeMatch[1], 10);
    if (number < 1 || number > 36) return;

    const parMatch = text.match(/PAR\s*[:：]?\s*(\d)/i);
    const par = parMatch ? parseInt(parMatch[1], 10) : 4;

    const candidates = collectImageCandidates($el, $);
    const imageUrl = bestImageUrl(candidates, sourceUrl);

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

    const existing = holes.get(number);
    if (
      !existing ||
      // upgrade: if existing has no image and new one does
      (!existing.imageUrl && imageUrl) ||
      // upgrade: if existing's image has a worse score than the new one
      (imageUrl &&
        existing.imageUrl &&
        scoreImageUrl(imageUrl) > scoreImageUrl(existing.imageUrl))
    ) {
      holes.set(number, {
        number,
        par,
        imageUrl,
        imageCandidates: candidates.length > 0 && candidates.length < 30 ? candidates.slice(0, 8) : undefined,
        yardages: Object.keys(yardages).length ? yardages : undefined,
      });
    }
  };

  // Strategy 1: structural class hints
  $(
    'section, article, div[class*="hole" i], div[class*="layout" i], li[class*="hole" i], li[class*="layout" i], .swiper-slide, .slick-slide',
  ).each((_, el) => {
    scanElement($(el));
  });
  notes.push(`strategy1: ${holes.size} holes`);

  // Strategy 2: broad sweep (avoid very large containers)
  if (holes.size < 9) {
    $("div, li, td").each((_, el) => {
      const $el = $(el);
      if ($el.find("div, li, td").length > 50) return;
      scanElement($el);
    });
    notes.push(`strategy2: ${holes.size} holes`);
  }

  // Strategy 3: heading lookup
  if (holes.size < 9) {
    $("h1, h2, h3, h4, h5").each((_, el) => {
      const $el = $(el);
      const t = $el.text();
      if (!/HOLE\s*[:：]?\s*\d/i.test(t)) return;
      let parent = $el.parent();
      for (let i = 0; i < 5 && parent.length; i++) {
        if (parent.find("img, source, [style*='background']").length) {
          scanElement(parent);
          break;
        }
        parent = parent.parent();
      }
    });
    notes.push(`strategy3: ${holes.size} holes`);
  }

  // Strategy 4: last-resort whole-page image grid scan (image URLs containing "hole")
  if (holes.size < 9) {
    // Find all images whose URL contains "hole" or "layout"
    const all: { src: string; index: number }[] = [];
    $("img, source").each((idx, im) => {
      const el = im as Element;
      for (const a of SRC_ATTRS) {
        const v = el.attribs?.[a];
        if (!v) continue;
        if (/hole|layout/i.test(v)) {
          // Resolve hole number from URL like hole01.jpg or _hole_1.png
          const m = v.match(/hole[_-]?(\d{1,2})/i) || v.match(/(\d{1,2})\.(jpe?g|png|webp)/i);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 1 && n <= 36) {
              all.push({ src: v, index: n });
            }
          }
        }
      }
    });
    for (const { src, index } of all) {
      if (holes.has(index)) continue;
      try {
        const abs = new URL(src, sourceUrl).href;
        holes.set(index, { number: index, par: 4, imageUrl: abs });
      } catch {
        // ignore
      }
    }
    notes.push(`strategy4: ${holes.size} holes`);
  }

  const totalImages = $("img").length;
  const finalHoles = Array.from(holes.values()).sort((a, b) => a.number - b.number);

  return {
    name,
    source: sourceUrl,
    holes: finalHoles,
    diagnostics: {
      htmlBytes: html.length,
      totalImages,
      holeSectionsTried: scanned,
      notes,
    },
  };
}
