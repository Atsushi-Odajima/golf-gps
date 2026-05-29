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

  const startWithHole = (holeNumber: number) => {
    startRound(course.id);
    router.push(`/course/${course.id}/play?startHole=${holeNumber}`);
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
          <div style={{ fontWeight: 700, marginBottom: 6 }}>スタート前</div>
          <div className="muted" style={{ marginBottom: 12 }}>
            {course.holes.filter((h) => h.imageDataUrl && h.tee && h.green).length} /{" "}
            {course.holes.length} ホール完了
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            スタート位置を選択してラウンドを開始
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn primary"
              onClick={() => startWithHole(1)}
              style={{ flex: 1 }}
            >
              ▶ OUTから (1H〜)
            </button>
            <button
              className="btn primary"
              onClick={() => startWithHole(10)}
              style={{ flex: 1 }}
              disabled={course.holes.length < 10}
            >
              ▶ INから (10H〜)
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
