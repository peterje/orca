import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunner } from "./agent-runner.ts"
import { GitHub, type PullRequestFeedback } from "./github.ts"
import { Linear, type LinearIssue } from "./linear.ts"
import { PromptGen } from "./prompt-gen.ts"
import { PullRequestStore, OrcaManagedPullRequest } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigData } from "./repo-config.ts"
import { Runner, RunnerLayer } from "./runner.ts"
import { RunState, RunStateBusyError, type ActiveRun } from "./run-state.ts"
import { Verifier } from "./verifier.ts"
import { Worktree, type ManagedWorktree } from "./worktree.ts"

const testFileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
  exists: (path: string) => Effect.sync(() => existsSync(path)),
  makeDirectory: (path: string, options?: { readonly recursive?: boolean | undefined }) =>
    Effect.sync(() => {
      mkdirSync(path, { recursive: options?.recursive ?? false })
    }),
  readFileString: (path: string) => Effect.sync(() => readFileSync(path, "utf8")),
  writeFileString: (path: string, data: string) =>
    Effect.sync(() => {
      writeFileSync(path, data)
    }),
} as unknown as FileSystem.FileSystem)

describe("Runner", () => {
  it.effect("requests Greptile review and records the waiting state for new pull requests", () => {
    const createdPullRequests: Array<{
      readonly baseBranch: string
      readonly body: string
      readonly cwd: string
      readonly draft: boolean
      readonly repo: string
      readonly title: string
    }> = []
    const requestedReviews: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []
    const storedPullRequests: Array<{
      readonly branch: string
      readonly issueDescription: string
      readonly issueId: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly prNumber: number
      readonly prUrl: string
      readonly repo: string
      readonly waitingForGreptileReviewSinceMs?: number | null | undefined
    }> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-1",
          mode: "implementation",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(createdPullRequests).toEqual([
          {
            baseBranch: "main",
            body: [
              "this pr brings example issue into the repo so the requested behavior is ready for review.",
              "",
              "### changes",
              "#### 1. deliver example issue",
              "this keeps the branch focused on the requested outcome and ready for the usual review flow.",
              "",
              "### verification",
              "- `bun run check`",
              "",
              "closes ENG-1",
            ].join("\n"),
            cwd: worktreeDirectory,
            draft: true,
            repo: "peterje/orca",
            title: "feat: example issue",
          },
        ])
        expect(requestedReviews).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(storedPullRequests).toHaveLength(1)
        expect(storedPullRequests[0]).toMatchObject({
          issueIdentifier: "ENG-1",
          prNumber: 42,
          repo: "peterje/orca",
        })
        expect(typeof storedPullRequests[0]?.waitingForGreptileReviewSinceMs).toBe("number")
        expect(readFileSync(join(worktreeDirectory, ".orca/issue.md"), "utf8")).toContain("Identifier: ENG-1")
      }).pipe(Effect.provide(makeRunnerLayer({ createdPullRequests, requestedReviews, storedPullRequests, worktreeDirectory })))
    })
  })

  it.effect("selects the next untracked implementation while Greptile reviews are still pending", () =>
    withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner
        const next = yield* runner.peekNext

        expect(Option.getOrNull(next)).toMatchObject({
          id: "issue-2",
          issueIdentifier: "ENG-2",
          kind: "implementation",
        })
      }).pipe(Effect.provide(makeRunnerLayer({
        issues: [
          issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Existing work" }),
          issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, title: "Next work" }),
        ],
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            number: 42,
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            prNumber: 42,
            prUrl: "https://github.com/peterje/orca/pull/42",
            waitingForGreptileReviewSinceMs: 1,
          }),
        ],
        worktreeDirectory: join(tempDirectory, "worktree"),
      }))),
    ))

  it.effect("pauses new implementation work when waiting pull requests reach the cap", () =>
    withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner
        const next = yield* runner.peekNext

        expect(next).toEqual(Option.none())
      }).pipe(Effect.provide(makeRunnerLayer({
        issues: [issue({ id: "issue-5", identifier: "ENG-5", isOrcaTagged: true, title: "Blocked by cap" })],
        pullRequestFeedbackByKey: {
          "peterje/orca#41": pullRequestFeedback({ number: 41, url: "https://github.com/peterje/orca/pull/41" }),
          "peterje/orca#42": pullRequestFeedback({ number: 42, url: "https://github.com/peterje/orca/pull/42" }),
          "peterje/orca#43": pullRequestFeedback({ number: 43, url: "https://github.com/peterje/orca/pull/43" }),
          "peterje/orca#44": pullRequestFeedback({ number: 44, url: "https://github.com/peterje/orca/pull/44" }),
        },
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            prNumber: 41,
            prUrl: "https://github.com/peterje/orca/pull/41",
            waitingForGreptileReviewSinceMs: 1,
          }),
          trackedPullRequest({
            issueId: "issue-2",
            issueIdentifier: "ENG-2",
            prNumber: 42,
            prUrl: "https://github.com/peterje/orca/pull/42",
            waitingForGreptileReviewSinceMs: 2,
          }),
          trackedPullRequest({
            issueId: "issue-3",
            issueIdentifier: "ENG-3",
            prNumber: 43,
            prUrl: "https://github.com/peterje/orca/pull/43",
            waitingForGreptileReviewSinceMs: 3,
          }),
          trackedPullRequest({
            issueId: "issue-4",
            issueIdentifier: "ENG-4",
            prNumber: 44,
            prUrl: "https://github.com/peterje/orca/pull/44",
            waitingForGreptileReviewSinceMs: 4,
          }),
        ],
        worktreeDirectory: join(tempDirectory, "worktree"),
      }))),
    ))

  it.effect("prioritizes actionable review work ahead of new implementation work", () =>
    withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner
        const next = yield* runner.peekNext

        expect(Option.getOrNull(next)).toMatchObject({
          id: "peterje/orca#42",
          issueIdentifier: "ENG-1",
          kind: "review",
          pullRequestNumber: 42,
        })
      }).pipe(Effect.provide(makeRunnerLayer({
        issues: [issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, title: "New work" })],
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            comments: [
              {
                authorLogin: "reviewer",
                body: "Please rename this helper before merge.",
                createdAtMs: 10,
                id: "comment-1",
                isBot: false,
              },
            ],
            number: 42,
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            prNumber: 42,
            prUrl: "https://github.com/peterje/orca/pull/42",
            waitingForGreptileReviewSinceMs: 1,
          }),
        ],
        worktreeDirectory: join(tempDirectory, "worktree"),
      }))),
    ))

  it.effect("allows only one active coding run at a time", () =>
    withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner
        const error = yield* runner.runNext.pipe(Effect.flip)

        expect(error).toBeInstanceOf(RunStateBusyError)
      }).pipe(Effect.provide(makeRunnerLayer({
        runStateAcquire: () => Effect.fail(new RunStateBusyError({ message: "An Orca run is already active." })),
        worktreeDirectory: join(tempDirectory, "worktree"),
      }))),
    ))
})

