import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunner } from "./agent-runner.ts"
import { GitHub } from "./github.ts"
import { Linear, type LinearIssue } from "./linear.ts"
import { PromptGen } from "./prompt-gen.ts"
import { PullRequestStore, OrcaManagedPullRequest } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigData } from "./repo-config.ts"
import { Runner, RunnerLayer } from "./runner.ts"
import { RunState, type ActiveRun } from "./run-state.ts"
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
              "this pr implements ENG-1 by addressing example issue, so the requested change is ready for review in orca's normal flow.",
              "",
              "### changes",
              "#### 1. deliver the requested issue work",
              "this update delivers the requested behavior while keeping the branch aligned with the repository's automation and review expectations.",
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
})

const makeRunnerLayer = (options: {
  readonly createdPullRequests: Array<{
    readonly baseBranch: string
    readonly body: string
    readonly cwd: string
    readonly draft: boolean
    readonly repo: string
    readonly title: string
  }>
  readonly requestedReviews: Array<{ readonly pullRequestNumber: number; readonly repo: string }>
  readonly storedPullRequests: Array<{
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
  readonly worktreeDirectory: string
}) => {
  const worktree = makeManagedWorktree(options.worktreeDirectory)

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
                options.createdPullRequests.push(request)
                return {
                  isDraft: true,
                  number: 42,
                  state: "OPEN",
                  url: "https://github.com/peterje/orca/pull/42",
                }
              }),
            detectRepo: Effect.die("not used in this test"),
            readPullRequestFeedback: () => Effect.die("not used in this test"),
            removePullRequestLabel: () => Effect.die("not used in this test"),
            requestPullRequestReview: (request) =>
              Effect.sync(() => {
                options.requestedReviews.push(request)
              }),
            viewCurrentPullRequest: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.succeed(
          Linear,
          Linear.of({
            authenticate: Effect.die("not used in this test"),
            commentOnIssue: () => Effect.void,
            issues: Effect.succeed([issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Example issue" })]),
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
            list: Effect.succeed([]),
            markReviewHandled: () => Effect.die("not used in this test"),
            upsert: (record) =>
              Effect.sync(() => {
                options.storedPullRequests.push(record)
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
            acquire: (run) => Effect.succeed({
              ...run,
              pid: process.pid,
              prNumber: null,
              prUrl: null,
              startedAtMs: 1,
            } as ActiveRun),
            clear: Effect.void,
            current: Effect.die("not used in this test"),
            update: () => Effect.succeed(null),
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
