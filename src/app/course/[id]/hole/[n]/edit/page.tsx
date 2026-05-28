"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Course, getCourse, imageKey, loadImage, saveCourse, saveImage } from "@/lib/storage";
import { useGeolocation } from "@/lib/useGeolocation";
import type { LatLng, Pixel } from "@/lib/geo";

type Mode = "tee" | "green" | null;

export default function HoleEditPage() {
  const params = useParams<{ id: string; n: string }>();
  const router = useRouter();
  const holeNumber = parseInt(params.n, 10);

  const [course, setCourse] = useState<Course | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [teePx, setTeePx] = useState<Pixel | null>(null);
  const [greenPx, setGreenPx] = useState<Pixel | null>(null);
  const [tee, setTee] = useState<LatLng | null>(null);
  const [green, setGreen] = useState<LatLng | null>(null);
  const [par, setPar] = useState<number>(4);
  const [yardages, setYardages] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<Mode>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { fix, error: gpsError } = useGeolocation(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await getCourse(params.id);
      if (cancelled || !c) return;
      setCourse(c);
      const hole = c.holes.find((h) => h.number === holeNumber);
      if (hole) {
        setPar(hole.par);
        setTeePx(hole.teePx);
        setGreenPx(hole.greenPx);
        setTee(hole.tee);
        setGreen(hole.green);
        setYardages(hole.yardages ?? {});
      }
      const dataUrl = await loadImage(imageKey(params.id, holeNumber));
      if (!cancelled && dataUrl) setImageUrl(dataUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, holeNumber]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // downsample to keep storage manageable
    const dataUrl = await downsampleImage(file, 1600);
    setImageUrl(dataUrl);
    await saveImage(imageKey(params.id, holeNumber), dataUrl);
  };

  const handleImageTap = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (!mode || !imgRef.current) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ("touches" in e) {
      const t = e.changedTouches[0];
      clientX = t.clientX;
      clientY = t.clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const xRel = (clientX - rect.left) / rect.width;
    const yRel = (clientY - rect.top) / rect.height;
    if (xRel < 0 || xRel > 1 || yRel < 0 || yRel > 1) return;
    // convert to natural pixel coords
    const nx = xRel * img.naturalWidth;
    const ny = yRel * img.naturalHeight;
    if (mode === "tee") {
      setTeePx({ x: nx, y: ny });
      if (fix) setTee({ lat: fix.lat, lng: fix.lng });
    } else if (mode === "green") {
      setGreenPx({ x: nx, y: ny });
      if (fix) setGreen({ lat: fix.lat, lng: fix.lng });
    }
    setMode(null);
  };

  const captureCurrentGps = (which: "tee" | "green") => {
    if (!fix) {
      alert("GPSがまだ取得できていません。少し待ってからお試しください。");
      return;
    }
    if (which === "tee") setTee({ lat: fix.lat, lng: fix.lng });
    else setGreen({ lat: fix.lat, lng: fix.lng });
  };

  const handleSave = async () => {
    if (!course) return;
    const updated: Course = {
      ...course,
      holes: course.holes.map((h) =>
        h.number === holeNumber
          ? {
              ...h,
              par,
              tee,
              green,
              teePx,
              greenPx,
              yardages: Object.keys(yardages).length ? yardages : undefined,
              imageDataUrl: imageUrl ? "stored" : null,
            }
          : h,
      ),
    };
    try {
      await saveCourse(updated);
      router.push(`/course/${params.id}`);
    } catch (e) {
      alert("保存に失敗しました: " + String(e));
    }
  };

  const canSave = imageUrl && teePx && greenPx && tee && green;

  return (
    <>
      <div className="appbar">
        <Link href={`/course/${params.id}`} className="back">
          ‹
        </Link>
        <h1>
          {course?.name} - {holeNumber}H
        </h1>
        <button className="btn primary" disabled={!canSave} onClick={handleSave}>
          保存
        </button>
      </div>

      <div className="page">
        <div className="card">
          <div className="row spread">
            <label>パー</label>
            <select
              value={par}
              onChange={(e) => setPar(parseInt(e.target.value, 10))}
              style={{ width: 80 }}
            >
              {[3, 4, 5, 6].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <YardageCard yardages={yardages} onChange={setYardages} />

        <div className="card">
          <div className="row spread" style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 700 }}>マップ画像</div>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              {imageUrl ? "差し替え" : "画像を選択"}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            style={{ display: "none" }}
          />

          {imageUrl ? (
            <div
              ref={containerRef}
              onClick={handleImageTap}
              onTouchEnd={handleImageTap}
              style={{
                position: "relative",
                width: "100%",
                background: "#000",
                borderRadius: 8,
                overflow: "hidden",
                cursor: mode ? "crosshair" : "default",
                touchAction: "manipulation",
              }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt="hole map"
                style={{ width: "100%", display: "block" }}
                onLoad={(e) => {
                  const t = e.currentTarget;
                  setImgSize({ w: t.naturalWidth, h: t.naturalHeight });
                }}
              />
              {imgSize && (
                <svg
                  viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                  }}
                >
                  {teePx && greenPx && (
                    <line
                      x1={teePx.x}
                      y1={teePx.y}
                      x2={greenPx.x}
                      y2={greenPx.y}
                      stroke="#f6c64a"
                      strokeWidth={Math.max(3, imgSize.w * 0.004)}
                      strokeDasharray={`${imgSize.w * 0.01} ${imgSize.w * 0.008}`}
                      opacity={0.7}
                    />
                  )}
                  {teePx && (
                    <g>
                      <circle
                        cx={teePx.x}
                        cy={teePx.y}
                        r={imgSize.w * 0.018}
                        fill="#3aa55c"
                        stroke="#fff"
                        strokeWidth={3}
                      />
                      <text
                        x={teePx.x}
                        y={teePx.y + imgSize.w * 0.006}
                        textAnchor="middle"
                        fill="#fff"
                        fontSize={imgSize.w * 0.025}
                        fontWeight="700"
                      >
                        T
                      </text>
                    </g>
                  )}
                  {greenPx && (
                    <g>
                      <circle
                        cx={greenPx.x}
                        cy={greenPx.y}
                        r={imgSize.w * 0.018}
                        fill="#e95d5d"
                        stroke="#fff"
                        strokeWidth={3}
                      />
                      <text
                        x={greenPx.x}
                        y={greenPx.y + imgSize.w * 0.006}
                        textAnchor="middle"
                        fill="#fff"
                        fontSize={imgSize.w * 0.025}
                        fontWeight="700"
                      >
                        G
                      </text>
                    </g>
                  )}
                </svg>
              )}
              {mode && (
                <div
                  style={{
                    position: "absolute",
                    top: 8,
                    left: 8,
                    right: 8,
                    background: "rgba(0,0,0,0.7)",
                    color: "#fff",
                    padding: "8px 12px",
                    borderRadius: 8,
                    fontWeight: 600,
                    pointerEvents: "none",
                  }}
                >
                  {mode === "tee" ? "ティー位置" : "グリーン中央"}をタップしてください
                </div>
              )}
            </div>
          ) : (
            <div className="muted" style={{ padding: "20px 0", textAlign: "center" }}>
              画像未設定
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>キャリブレーション</div>
          <div className="muted" style={{ marginBottom: 12 }}>
            ティーとグリーンの「画像上の位置」と「GPS座標」をそれぞれ登録します。
            実際に現地で「GPSを記録」ボタンを押すのが最も正確です。
          </div>

          <CalibrationRow
            label="ティー"
            color="#3aa55c"
            px={teePx}
            latlng={tee}
            onSetPx={() => setMode("tee")}
            onCaptureGps={() => captureCurrentGps("tee")}
            gpsReady={!!fix}
          />
          <CalibrationRow
            label="グリーン中央"
            color="#e95d5d"
            px={greenPx}
            latlng={green}
            onSetPx={() => setMode("green")}
            onCaptureGps={() => captureCurrentGps("green")}
            gpsReady={!!fix}
          />

          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            現在のGPS:{" "}
            {fix
              ? `${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)} (±${fix.accuracy.toFixed(0)}m)`
              : gpsError ?? "取得中..."}
          </div>
        </div>
      </div>
    </>
  );
}

