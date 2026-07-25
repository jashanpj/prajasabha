import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "test-session-secret-do-not-use-in-prod";
const MEMBER_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER_MEMBER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("signSession / verifySession", () => {
  it("round-trips a valid session", async () => {
    const cookie = await signSession(MEMBER_ID, SECRET, Date.now() + 60_000);
    const result = await verifySession(cookie, SECRET);
    expect(result).toEqual({ memberId: MEMBER_ID });
  });

  it("rejects a session signed with a different secret", async () => {
    const cookie = await signSession(MEMBER_ID, SECRET, Date.now() + 60_000);
    const result = await verifySession(cookie, "a-different-secret");
    expect(result).toBeNull();
  });

  it("rejects an expired session", async () => {
    const cookie = await signSession(MEMBER_ID, SECRET, Date.now() - 1);
    const result = await verifySession(cookie, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a tampered memberId", async () => {
    const cookie = await signSession(MEMBER_ID, SECRET, Date.now() + 60_000);
    const [, expiresAt, signature] = cookie.split(".");
    const tampered = `${OTHER_MEMBER_ID}.${expiresAt}.${signature}`;
    const result = await verifySession(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a malformed cookie value", async () => {
    expect(await verifySession("not-a-valid-cookie", SECRET)).toBeNull();
    expect(await verifySession("", SECRET)).toBeNull();
  });
});
