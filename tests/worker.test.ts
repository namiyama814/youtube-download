import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { cleanup } from "../worker/index";
import { youtubeUrl } from "../worker/validation";
let mf: Miniflare;
let db: D1Database;
let bucket: R2Bucket;
const url = "https://www.youtube.com/watch?v=abcdefghijk";
async function request(
  path: string,
  method = "GET",
  data?: unknown,
  internal = false,
) {
  return mf.dispatchFetch(`http://localhost${path}`, {
    method,
    headers: {
      Origin: "http://localhost",
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(internal ? { Authorization: "Bearer test-secret" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
}
async function create() {
  const r = await request("/api/jobs", "POST", {
    url,
    format: "mp4",
    quality: "720",
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function claim() {
  return (
    (await (await request("/internal/claim", "POST", {}, true)).json()) as {
      job: Record<string, unknown> | null;
    }
  ).job!;
}
beforeAll(async () => {
  const script = buildSync({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  }).outputFiles[0].text;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "test",
      modules: true,
      script,
      compatibilityDate: "2026-10-09",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["FILES"],
      bindings: {
        LOCAL_DEV: "true",
        INTERNAL_SECRET: "test-secret",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "",
        RENDER_URL: "",
      },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  bucket = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket;
  // SQLite trigger contains semicolons; execute schema statements individually.
  const schema = readFileSync("migrations/0001_jobs.sql", "utf8");
  const split = schema.indexOf("CREATE TRIGGER");
  for (const sql of schema
    .slice(0, split)
    .split(";")
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
  await db.prepare(schema.slice(split)).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM jobs").run();
});
describe("URL validation", () => {
  it("normalizes Shorts and short links", () => {
    expect(youtubeUrl("https://youtu.be/abcdefghijk?t=1")).toBe(url);
    expect(youtubeUrl("https://www.youtube.com/shorts/abcdefghijk")).toBe(url);
  });
  it("rejects other hosts, playlists and malformed IDs", () => {
    for (const s of [
      "http://youtu.be/abcdefghijk",
      "https://youtube.com.evil.test/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk&list=x",
      "https://youtu.be/short",
      "https://user@youtu.be/abcdefghijk",
    ])
      expect(() => youtubeUrl(s)).toThrow();
  });
});
describe("Worker lifecycle", () => {
  it("fails closed without Access and protects internal routes", async () => {
    expect(
      (await mf.dispatchFetch("https://example.com/api/jobs")).status,
    ).toBe(401);
    expect((await request("/internal/claim", "POST", {})).status).toBe(401);
    expect(
      (
        await mf.dispatchFetch("http://localhost/api/jobs", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("atomically claims only one job and enforces queue limit", async () => {
    await create();
    const first = await claim();
    expect(first.status).toBe("running");
    expect(await claim()).toBeNull();
    for (let i = 0; i < 10; i++) await create();
    expect(
      (
        await request("/api/jobs", "POST", {
          url,
          format: "mp4",
          quality: "720",
        })
      ).status,
    ).toBe(429);
  });
  it("completes, streams files and denies expired downloads", async () => {
    const id = await create(),
      job = await claim();
    const key = `results/${id}.mp4`;
    await request(
      `/internal/jobs/${id}`,
      "POST",
      { lease: job.lease, status: "uploading" },
      true,
    );
    await bucket.put(key, "video-content");
    expect(
      (
        await request(
          `/internal/jobs/${id}`,
          "POST",
          { lease: job.lease, status: "completed" },
          true,
        )
      ).status,
    ).toBe(200);
    const res = await request(`/api/jobs/${id}/download`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("video-content");
    await db
      .prepare("UPDATE jobs SET expires_at=? WHERE id=?")
      .bind(Date.now() - 1, id)
      .run();
    expect((await request(`/api/jobs/${id}/download`)).status).toBe(410);
  });
  it("cancels active jobs and rejects stale leases", async () => {
    const id = await create(),
      job = await claim();
    await request(`/api/jobs/${id}/cancel`, "POST");
    expect(
      await (
        await request(
          `/internal/jobs/${id}`,
          "POST",
          { lease: job.lease },
          true,
        )
      ).json(),
    ).toEqual({ cancel: true });
    expect(
      (
        await request(
          `/internal/jobs/${id}`,
          "POST",
          { lease: job.lease, status: "completed" },
          true,
        )
      ).status,
    ).toBe(409);
  });
  it("recovers interrupted jobs and permits retry", async () => {
    const id = await create();
    await claim();
    await db
      .prepare("UPDATE jobs SET heartbeat=? WHERE id=?")
      .bind(Date.now() - 180000, id)
      .run();
    await claim();
    expect(
      (
        await db
          .prepare("SELECT status FROM jobs WHERE id=?")
          .bind(id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("failed");
    await create();
    expect((await claim()).status).toBe("running");
  });
  it("rejects completion before upload and records failure", async () => {
    const id = await create(),
      job = await claim();
    expect(
      (
        await request(
          `/internal/jobs/${id}`,
          "POST",
          { lease: job.lease, status: "completed" },
          true,
        )
      ).status,
    ).toBe(400);
    await request(
      `/internal/jobs/${id}`,
      "POST",
      { lease: job.lease, status: "failed" },
      true,
    );
    expect(
      (
        await db
          .prepare("SELECT status FROM jobs WHERE id=?")
          .bind(id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("failed");
  });
  it("deletes saved results", async () => {
    const id = await create(),
      job = await claim();
    await bucket.put(`results/${id}.mp4`, "data");
    await request(
      `/internal/jobs/${id}`,
      "POST",
      { lease: job.lease, status: "completed" },
      true,
    );
    expect((await request(`/api/jobs/${id}`, "DELETE")).status).toBe(200);
    expect(await bucket.head(`results/${id}.mp4`)).toBeNull();
  });
  it("uploads through the authenticated multipart API", async () => {
    const id = await create(),
      job = await claim();
    await request(
      `/internal/jobs/${id}`,
      "POST",
      { lease: job.lease, status: "uploading" },
      true,
    );
    const headers = {
      Authorization: "Bearer test-secret",
      "X-Job-Lease": String(job.lease),
    };
    const endpoint = `http://localhost/internal/jobs/${id}/upload/`;
    expect(
      (await mf.dispatchFetch(endpoint + "start", { method: "POST", headers }))
        .status,
    ).toBe(200);
    const part = await mf.dispatchFetch(endpoint + "part?number=1", {
      method: "PUT",
      headers,
      body: "sample",
    });
    expect(part.status).toBe(200);
    const result = await mf.dispatchFetch(endpoint + "complete", {
      method: "POST",
      headers,
      body: JSON.stringify({ parts: [await part.json()] }),
    });
    expect(result.status).toBe(200);
    expect(
      (
        await request(
          `/internal/jobs/${id}`,
          "POST",
          { lease: job.lease, status: "completed" },
          true,
        )
      ).status,
    ).toBe(200);
    expect(await (await request(`/api/jobs/${id}/download`)).text()).toBe(
      "sample",
    );
  });
  it("removes expired objects and failed upload remnants", async () => {
    const id = await create(),
      job = await claim();
    await bucket.put(`results/${id}.mp4`, "data");
    await request(
      `/internal/jobs/${id}`,
      "POST",
      { lease: job.lease, status: "completed" },
      true,
    );
    await db
      .prepare("UPDATE jobs SET expires_at=? WHERE id=?")
      .bind(Date.now() - 1, id)
      .run();
    await cleanup({ DB: db, FILES: bucket } as Env & {
      INTERNAL_SECRET: string;
    });
    expect(await bucket.head(`results/${id}.mp4`)).toBeNull();
    expect(
      (
        await db
          .prepare("SELECT status FROM jobs WHERE id=?")
          .bind(id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
  });
});
