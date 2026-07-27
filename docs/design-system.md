# Praja / PrajaSabha — Design System

Extracted from the delivered design package (`Praja Civic Platform.dc.html` +
`web/`/`mobile/` screens: landing, verification, dashboard, issue detail,
ledger, model bill, panel, RTI, MP console, responsibility-router
explainer, Malayalam dashboard variant). This is the source of truth for
theming — treat it the same way CLAUDE.md's product-law strings are
treated: copy values exactly, don't eyeball them off a screenshot.

## ⚠️ Before this package (or any screenshot of it) goes anywhere public

The design mockups use the **real sitting MP's name** for the pilot
constituency as the default/sample data in `Praja Civic Platform.dc.html`,
`web/mp-dashboard.dc.html`, and the `mpName` prop default. This is exactly
the risk the PRD already calls out (Risks & Dependencies #9: "Real-
representative data in design assets... replace with fictional placeholder
before any external sharing"). It is now confirmed present, not
hypothetical. **Do not commit the raw design files to this public repo, and
redact the name before sharing screenshots externally**, until this is
fixed. Tracked as #74.

The name itself is deliberately not repeated here: this file is committed to
a public repo, so naming the person in the very note that warns against
exposing them would defeat the purpose. See #74 for the specific occurrences
to fix in the design package.

## Brand

- Name in the design package: **Praja** (Malayalam: പ്രജ). Working name in
  PRD, pending trademark check.
- Name used in this repo/CLAUDE.md so far: **PrajaSabha**. These don't
  match — needs a decision, not just a trademark check. Folded into the
  existing "open product decisions" issue.
- Tagline (landing hero): "Your constituency. Your voice. On the record."
- Standing disclaimer (footer of every screen, EN):
  > Praja is an independent civic platform. It is not affiliated with any
  > government body or political party.
- Logo mark: a custom 24-spoke wheel — three concentric elements (outer
  ring, dashed spoke ring, center dot), drawn as plain strokes, **not** a
  reproduction of the State Emblem/Ashoka Chakra. This distinction is
  explicit in the design file's own annotation and must be preserved by
  whoever implements the real SVG — don't "complete" it into a chakra.

## Color tokens

| Token | Hex | Use |
|---|---|---|
| Chakra Navy | `#1A2E5C` | Primary/dominant. Headers, primary buttons, links, headings |
| Navy (pressed) | `#111F42` | Button pressed state |
| Saffron | `#E8862D` | Accent — "in progress" states, tricolour accent line. Never appears without green nearby |
| India Green | `#1E7A46` | Accent — verified/success/acted-upon states |
| Warm Ivory | `#FAF9F6` | Page background |
| Charcoal | `#22262B` | Primary text |
| Muted | `#6B7180` | Secondary/caption text |
| Disabled | `#C9CCD4` | Disabled button fill |
| Card border | `#E0DCD2` | 1px borders on white cards over the ivory background |
| Card fill | `#FFFFFF` | Card backgrounds |

Derived semantic colors used in status chips/badges (icon + label always,
never color alone — this is also CLAUDE.md product law, not just a design
preference):

| State | Text | Fill | Border | Dot/icon |
|---|---|---|---|---|
| Delivered | `#1A2E5C` | transparent | `#C4CADB` | hollow navy ring |
| Acknowledged | `#8A5314` | `#FBF0E2` | `#EBCFA8` | saffron `→` |
| Acted upon / Verified | `#175E37` | `#EAF3EE` | `#BDD9C9` | green `✓` |
| No response | `#565B64` | `#F0EEE8` | `#D8D4C9` | muted `–` |

**Balance rule** (from the design file verbatim): *"Saffron never appears
without green nearby. Navy is the dominant. Tricolour appears only as a
3px accent line"* — a horizontal gradient bar (saffron 0–33.3%, white
33.3–66.6%, green 66.6–100%) used as a hairline divider under every header,
never as a solid tricolour block or background.

## Typography

- **Display/headings (English):** Source Serif 4, 700 weight. 28px display, 20px heading.
- **Headings (Malayalam):** Noto Serif Malayalam, 600–700 weight.
- **Body/UI (English):** Public Sans, 400/500/600/700.
- **Body/UI (Malayalam):** Noto Sans Malayalam, 400–700.
- **Section label:** Public Sans 15px/600.
- **Body copy:** Public Sans 14px/400, line-height ~1.55. House style, stated
  directly in the design file: *"plain, respectful, non-inflammatory. Facts
  over adjectives."* — this is a content/tone rule as much as a type rule.
- **Caption:** 12px/400, muted color.
- **Numerals:** `font-variant-numeric: tabular-nums` on every stat/count so
  numbers don't jitter (vote counts, percentages, day counters).
- Bilingual pairing: English and Malayalam are set in matching weights side
  by side (e.g. "Praja · പ്രജ"), never Malayalam as a smaller afterthought.

## Components

- **Buttons:** Primary (navy fill, white text, 8px radius), Pressed (darker
  navy `#111F42`), Disabled (`#C9CCD4` fill), Secondary (navy outline,
  transparent fill), Tertiary (text link with a saffron underline).
- **Badges (identity):** pill-shaped, icon-in-circle + label.
  - T1: "Verified Citizen" — navy outline, navy check-circle.
  - T2: "Verified Constituent — {ward}" — green fill (`#EAF3EE`/`#BDD9C9`/`#175E37`), green check-circle. Always includes the ward name.
- **Status chips:** rectangular (6px radius, not pill), icon + label per the
  semantic table above. This shape distinguishes them from identity badges.
- **Cards:** white fill, `#E0DCD2` 1px border, 12px radius, on the ivory page background.
- **Progress/quorum bars:** 8–9px tall, 4–5px radius, muted track (`#ECE9E1`), navy or green fill depending on context.
- **Timeline/tracker stepper:** vertical, filled circle + connecting line for completed steps, hollow outline circle for pending steps (matches E3's Delivered→Acknowledged→Action reported→Closed states).
- **Sentiment bar chart:** monthly bars, color intensity ramps from muted (`#C4CADB`) to navy (`#1A2E5C`) as the trend improves — never a single composite number, always paired with an `n = ` sample-size caption.

## Canonical copy patterns (treat like status strings — copy exactly)

- Panel member pseudonymous ID format: `Constituent {Ward-initial}-{3 digits}` e.g. `Constituent K-417`.
- Model bill ID format: `MB-{YYYY}-{NN}` e.g. `MB-2026-03`.
- RTI reference format (authority-issued, shown once filed): `{AUTHORITY-CODE}/RTI/{YYYY}/{NNNN}` e.g. `KMC/RTI/2026/1108`.
- Issue ID format: `{DISTRICT-CODE}-{NNNN}` e.g. `EKM-0412`.
- "Copied for information only" is always rendered visually distinct from "responsible" (per B2's AC) — in the design this is a plain-text caption next to the chip, not a second badge style.

## Bilingual/i18n note

Every screen in the package has a full Malayalam variant available (the
package includes `mobile/dashboard-ml.dc.html` as the reference), confirming
the CLAUDE.md i18n rule (every string in both `ml.json` and `en.json`) is
achievable at the design layer — the Malayalam variant is not a cut-down
version, it carries the same content density as English.