const TEE_DEFS: { key: string; label: string; color: string; text?: string }[] = [
  { key: "Black", label: "BLACK", color: "#1a1a1a", text: "#ffffff" },
  { key: "Blue", label: "BLUE", color: "#3a8fff", text: "#ffffff" },
  { key: "White", label: "WHITE", color: "#f3f4ec", text: "#1a1a1a" },
  { key: "Green", label: "GREEN", color: "#3aa55c", text: "#ffffff" },
  { key: "Gold", label: "GOLD", color: "#d8a23a", text: "#1a1a1a" },
  { key: "Red", label: "RED", color: "#e95d5d", text: "#ffffff" },
];

function YardageCard({
  yardages,
  onChange,
}: {
  yardages: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  const setVal = (key: string, raw: string) => {
    const next = { ...yardages };
    if (raw === "") {
      delete next[key];
    } else {
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 0 && n < 1000) next[key] = n;
    }
    onChange(next);
  };

  // Sort: tees with values first (in TEE_DEFS order), then empty tees
  const ordered = [...TEE_DEFS].sort((a, b) => {
    const hasA = a.key in yardages ? 0 : 1;
    const hasB = b.key in yardages ? 0 : 1;
    return hasA - hasB;
  });

  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 8 }}>ティー別ヤーデージ</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 8,
        }}
      >
        {ordered.map((t) => (
          <div
            key={t.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "6px 8px",
            }}
          >
            <span
              style={{
                background: t.color,
                color: t.text,
                fontWeight: 800,
                fontSize: 10,
                padding: "3px 6px",
                borderRadius: 4,
                minWidth: 42,
                textAlign: "center",
                border: t.key === "White" ? "1px solid var(--line)" : "none",
                letterSpacing: 0.5,
              }}
            >
              {t.label}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={999}
              value={yardages[t.key] ?? ""}
              onChange={(e) => setVal(t.key, e.target.value)}
              placeholder="—"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "var(--text)",
                fontSize: 18,
                fontWeight: 700,
                textAlign: "right",
                padding: 0,
                width: "100%",
                minWidth: 0,
                fontVariantNumeric: "tabular-nums",
              }}
            />
            <span className="muted" style={{ fontSize: 11 }}>yd</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalibrationRow({
  label,
  color,
  px,
  latlng,
  onSetPx,
  onCaptureGps,
  gpsReady,
}: {
  label: string;
  color: string;
  px: Pixel | null;
  latlng: LatLng | null;
  onSetPx: () => void;
  onCaptureGps: () => void;
  gpsReady: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto",
        gap: 8,
        alignItems: "center",
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: color,
        }}
      />
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div className="muted" style={{ fontSize: 11 }}>
          {px ? "画像○" : "画像×"} / {latlng ? "GPS○" : "GPS×"}
        </div>
      </div>
      <button className="btn" onClick={onSetPx}>
        画像
      </button>
      <button className="btn" onClick={onCaptureGps} disabled={!gpsReady}>
        GPS
      </button>
    </div>
  );
}

async function downsampleImage(file: File, maxDim: number): Promise<string> {
  const url = URL.createObjectURL(file);
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
