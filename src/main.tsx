import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Job = {
  id: string;
  url: string;
  format: string;
  quality: string;
  status: string;
  progress: number;
  title: string | null;
  error: string | null;
  expires_at: number | null;
  created_at: number;
};
const labels: Record<string, string> = {
  queued: "待機中",
  running: "ダウンロード中",
  converting: "変換中",
  uploading: "保存中",
  completed: "完了",
  failed: "失敗",
  cancelled: "キャンセル済み",
  expired: "期限切れ",
};
async function api<T = unknown>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(
      (result as { error?: string }).error ?? "通信に失敗しました。",
    );
  return result as T;
}
function App() {
  const [jobs, setJobs] = useState<Job[]>([]),
    [url, setUrl] = useState(""),
    [format, setFormat] = useState("mp4"),
    [quality, setQuality] = useState("1080"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  async function refresh() {
    try {
      setJobs(await api<Job[]>("/api/jobs"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  async function action(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <span className="eyebrow">PRIVATE MEDIA TOOL</span>
        <h1>
          YouTube Download<span>動画も、音声も。</span>
        </h1>
        <p>
          URL
          を貼り付けて、必要な形式で保存。ファイルは完了から1時間で削除されます。
        </p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            await api("/api/jobs", "POST", { url, format, quality });
            setUrl("");
          });
        }}
      >
        <label htmlFor="url">YouTube の URL</label>
        <input
          id="url"
          type="url"
          required
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="controls">
          <label>
            形式
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="mp4">動画 · MP4</option>
              <option value="mp3">音声 · MP3</option>
            </select>
          </label>
          <label>
            画質
            <select
              disabled={format === "mp3"}
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="best">最高画質</option>
              <option value="1080">1080p 以下</option>
              <option value="720">720p 以下</option>
              <option value="480">480p 以下</option>
            </select>
          </label>
          <button disabled={busy} type="submit">
            ダウンロードを開始 ↗
          </button>
        </div>
        <small>公開動画・Shorts に対応 · 同時処理1件 · 最大1GB / 60分</small>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section>
        <div className="section-head">
          <h2>ダウンロード一覧</h2>
          <span>{jobs.length} 件</span>
        </div>
        {jobs.length === 0 ? (
          <div className="empty">
            まだダウンロードはありません。
            <br />
            <small>上のフォームから動画を追加してください。</small>
          </div>
        ) : (
          jobs.map((job) => {
            const status =
              job.status === "completed" &&
              job.expires_at &&
              job.expires_at <= now
                ? "expired"
                : job.status;
            const working = [
              "queued",
              "running",
              "converting",
              "uploading",
            ].includes(status);
            return (
              <article key={job.id}>
                <div className="job-head">
                  <span className={`badge ${status}`}>{labels[status]}</span>
                  <span className="meta">
                    {job.format.toUpperCase()}{" "}
                    {job.format === "mp4"
                      ? job.quality === "best"
                        ? "最高画質"
                        : `${job.quality}p`
                      : ""}
                  </span>
                </div>
                <h3>{job.title ?? "YouTube 動画"}</h3>
                <a
                  className="source"
                  href={job.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {job.url}
                </a>
                {working && (
                  <>
                    <progress
                      max="100"
                      value={job.progress}
                      aria-label="進捗"
                    />
                    <small>
                      {Math.round(job.progress)}%
                      {status === "queued" ? " · 順番待ち" : ""}
                    </small>
                  </>
                )}
                {job.error && <p className="error">{job.error}</p>}
                <footer>
                  <small>
                    {new Date(job.created_at).toLocaleString("ja-JP")}
                    {status === "completed" && job.expires_at
                      ? ` · 残り ${Math.max(0, Math.ceil((job.expires_at - now) / 60000))} 分`
                      : ""}
                  </small>
                  <div className="actions">
                    {status === "completed" && (
                      <a
                        className="download"
                        href={`/api/jobs/${job.id}/download`}
                      >
                        ファイルを取得
                      </a>
                    )}
                    {working ? (
                      <button
                        disabled={busy}
                        className="secondary"
                        onClick={() =>
                          void action(() =>
                            api(`/api/jobs/${job.id}/cancel`, "POST"),
                          )
                        }
                      >
                        キャンセル
                      </button>
                    ) : (
                      <>
                        {["failed", "cancelled", "expired"].includes(
                          status,
                        ) && (
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={() =>
                              void action(() =>
                                api("/api/jobs", "POST", {
                                  url: job.url,
                                  format: job.format,
                                  quality: job.quality,
                                }),
                              )
                            }
                          >
                            再試行
                          </button>
                        )}
                        <button
                          disabled={busy}
                          className="secondary"
                          onClick={() =>
                            void action(() =>
                              api(`/api/jobs/${job.id}`, "DELETE"),
                            )
                          }
                        >
                          削除
                        </button>
                      </>
                    )}
                  </div>
                </footer>
              </article>
            );
          })
        )}
      </section>
      <p className="note">
        限定メンバーの共有一覧です。保存・利用できる動画を指定してください。
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
