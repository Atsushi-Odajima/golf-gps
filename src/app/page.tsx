"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  BackupBundle,
  Course,
  createBlankCourse,
  deleteCourse,
  downloadBackup,
  exportAll,
  getActiveRound,
  getStorageStatus,
  importAll,
  listCourses,
  requestPersistentStorage,
  saveCourse,
  StorageStatus,
} from "@/lib/storage";
import {
  fetchImportedCourse,
  ImportProgress,
  saveImportedCourse,
} from "@/lib/importCourse";

export default function HomePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [hasActive, setHasActive] = useState(false);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [showStorage, setShowStorage] = useState(false);
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const list = await listCourses();
      setCourses(list);
    } catch (e) {
      console.error("listCourses failed", e);
    }
    const r = getActiveRound();
    setHasActive(!!r);
    setActiveCourseId(r?.courseId ?? null);
    try {
      const s = await getStorageStatus();
      setStorage(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    // request persistent storage at startup so iOS/Safari doesn't evict our data
    requestPersistentStorage().finally(() => {
      refresh();
    });
  }, []);

  const handleAdd = async () => {
    const name = prompt("コース名を入力", "新しいコース");
    if (!name) return;
    const countStr = prompt("ホール数（例: 18）", "18");
    const count = Math.max(1, Math.min(36, parseInt(countStr || "18", 10) || 18));
    const course = createBlankCourse(name, count);
    try {
      await saveCourse(course);
      await refresh();
    } catch (e) {
      alert("コース保存に失敗しました: " + String(e));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このコースを削除しますか？")) return;
    await deleteCourse(id);
    await refresh();
  };

  const handleImportUrl = async () => {
    const url = prompt(
      "ゴルフ場のコースレイアウトページURLを貼り付けてください\n例: https://reserve.accordiagolf.com/golfCourse/saitama/tamagawa/layout",
    );
    if (!url) return;
    setImporting({ total: 0, completed: 0, failures: [] });
    try {
      const imported = await fetchImportedCourse(url.trim());
      if (!imported.holes.length) throw new Error("ホール情報が抽出できませんでした");
      const withImage = imported.holes.filter((h) => h.imageUrl).length;
      const confirmMsg =
        `「${imported.name}」を ${imported.holes.length} ホール分インポートします。\n` +
        `画像URLが見つかったホール: ${withImage} / ${imported.holes.length}\n\n` +
        (withImage === 0
          ? "⚠ 画像URLが1つも見つかりませんでした。インポートしても画像は付きません。\n"
          : withImage < imported.holes.length
            ? "⚠ 一部のホールで画像URLが見つかっていません。\n"
            : "") +
        `続行しますか？`;
      if (!confirm(confirmMsg)) {
        setImporting(null);
        return;
      }
      const result = await saveImportedCourse(imported, (p) => setImporting(p));
      const finalFailures = importing?.failures ?? [];
      await refresh();
      setImporting(null);

      // build a concise summary
      const okCount = result.holes.filter((h) => h.imageDataUrl).length;
      let msg = `インポート完了: ${imported.name}\n画像取得 ${okCount} / ${imported.holes.length} ホール`;
      const failuresAccum: { hole: number; reason: string }[] = [];
      // collect failures from progress callbacks — store last seen
      // (saveImportedCourse mutates failures inside, so just rebuild from result)
      for (const h of imported.holes) {
        const saved = result.holes.find((x) => x.number === h.number);
        if (!saved?.imageDataUrl) {
          failuresAccum.push({
            hole: h.number,
            reason: h.imageUrl ? "ダウンロード失敗" : "画像URL無し",
          });
        }
      }
      if (failuresAccum.length) {
        msg +=
          `\n\n失敗: ${failuresAccum
            .slice(0, 6)
            .map((f) => `H${f.hole} (${f.reason})`)
            .join(", ")}` + (failuresAccum.length > 6 ? "..." : "");
        if (imported.diagnostics) {
          msg += `\n\n解析情報: HTML ${(imported.diagnostics.htmlBytes / 1024).toFixed(1)}KB, 全img ${imported.diagnostics.totalImages}個`;
        }
      }
      alert(msg);
    } catch (e) {
      setImporting(null);
      alert("インポート失敗: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleExport = async () => {
    try {
      const bundle = await exportAll();
      downloadBackup(bundle);
    } catch (e) {
      alert("エクスポート失敗: " + String(e));
    }
  };

  const handleImportClick = () => fileRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so same file can be re-picked
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as BackupBundle;
      const mode = confirm(
        "「OK」で現在のデータに追加、「キャンセル」で全て置き換えます",
      )
        ? "merge"
        : "replace";
      await importAll(bundle, mode);
      await refresh();
      alert("インポート完了しました");
    } catch (err) {
      alert("インポート失敗: " + String(err));
    }
  };

  const fmtBytes = (n?: number) => {
    if (n == null) return "—";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
  };

  return (
    <>
      <div className="appbar">
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={handleAdd}>
          ＋
        </button>
      </div>

      {importing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            className="card"
            style={{ maxWidth: 360, width: "100%", textAlign: "center" }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div>
            <div style={{ fontWeight: 700 }}>インポート中</div>
            <div className="muted" style={{ marginTop: 8 }}>
              {importing.current ?? "解析中…"}
            </div>
            {importing.total > 0 && (
              <>
                <div
                  style={{
                    marginTop: 12,
                    height: 8,
                    background: "var(--panel-2)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${(importing.completed / importing.total) * 100}%`,
                      background: "var(--accent)",
                      transition: "width 0.2s",
                    }}
                  />
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {importing.completed} / {importing.total} ホール
                </div>
              </>
            )}
            {importing.failures.length > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 8, color: "var(--accent-2)" }}>
                取得失敗: {importing.failures.length}件
              </div>
            )}
          </div>
        </div>
      )}

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

        {/* Storage status */}
        <div className="card">
          <div
            className="row spread"
            style={{ cursor: "pointer" }}
            onClick={() => setShowStorage((s) => !s)}
          >
            <div>
              <div style={{ fontWeight: 700 }}>
                💾 保存状況{" "}
                {storage?.persistent ? (
                  <span style={{ color: "var(--accent)" }}>✓ 永続化済み</span>
                ) : (
                  <span style={{ color: "var(--accent-2)" }}>● 標準（消える可能性あり）</span>
                )}
              </div>
              <div className="muted">
                コース {storage?.courses ?? "—"} ／ 画像 {storage?.images ?? "—"} 件
              </div>
            </div>
            <div style={{ fontSize: 18 }}>{showStorage ? "▾" : "▸"}</div>
          </div>
          {showStorage && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                使用量: {fmtBytes(storage?.usageBytes)} / {fmtBytes(storage?.quotaBytes)}
              </div>
              {!storage?.persistent && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  ※ iOSは長期アクセスがないと自動でデータを消すことがあります。
                  「ホーム画面に追加」して使うと永続化されやすくなります。
                  バックアップも併せて取ることを推奨します。
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={handleExport} style={{ flex: 1 }}>
                  ⬇ バックアップ
                </button>
                <button className="btn" onClick={handleImportClick} style={{ flex: 1 }}>
                  ⬆ 復元
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={handleImportFile}
              />
            </div>
          )}
        </div>

        <button
          onClick={handleImportUrl}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginTop: 16,
            padding: "14px 18px",
            background: "var(--accent)",
            color: "#1a1208",
            border: "none",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 800,
            boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
          }}
        >
          🔗 コースマップURL登録
        </button>

        <h1 style={{ fontSize: 20, margin: "20px 4px 10px", fontWeight: 700 }}>
          コース一覧
        </h1>

        {courses.length === 0 && (
          <div className="card muted">
            まだコースがありません。右上の「＋」から作成、
            または上の「コースマップURL登録」からインポートしてください。
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
