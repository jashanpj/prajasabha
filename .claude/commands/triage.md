---
description: Propose labels, milestone, and duplicate flags for new unlabeled issues, for the maintainer's approval.
---
Run `gh issue list --search "no:label" --state open --json number,title,body`
to find untriaged issues.

For each issue:
1. Propose a `module:A`…`module:L` label and a `type:story|bug|chore|spike`
   label based on its content.
2. Propose a milestone (M0–M7) if the body/context makes one clear.
3. Search existing issues for likely duplicates and flag them.
4. Flag `good-first-issue` if it looks self-contained and low-risk; flag
   `needs-design` if it depends on an unresolved UX decision.

Present all proposals as a single table. Do not run `gh issue edit` on
anything until I approve the batch.
