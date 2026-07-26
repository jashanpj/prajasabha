import { describe, expect, it, vi } from "vitest";
import { sendDuplicateEmailNotice, sendMagicLinkEmail } from "./resend";

describe("sendMagicLinkEmail", () => {
  it("posts to the Resend API with the expected shape", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );

    const ok = await sendMagicLinkEmail(
      {
        to: "voter@example.com",
        link: "https://prajasabha.example/api/auth/register/verify?token=abc",
        locale: "ml",
        ttlMinutes: 15,
      },
      "test-api-key",
      fetchImpl,
    );

    expect(ok).toBe(true);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [url, init] = call;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init?.body as string);
    expect(body.to).toEqual(["voter@example.com"]);
    expect(body.html).toContain("https://prajasabha.example/api/auth/register/verify?token=abc");
  });

  it("renders the Malayalam subject/body for locale 'ml', with the real TTL interpolated", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("{}", { status: 200 }),
    );
    await sendMagicLinkEmail(
      { to: "voter@example.com", link: "https://x/verify?token=abc", locale: "ml", ttlMinutes: 15 },
      "key",
      fetchImpl,
    );
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [, init] = call;
    const body = JSON.parse(init?.body as string);
    expect(body.subject).toBe("നിങ്ങളുടെ സൈൻ-ഇൻ ലിങ്ക്");
    expect(body.html).toContain("15");
  });

  it("renders the English subject/body for locale 'en', with the real TTL interpolated", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("{}", { status: 200 }),
    );
    await sendMagicLinkEmail(
      { to: "voter@example.com", link: "https://x/verify?token=abc", locale: "en", ttlMinutes: 30 },
      "key",
      fetchImpl,
    );
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [, init] = call;
    const body = JSON.parse(init?.body as string);
    expect(body.subject).toBe("Your sign-in link");
    expect(body.html).toContain("30");
  });

  it("returns false when Resend responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("error", { status: 500 }),
    );
    const ok = await sendMagicLinkEmail(
      { to: "voter@example.com", link: "https://x/verify?token=abc", locale: "ml", ttlMinutes: 15 },
      "key",
      fetchImpl,
    );
    expect(ok).toBe(false);
  });

  it("returns false (fails closed) when the request itself throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const ok = await sendMagicLinkEmail(
      { to: "voter@example.com", link: "https://x/verify?token=abc", locale: "ml", ttlMinutes: 15 },
      "key",
      fetchImpl,
    );
    expect(ok).toBe(false);
  });
});

describe("sendDuplicateEmailNotice", () => {
  it("posts a notice email distinct from the magic-link email", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("{}", { status: 200 }),
    );
    const ok = await sendDuplicateEmailNotice(
      { to: "voter@example.com", locale: "en" },
      "key",
      fetchImpl,
    );
    expect(ok).toBe(true);

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [, init] = call;
    const body = JSON.parse(init?.body as string);
    expect(body.to).toEqual(["voter@example.com"]);
    expect(body.subject).toBe("You already have a PrajaSabha account");
    // Never contains a magic-link-style verify URL — this is a notice, not
    // a way to sign in to the existing account.
    expect(body.html).not.toContain("/verify?token=");
  });

  it("renders the Malayalam notice for locale 'ml'", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("{}", { status: 200 }),
    );
    await sendDuplicateEmailNotice({ to: "voter@example.com", locale: "ml" }, "key", fetchImpl);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const [, init] = call;
    const body = JSON.parse(init?.body as string);
    expect(body.subject).toBe("നിങ്ങൾക്ക് ഇതിനകം ഒരു PrajaSabha അക്കൗണ്ട് ഉണ്ട്");
  });

  it("returns false when Resend responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response("error", { status: 500 }),
    );
    const ok = await sendDuplicateEmailNotice(
      { to: "voter@example.com", locale: "en" },
      "key",
      fetchImpl,
    );
    expect(ok).toBe(false);
  });
});
