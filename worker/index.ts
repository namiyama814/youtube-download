import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { options } from "./validation";
type Bindings = Env & { INTERNAL_SECRET: string };
type Job = {
  id: string;
  status: string;
  lease: string;
  cancel_requested: number;
  object_key: string | null;
  expires_at: number | null;
  filename: string | null;
  format: string;
  size: number;
  upload_id: string | null;
};
const active = "('running','converting','uploading')";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function secret(req: Request, env: Bindings) {
  const supplied =
    req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.INTERNAL_SECRET || !supplied) return false;
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(supplied), hash(env.INTERNAL_SECRET)]);
  return timingSafeEqual(a, b);
}
async function access(req: Request, env: Bindings) {
  const url = new URL(req.url);
  if (
    env.LOCAL_DEV === "true" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  )
    return true;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    await jwtVerify(
      req.headers.get("Cf-Access-Jwt-Assertion") ?? "",
      createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"] },
    );
    return true;
  } catch {
    return false;
  }
}
async function body(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("入力が不正です。");
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 32768) {
      await reader.cancel();
      throw new Error("入力が大きすぎます。");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("入力が不正です。");
  return data as Record<string, unknown>;
}
export async function cleanup(env: Bindings, now = Date.now()) {
  await env.DB.prepare(
    `UPDATE jobs SET status='failed',error='処理が中断されました。再試行してください。',lease=NULL,updated_at=? WHERE status IN ${active} AND (heartbeat < ? OR started_at < ?)`,
  )
    .bind(now, now - 120000, now - 3600000)
    .run();
  const rows = await env.DB.prepare(
    "SELECT id,object_key,upload_id FROM jobs WHERE object_key IS NOT NULL AND (expires_at<=? OR status IN ('failed','cancelled','expired')) LIMIT 100",
  )
    .bind(now)
    .all<{ id: string; object_key: string; upload_id: string | null }>();
  for (const row of rows.results) {
    if (row.upload_id) {
      try {
        await env.FILES.resumeMultipartUpload(
          row.object_key,
          row.upload_id,
        ).abort();
      } catch {
        console.error("multipart_abort_failed");
      }
    }
    await env.FILES.delete(row.object_key);
    await env.DB.prepare(
      "UPDATE jobs SET object_key=NULL,upload_id=NULL,status=CASE WHEN status='completed' THEN 'expired' ELSE status END,updated_at=? WHERE id=?",
    )
      .bind(now, row.id)
      .run();
  }
  await env.DB.prepare(
    "DELETE FROM jobs WHERE object_key IS NULL AND status IN ('failed','cancelled','expired') AND updated_at<?",
  )
    .bind(now - 7 * 86400000)
    .run();
}
async function internal(req: Request, env: Bindings, path: string) {
  if (!(await secret(req, env))) return json({ error: "Unauthorized" }, 401);
  const now = Date.now();
  if (path === "/internal/maintenance" && req.method === "POST") {
    await cleanup(env, now);
    return json({ ok: true });
  }
  if (path === "/internal/claim" && req.method === "POST") {
    await env.DB.prepare(
      `UPDATE jobs SET status='failed',error='処理が中断されました。',lease=NULL,updated_at=? WHERE status IN ${active} AND heartbeat<?`,
    )
      .bind(now, now - 120000)
      .run();
    const lease = crypto.randomUUID();
    const job = await env.DB.prepare(
      `UPDATE jobs SET status='running',lease=?,started_at=?,heartbeat=?,updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM jobs WHERE status IN ${active}) RETURNING *`,
    )
      .bind(lease, now, now, now)
      .first();
    return json({ job });
  }
  const uploadMatch =
    /^\/internal\/jobs\/([\w-]+)\/upload\/(start|part|complete)$/.exec(path);
  if (uploadMatch) {
    const lease = req.headers.get("X-Job-Lease") ?? "";
    const job = await env.DB.prepare(
      "SELECT * FROM jobs WHERE id=? AND lease=? AND status='uploading' AND cancel_requested=0",
    )
      .bind(uploadMatch[1], lease)
      .first<Job>();
    if (!job) return json({ error: "Lease lost" }, 409);
    const key = `results/${job.id}.${job.format}`;
    if (uploadMatch[2] === "start" && req.method === "POST") {
      if (job.upload_id) return json({ uploadId: job.upload_id });
      const upload = await env.FILES.createMultipartUpload(key, {
        httpMetadata: {
          contentType: job.format === "mp3" ? "audio/mpeg" : "video/mp4",
        },
      });
      const result = await env.DB.prepare(
        "UPDATE jobs SET upload_id=? WHERE id=? AND lease=? AND status='uploading' AND cancel_requested=0",
      )
        .bind(upload.uploadId, job.id, lease)
        .run();
      if (!result.meta.changes) {
        await upload.abort();
        return json({ error: "Lease lost" }, 409);
      }
      return json({ uploadId: upload.uploadId });
    }
    if (!job.upload_id) return json({ error: "No upload" }, 409);
    const upload = env.FILES.resumeMultipartUpload(key, job.upload_id);
    if (uploadMatch[2] === "part" && req.method === "PUT") {
      const number = Number(new URL(req.url).searchParams.get("number"));
      const length = Number(req.headers.get("Content-Length"));
      if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > 120 ||
        length < 1 ||
        length > 8 * 1024 * 1024 ||
        !req.body
      )
        return json({ error: "Invalid part" }, 400);
      return json(await upload.uploadPart(number, req.body));
    }
    if (uploadMatch[2] === "complete" && req.method === "POST") {
      const data = await body(req);
      if (
        !Array.isArray(data.parts) ||
        data.parts.length < 1 ||
        data.parts.length > 120
      )
        return json({ error: "Invalid parts" }, 400);
      const parts = data.parts.map((p: unknown, i: number) => {
        if (!p || typeof p !== "object") throw new Error("Invalid parts");
        const part = p as Record<string, unknown>;
        if (part.partNumber !== i + 1 || typeof part.etag !== "string")
          throw new Error("Invalid parts");
        return { partNumber: i + 1, etag: part.etag };
      });
      await upload.complete(parts);
      await env.DB.prepare(
        "UPDATE jobs SET upload_id=NULL WHERE id=? AND lease=?",
      )
        .bind(job.id, lease)
        .run();
      return json({ ok: true });
    }
    return json({ error: "Invalid upload operation" }, 400);
  }
  const match = /^\/internal\/jobs\/([\w-]+)$/.exec(path);
  if (!match || req.method !== "POST") return json({ error: "Not found" }, 404);
  const data = await body(req);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND lease=?")
    .bind(match[1], String(data.lease))
    .first<Job>();
  if (job?.status === "completed" && data.status === "completed")
    return json({ cancel: false });
  if (!job || !["running", "converting", "uploading"].includes(job.status))
    return json({ error: "Lease lost" }, 409);
  if (job.cancel_requested) {
    await env.DB.prepare(
      "UPDATE jobs SET status='cancelled',lease=NULL,updated_at=? WHERE id=? AND lease=?",
    )
      .bind(now, job.id, job.lease)
      .run();
    return json({ cancel: true });
  }
  const status = String(data.status ?? job.status);
  if (
    ![
      "running",
      "converting",
      "uploading",
      "completed",
      "failed",
      "cancelled",
    ].includes(status)
  )
    return json({ error: "Invalid status" }, 400);
  const key = `results/${job.id}.${job.format}`;
  let size: number | null = null;
  if (status === "completed") {
    const obj = await env.FILES.head(key);
    if (!obj || obj.size > 1_000_000_000)
      return json({ error: "Missing or oversized result" }, 400);
    size = obj.size;
  }
  // Reserve the deterministic key before upload so cleanup can remove interrupted uploads.
  const progress =
    typeof data.progress === "number" && Number.isFinite(data.progress)
      ? Math.max(0, Math.min(100, data.progress))
      : 0;
  const title =
    typeof data.title === "string" ? data.title.slice(0, 200) : null;
  const errors: Record<string, string> = {
    bot_detected:
      "YouTube が Render からのアクセスを制限しています。時間を置いて再試行してください。",
    authentication_required: "ログインが必要な動画は取得できません。",
    unavailable: "この動画は公開されていないか、利用できません。",
    network_error: "動画サイトとの通信に失敗しました。再試行してください。",
    upload_failed: "ファイルの保存に失敗しました。再試行してください。",
    unsupported_video: "ライブ配信やプレイリストは取得できません。",
    size_limit:
      "ファイルがサイズ上限を超えています。画質を下げて再試行してください。",
  };
  const error =
    status === "failed"
      ? (errors[String(data.error_code)] ??
        "ダウンロードに失敗しました。動画の公開状態や制限を確認して再試行してください。")
      : null;
  const result = await env.DB.prepare(
    `UPDATE jobs SET status=?,progress=?,title=COALESCE(?,title),error=?,heartbeat=?,updated_at=?,object_key=COALESCE(?,object_key),filename=COALESCE(?,filename),size=COALESCE(?,size),expires_at=COALESCE(?,expires_at) WHERE id=? AND lease=? AND cancel_requested=0 AND status IN ${active}`,
  )
    .bind(
      status,
      progress,
      title,
      error,
      now,
      now,
      ["uploading", "completed"].includes(status) ? key : null,
      status === "completed" ? `${job.id}.${job.format}` : null,
      size,
      status === "completed" ? now + 3600000 : null,
      job.id,
      job.lease,
    )
    .run();
  return json({ cancel: result.meta.changes === 0 });
}
async function browser(req: Request, env: Bindings, path: string) {
  if (!(await access(req, env)))
    return json(
      { error: "ログインが必要です。Access の設定を確認してください。" },
      401,
    );
  if (
    req.method !== "GET" &&
    req.headers.get("Origin") !== new URL(req.url).origin
  )
    return json({ error: "Invalid origin" }, 403);
  const now = Date.now();
  if (path === "/api/jobs" && req.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id,url,format,quality,CASE WHEN status='completed' AND expires_at<=? THEN 'expired' ELSE status END AS status,progress,title,error,created_at,expires_at,size FROM jobs ORDER BY created_at DESC LIMIT 100",
    )
      .bind(now)
      .all();
    return json(result.results);
  }
  if (path === "/api/jobs" && req.method === "POST") {
    const input = options(await body(req));
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO jobs(id,url,format,quality,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(id, input.url, input.format, input.quality, now, now)
        .run();
    } catch (e) {
      if (String(e).includes("queue_full"))
        return json({ error: "待機中のジョブは最大10件です。" }, 429);
      throw e;
    }
    return json({ id }, 201);
  }
  const m = /^\/api\/jobs\/([\w-]+)(?:\/(download|cancel))?$/.exec(path);
  if (!m) return json({ error: "Not found" }, 404);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(m[1])
    .first<Job>();
  if (!job) return json({ error: "Not found" }, 404);
  if (m[2] === "download" && req.method === "GET") {
    if (
      job.status !== "completed" ||
      !job.expires_at ||
      job.expires_at <= now ||
      !job.object_key
    )
      return json(
        { error: "取得期限が切れているか、処理が完了していません。" },
        410,
      );
    const obj = await env.FILES.get(job.object_key, { range: req.headers });
    if (!obj) return json({ error: "ファイルがありません。" }, 404);
    const headers = new Headers({
      "Content-Type": job.format === "mp3" ? "audio/mpeg" : "video/mp4",
      "Content-Disposition": `attachment; filename="${job.filename}"`,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
    });
    let code = 200;
    if (
      req.headers.has("Range") &&
      obj.range &&
      "offset" in obj.range &&
      obj.range.offset !== undefined &&
      obj.range.length !== undefined
    ) {
      headers.set(
        "Content-Range",
        `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`,
      );
      headers.set("Content-Length", String(obj.range.length));
      code = 206;
    } else headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { status: code, headers });
  }
  if (m[2] === "cancel" && req.method === "POST") {
    await env.DB.prepare(
      `UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=? AND status IN ('queued','running','converting','uploading')`,
    )
      .bind(now, job.id)
      .run();
    return json({ ok: true });
  }
  if (!m[2] && req.method === "DELETE") {
    if (["running", "converting", "uploading"].includes(job.status))
      return json({ error: "先にキャンセルしてください。" }, 409);
    if (job.object_key) await env.FILES.delete(job.object_key);
    await env.DB.prepare("DELETE FROM jobs WHERE id=?").bind(job.id).run();
    return json({ ok: true });
  }
  if (!m[2] && req.method === "GET") return json({ ...job, lease: undefined });
  return json({ error: "Not found" }, 404);
}
export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    try {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/internal/")) return await internal(req, env, path);
      if (path.startsWith("/api/")) return await browser(req, env, path);
      if (!(await access(req, env)))
        return json({ error: "ログインが必要です。" }, 401);
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof TypeError)
        return json({ error: "入力が不正です。" }, 400);
      if (e instanceof Error && !String(e).includes("D1"))
        return json({ error: e.message }, 400);
      console.error("request_failed");
      return json({ error: "処理に失敗しました。" }, 500);
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(cleanup(env));
    if (env.RENDER_URL)
      ctx.waitUntil(
        fetch(`${env.RENDER_URL.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(20000),
        })
          .then((r) => {
            if (!r.ok) console.error("render_health_failed");
          })
          .catch(() => console.error("render_unreachable")),
      );
  },
};
