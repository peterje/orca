---
agent: opencode
agent-args:
agent-timeout-minutes: 45
base-branch: main
branch-prefix: orca
cleanup-worktree-on-success: true
draft-pr: true
greptile-poll-interval-seconds: 30
linear-label: Orca
linear-workspace: peteredm
max-waiting-pull-requests: 4
repo: peterje/orca
setup:
  - bun install
stall-timeout-minutes: 10
verify:
  - bun run check
  - bun run test
  - bun run build
---

You are working on the current Orca issue in this repository.

- implement the selected issue end-to-end
- keep changes focused on the selected work
- run the configured verification commands before handing off
- avoid mutating unrelated git state
