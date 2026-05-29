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
import { Calibration, haversineMeters, metersToYards, worldToPixel } from "@/lib/geo";

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
  const lastSaveAtRef = useRef<number>(0);

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

  const calibration: Calibration | null = useMemo(() => {
    if (!hole || !hole.tee || !hole.green || !hole.teePx || !hole.greenPx) return null;
    return {
      tee: hole.tee,
      green: hole.green,
      teePx: hole.teePx,
      greenPx: hole.greenPx,
    };
  }, [hole]);

  const yardsToGreen = useMemo(() => {
    if (!fix || !hole?.green) return null;
    return metersToYards(haversineMeters(fix, hole.green));
  }, [fix, hole?.green]);

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

  const captureGpsFor = async (which: "tee" | "green") => {
    if (!fix) {
      alert("GPSがまだ取得できていません。少し待ってからお試しください。");
      return;
    }
    if (!course || !hole) return;
    const wasSet = which === "tee" ? hole.tee : hole.green;
    const label = which === "tee" ? "ティー" : "グリーン手前";
    if (wasSet && !confirm(`${label}位置は既に登録済みです。\n現在地で上書きしますか？`)) {
      return;
    }
    const updatedHole: Hole = {
      ...hole,
      [which]: { lat: fix.lat, lng: fix.lng },
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

  const totalScore = Object.values(round.strokes).reduce((a, b) => a + b, 0);
  const totalPar = course.holes.reduce((a, h) => a + h.par, 0);

  return (
    <div style={{ position: "relative", height: "100dvh", overflow: "hidden", background: "#000" }}>
      {/* Top bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          padding: "calc(env(safe-area-inset-top) + 8px) 12px 8px 150px",
          background: "linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Link href={`/course/${params.id}`} className="btn ghost" style={{ padding: "6px 10px" }}>
          ‹
        </Link>
        <button
          onClick={() => setShowHolePicker((s) => !s)}
          className="btn"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          {currentHole}H ・ Par {hole?.par ?? "-"} ▾
        </button>
        <div style={{ flex: 1 }} />
        <div
          style={{
            background: "rgba(0,0,0,0.5)",
            padding: "6px 10px",
            borderRadius: 8,
            fontWeight: 700,
          }}
        >
          {totalScore} / {totalPar}
        </div>
        <button
          className="btn"
          onClick={handleFinish}
          style={{ background: "rgba(0,0,0,0.5)", color: "var(--danger)" }}
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
              top: "calc(env(safe-area-inset-top) + 56px)",
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
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <img
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
                {/* Live GPS marker */}
                {playablePx && (
                  <g>
                    <circle
                      cx={playablePx.x}
                      cy={playablePx.y}
                      r={imgSize.w * 0.025}
                      fill="#3a8fff"
                      fillOpacity={0.2}
                    />
                    <circle
                      cx={playablePx.x}
                      cy={playablePx.y}
                      r={imgSize.w * 0.012}
                      fill="#3a8fff"
                      stroke="#fff"
                      strokeWidth={3}
                    />
                  </g>
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

      {/* GPS capture buttons for this hole's tee / green */}
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
          onClick={() => captureGpsFor("tee")}
          title="このティー位置を現在地で登録"
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            background: hole?.tee ? "rgba(58,165,92,0.85)" : "rgba(10,20,16,0.85)",
            border: `2px solid ${hole?.tee ? "#3aa55c" : "var(--accent)"}`,
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
          <span style={{ fontSize: 18 }}>{hole?.tee ? "✓" : "📍"}</span>
          <span>ティー</span>
        </button>
        <button
          onClick={() => captureGpsFor("green")}
          title="このグリーン手前位置を現在地で登録"
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            background: hole?.green ? "rgba(233,93,93,0.85)" : "rgba(10,20,16,0.85)",
            border: `2px solid ${hole?.green ? "#e95d5d" : "var(--accent)"}`,
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
          <span style={{ fontSize: 18 }}>{hole?.green ? "✓" : "📍"}</span>
          <span>グリーン</span>
        </button>
      </div>

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
