# Orca PRD

## Overview

Orca is a Bun + Effect CLI for orchestrating autonomous software work from Linear.

This first version is intentionally minimal. Orca will:

- authenticate with Linear
- find tickets tagged `Orca`
- determine which tickets Orca would work on next
- expose that queue through a CLI
- run a polling server loop that prints the current ticket Orca would implement

Orca does not yet provision environments, run agents, edit code, or update tickets.

## Goals

- Build a reliable Linear-first task selection engine
- Follow the architecture style and Effect best practices used in `lalph`
- Use Bun as the package manager and runtime
- Keep the first implementation small, inspectable, and easy to extend with agent execution later

## Non-Goals

- Support issue sources other than Linear
- Provision local or remote development environments
- Execute OpenCode or any other coding agent
- Mutate ticket state in Linear
- Support multiple orchestration backends

## Primary User Flow

1. User authenticates Orca with Linear
2. User tags one or more Linear tickets with `Orca`
3. User runs `orca issues list` to see the queue Orca would work
4. User runs `orca serve` to start a polling loop
5. Orca periodically recomputes the queue and prints the ticket it would implement next

## Product Requirements

### 1. Linear Authentication

Orca must support authenticating with Linear via OAuth PKCE.

Requirements:

- Provide a command: `orca linear auth`
- Store access and refresh tokens locally in Orca-managed config storage
- Refresh expired tokens automatically
- Reuse a valid stored token without re-authentication

Notes:

- Follow the general approach used in `lalph`'s Linear token manager
- Local persistence should live under `./.orca/` in the working repository or current directory

### 2. Identify Orca Work

Orca work is defined as Linear issues tagged with the label `Orca`.

Requirements:

- Query Linear for issues relevant to Orca
- Include incomplete issues that are direct Orca work items
- If an Orca-tagged issue is blocked by another incomplete issue, include the blocking issue even if it is not tagged `Orca`
- Ignore completed and canceled issues for queue selection

### 3. Ticket Ordering Rules

`orca issues list` and `orca serve` must use the same planning logic.

Base ordering rules:

- first sort by priority, with more urgent issues first
- then sort by creation date, most recent first

Blocker-aware rule:

- Orca can only work on tickets with no incomplete blockers
- if a high-priority Orca-tagged ticket is blocked, Orca should work on the blocking tickets first
- untagged blockers inherited from an Orca-tagged ticket are valid Orca work

Planner behavior:

- start from all issues tagged `Orca`
- recursively walk incomplete blockers
- build a work set containing tagged issues and required blockers
- determine which issues are actionable now
- order actionable work by effective priority, then creation date descending

Effective priority:

- a directly tagged issue uses its own priority
- a blocker inherits the most urgent priority of the Orca-tagged issue(s) it unblocks

### 4. `orca issues list`

This command shows the current Orca work queue.

Requirements:

- Provide a command: `orca issues list`
- Print the issues Orca would complete
- Separate output into at least:
  - actionable issues
  - blocked issues
- For blocked issues, show which issues are blocking them
- For inherited blockers, indicate that they are included because they unblock Orca-tagged work

Example intent:

- users should be able to inspect why a given ticket is or is not currently runnable

### 5. `orca serve`

This command starts the Orca server loop.

Requirements:

- Provide a command: `orca serve`
- Poll Linear on a fixed interval
- Recompute the Orca queue on every poll
- Print the ticket Orca would implement next
- If no actionable work exists, print that no work is currently available
- Do not execute any implementation yet
- Do not mutate Linear yet

Initial behavior example:

- `Would implement: ENG-123 Improve issue planner logging`

### 6. Implementation Style

Requirements:

- Use Bun as runtime and package manager
- Use Effect for service composition, configuration, errors, and command handlers
- Follow `lalph` conventions where reasonable, especially for:
  - CLI structure
  - service layers
  - persisted settings/token management
  - Linear integration patterns

## Technical Direction

## Repo Layout

Orca currently contains a `web/` app. The new CLI should be added without disturbing that app.

Planned layout:

```text
orca/
  PRD.md
  package.json
  bun.lock
  tsconfig.json
  apps/
    cli/
      package.json
      src/
        cli.ts
        commands/
          linear.ts
          issues.ts
          serve.ts
        Linear.ts
        Linear/
          TokenManager.ts
        IssuePlanner.ts
        Settings.ts
        Kvs.ts
        shared/
          platform.ts
  web/
```

## Core Modules

### Linear Client

Responsible for:

- token access
- token refresh
- GraphQL queries
- decoding Linear responses into Effect schemas

### Issue Planner

Responsible for:

- expanding the Orca-tagged issue set through blockers
- computing actionable vs blocked issues
- deriving effective priority for inherited blockers
- sorting output deterministically

### CLI Commands

Responsible for:

- `orca linear auth`
- `orca issues list`
- `orca serve`

## Data Model

The minimal internal issue model should include:

- `id`
- `identifier`
- `title`
- `priority`
- `createdAt`
- `state`
- `labels`
- `blockedBy`
- `isOrcaTagged`
- `inheritedFrom`

## Polling Behavior

Initial default polling interval: 30 seconds.

The loop should:

1. fetch the current issue graph from Linear
2. compute the Orca plan
3. print the top actionable issue, if any
4. sleep and repeat

This should mirror the shape of `lalph`'s serve loop, but without worker execution.

## Success Criteria

Orca v0 is successful when:

- a user can authenticate with Linear once
- `orca issues list` reliably shows the blocker-aware Orca queue
- `orca serve` continuously prints the issue Orca would take next
- the queue logic is deterministic and easy to test

## Open Questions

- Should the `Orca` label match be case-sensitive or case-insensitive?
- Should Orca require tickets to be assigned to the authenticated Linear user, or consider all tickets in scope?
- Which Linear workflow states count as actionable for v1 beyond standard unstarted/started/completed/canceled categories?
- Should `orca serve` suppress duplicate output if the top ticket has not changed since the previous poll?

## Recommended Defaults

- label matching: case-insensitive on label name, exact match on `Orca`
- assignment filter: no assignee restriction for v1
- duplicate serve output: only print when the selected top ticket changes, plus periodic heartbeat when no work exists
