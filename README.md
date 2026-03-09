# Orca

<p align="center">
  <svg width="360" height="180" viewBox="0 0 360 180" role="img" aria-labelledby="orca-title orca-desc" xmlns="http://www.w3.org/2000/svg">
    <title id="orca-title">Orca</title>
    <desc id="orca-desc">A stylized ship riding over teal waves.</desc>
    <defs>
      <linearGradient id="orca-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f4fbff" />
        <stop offset="100%" stop-color="#dff6fb" />
      </linearGradient>
      <linearGradient id="orca-sea" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#127c8a" />
        <stop offset="100%" stop-color="#26b5ce" />
      </linearGradient>
      <linearGradient id="orca-hull" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#123d52" />
        <stop offset="100%" stop-color="#0d2330" />
      </linearGradient>
    </defs>
    <rect width="360" height="180" rx="24" fill="url(#orca-sky)" />
    <circle cx="285" cy="46" r="18" fill="#fff6c2" />
    <path d="M28 126C52 113 72 113 96 126C120 139 140 139 164 126C188 113 208 113 232 126C256 139 276 139 300 126C320 115 334 114 348 120V180H28Z" fill="url(#orca-sea)" opacity="0.95" />
    <path d="M78 119L121 92H208L243 119H78Z" fill="url(#orca-hull)" />
    <path d="M130 89V58L172 89Z" fill="#26b5ce" />
    <rect x="157" y="51" width="6" height="42" rx="3" fill="#123d52" />
    <rect x="185" y="72" width="20" height="10" rx="3" fill="#dff6fb" opacity="0.9" />
    <rect x="209" y="72" width="20" height="10" rx="3" fill="#dff6fb" opacity="0.7" />
    <path d="M94 133C111 126 126 126 143 133" stroke="#dff6fb" stroke-width="4" stroke-linecap="round" fill="none" />
    <path d="M175 139C193 131 209 131 227 139" stroke="#dff6fb" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.9" />
    <text x="30" y="40" fill="#123d52" font-size="24" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="700">orca</text>
    <text x="30" y="62" fill="#127c8a" font-size="11" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">linear-first autonomous software work</text>
  </svg>
</p>

Orca is a Bun + Effect CLI that pulls work from Linear, explains why a ticket is actionable, and can spin up an agent-driven execution loop for the next issue in the queue.

## What it does

- Authenticates with Linear using OAuth PKCE.
- Finds issues tagged for Orca and recursively includes blockers needed to unblock them.
- Shows actionable work, blocked work, and the dependency graph behind the queue.
- Polls Linear on an interval to report what Orca would implement next.
- Can create a worktree, run an agent, verify the result, and open a draft PR.

## Getting started

### Prerequisites

- `bun` 1.3+
- `gh` authenticated for the target repo
- `opencode` or `codex` if you want Orca to execute work
- Access to the Linear workspace you want to plan from

### Install dependencies

```sh
bun install
```

### Explore the CLI

```sh
bun run orca --help
```

### Initialize Orca in a repo

Run this in the repository Orca should manage:

```sh
bun run orca init --repo owner/name
```

This writes repo-local state under `./.orca/`, including config, cached settings, and active run state.

### Authenticate with Linear

```sh
bun run orca linear auth
```

Orca starts a local callback server on `http://localhost:34338/callback`. If you need to override the bundled Linear OAuth client, set `LINEAR_CLIENT_ID` before running auth.

### Inspect the queue

```sh
bun run orca issues list
```

### Start the planner loop

```sh
bun run orca serve
```

### Execute one issue

```sh
bun run orca run next
```

Or continuously execute the top actionable issue:

```sh
bun run orca serve --execute
```

## Development

```sh
bun run check
bun run test
bun run build
```

The built binary is written to `dist/orca`.