const makeRunnerLayer = (options: {
  readonly createdPullRequests?: Array<{
    readonly baseBranch: string
    readonly body: string
    readonly cwd: string
    readonly draft: boolean
    readonly repo: string
    readonly title: string
  }>
  readonly issues?: ReadonlyArray<LinearIssue>
  readonly pullRequestFeedbackByKey?: Readonly<Record<string, PullRequestFeedback>>
  readonly requestedReviews?: Array<{ readonly pullRequestNumber: number; readonly repo: string }>
  readonly runStateAcquire?: (
    run: Omit<typeof ActiveRun.Type, "pid" | "prNumber" | "prUrl" | "startedAtMs">,
  ) => Effect.Effect<ActiveRun, RunStateBusyError>
  readonly storedPullRequests?: Array<{
    readonly branch: string
    readonly issueDescription: string
    readonly issueId: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly prNumber: number
    readonly prUrl: string
    readonly repo: string
    readonly waitingForGreptileReviewSinceMs?: number | null | undefined
  }>
  readonly trackedPullRequests?: ReadonlyArray<OrcaManagedPullRequest>
  readonly worktreeDirectory: string
}) => {
  const worktree = makeManagedWorktree(options.worktreeDirectory)
  const createdPullRequests = options.createdPullRequests ?? []
  const requestedReviews = options.requestedReviews ?? []
  const storedPullRequests = options.storedPullRequests ?? []
  const trackedPullRequests = options.trackedPullRequests ?? []
  let activeRun: ActiveRun | null = null

  return RunnerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        testFileSystemLayer,
        Layer.succeed(
          AgentRunner,
          AgentRunner.of({
            run: () => Effect.void,
          }),
        ),
        Layer.succeed(
          GitHub,
          GitHub.of({
            createPullRequest: (request) =>
              Effect.sync(() => {
                createdPullRequests.push(request)
                return {
                  isDraft: true,
                  number: 42,
                  state: "OPEN",
                  url: "https://github.com/peterje/orca/pull/42",
                }
              }),
            detectRepo: Effect.die("not used in this test"),
            readPullRequestFeedback: (request) =>
              Effect.succeed(
                options.pullRequestFeedbackByKey?.[makePullRequestKey(request)]
                ?? pullRequestFeedback({
                  number: request.pullRequestNumber,
                  url: `https://github.com/${request.repo}/pull/${request.pullRequestNumber}`,
                }),
              ),
            removePullRequestLabel: () => Effect.die("not used in this test"),
            requestPullRequestReview: (request) =>
              Effect.sync(() => {
                requestedReviews.push(request)
              }),
            viewCurrentPullRequest: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.succeed(
          Linear,
          Linear.of({
            authenticate: Effect.die("not used in this test"),
            commentOnIssue: () => Effect.void,
            issues: Effect.succeed(
              options.issues ?? [issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Example issue" })],
            ),
            markIssueInProgress: () => Effect.void,
            viewer: Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          PromptGen,
          PromptGen.of({
            buildImplementationPrompt: () =>
              Effect.succeed({
                prompt: "Implement the issue.",
                promptFileContents: "# Linear issue\n\nIdentifier: ENG-1\n",
              }),
            buildReviewPrompt: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          PullRequestStore,
          PullRequestStore.of({
            list: Effect.succeed(trackedPullRequests),
            markReviewHandled: () => Effect.die("not used in this test"),
            upsert: (record) =>
              Effect.sync(() => {
                storedPullRequests.push(record)
                return new OrcaManagedPullRequest({
                  branch: record.branch,
                  createdAtMs: 1,
                  issueDescription: record.issueDescription,
                  issueId: record.issueId,
                  issueIdentifier: record.issueIdentifier,
                  issueTitle: record.issueTitle,
                  lastReviewedAtMs: null,
                  prNumber: record.prNumber,
                  prUrl: record.prUrl,
                  repo: record.repo,
                  updatedAtMs: 1,
                  waitingForGreptileReviewSinceMs: record.waitingForGreptileReviewSinceMs ?? null,
                })
              }),
          }),
        ),
        Layer.succeed(
          RepoConfig,
          RepoConfig.of({
            bootstrap: () => Effect.die("not used in this test"),
            configPath: Effect.die("not used in this test"),
            exists: Effect.die("not used in this test"),
            read: Effect.succeed(new RepoConfigData({
              agent: "opencode",
              agentArgs: [],
              agentTimeoutMinutes: 45,
              baseBranch: "main",
              branchPrefix: "orca",
              cleanupWorktreeOnSuccess: false,
              draftPr: true,
              greptilePollIntervalSeconds: 30,
              linearLabel: "Orca",
              maxWaitingPullRequests: 4,
              repo: "peterje/orca",
              setup: ["bun install"],
              stallTimeoutMinutes: 10,
              verify: ["bun run check"],
            })),
            readOption: Effect.die("not used in this test"),
            write: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          RunState,
          RunState.of({
            acquire: options.runStateAcquire ?? ((run) => Effect.sync(() => {
              activeRun = {
                ...run,
                pid: process.pid,
                prNumber: null,
                prUrl: null,
                startedAtMs: 1,
              } as ActiveRun
              return activeRun
            })),
            clear: Effect.void,
            current: Effect.sync(() => activeRun),
            update: (patch) =>
              Effect.sync(() => {
                if (activeRun === null) {
                  return null
                }
                activeRun = {
                  ...activeRun,
                  prNumber: patch.prNumber ?? activeRun.prNumber,
                  prUrl: patch.prUrl ?? activeRun.prUrl,
                  stage: patch.stage ?? activeRun.stage,
                } as ActiveRun
                return activeRun
              }),
          }),
        ),
        Layer.succeed(
          Verifier,
          Verifier.of({
            run: () => Effect.succeed([]),
          }),
        ),
        Layer.succeed(
          Worktree,
          Worktree.of({
            create: () => Effect.succeed(worktree),
            resume: () => Effect.die("not used in this test"),
          }),
        ),
      ),
    ),
  )
}

const trackedPullRequest = (overrides: Partial<typeof OrcaManagedPullRequest.Type> & Pick<typeof OrcaManagedPullRequest.Type, "issueId" | "issueIdentifier" | "prNumber" | "prUrl">) =>
  new OrcaManagedPullRequest({
    branch: overrides.branch ?? `orca/${overrides.issueIdentifier.toLowerCase()}`,
    createdAtMs: overrides.createdAtMs ?? 1,
    issueDescription: overrides.issueDescription ?? "Example issue description",
    issueId: overrides.issueId,
    issueIdentifier: overrides.issueIdentifier,
    issueTitle: overrides.issueTitle ?? "Example issue",
    lastReviewedAtMs: overrides.lastReviewedAtMs ?? null,
    prNumber: overrides.prNumber,
    prUrl: overrides.prUrl,
    repo: overrides.repo ?? "peterje/orca",
    updatedAtMs: overrides.updatedAtMs ?? 1,
    waitingForGreptileReviewSinceMs: overrides.waitingForGreptileReviewSinceMs ?? null,
  })

const pullRequestFeedback = (overrides?: Partial<PullRequestFeedback>): PullRequestFeedback => ({
  authorLogin: overrides?.authorLogin ?? "author",
  comments: overrides?.comments ?? [],
  isDraft: overrides?.isDraft ?? true,
  labels: overrides?.labels ?? [],
  number: overrides?.number ?? 1,
  reviewThreads: overrides?.reviewThreads ?? [],
  reviews: overrides?.reviews ?? [],
  state: overrides?.state ?? "OPEN",
  url: overrides?.url ?? "https://github.com/peterje/orca/pull/1",
})

const makePullRequestKey = (pullRequest: { readonly prNumber?: number; readonly pullRequestNumber?: number; readonly repo: string }) =>
  `${pullRequest.repo}#${pullRequest.prNumber ?? pullRequest.pullRequestNumber}`

const makeManagedWorktree = (directory: string): ManagedWorktree => ({
  branch: "orca/eng-1-example-issue",
  directory,
  remove: Effect.void,
  run: () => Effect.succeed(0),
  runString: (command) => {
    if (command === "git status --porcelain --untracked-files=all") {
      return Effect.succeed(" M apps/cli/src/runner.ts\n")
    }
    if (command.startsWith("git rev-list --count ")) {
      return Effect.succeed("0\n")
    }
    return Effect.die(`Unexpected command: ${command}`)
  },
})

const issue = (overrides: Partial<LinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title">): LinearIssue => ({
  blockedBy: overrides.blockedBy ?? [],
  childIds: overrides.childIds ?? [],
  createdAtMs: overrides.createdAtMs ?? Date.parse("2026-01-01T00:00:00.000Z"),
  description: overrides.description ?? "Example issue description",
  id: overrides.id,
  identifier: overrides.identifier,
  isOrcaTagged: overrides.isOrcaTagged ?? false,
  labels: overrides.labels ?? ["Orca"],
  parentId: overrides.parentId ?? null,
  priority: overrides.priority ?? 0,
  stateId: overrides.stateId ?? `${overrides.id}-state`,
  stateName: overrides.stateName ?? "Unstarted",
  state: overrides.state ?? "unstarted",
  teamStates: overrides.teamStates ?? [],
  title: overrides.title,
})

const withTempDirectory = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "orca-runner-"))),
    (tempDirectory) =>
      Effect.sync(() => {
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(use))
