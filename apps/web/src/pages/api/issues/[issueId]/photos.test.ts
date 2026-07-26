import { randomUUID } from "node:crypto";
import { schema } from "db";
import { eq } from "drizzle-orm";
import { signSession } from "shared";
import { describe, expect, it, vi } from "vitest";
import { getServiceRoleDb } from "../../../../lib/db";
import { handlePhotoUpload } from "./photos";

// Issue #24 (B1 — Raise an Issue form). handlePhotoUpload shares
// draft.ts's session/ownership/draft-status guards, validates against
// issuePhotoUploadSchema, sniffs mime from magic bytes (never a
// client-supplied filename/content-type), 409s past 5 photos, runs
// stripExif, writes to R2 (ISSUE_PHOTOS binding) under
// issues/{issueId}/{uuid}.{ext}, and appends the key to photoKeys.
//
// This is where #24's test notes' "EXIF-strip verified on an uploaded
// fixture image with GPS data" is checked at the endpoint/integration
// level: the GPS-bearing JPEG fixture below is uploaded through the real
// handler, and the bytes the fake R2 mock's put() actually received are
// asserted to have no APP1/EXIF marker left — proving the endpoint, not
// just the standalone stripExif unit, does the stripping before persisting.

const VALID_WARD_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is not set. This test needs a real Postgres — see CONTRIBUTING.md.",
    );
  }
  return url;
}

function fakeR2() {
  const store = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer | Uint8Array | ArrayBufferView) => {
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value instanceof ArrayBuffer ? value : (value as ArrayBufferView).buffer);
    store.set(key, bytes);
    return { key };
  });
  return {
    put,
    get: vi.fn(async (key: string) => {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { arrayBuffer: async () => bytes.buffer };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_DATABASE_URL: appDatabaseUrl(),
    SESSION_SECRET: "session-secret",
    ISSUE_PHOTOS: fakeR2(),
    RATE_LIMIT_KV: fakeKv(),
    ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1000",
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fake Cloudflare.Env for unit tests
  } as any;
}

async function sessionCookie(memberId: string, secret = "session-secret"): Promise<string> {
  const cookie = await signSession(memberId, secret, Date.now() + 60 * 60 * 1000);
  return `ps_session=${cookie}`;
}

async function insertMember(tier: "t0" | "t1" | "t2" = "t1"): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.members)
    .values({ pseudonym: `issue-photos-${randomUUID().slice(0, 8)}`, tier, locale: "ml" })
    .returning({ memberId: schema.members.memberId });
  if (!inserted) throw new Error("member insert returned no row");
  return inserted.memberId;
}

async function deleteMember(memberId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.members).where(eq(schema.members.memberId, memberId));
}

async function insertIssue(
  createdBy: string,
  overrides: Partial<{
    status: "draft" | "published" | "merged" | "closed";
    slug: string;
  }> = {},
): Promise<string> {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [inserted] = await db
    .insert(schema.issues)
    .values({
      slug: overrides.slug ?? `photos-test-${randomUUID().slice(0, 8)}`,
      titleMl: "t",
      titleEn: "t",
      body: "b",
      category: "roads",
      wardId: VALID_WARD_ID,
      status: overrides.status ?? "draft",
      createdBy,
    })
    .returning({ issueId: schema.issues.issueId });
  if (!inserted) throw new Error("issue insert returned no row");
  return inserted.issueId;
}

async function deleteIssue(issueId: string): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db.delete(schema.issues).where(eq(schema.issues.issueId, issueId));
}

async function getIssue(issueId: string) {
  const db = getServiceRoleDb(appDatabaseUrl());
  const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueId, issueId));
  return row;
}

async function setPhotoKeys(issueId: string, keys: string[]): Promise<void> {
  const db = getServiceRoleDb(appDatabaseUrl());
  await db
    .update(schema.issues)
    // biome-ignore lint/suspicious/noExplicitAny: photoKeys lands via issue #24's migration (0004), not yet in packages/db's schema.ts as of this test's authoring
    .set({ photoKeys: keys } as any)
    .where(eq(schema.issues.issueId, issueId));
}

// ---- byte-literal GPS-EXIF JPEG fixture (duplicated from
// packages/shared/src/exif-strip.test.ts — self-contained per this repo's
// existing per-file test-helper convention, e.g. fakeKv/testEnv are
// likewise redefined in every sibling *.test.ts rather than shared). ----

function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function buildExifTiffPayload(): number[] {
  const bytes: number[] = [];
  bytes.push(0x49, 0x49, 0x2a, 0x00, ...u32le(8));
  const gpsIfdOffset = 8 + 2 + 12 + 4;
  bytes.push(...u16le(1));
  bytes.push(...u16le(0x8825), ...u16le(4), ...u32le(1), ...u32le(gpsIfdOffset));
  bytes.push(...u32le(0));
  const gpsDataOffset = gpsIfdOffset + 2 + 12 * 2 + 4;
  bytes.push(...u16le(2));
  bytes.push(...u16le(0x0001), ...u16le(2), ...u32le(2), 0x4e, 0x00, 0x00, 0x00);
  bytes.push(...u16le(0x0002), ...u16le(5), ...u32le(3), ...u32le(gpsDataOffset));
  bytes.push(...u32le(0));
  bytes.push(...u32le(12), ...u32le(1));
  bytes.push(...u32le(34), ...u32le(1));
  bytes.push(...u32le(5678), ...u32le(100));
  return bytes;
}

