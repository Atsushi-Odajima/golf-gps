"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Course,
  createBlankCourse,
  deleteCourse,
  getActiveRound,
  listCourses,
  saveCourse,
} from "@/lib/storage";

export default function HomePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [hasActive, setHasActive] = useState(false);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);

  const refresh = () => {
    setCourses(listCourses());
    const r = getActiveRound();
    setHasActive(!!r);
    setActiveCourseId(r?.courseId ?? null);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAdd = () => {
    const name = prompt("コース名を入力", "新しいコース");
    if (!name) return;
    const countStr = prompt("ホール数（例: 18）", "18");
    const count = Math.max(1, Math.min(36, parseInt(countStr || "18", 10) || 18));
    const course = createBlankCourse(name, count);
    saveCourse(course);
    refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このコースを削除しますか？")) return;
    await deleteCourse(id);
    refresh();
  };

  return (
    <>
      <div className="appbar">
        <h1>コース一覧</h1>
        <button className="btn primary" onClick={handleAdd}>
          ＋コース
        </button>
      </div>

      <div className="page">
        {hasActive && activeCourseId && (
          <Link href={`/course/${activeCourseId}/play`} style={{ display: "block" }}>
            <div className="card" style={{ borderColor: "var(--accent)" }}>
              <div className="row spread">
                <div>
                  <div style={{ fontWeight: 700 }}>▶ ラウンド中</div>
                  <div className="muted">タップして再開</div>
                </div>
                <div style={{ fontSize: 22 }}>›</div>
              </div>
            </div>
          </Link>
        )}

        <h2 style={{ fontSize: 14, color: "var(--text-dim)", margin: "16px 4px 8px" }}>
          コース一覧
        </h2>

        {courses.length === 0 && (
          <div className="card muted">
            まだコースがありません。右上の「＋コース」から作成してください。
          </div>
        )}

        {courses.map((c) => (
          <div key={c.id} className="list-item">
            <Link
              href={`/course/${c.id}`}
              style={{ flex: 1, color: "var(--text)", padding: "4px 0" }}
            >
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div className="muted">
                {c.holes.length}ホール ・ 設定済み{" "}
                {c.holes.filter((h) => h.imageDataUrl && h.tee && h.green).length}
              </div>
            </Link>
            <button className="btn danger" onClick={() => handleDelete(c.id)}>
              削除
            </button>
          </div>
        ))}

        <div style={{ height: 40 }} />
        <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>
          位置情報の取得を許可してご利用ください。<br />
          コースマップ画像は個人利用の範囲内でご準備ください。
        </div>
      </div>
    </>
  );
}
