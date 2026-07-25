---
description: Run tests, commit with Conventional Commits, push, and open a PR with the invariants/i18n checklist filled in.
---
1. Run the full test suite and linters/type-check. Stop and report if
   anything fails — do not open a PR on a red build.
2. Run the security-reviewer, schema-guard (if packages/db or
   packages/vault-db changed), and i18n-auditor (if any UI changed) agents.
   Resolve or explicitly justify any FAIL before continuing.
3. Stage only the files relevant to this issue — never a blanket `git add -A`.
4. Commit using Conventional Commits (`feat|fix|chore|docs(<module scope>):
   <summary>`), referencing "Closes #<issue>" if this branch was created for
   an issue.
5. Push the current branch.
6. Open a PR with `gh pr create` using the repo's PR template, filling in the
   Acceptance Criteria checklist, the CLAUDE.md invariants checklist, and
   confirming ml.json/en.json key parity.
7. Report the PR URL.
