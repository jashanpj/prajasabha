// Transactional email via Resend (issue #20 — not SES: plain fetch(), no
// AWS SDK/request-signing needed, a natural fit for Cloudflare Workers).
// Bilingual subject/body, matching the member's chosen locale — Malayalam
// is the default per CLAUDE.md.
const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "PrajaSabha <noreply@prajasabha.example>";

const MAGIC_LINK_COPY = {
  ml: {
    subject: "നിങ്ങളുടെ സൈൻ-ഇൻ ലിങ്ക്",
    body: (link: string, ttlMinutes: number) =>
      `<p>PrajaSabha-യിൽ സൈൻ ഇൻ ചെയ്യാൻ താഴെയുള്ള ലിങ്കിൽ ക്ലിക്ക് ചെയ്യുക:</p><p><a href="${link}">${link}</a></p><p>ഈ ലിങ്ക് ${ttlMinutes} മിനിറ്റിനുള്ളിൽ കാലഹരണപ്പെടും.</p>`,
  },
  en: {
    subject: "Your sign-in link",
    body: (link: string, ttlMinutes: number) =>
      `<p>Click the link below to sign in to PrajaSabha:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${ttlMinutes} minutes.</p>`,
  },
} as const;

const DUPLICATE_NOTICE_COPY = {
  ml: {
    subject: "നിങ്ങൾക്ക് ഇതിനകം ഒരു PrajaSabha അക്കൗണ്ട് ഉണ്ട്",
    body: "<p>ഈ ഇമെയിൽ വിലാസം ഉപയോഗിച്ച് ആരോ PrajaSabha-യിൽ വീണ്ടും രജിസ്റ്റർ ചെയ്യാൻ ശ്രമിച്ചു — എന്നാൽ ഈ വിലാസത്തിന് ഇതിനകം ഒരു അക്കൗണ്ട് ഉണ്ട്. ഇത് നിങ്ങളല്ലെങ്കിൽ, ഈ ഇമെയിൽ അവഗണിക്കുക.</p>",
  },
  en: {
    subject: "You already have a PrajaSabha account",
    body: "<p>Someone tried to register on PrajaSabha using this email address — but an account already exists for it. If this wasn't you, you can safely ignore this email.</p>",
  },
} as const;

async function postToResend(
  apiKey: string,
  fetchImpl: typeof fetch,
  payload: { to: string; subject: string; html: string },
): Promise<boolean> {
  try {
    const response = await fetchImpl(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface MagicLinkEmail {
  to: string;
  link: string;
  locale: "ml" | "en";
  ttlMinutes: number;
}

export async function sendMagicLinkEmail(
  email: MagicLinkEmail,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const copy = MAGIC_LINK_COPY[email.locale];
  return postToResend(apiKey, fetchImpl, {
    to: email.to,
    subject: copy.subject,
    html: copy.body(email.link, email.ttlMinutes),
  });
}

export interface DuplicateEmailNotice {
  to: string;
  locale: "ml" | "en";
}

/**
 * Sent instead of a magic link when the email is already registered —
 * never a distinguishable HTTP response (anti-enumeration: the caller
 * gets the identical 202 either way, see start.ts).
 */
export async function sendDuplicateEmailNotice(
  notice: DuplicateEmailNotice,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const copy = DUPLICATE_NOTICE_COPY[notice.locale];
  return postToResend(apiKey, fetchImpl, { to: notice.to, subject: copy.subject, html: copy.body });
}
