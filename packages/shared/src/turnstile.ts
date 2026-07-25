const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Server-side Cloudflare Turnstile verification (HLD A7: "Turnstile on
 * forms"). Fails closed — any network error or non-200 response is
 * treated as a failed verification, never silently allowed through.
 * `fetchImpl` is injectable so callers/tests don't need a real network
 * call.
 */
export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await fetchImpl(SITEVERIFY_URL, { method: "POST", body });
    if (!response.ok) return false;
    const data = (await response.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
