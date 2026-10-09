CREATE TABLE jobs (
 id TEXT PRIMARY KEY, url TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('mp4','mp3')),
 quality TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0,
 title TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 started_at INTEGER, heartbeat INTEGER, expires_at INTEGER, object_key TEXT, filename TEXT, size INTEGER,
 upload_id TEXT, lease TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_status ON jobs(status, created_at);
CREATE UNIQUE INDEX one_active_job ON jobs((1)) WHERE status IN ('running','converting','uploading');
CREATE TRIGGER queue_limit BEFORE INSERT ON jobs WHEN (SELECT count(*) FROM jobs WHERE status='queued') >= 10
BEGIN SELECT RAISE(ABORT,'queue_full'); END;
