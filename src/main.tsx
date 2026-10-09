import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { youtubeUrl } from "../worker/validation";
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
  size?: number | null;
};
type IconName =
  | "download"
  | "video"
  | "audio"
  | "link"
  | "arrow"
  | "check"
  | "clock"
  | "close"
  | "retry"
  | "trash"
  | "alert";
function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  const paths: Record<IconName, React.ReactNode> = {
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5" />
        <path d="M4 16v4h16v-4" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m10 9 5 3-5 3Z" />
      </>
    ),
    audio: (
      <>
        <path d="M9 18V5l11-2v13M9 9l11-2" />
        <ellipse cx="6" cy="18" rx="3" ry="3" />
        <ellipse cx="17" cy="16" rx="3" ry="3" />
      </>
    ),
    link: (
      <>
        <path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    retry: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6m0 3v1" />
      </>
    ),
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const labels: Record<string, string> = {
  queued: "順番待ち",
  running: "ダウンロード中",
  converting: "変換中",
  uploading: "保存中",
  completed: "取得できます",
  failed: "取得に失敗",
  cancelled: "キャンセル済み",
  expired: "保存期限終了",
};
const active = (status: string) =>
  ["queued", "running", "converting", "uploading"].includes(status);
const statusOf = (job: Job, now: number) =>
  job.status === "completed" && job.expires_at && job.expires_at <= now
    ? "expired"
    : job.status;
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
    [quality, setQuality] = useState("1080");
  const [error, setError] = useState(""),
    [urlError, setUrlError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(""),
    [loading, setLoading] = useState(true),
    [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState("all");
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api<Job[]>("/api/jobs");
        if (!disposed) {
          setJobs(next);
          setConnectionError("");
          setCancelling(
            (prev) =>
              new Set(
                [...prev].filter((id) =>
                  next.some((j) => j.id === id && active(j.status)),
                ),
              ),
          );
        }
      } catch (e) {
        if (!disposed) setConnectionError((e as Error).message);
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function action(
    key: string,
    task: () => Promise<unknown>,
    message: string,
  ) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await task();
      setNotice(message);
      setJobs(await api<Job[]>("/api/jobs"));
      setConnectionError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      youtubeUrl(url.trim());
      setUrlError("");
    } catch {
      setUrlError(
        "単一の YouTube 動画または Shorts の URL を入力してください。",
      );
      return;
    }
    await action(
      "create",
      async () => {
        await api("/api/jobs", "POST", { url: url.trim(), format, quality });
        setUrl("");
        setFilter("all");
      },
      "ダウンロードを追加しました。順番に処理します。",
    );
  }
  const counts = {
    all: jobs.length,
    active: jobs.filter((j) => active(statusOf(j, now))).length,
    ready: jobs.filter((j) => statusOf(j, now) === "completed").length,
  };
  const visible = jobs.filter(
    (j) =>
      filter === "all" ||
      (filter === "active"
        ? active(statusOf(j, now))
        : statusOf(j, now) === "completed"),
  );
  return (
    <>
      <div className="topbar">
        <a className="brand" href="/" aria-label="YouTube Download ホーム">
          <span className="brand-mark">
            <Icon name="download" />
          </span>
          <span>YouTube Download</span>
        </a>
        <span className="private-label">
          <span className="status-dot" />
          メンバー限定
        </span>
      </div>
      <main>
        <header className="intro">
          <div>
            <p className="eyebrow">YOUR LINK. YOUR FORMAT.</p>
            <h1>動画を、手元に。</h1>
            <p className="intro-copy">
              YouTube のリンクから、動画や音声を保存できます。
            </p>
          </div>
          <div className="intro-counter">
            <span className="counter-number">
              01<span>h</span>
            </span>
            <p>ファイルの保存時間</p>
          </div>
        </header>
        <div className="workspace">
          <form
            className="composer"
            onSubmit={(e) => void submit(e)}
            noValidate
          >
            <div className="panel-heading">
              <span className="step-number">01</span>
              <h2>リンクを追加</h2>
            </div>
            <label className="field-label" htmlFor="url">
              YouTube の URL
            </label>
            <div className={`url-field ${urlError ? "invalid" : ""}`}>
              <Icon name="link" />
              <input
                id="url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="YouTube のリンクを貼り付け"
                value={url}
                aria-invalid={!!urlError}
                aria-describedby={urlError ? "url-error" : "url-help"}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError("");
                }}
              />
              {url && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="URL をクリア"
                  onClick={() => {
                    setUrl("");
                    setUrlError("");
                    document.getElementById("url")?.focus();
                  }}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            {urlError ? (
              <p className="field-error" id="url-error" role="alert">
                <Icon name="alert" />
                {urlError}
              </p>
            ) : (
              <p id="url-help" className="field-hint">
                通常の動画・Shorts に対応しています。
              </p>
            )}
            <fieldset className="format-field">
              <legend>保存する形式</legend>
              <div className="format-options">
                {[
                  {
                    value: "mp4",
                    icon: "video",
                    title: "動画",
                    sub: "MP4 · 映像と音声",
                  },
                  {
                    value: "mp3",
                    icon: "audio",
                    title: "音声",
                    sub: "MP3 · 音声のみ",
                  },
                ].map((item) => (
                  <label
                    className={`format-card ${format === item.value ? "selected" : ""}`}
                    key={item.value}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="format"
                      value={item.value}
                      checked={format === item.value}
                      onChange={() => setFormat(item.value)}
                    />
                    <Icon name={item.icon as IconName} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.sub}</small>
                    </span>
                    <span className="radio-indicator">
                      {format === item.value && <span />}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {format === "mp4" ? (
              <fieldset className="quality-field">
                <legend>画質の上限</legend>
                <div className="quality-options">
                  {[
                    { value: "480", label: "480p" },
                    { value: "720", label: "720p" },
                    { value: "1080", label: "1080p" },
                    { value: "best", label: "最高画質" },
                  ].map((item) => (
                    <label
                      key={item.value}
                      className={quality === item.value ? "selected" : ""}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name="quality"
                        value={item.value}
                        checked={quality === item.value}
                        onChange={() => setQuality(item.value)}
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
                <p className="field-hint">
                  指定の画質がない場合は、低い画質で保存します。
                </p>
              </fieldset>
            ) : (
              <div className="audio-detail">
                <Icon name="audio" />
                <span>
                  MP3 / 192kbps<span>音声だけを取り出して保存します。</span>
                </span>
              </div>
            )}
            <button
              className="submit-button"
              type="submit"
              disabled={!!busy || !url.trim()}
            >
              {busy === "create" ? (
                <>
                  <span className="spinner" />
                  追加しています
                </>
              ) : (
                <>
                  <Icon name="download" />
                  ダウンロードを開始
                  <Icon name="arrow" />
                </>
              )}
            </button>
            <p className="composer-caption">
              追加後はブラウザーを閉じても処理が続きます。
            </p>
          </form>
          <aside className="guide">
            <div className="panel-heading">
              <span className="step-number">02</span>
              <h2>完了したら取得</h2>
            </div>
            <p className="guide-lead">
              保存できるのは、
              <br />
              完了から <strong>1時間</strong>。
            </p>
            <p className="guide-copy">
              下の一覧で進捗を確認し、完了したら「ファイルを取得」を押してください。
            </p>
            <div className="guide-rule">
              <Icon name="clock" />
              <p>
                期限を過ぎたファイルは自動で削除されます。必要なときは再試行できます。
              </p>
            </div>
            <dl className="limits">
              <div>
                <dt>同時処理</dt>
                <dd>1件ずつ</dd>
              </div>
              <div>
                <dt>ファイルサイズ</dt>
                <dd>最大 1GB</dd>
              </div>
              <div>
                <dt>処理時間</dt>
                <dd>最大 60分</dd>
              </div>
            </dl>
            <p className="guide-foot">
              公開動画が対象です。プレイリスト・ライブ配信には対応していません。
            </p>
          </aside>
        </div>
        <div className="feedback" aria-live="polite">
          {notice && (
            <p className="notice">
              <Icon name="check" />
              {notice}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          {connectionError && (
            <p className="error" role="alert">
              <Icon name="alert" />
              一覧を更新できません。{connectionError}
            </p>
          )}
        </div>
        <section className="library" aria-labelledby="library-title">
          <div className="library-heading">
            <div>
              <p className="eyebrow">DOWNLOADS</p>
              <h2 id="library-title">ダウンロード一覧</h2>
            </div>
            <span className="live-label">
              <span className="status-dot" />
              {loading
                ? "読み込み中"
                : connectionError
                  ? "接続を確認してください"
                  : "3秒ごとに自動更新"}
            </span>
          </div>
          <div className="filters" role="group" aria-label="一覧の絞り込み">
            {[
              { value: "all", label: "すべて", count: counts.all },
              { value: "active", label: "処理中", count: counts.active },
              { value: "ready", label: "取得可能", count: counts.ready },
            ].map((item) => (
              <button
                type="button"
                className={filter === item.value ? "selected" : ""}
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                key={item.value}
              >
                {item.label}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          {loading ? (
            <div className="empty">
              <span className="spinner" />
              <h3>一覧を読み込んでいます</h3>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">
                <Icon
                  name={
                    filter === "ready"
                      ? "check"
                      : filter === "active"
                        ? "clock"
                        : "download"
                  }
                />
              </span>
              <h3>
                {filter === "all"
                  ? "最初の1本を、追加しましょう。"
                  : filter === "active"
                    ? "処理中のダウンロードはありません。"
                    : "取得できるファイルはまだありません。"}
              </h3>
              <p>
                {filter === "all"
                  ? "上のフォームにリンクを貼り付けると、ここに表示されます。"
                  : filter === "active"
                    ? "追加した動画は、1件ずつ順番に処理します。"
                    : "ダウンロードが完了すると、この一覧に表示されます。"}
              </p>
              {filter !== "all" && (
                <button
                  className="text-button"
                  onClick={() => setFilter("all")}
                >
                  すべてのダウンロードを見る
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          ) : (
            <div className="job-list">
              {visible.map((job) => {
                const status = statusOf(job, now),
                  working = active(status);
                const remaining = job.expires_at
                  ? Math.max(0, Math.ceil((job.expires_at - now) / 60000))
                  : 0;
                return (
                  <article
                    className={`job ${working ? "working" : ""}`}
                    key={job.id}
                  >
                    <div className="file-icon">
                      <Icon name={job.format === "mp3" ? "audio" : "video"} />
                      <span>{job.format.toUpperCase()}</span>
                    </div>
                    <div className="job-body">
                      <div className="job-topline">
                        <span className={`badge ${status}`}>
                          {working && status !== "queued" ? (
                            <span className="spinner" />
                          ) : (
                            <Icon
                              name={
                                status === "completed"
                                  ? "check"
                                  : status === "failed"
                                    ? "alert"
                                    : status === "queued"
                                      ? "clock"
                                      : "close"
                              }
                            />
                          )}{" "}
                          {labels[status] ?? status}
                        </span>
                        <span className="job-meta">
                          {job.format === "mp4"
                            ? job.quality === "best"
                              ? "最高画質"
                              : `${job.quality}p 以下`
                            : "192kbps"}
                          <span> / </span>
                          {new Intl.DateTimeFormat("ja-JP", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          }).format(job.created_at)}
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
                        <Icon name="arrow" />
                      </a>
                      {working && (
                        <div className="progress-block">
                          <div className="progress-label">
                            <span>
                              {status === "queued"
                                ? "順番が来ると自動で開始します。"
                                : status === "converting"
                                  ? "ファイルを指定の形式に変換しています。"
                                  : status === "uploading"
                                    ? "ファイルを保存しています。"
                                    : "動画を取得しています。"}
                            </span>
                            {status !== "queued" && (
                              <strong>{Math.round(job.progress)}%</strong>
                            )}
                          </div>
                          {status !== "queued" && (
                            <div
                              className="progress-track"
                              role="progressbar"
                              aria-label="ダウンロード進捗"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(job.progress)}
                            >
                              <div style={{ width: `${job.progress}%` }} />
                            </div>
                          )}
                        </div>
                      )}
                      {job.error && (
                        <p className="job-error">
                          <Icon name="alert" />
                          {job.error}
                        </p>
                      )}
                      {status === "completed" && (
                        <p className="expires">
                          <Icon name="clock" />
                          <strong>あと {remaining} 分で削除</strong>
                          {job.size
                            ? ` · ${(job.size / 1_000_000).toFixed(1)} MB`
                            : ""}
                        </p>
                      )}
                      {status === "expired" && (
                        <p className="expired-copy">
                          保存期間が終了しました。再試行するともう一度取得できます。
                        </p>
                      )}
                    </div>
                    <div className="job-actions">
                      {status === "completed" && (
                        <a
                          className="download-button"
                          href={`/api/jobs/${job.id}/download`}
                        >
                          <Icon name="download" />
                          ファイルを取得
                        </a>
                      )}
                      {working ? (
                        <button
                          className="secondary-button"
                          disabled={!!busy || cancelling.has(job.id)}
                          onClick={() =>
                            void action(
                              job.id,
                              async () => {
                                await api(`/api/jobs/${job.id}/cancel`, "POST");
                                setCancelling(
                                  (prev) => new Set([...prev, job.id]),
                                );
                              },
                              "キャンセルを受け付けました。",
                            )
                          }
                        >
                          {cancelling.has(job.id)
                            ? "キャンセル中"
                            : "キャンセル"}
                        </button>
                      ) : (
                        <>
                          {["failed", "cancelled", "expired"].includes(
                            status,
                          ) && (
                            <button
                              className="secondary-button"
                              disabled={!!busy}
                              onClick={() =>
                                void action(
                                  job.id,
                                  async () => {
                                    await api("/api/jobs", "POST", {
                                      url: job.url,
                                      format: job.format,
                                      quality: job.quality,
                                    });
                                    setFilter("all");
                                  },
                                  "再試行を追加しました。",
                                )
                              }
                            >
                              <Icon name="retry" />
                              再試行
                            </button>
                          )}
                          <button
                            className="delete-button"
                            disabled={!!busy}
                            onClick={() =>
                              void action(
                                job.id,
                                () => api(`/api/jobs/${job.id}`, "DELETE"),
                                "ダウンロードを削除しました。",
                              )
                            }
                            aria-label={`${job.title ?? "YouTube 動画"}を削除`}
                          >
                            <Icon name="trash" />
                            削除
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <footer className="page-footer">
          <span>YouTube Download</span>
          <p>
            一覧はメンバー間で共有されます。保存・利用できる動画を指定してください。
          </p>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
