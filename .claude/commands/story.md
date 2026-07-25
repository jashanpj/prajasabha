---
description: Load a GitHub issue, enter plan mode, and propose an implementation + test plan derived from its acceptance criteria.
---
Run `gh issue view $ARGUMENTS --json title,body,labels,milestone` and read the issue.

Enter plan mode. Propose:
1. An implementation plan broken into the smallest reviewable steps.
2. The list of tests to write first (derived directly from the issue's
   Acceptance Criteria field), before any implementation — delegate this to
   the test-writer agent once the plan is approved.

Cross-check the plan against CLAUDE.md's invariants and flag anything in the
issue that conflicts with them before proposing a plan around it.

Do not begin implementation until the plan is approved.
