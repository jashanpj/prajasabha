# Security policy

PrajaSabha handles civic participation data with a hard architectural
separation between identity and civic-activity data (see `CLAUDE.md`). We
take reports affecting that separation, authentication/authorization, or
any other security property extremely seriously.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting instead:
[Report a vulnerability](../../security/advisories/new) (Security tab →
"Report a vulnerability"). This opens a private advisory visible only to
maintainers until we agree on disclosure.

If you cannot use GitHub's private reporting, email the address listed in
this repository's `security.txt` (`.well-known/security.txt` once deployed).

Please include:
- Affected component/module and, if known, file/line
- Reproduction steps or a PoC
- Impact, especially anything touching the vault join rule (identity data
  crossing into participation data) or authz/RLS bypass

## Scope

In scope: this repository's code, its Astro API endpoints, Supabase
RLS policies, and the Cloudflare Worker deployment configuration it ships.

Out of scope: third-party services we depend on (Supabase, Cloudflare,
GitHub) — report those directly to the vendor.

## Response

We aim to acknowledge new reports within 5 business days and to agree on a
disclosure timeline once triaged. Credit is offered in the advisory unless
you ask to stay anonymous.
