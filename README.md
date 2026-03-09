# Orca

<p align="center">
  <img src="./docs/orca-mark.svg" alt="Orca navigating work from Linear to GitHub" width="640" />
</p>

Orca is a Bun + Effect CLI that plans software work from Linear, expands blockers into the queue, and can execute the next actionable issue in an isolated git worktree.

## Getting started

### Prerequisites

- [Bun](https://bun.sh/)
- [`gh`](https://cli.github.com/) authenticated for the repo you want Orca to open pull requests against
- A Linear workspace you can authenticate against
- [`weave`](https://github.com/Ataraxy-Labs/weave) installed locally so Orca can sync tracked pull requests with the base branch before falling back to manual merge-conflict resolution

### Install dependencies

```bash
bun install
```

### Bootstrap Orca in a repo

```bash
bun run orca init --repo owner/name
```

This creates repo-local Orca config in `./.orca/repo.json` and infers verification commands from `package.json`.

Before Orca starts maintaining tracked pull requests, configure the repo-local weave merge driver:

```bash
weave setup
```

Orca expects weave to be available in the repo and will use it when syncing tracked pull request branches with the base branch.

### Authenticate with Linear

```bash
bun run orca linear auth
```

Orca starts a local OAuth callback server on `http://localhost:34338/callback`, prints an auth URL, and stores the session under `./.orca/`.

### Inspect the queue

```bash
bun run orca issues list
```

The planner includes:

- issues tagged with `Orca`
- incomplete blockers of tagged issues
- incomplete child issues needed to unblock tagged work

It prints actionable work, blocked work, and a dependency graph.

### Run Orca in planning mode

```bash
bun run orca serve
```

This polls Linear every 30 seconds and prints a mission-control snapshot with the current stage, the next item up, and the queue state.

### Inspect mission control once

```bash
bun run orca status
```

This prints the same high-level snapshot once without starting the polling loop.

### Execute work

Run one issue once:

```bash
bun run orca run next
```

Or continuously execute the top actionable issue:

```bash
bun run orca serve --execute
```

In execution mode, Orca fetches the latest `origin/<base-branch>`, creates a git worktree under `./.orca/worktrees/` from that remote base to reduce avoidable merge conflicts, runs the configured verification commands, pushes a branch, and opens a draft pull request.

## Command guide

- `bun run orca init` - create or update repo-local Orca config
- `bun run orca linear auth` - authenticate with Linear via OAuth PKCE
- `bun run orca issues list` - show actionable and blocked Orca work
- `bun run orca status` - show the current mission-control snapshot
- `bun run orca serve` - poll Linear and keep the mission-control snapshot updated
- `bun run orca run next` - execute the top actionable issue once

You can also build the standalone CLI binary with:

```bash
bun run build
```

## Development

Verify the repo with:

```bash
bun run check
bun run test
bun run build
```

## How Orca decides what to work on

Orca starts from Linear issues tagged with `Orca`, recursively pulls in incomplete blockers and child issues, then sorts actionable work by effective priority and creation time. Direct Orca issues use their own priority; inherited blockers use the most urgent priority of the Orca-tagged issue they unblock.
