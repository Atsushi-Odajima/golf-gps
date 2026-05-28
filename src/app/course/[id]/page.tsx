"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Course, getCourse, startRound } from "@/lib/storage";

export default function CoursePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getCourse(params.id);
        if (!cancelled) {
          setCourse(c);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (loading) {
    return (
      <>
        <div className="appbar">
          <Link href="/" className="back">
            ‹
          </Link>
          <h1>コース</h1>
        </div>
        <div className="page muted">読み込み中...</div>
      </>
    );
  }

  if (!course) {
    return (
      <>
        <div className="appbar">
          <Link href="/" className="back">
            ‹
          </Link>
          <h1>コース</h1>
        </div>
        <div className="page muted">コースが見つかりません。</div>
      </>
    );
  }

  const ready = course.holes.every((h) => h.imageDataUrl && h.tee && h.green);
  const someReady = course.holes.some((h) => h.imageDataUrl && h.tee && h.green);

  const handleStart = () => {
    startRound(course.id);
    router.push(`/course/${course.id}/play`);
  };

  return (
    <>
      <div className="appbar">
        <Link href="/" className="back">
          ‹
        </Link>
        <h1>{course.name}</h1>
      </div>

      <div className="page">
        <div className="card">
          <div className="row spread">
            <div>
              <div style={{ fontWeight: 700 }}>セットアップ状況</div>
              <div className="muted">
                {course.holes.filter((h) => h.imageDataUrl && h.tee && h.green).length} /{" "}
                {course.holes.length} ホール完了
              </div>
            </div>
            <button className="btn primary" onClick={handleStart}>
              {ready ? "▶ ラウンド開始" : someReady ? "▶ 設定済から開始" : "▶ デモ開始"}
            </button>
          </div>
        </div>

        <h2 style={{ fontSize: 14, color: "var(--text-dim)", margin: "16px 4px 8px" }}>
          ホール一覧
        </h2>

        <div className="grid-holes">
          {course.holes.map((h) => (
            <Link key={h.number} href={`/course/${course.id}/hole/${h.number}/edit`}>
              <div className={`hole-chip ${h.imageDataUrl && h.tee && h.green ? "has-image" : ""}`}>
                {h.number}H<span className="par">Par {h.par}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
