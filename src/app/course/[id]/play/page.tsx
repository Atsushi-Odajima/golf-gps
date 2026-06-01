"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Course,
  Hole,
  Round,
  clearActiveRound,
  getActiveRound,
  getCourse,
  imageKey,
  loadImage,
  saveActiveRound,
  saveCourse,
  startRound,
} from "@/lib/storage";
import { useGeolocation } from "@/lib/useGeolocation";
import {
  bearingFromTo,
  Calibration,
  haversineMeters,
  metersToYards,
  projectLatLng,
  worldToPixel,
  yardsToMeters,
} from "@/lib/geo";

const MAX_TRACK_POINTS_PER_HOLE = 600;
const MIN_TRACK_DISTANCE_M = 3;
const MIN_TRACK_INTERVAL_MS = 3000;
const SAVE_THROTTLE_MS = 5000;

export default function PlayPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [course, setCourse] = useState<Course | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [currentHole, setCurrentHole] = useState<number>(1);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [showHolePicker, setShowHolePicker] = useState(false);
  const [showTeePicker, setShowTeePicker] = useState(false);
  const [tapMode, setTapMode] = useState<"green" | "tee" | null>(null);
  const lastSaveAtRef = useRef<number>(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const { fix, error: gpsError } = useGeolocation(true);

  // Init course + round
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await getCourse(params.id);
      if (cancelled || !c) return;
      setCourse(c);
      let r = getActiveRound();
      if (!r || r.courseId !== c.id) {
        r = startRound(c.id);
      }
      setRound(r);
      // Priority: explicit ?startHole query → first calibrated hole → 1
      const startHoleParam = searchParams?.get("startHole");
      const parsed = startHoleParam ? parseInt(startHoleParam, 10) : NaN;
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 36) {
        setCurrentHole(parsed);
      } else {
        const firstReady = c.holes.find((h) => h.tee && h.green);
        setCurrentHole(firstReady?.number ?? 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // searchParams intentionally excluded to avoid resetting when URL changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // Load image when hole changes
  useEffect(() => {
    if (!course) return;
    setImageUrl(null);
    setImgSize(null);
    loadImage(imageKey(course.id, currentHole)).then((dataUrl) => {
      if (dataUrl) setImageUrl(dataUrl);
    });
  }, [course, currentHole]);

  // Append GPS fixes to the track for the current hole.
  // Aggressively throttled: only add a point every MIN_TRACK_INTERVAL_MS / MIN_TRACK_DISTANCE_M.
  // localStorage writes are further throttled to SAVE_THROTTLE_MS to keep the main thread free.
  useEffect(() => {
    if (!fix || !round) return;
    setRound((prev) => {
      if (!prev) return prev;
      const existing = prev.tracks[currentHole] ?? [];
      const last = existing[existing.length - 1];
      if (
        last &&
        fix.timestamp - last.t < MIN_TRACK_INTERVAL_MS &&
        haversineMeters({ lat: last.lat, lng: last.lng }, fix) < MIN_TRACK_DISTANCE_M
      ) {
        return prev;
      }
      let newTrack = [
        ...existing,
        { lat: fix.lat, lng: fix.lng, t: fix.timestamp },
      ];
      if (newTrack.length > MAX_TRACK_POINTS_PER_HOLE) {
        newTrack = newTrack.slice(newTrack.length - MAX_TRACK_POINTS_PER_HOLE);
      }
      const next: Round = {
        ...prev,
        tracks: { ...prev.tracks, [currentHole]: newTrack },
      };
      const now = Date.now();
      if (now - lastSaveAtRef.current > SAVE_THROTTLE_MS) {
        lastSaveAtRef.current = now;
        try {
          saveActiveRound(next);
        } catch {
          // ignore - storage pressure shouldn't crash the round
        }
      }
      return next;
    });
  }, [fix, currentHole, round?.courseId]);

  // Make sure the round is always persisted when leaving the page
  useEffect(() => {
    return () => {
      const r = round;
      if (r) {
        try {
          saveActiveRound(r);
        } catch {
          // ignore
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hole: Hole | null = useMemo(
    () => course?.holes.find((h) => h.number === currentHole) ?? null,
    [course, currentHole],
  );

  /**
   * Auto-detect tee→green bearing from the player's GPS track.
   *
   * Once we have a track point at least AUTO_BEARING_MIN_DIST_M meters away from
   * the captured tee, we assume the player walked roughly toward the green and
   * lock in that bearing. The derived green world coords then drive a normal
   * haversine distance calculation, which correctly handles sideways/backward
   * movement after the initial commit is made.
   */
  const AUTO_BEARING_MIN_DIST_M = 30;
  useEffect(() => {
    if (!course || !hole || !hole.tee) return;
    if (hole.bearingFromTeeDeg != null) return; // already locked
    const points = round?.tracks[currentHole] ?? [];
    if (points.length === 0) return;

    let farthest = 0;
    let farthestPoint: { lat: number; lng: number } | null = null;
    for (const p of points) {
      const d = haversineMeters({ lat: p.lat, lng: p.lng }, hole.tee);
      if (d > farthest) {
        farthest = d;
        farthestPoint = { lat: p.lat, lng: p.lng };
      }
    }
    if (!farthestPoint || farthest < AUTO_BEARING_MIN_DIST_M) return;

    const detected = bearingFromTo(hole.tee, farthestPoint);
    const updatedCourse: Course = {
      ...course,
      holes: course.holes.map((h) =>
        h.number === hole.number ? { ...h, bearingFromTeeDeg: detected } : h,
      ),
    };
    setCourse(updatedCourse);
    saveCourse(updatedCourse).catch(() => {
      // non-critical
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    course?.id,
    hole?.number,
    hole?.tee?.lat,
    hole?.tee?.lng,
    hole?.bearingFromTeeDeg,
    round?.tracks[currentHole]?.length,
  ]);

  // Effective tee image position: explicit pin if user has tapped it on the
  // map, otherwise a sensible default near the bottom of the image (Accordia /
  // 国内コースのマップは下端のティーボックスに各ティーカラーのドットが描かれ
  // ているのが標準構図)。
  const effectiveTeePx = useMemo(() => {
    if (hole?.teePx) return hole.teePx;
    if (!imgSize) return null;
    return { x: imgSize.w / 2, y: imgSize.h * 0.9 };
  }, [hole?.teePx, imgSize]);

  const selectedTee = round?.selectedTee;
  const teeYardage = selectedTee && hole?.yardages?.[selectedTee]
    ? hole.yardages[selectedTee]
    : null;

  /**
   * Derived green world coords:
   *   from tee GPS + auto-detected bearing + selected yardage.
   */
  const derivedGreen = useMemo(() => {
    if (!hole?.tee || hole.bearingFromTeeDeg == null || teeYardage == null) return null;
    return projectLatLng(hole.tee, hole.bearingFromTeeDeg, yardsToMeters(teeYardage));
  }, [hole?.tee, hole?.bearingFromTeeDeg, teeYardage]);

  const calibration: Calibration | null = useMemo(() => {
    const tee = hole?.tee ?? null;
    const greenPx = hole?.greenPx ?? null;
    const teePx = effectiveTeePx;
    // Prefer the green derived from bearing + yardage; fall back to a legacy
    // explicit hole.green (LatLng) if it was captured before.
    const green = derivedGreen ?? hole?.green ?? null;
    if (!tee || !green || !teePx || !greenPx) return null;
    return { tee, green, teePx, greenPx };
  }, [hole?.tee, hole?.green, hole?.greenPx, effectiveTeePx, derivedGreen]);

  const yardsToGreen = useMemo(() => {
    if (!fix) return null;
    // Preferred: derived green from bearing
    if (derivedGreen) {
      return metersToYards(haversineMeters(fix, derivedGreen));
    }
    // Fallback: legacy explicit green GPS
    if (hole?.green) {
      return metersToYards(haversineMeters(fix, hole.green));
    }
    // Last resort: linear "yardage - walked from tee"
    if (teeYardage != null && hole?.tee) {
      const walkedM = haversineMeters(fix, hole.tee);
      const walkedY = metersToYards(walkedM);
      return Math.max(0, teeYardage - walkedY);
    }
    return null;
  }, [fix, hole, teeYardage, derivedGreen]);

  const yardsToTee = useMemo(() => {
    if (!fix || !hole?.tee) return null;
    return metersToYards(haversineMeters(fix, hole.tee));
  }, [fix, hole?.tee]);

  const trackPoints = useMemo(
    () => round?.tracks[currentHole] ?? [],
    [round, currentHole],
  );

  const trackPx = useMemo(
    () =>
      calibration
        ? trackPoints.map((p) => worldToPixel(calibration, { lat: p.lat, lng: p.lng }))
        : [],
    [calibration, trackPoints],
  );

  const strokes = round?.strokes[currentHole] ?? 0;
  const setStrokes = (delta: number) => {
    setRound((prev) => {
      if (!prev) return prev;
      const next: Round = {
        ...prev,
        strokes: {
          ...prev.strokes,
          [currentHole]: Math.max(0, (prev.strokes[currentHole] ?? 0) + delta),
        },
      };
      saveActiveRound(next);
      return next;
    });
  };

  const setSelectedTee = (teeName: string) => {
    setRound((prev) => {
      if (!prev) return prev;
      const next: Round = { ...prev, selectedTee: teeName };
      saveActiveRound(next);
      return next;
    });
    setShowTeePicker(false);
  };

  /**
   * Map a click/touch on the displayed map image to natural-image-pixel coords.
   * Accounts for objectFit: contain letterbox/pillarbox.
   */
  const tapToImagePx = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img || !imgSize) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const containerAspect = rect.width / rect.height;
    const imageAspect = imgSize.w / imgSize.h;
    let displayedW: number, displayedH: number, offsetX: number, offsetY: number;
    if (containerAspect > imageAspect) {
      displayedH = rect.height;
      displayedW = displayedH * imageAspect;
      offsetX = (rect.width - displayedW) / 2;
      offsetY = 0;
    } else {
      displayedW = rect.width;
      displayedH = displayedW / imageAspect;
      offsetX = 0;
      offsetY = (rect.height - displayedH) / 2;
    }
    const tx = clientX - rect.left - offsetX;
    const ty = clientY - rect.top - offsetY;
    if (tx < 0 || ty < 0 || tx > displayedW || ty > displayedH) return null;
    return {
      x: (tx / displayedW) * imgSize.w,
      y: (ty / displayedH) * imgSize.h,
    };
  };

  const handleMapTap = async (e: React.MouseEvent | React.TouchEvent) => {
    if (!tapMode) return;
    let cx: number, cy: number;
    if ("changedTouches" in e) {
      const t = e.changedTouches[0];
      cx = t.clientX;
      cy = t.clientY;
    } else {
      cx = (e as React.MouseEvent).clientX;
      cy = (e as React.MouseEvent).clientY;
    }
    const px = tapToImagePx(cx, cy);
    if (!px) return;
    if (!course || !hole) return;
    const updatedHole: Hole =
      tapMode === "tee"
        ? { ...hole, teePx: px }
        : { ...hole, greenPx: px };
    const updatedCourse: Course = {
      ...course,
      holes: course.holes.map((h) => (h.number === hole.number ? updatedHole : h)),
    };
    setCourse(updatedCourse);
    setTapMode(null);
    try {
      await saveCourse(updatedCourse);
    } catch (err) {
      alert("保存に失敗しました: " + String(err));
    }
  };

  const captureTee = async () => {
    if (!fix) {
      alert("GPSがまだ取得できていません。少し待ってからお試しください。");
      return;
    }
    if (!course || !hole) return;
    if (hole.tee && !confirm("ティー位置は既に登録済みです。\n現在地で上書きしますか？")) {
      return;
    }
    // Re-capturing the tee invalidates the previously auto-detected bearing
    // AND the previous image-tap of the tee (player may be on a different
    // tee box this round).
    const updatedHole: Hole = {
      ...hole,
      tee: { lat: fix.lat, lng: fix.lng },
      bearingFromTeeDeg: undefined,
      teePx: null,
    };
    const updatedCourse: Course = {
      ...course,
      holes: course.holes.map((h) => (h.number === hole.number ? updatedHole : h)),
    };
    setCourse(updatedCourse);
    try {
      await saveCourse(updatedCourse);
    } catch (e) {
      alert("保存に失敗しました: " + String(e));
    }
    // Immediately drop into tap-mode so the player can pinpoint their tee
    // colour's dot on the map image. Until they tap, the silhouette falls
    // back to the approximate default near the bottom-centre.
    setTapMode("tee");
  };

  const goToHole = (n: number) => {
    setCurrentHole(n);
    setShowHolePicker(false);
  };

  const handleFinish = () => {
    if (!confirm("ラウンドを終了しますか？スコアと軌跡はクリアされます。")) return;
    clearActiveRound();
    router.push(`/course/${params.id}`);
  };

  if (!course || !round) {
    return <div className="page muted">読み込み中...</div>;
  }

  const playablePx = calibration && fix ? worldToPixel(calibration, fix) : null;

  // The hole is "started" once we have a tee GPS *and* a tee color (yardage)
  // selected. Both are needed before distance/positioning makes sense.
  const isHoleStarted = !!hole?.tee && !!selectedTee;

  // Pixel position to render the player silhouette at.
  // - Preferred: the GPS-derived position once calibration is complete.
  // - Otherwise: pin the silhouette to the tee image position so the user
  //   gets immediate visual feedback the moment they press ホールスタート.
  // (Plain expression, not useMemo — useMemo here would sit after the early
  //  return above and violate rules-of-hooks.)
  const playerMarkerPx = playablePx ?? (isHoleStarted && effectiveTeePx ? effectiveTeePx : null);

  const totalScore = Object.values(round.strokes).reduce((a, b) => a + b, 0);
  const totalPar = course.holes.reduce((a, h) => a + h.par, 0);

  return (
    <div style={{ position: "relative", height: "100dvh", overflow: "hidden", background: "#000" }}>
      {/* Back + hole picker — anchored to top-LEFT, below the brand badge */}
      <div
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top) + 42px)",
          left: "calc(env(safe-area-inset-left) + 8px)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          zIndex: 10,
        }}
      >
        <Link
          href={`/course/${params.id}`}
          className="btn"
          style={{
            background: "rgba(0,0,0,0.65)",
            padding: "8px 14px",
            border: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          ‹
        </Link>
        <button
          onClick={() => setShowHolePicker((s) => !s)}
          className="btn"
          style={{
            background: "rgba(0,0,0,0.65)",
            border: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          {currentHole}H ・ Par {hole?.par ?? "-"} ▾
        </button>
      </div>

      {/* Score + Finish — bottom-left (above GPS indicator, below stroke counter) */}
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: "calc(env(safe-area-inset-bottom) + 56px)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 8,
          minWidth: 90,
        }}
      >
        <div
          style={{
            background: "rgba(10,20,16,0.85)",
            border: "1px solid var(--line)",
            padding: "6px 10px",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 14,
            color: "#fff",
            textAlign: "center",
          }}
        >
          {totalScore} / {totalPar}
        </div>
        <button
          onClick={handleFinish}
          style={{
            background: "rgba(10,20,16,0.85)",
            color: "var(--danger)",
            border: "1px solid var(--danger)",
            padding: "6px 10px",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          終了
        </button>
      </div>

      {showHolePicker && (
        <>
          <div
            onClick={() => setShowHolePicker(false)}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 14,
              background: "rgba(0,0,0,0.3)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(env(safe-area-inset-top) + 92px)",
              left: 12,
              right: 12,
              background: "rgba(10,20,16,0.97)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 12,
              zIndex: 15,
              maxHeight: "70vh",
              overflowY: "auto",
            }}
          >
            <div className="grid-holes">
              {course.holes.map((h) => {
                const ready = !!(h.tee && h.green);
                const isCurrent = h.number === currentHole;
                return (
                  <button
                    key={h.number}
                    onClick={() => goToHole(h.number)}
                    className={`hole-chip ${ready ? "has-image" : ""}`}
                    style={{
                      background: isCurrent ? "var(--fairway)" : undefined,
                      borderColor: isCurrent ? "var(--accent)" : undefined,
                      opacity: ready ? 1 : 0.75,
                    }}
                  >
                    {h.number}H
                    <span className="par">
                      Par {h.par} {round.strokes[h.number] ? `/ ${round.strokes[h.number]}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <div
              className="muted"
              style={{ fontSize: 11, marginTop: 10, textAlign: "center" }}
            >
              背景タップで閉じる
            </div>
          </div>
        </>
      )}

      {/* Map area */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {imageUrl ? (
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              cursor: tapMode ? "crosshair" : "default",
            }}
            onClick={handleMapTap}
            onTouchEnd={handleMapTap}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt=""
              onLoad={(e) =>
                setImgSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
            {imgSize && (
              <svg
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="xMidYMid meet"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                {/* Tee → Green axis (faint guide) */}
                {hole?.teePx && hole?.greenPx && (
                  <line
                    x1={hole.teePx.x}
                    y1={hole.teePx.y}
                    x2={hole.greenPx.x}
                    y2={hole.greenPx.y}
                    stroke="#ffffff"
                    strokeOpacity={0.25}
                    strokeWidth={Math.max(2, imgSize.w * 0.0025)}
                    strokeDasharray={`${imgSize.w * 0.012} ${imgSize.w * 0.01}`}
                  />
                )}
                {/* Track polyline */}
                {trackPx.length > 1 && (
                  <polyline
                    points={trackPx.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke="#f6c64a"
                    strokeWidth={Math.max(4, imgSize.w * 0.005)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {/* Tee marker */}
                {hole?.teePx && (
                  <circle
                    cx={hole.teePx.x}
                    cy={hole.teePx.y}
                    r={imgSize.w * 0.012}
                    fill="#3aa55c"
                    stroke="#fff"
                    strokeWidth={2}
                  />
                )}
                {/* Green marker */}
                {hole?.greenPx && (
                  <circle
                    cx={hole.greenPx.x}
                    cy={hole.greenPx.y}
                    r={imgSize.w * 0.012}
                    fill="#e95d5d"
                    stroke="#fff"
                    strokeWidth={2}
                  />
                )}
                {/* Live GPS marker — person silhouette like a cart navi.
                    Sits on the tee position immediately after ホールスタート,
                    then transitions to the GPS-derived position once
                    bearing-calibration completes. */}
                {playerMarkerPx && (
                  <PersonMarker
                    x={playerMarkerPx.x}
                    y={playerMarkerPx.y}
                    size={imgSize.w * 0.05}
                  />
                )}
              </svg>
            )}
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              background:
                "radial-gradient(circle at 50% 40%, #1d4a35 0%, #0a2418 70%, #050d09 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 12,
              padding: 24,
            }}
          >
            <div style={{ fontSize: 48, opacity: 0.5 }}>⛳</div>
            <div className="muted" style={{ textAlign: "center" }}>
              {hole?.tee && hole?.green
                ? "マップ画像が未登録です"
                : "このホールはキャリブレーション未設定（デモ表示）"}
            </div>
            <Link
              href={`/course/${params.id}/hole/${currentHole}/edit`}
              className="btn"
              style={{ marginTop: 8 }}
            >
              このホールを設定
            </Link>
          </div>
        )}
      </div>

      {/* Big distance-to-green panel (Marshal-Ai style) */}
      <div
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top) + 56px)",
          right: 8,
          textAlign: "right",
          zIndex: 8,
          textShadow: "0 2px 6px rgba(0,0,0,0.9)",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 0.9,
            color: "#fff",
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {yardsToGreen !== null ? Math.round(yardsToGreen) : "---"}
        </div>
        <div style={{ fontSize: 14, color: "#fff", opacity: 0.9, marginTop: 2 }}>
          グリーンまで yard
        </div>
        {yardsToTee !== null && (
          <div style={{ fontSize: 11, color: "#fff", opacity: 0.7, marginTop: 4 }}>
            ティーから {Math.round(yardsToTee)}y
          </div>
        )}
      </div>

      {/* Stroke counter (left edge, vertical) */}
      <div
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          transform: "translateY(-50%)",
          background: "rgba(10,20,16,0.85)",
          border: "1px solid var(--line)",
          borderRadius: 16,
          padding: "10px 8px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          zIndex: 8,
        }}
      >
        <button
          onClick={() => setStrokes(1)}
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "#1a1208",
            fontSize: 28,
            fontWeight: 800,
          }}
        >
          ＋
        </button>
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1 }}>{strokes}</div>
          <div className="muted" style={{ fontSize: 11 }}>打目</div>
        </div>
        <button
          onClick={() => setStrokes(-1)}
          disabled={strokes === 0}
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--panel-2)",
            color: "#fff",
            fontSize: 28,
            fontWeight: 800,
            border: "1px solid var(--line)",
          }}
        >
          －
        </button>
      </div>

      {/* Prominent ホールスタート button — shown until the hole has been
          started (tee captured + tee color picked). Tapping it captures the
          current GPS as the tee position; the silhouette will appear at the
          tee image position immediately, then move with GPS once bearing
          is auto-detected from walking. */}
      {!isHoleStarted && (
        <button
          onClick={async () => {
            if (!selectedTee) {
              alert("先に「ティー選択」でティー色 (白/青/赤など) を選んでください。");
              setShowTeePicker(true);
              return;
            }
            await captureTee();
          }}
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(env(safe-area-inset-bottom) + 100px)",
            background: "var(--accent)",
            color: "#1a1208",
            padding: "14px 28px",
            borderRadius: 999,
            fontSize: 17,
            fontWeight: 800,
            border: "2px solid #fff",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            zIndex: 9,
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          ▶ ホールスタート
          {selectedTee && (
            <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7 }}>
              ({selectedTee.toUpperCase()} {teeYardage}y)
            </span>
          )}
        </button>
      )}

      {/* Setup action buttons: tee GPS + green tap-on-map */}
      <div
        style={{
          position: "absolute",
          right: 12,
          bottom: "calc(env(safe-area-inset-bottom) + 56px)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          zIndex: 8,
        }}
      >
        <button
          onClick={captureTee}
          title="現在地をティーに登録 (歩行で方位を自動補正)"
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            background:
              hole?.tee && hole?.bearingFromTeeDeg != null
                ? "rgba(58,165,92,0.85)"
                : hole?.tee
                  ? "rgba(232,155,42,0.85)"
                  : "rgba(10,20,16,0.85)",
            border: `2px solid ${
              hole?.tee && hole?.bearingFromTeeDeg != null
                ? "#3aa55c"
                : hole?.tee
                  ? "var(--accent-2)"
                  : "var(--accent)"
            }`,
            color: "#fff",
            fontSize: 11,
            fontWeight: 800,
            lineHeight: 1.1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          <span style={{ fontSize: 18 }}>
            {hole?.tee && hole?.bearingFromTeeDeg != null ? "✓" : hole?.tee ? "⏳" : "📍"}
          </span>
          <span>ティー</span>
        </button>
        <button
          onClick={() => setTapMode(tapMode === "green" ? null : "green")}
          title="マップ上でグリーン手前位置をタップして登録"
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            background:
              tapMode === "green"
                ? "rgba(246,198,74,0.95)"
                : hole?.greenPx
                  ? "rgba(233,93,93,0.85)"
                  : "rgba(10,20,16,0.85)",
            border: `2px solid ${
              tapMode === "green"
                ? "#fff"
                : hole?.greenPx
                  ? "#e95d5d"
                  : "var(--accent)"
            }`,
            color: tapMode === "green" ? "#1a1208" : "#fff",
            fontSize: 11,
            fontWeight: 800,
            lineHeight: 1.1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          <span style={{ fontSize: 18 }}>
            {tapMode === "green" ? "✏︎" : hole?.greenPx ? "✓" : "📌"}
          </span>
          <span>グリーン</span>
        </button>
      </div>

      {/* Tee picker trigger (shows currently selected tee and yardage) */}
      {hole?.yardages && Object.keys(hole.yardages).length > 0 && (
        <button
          onClick={() => setShowTeePicker(true)}
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top) + 230px)",
            right: 12,
            background: "rgba(10,20,16,0.85)",
            border: "1px solid var(--accent)",
            borderRadius: 18,
            padding: "8px 14px",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            zIndex: 8,
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
          }}
        >
          {selectedTee
            ? `${selectedTee.toUpperCase()}  ${teeYardage}y ▾`
            : "ティー選択 ▾"}
        </button>
      )}

      {/* Tee picker modal */}
      {showTeePicker && hole?.yardages && (
        <div
          onClick={() => setShowTeePicker(false)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 16,
              maxWidth: 320,
              width: "100%",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 12, textAlign: "center" }}>
              ティー選択
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {PLAY_TEE_DEFS.map((t) => {
                const yd = hole.yardages?.[t.key];
                if (!yd) return null;
                const isSelected = selectedTee === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setSelectedTee(t.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: isSelected ? "var(--fairway)" : "var(--panel-2)",
                      border: `1px solid ${isSelected ? "var(--accent)" : "var(--line)"}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                      color: "var(--text)",
                    }}
                  >
                    <span
                      style={{
                        background: t.color,
                        color: t.text,
                        fontWeight: 800,
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 4,
                        minWidth: 50,
                        textAlign: "center",
                        border: t.key === "White" ? "1px solid var(--line)" : "none",
                      }}
                    >
                      {t.label}
                    </span>
                    <span
                      style={{ fontWeight: 700, fontSize: 18, flex: 1, textAlign: "right" }}
                    >
                      {yd}
                      <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                        yd
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setShowTeePicker(false)}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px",
                background: "transparent",
                color: "var(--text-dim)",
                border: "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Tap-mode banner */}
      {tapMode && (
        <div
          style={{
            // Bottom-centered, content width so it doesn't cover the map's upper
            // portion where the green is drawn. Sits above the GPS indicator and
            // between the left (Score+End) and right (Tee/Green) action stacks.
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(env(safe-area-inset-bottom) + 50px)",
            background: "rgba(246,198,74,0.95)",
            color: "#1a1208",
            padding: "8px 14px",
            borderRadius: 999,
            zIndex: 16,
            fontWeight: 700,
            fontSize: 13,
            boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            whiteSpace: "nowrap",
            maxWidth: "calc(100vw - 220px)",
          }}
        >
          <span>
            {tapMode === "tee"
              ? `📌 ${selectedTee ? selectedTee.toUpperCase() + "の" : ""}ティー位置をタップ`
              : "📌 グリーンをタップ"}
          </span>
          <button
            onClick={() => setTapMode(null)}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              padding: 0,
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(0,0,0,0.45)",
              fontSize: 14,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#1a1208",
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* GPS accuracy indicator (bottom) */}
      <div
        style={{
          position: "absolute",
          bottom: "calc(env(safe-area-inset-bottom) + 12px)",
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(10,20,16,0.8)",
          padding: "6px 12px",
          borderRadius: 999,
          fontSize: 12,
          color: "var(--text-dim)",
          zIndex: 8,
        }}
      >
        {fix ? (
          <>
            <span style={{ color: fix.accuracy < 15 ? "#3aa55c" : "var(--accent-2)" }}>●</span>{" "}
            GPS ±{Math.round(fix.accuracy)}m
          </>
        ) : gpsError ? (
          <span style={{ color: "var(--danger)" }}>{gpsError}</span>
        ) : (
          "GPS取得中..."
        )}
      </div>
    </div>
  );
}

/**
 * Live-position marker: a soft halo + a simple person silhouette
 * (head + rounded-shoulder torso) rendered inside the map SVG.
 *
 *   x, y  – pixel coordinates in the image's natural coord space
 *   size  – overall figure height (px in the same space)
 */
function PersonMarker({ x, y, size }: { x: number; y: number; size: number }) {
  const s = size;
  return (
    <g>
      {/* Soft outer halo for visibility */}
      <circle cx={x} cy={y} r={s * 1.0} fill="#3a8fff" fillOpacity={0.18} />
      <circle cx={x} cy={y} r={s * 0.55} fill="#3a8fff" fillOpacity={0.28} />
      {/* Person — translate so figure stands centred at (x, y) */}
      <g transform={`translate(${x} ${y})`} fill="#3a8fff" stroke="#ffffff" strokeWidth={s * 0.06} strokeLinejoin="round">
        {/* Head */}
        <circle cx={0} cy={-s * 0.55} r={s * 0.24} />
        {/* Torso with rounded shoulders / tapered waist */}
        <path
          d={`M ${-s * 0.4} ${-s * 0.1}
              Q ${-s * 0.5} ${s * 0.15}, ${-s * 0.4} ${s * 0.5}
              L ${s * 0.4} ${s * 0.5}
              Q ${s * 0.5} ${s * 0.15}, ${s * 0.4} ${-s * 0.1}
              Q ${0} ${-s * 0.25}, ${-s * 0.4} ${-s * 0.1} Z`}
        />
      </g>
    </g>
  );
}

const PLAY_TEE_DEFS: { key: string; label: string; color: string; text: string }[] = [
  { key: "Black", label: "BLACK", color: "#1a1a1a", text: "#ffffff" },
  { key: "Blue", label: "BLUE", color: "#3a8fff", text: "#ffffff" },
  { key: "White", label: "WHITE", color: "#f3f4ec", text: "#1a1a1a" },
  { key: "Green", label: "GREEN", color: "#3aa55c", text: "#ffffff" },
  { key: "Gold", label: "GOLD", color: "#d8a23a", text: "#1a1a1a" },
  { key: "Red", label: "RED", color: "#e95d5d", text: "#ffffff" },
];
