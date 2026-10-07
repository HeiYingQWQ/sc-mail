## What changed

<!-- Describe the user-visible or operational behavior and why it is needed. -->

## Validation

<!-- List the commands actually run and their results. Mark checks that were not run. -->

- [ ] Relevant automated checks passed
- [ ] Documentation matches the implemented and verified behavior
- [ ] No credentials, production data, or untrusted email instructions were added

## Merge gates

<!-- Follow AGENTS.md. Record the exact latest head SHA, CI link, independent reviewer/tool and review result, and acceptance evidence. Recheck all gates after new commits. Author self-checks are not an independent review. -->

- Head SHA:
- Independent review and evidence:
- Acceptance scope and evidence:
- [ ] CI succeeded for this latest head
- [ ] Independent review passed for this latest head; blocking findings resolved
- [ ] Necessary acceptance for the change completed; unverified external behavior stated

Push all changes through feature/* or fix/*; keep failed or unreviewed work on the branch. Merge only after every gate passes, using squash merge. Local hooks do not replace server protection. Current repository protection limits are documented in AGENTS.md.

## Data and rollout

<!-- Describe schema/migration, compatibility, backup, and deployment needs. Write “none” when not applicable. -->

## Remaining gaps

<!-- State any unverified behavior or follow-up work; do not describe it as complete. -->
