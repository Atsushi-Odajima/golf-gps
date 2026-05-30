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

  // PAR vote tally: hole# → { par: count }.
  // We collect every PAR-near-HOLE mention across the whole page and let
  // majority decide the final value. This is robust against parents that
  // contain multiple holes (where naive proximity matches the wrong PAR).
  const parVotes = new Map<number, Map<number, number>>();
  const voteFor = (holeNum: number, par: number) => {
    let m = parVotes.get(holeNum);
    if (!m) {
      m = new Map();
      parVotes.set(holeNum, m);
    }
    m.set(par, (m.get(par) ?? 0) + 1);
  };

  const PAR_REGEX = /PAR\s*[:：]?\s*([3-6])(?!\d)/i;

  const scanElement = ($el: cheerio.Cheerio<AnyNode>) => {
    scanned++;
    const text = $el.text();

    // Find every HOLE marker in this element's text and split into segments,
    // one per hole. This avoids leaking PAR across hole boundaries when a
    // parent wraps several holes.
    const holeMarkers: { idx: number; number: number }[] = [];
    const holeRegex = /HOLE\s*[:：]?\s*(\d{1,2})\b/gi;
    let hm: RegExpExecArray | null;
    while ((hm = holeRegex.exec(text)) !== null) {
      const n = parseInt(hm[1], 10);
      if (n >= 1 && n <= 36) holeMarkers.push({ idx: hm.index, number: n });
    }
    if (holeMarkers.length === 0) return;

    // Only attribute the element's image to a hole when this element contains
    // exactly one hole (otherwise we can't tell which image is which).
    const singleHole = holeMarkers.length === 1;
    const candidates = singleHole ? collectImageCandidates($el, $) : [];
    const imageUrl = singleHole ? bestImageUrl(candidates, sourceUrl) : null;

    for (let i = 0; i < holeMarkers.length; i++) {
      const number = holeMarkers[i].number;
      const start = holeMarkers[i].idx;
      const end = i + 1 < holeMarkers.length ? holeMarkers[i + 1].idx : text.length;
      const segment = text.substring(start, end);

      // PAR in the first ~250 chars of this hole's segment
      const parMatch = segment
        .substring(0, Math.min(segment.length, 250))
        .match(PAR_REGEX);
      if (parMatch) {
        voteFor(number, parseInt(parMatch[1], 10));
      }

      // Yardages
      const yardages: ImportedHole["yardages"] = {};
      const yardRegex = /(Blue|White|Green|Red|BLACK|GOLD)[^\d]{0,20}(\d{2,3})/gi;
      let m: RegExpExecArray | null;
      while ((m = yardRegex.exec(segment)) !== null) {
        const key = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const yd = parseInt(m[2], 10);
        if (yd > 50 && yd < 800 && !(key in yardages)) {
          (yardages as Record<string, number>)[key] = yd;
        }
      }

      const existing = holes.get(number);
      // Provisional par; will be overwritten by majority vote at the end.
      const par = parMatch ? parseInt(parMatch[1], 10) : (existing?.par ?? 4);

      const next: ImportedHole = {
        number,
        par,
        imageUrl: singleHole ? imageUrl : (existing?.imageUrl ?? null),
        imageCandidates:
          singleHole && candidates.length > 0 && candidates.length < 30
            ? candidates.slice(0, 8)
            : existing?.imageCandidates,
        yardages:
          existing?.yardages ?? (Object.keys(yardages).length ? yardages : undefined),
      };

      if (!existing) {
        holes.set(number, next);
      } else {
        // Upgrade image if better
        let mergedImage = existing.imageUrl;
        if (singleHole && imageUrl) {
          if (!existing.imageUrl) mergedImage = imageUrl;
          else if (scoreImageUrl(imageUrl) > scoreImageUrl(existing.imageUrl))
            mergedImage = imageUrl;
        }
        holes.set(number, {
          ...existing,
          imageUrl: mergedImage,
          yardages: existing.yardages ?? next.yardages,
        });
      }
    }
  };

  // ----- Scorecard-table detection -----
  // Many golf course pages include a scorecard with a "PAR" row whose cells
  // are the 18 par values. If found, those are extremely reliable and we
  // add them as additional votes (heavily weighted).
  const scanScorecard = () => {
    $("tr").each((_, row) => {
      const cells = $(row)
        .find("th, td")
        .toArray()
        .map((c) => $(c).text().trim());
      if (cells.length < 18) return;
      const labelIdx = cells.findIndex((c) => /^(PAR|パー)\b/i.test(c));
      if (labelIdx < 0) return;

      const collected: number[] = [];
      for (let i = labelIdx + 1; i < cells.length; i++) {
        const n = parseInt(cells[i], 10);
        if (!isNaN(n) && n >= 3 && n <= 6) {
          collected.push(n);
          if (collected.length === 18) break;
        }
        // larger numbers (OUT/IN/TOTAL subtotals) are skipped silently
      }
      if (collected.length === 18) {
        // Weight scorecard votes heavily so they win against noisy section parses.
        collected.forEach((p, i) => {
          for (let w = 0; w < 5; w++) voteFor(i + 1, p);
        });
        notes.push(`scorecard found: pars ${collected.join(",")}`);
      }
    });
  };

  // Strategy 0: scorecard table (most reliable PAR source if present)
  scanScorecard();

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

  // Apply majority-vote PAR to each hole. The scorecard table votes are
  // weighted 5x so they win against any single noisy section parse.
  for (const [number, parCounts] of parVotes) {
    let bestPar = 4;
    let bestCount = 0;
    for (const [par, count] of parCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestPar = par;
      }
    }
    const hole = holes.get(number);
    if (hole) {
      hole.par = bestPar;
    } else {
      // PAR vote without an associated hole entry (e.g., scorecard-only):
      // create a stub so the hole shows up in the imported course.
      holes.set(number, { number, par: bestPar, imageUrl: null });
    }
  }
  notes.push(`par votes: ${JSON.stringify(Object.fromEntries(
    Array.from(parVotes).map(([n, m]) => [n, Object.fromEntries(m)])
  ))}`);

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