function buildApp1ExifSegment(): number[] {
  const tiff = buildExifTiffPayload();
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = 2 + payload.length;
  return [0xff, 0xe1, ...u16be(length), ...payload];
}

const SOS_AND_SCAN_AND_EOI = [
  0xff,
  0xda,
  ...u16be(8),
  0x01,
  0x01,
  0x00,
  0x00,
  0x3f,
  0x00,
  0x01,
  0x02,
  0x03,
  0x04,
  0xff,
  0xd9,
];

function buildJpegWithGpsExif(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...buildApp1ExifSegment(), ...SOS_AND_SCAN_AND_EOI]);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function callPhotoUpload(
  body: unknown,
  env: ReturnType<typeof testEnv>,
  issueId: string,
  cookie?: string,
): ReturnType<typeof handlePhotoUpload> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://prajasabha.example/api/issues/${issueId}/photos`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handlePhotoUpload(request, env, issueId);
}

const validPhotoBody = { photoBase64: toBase64(buildJpegWithGpsExif()), filename: "photo.jpg" };

describe("handlePhotoUpload (POST /api/issues/:issueId/photos)", () => {
  it("returns 401 when there is no ps_session cookie", async () => {
    const res = await callPhotoUpload(validPhotoBody, testEnv(), randomUUID());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not the issue's creator", async () => {
    const ownerId = await insertMember("t1");
    const otherId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(ownerId);
      const cookie = await sessionCookie(otherId);
      const res = await callPhotoUpload(validPhotoBody, testEnv(), issueId, cookie);
      expect(res.status).toBe(403);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(ownerId);
      await deleteMember(otherId);
    }
  });

  it("returns 404 when the issue does not exist", async () => {
    const memberId = await insertMember("t1");
    try {
      const cookie = await sessionCookie(memberId);
      const res = await callPhotoUpload(validPhotoBody, testEnv(), randomUUID(), cookie);
      expect(res.status).toBe(404);
    } finally {
      await deleteMember(memberId);
    }
  });

  it("returns 409 once the issue is no longer a draft", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId, { status: "published" });
      const cookie = await sessionCookie(memberId);
      const res = await callPhotoUpload(validPhotoBody, testEnv(), issueId, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 400 for an unsupported mime type sniffed from magic bytes, even with a .jpg filename", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const notAnImage = new TextEncoder().encode("this is definitely not an image file");
      const res = await callPhotoUpload(
        { photoBase64: toBase64(notAnImage), filename: "photo.jpg" },
        testEnv(),
        issueId,
        cookie,
      );
      expect(res.status).toBe(400);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("returns 409 once the issue already has 5 photo keys", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      await setPhotoKeys(
        issueId,
        Array.from({ length: 5 }, () => `issues/${issueId}/${randomUUID()}.jpg`),
      );
      const cookie = await sessionCookie(memberId);
      const res = await callPhotoUpload(validPhotoBody, testEnv(), issueId, cookie);
      expect(res.status).toBe(409);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("201 happy path: returns {key}, appends to photoKeys, and strips EXIF/GPS before the bytes reach R2", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const env = testEnv();

      const res = await callPhotoUpload(validPhotoBody, env, issueId, cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: string };
      expect(body.key).toBeTruthy();

      // The fixture's raw bytes DO carry an APP1/EXIF marker (see
      // packages/shared/src/exif-strip.test.ts) — asserting it's absent
      // here proves the endpoint actually calls stripExif before put(),
      // not just that stripExif itself works in isolation.
      expect(env.ISSUE_PHOTOS.put).toHaveBeenCalledTimes(1);
      const putCall = env.ISSUE_PHOTOS.put.mock.calls[0];
      const putBytesArg = putCall[1] as ArrayBuffer | Uint8Array;
      const putBytes =
        putBytesArg instanceof Uint8Array ? putBytesArg : new Uint8Array(putBytesArg);

      let hasApp1Marker = false;
      for (let i = 0; i < putBytes.length - 1; i++) {
        if (putBytes[i] === 0xff && putBytes[i + 1] === 0xe1) hasApp1Marker = true;
      }
      expect(hasApp1Marker).toBe(false);
      // Sanity: something was actually written, and it's shorter than the
      // GPS-bearing input (the APP1 segment was really removed, not just
      // masked).
      expect(putBytes.length).toBeGreaterThan(0);
      expect(putBytes.length).toBeLessThan(buildJpegWithGpsExif().length);

      const issue = await getIssue(issueId);
      // biome-ignore lint/suspicious/noExplicitAny: photoKeys lands via issue #24's migration (0004), not yet in packages/db's schema.ts as of this test's authoring
      const photoKeys = (issue as any)?.photoKeys as string[] | undefined;
      expect(photoKeys).toContain(body.key);
      expect(photoKeys?.length).toBe(1);
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });

  it("rejects once the per-member photo-upload rate limit is exceeded", async () => {
    const memberId = await insertMember("t1");
    let issueId: string | undefined;
    try {
      issueId = await insertIssue(memberId);
      const cookie = await sessionCookie(memberId);
      const env = testEnv({ ISSUE_PHOTO_RATE_LIMIT_PER_MEMBER_PER_HOUR: "1" });

      const first = await callPhotoUpload(validPhotoBody, env, issueId, cookie);
      expect(first.status).toBe(201);

      const second = await callPhotoUpload(validPhotoBody, env, issueId, cookie);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      if (issueId) await deleteIssue(issueId);
      await deleteMember(memberId);
    }
  });
});
