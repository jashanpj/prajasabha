import type { APIRoute } from "astro";
import { schema } from "db";
import { eq } from "drizzle-orm";
import {
  checkAndIncrement,
  issuePhotoUploadSchema,
  loadIssuePhotoRateLimitConfig,
  stripExif,
  verifySession,
} from "shared";
import { getServiceRoleDb } from "../../../../lib/db";

// B1 — evidence-photo upload (issue #24). Same 401/404/403/409 guard chain
// as draft.ts, then:
//   1. mime is sniffed from magic bytes — never trusted from the filename
//      or a client Content-Type (a .jpg name on non-JPEG bytes is a 400);
//   2. the 5-photo cap is enforced against issues.photo_keys (409);
//   3. stripExif runs BEFORE the R2 put — GPS/EXIF never touches storage
//      (the privacy control #24's test notes single out);
//   4. the object key is server-generated (issues/{issueId}/{uuid}.{ext})
//      and appended to photo_keys — R2 is the blob store, PG the index
//      (HLD §1). Nothing here is public: publish/moderation decide what
//      becomes visible, and published photos are PII-redacted separately.
const MAX_PHOTOS_PER_ISSUE = 5;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function sniffImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function handlePhotoUpload(
  request: Request,
  env: Cloudflare.Env,
  issueId: string,
): Promise<Response> {
  const cookieValue = parseCookie(request.headers.get("Cookie"), "ps_session");
  const session = cookieValue ? await verifySession(cookieValue, env.SESSION_SECRET) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { issuePhotoRateLimitPerMemberPerHour } = loadIssuePhotoRateLimitConfig(
    env as unknown as Record<string, string | undefined>,
  );
  const limit = await checkAndIncrement(
    env.RATE_LIMIT_KV,
    `ratelimit:issue-photo:member:${session.memberId}:${hourBucket()}`,
    issuePhotoRateLimitPerMemberPerHour,
    3600,
  );
  if (!limit.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = getServiceRoleDb(env.APP_DATABASE_URL);
  const [issue] = await db
    .select({
      createdBy: schema.issues.createdBy,
      status: schema.issues.status,
      photoKeys: schema.issues.photoKeys,
    })
    .from(schema.issues)
    .where(eq(schema.issues.issueId, issueId))
    .limit(1);

  if (!issue) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (issue.createdBy !== session.memberId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (issue.status !== "draft") {
    return Response.json({ error: "not_a_draft" }, { status: 409 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = issuePhotoUploadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const bytes = decodeBase64(parsed.data.photoBase64);
  if (!bytes) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const mime = sniffImageMime(bytes);
  if (!mime) {
    return Response.json({ error: "unsupported_media_type" }, { status: 400 });
  }

  if (issue.photoKeys.length >= MAX_PHOTOS_PER_ISSUE) {
    return Response.json({ error: "photo_limit_reached" }, { status: 409 });
  }

  const stripped = stripExif(bytes, mime);
  const extension = mime === "image/jpeg" ? "jpg" : "png";
  const key = `issues/${issueId}/${crypto.randomUUID()}.${extension}`;

  await env.ISSUE_PHOTOS.put(key, stripped);

  await db
    .update(schema.issues)
    .set({ photoKeys: [...issue.photoKeys, key] })
    .where(eq(schema.issues.issueId, issueId));

  return Response.json({ key }, { status: 201 });
}

function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // e.g. "2026-07-26T03"
}

export const POST: APIRoute = async ({ request, params }) => {
  const issueId = params.issueId;
  if (!issueId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { env } = await import("cloudflare:workers");
  return handlePhotoUpload(request, env, issueId);
};
