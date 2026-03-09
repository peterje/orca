import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, FileSystem, Layer, Option } from "effect"
import { TestConsole } from "effect/testing"
import { AgentRunner } from "./agent-runner.ts"
import { GitHub, type PullRequestFeedback } from "./github.ts"
import { Linear, type LinearIssue } from "./linear.ts"
import { PromptGen } from "./prompt-gen.ts"
import { PullRequestStore, OrcaManagedPullRequest } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigData } from "./repo-config.ts"
import { RunState, RunStateBusyError } from "./run-state.ts"
import { Runner, RunnerLayer } from "./runner.ts"
import { Verifier } from "./verifier.ts"
import { Worktree, type ManagedWorktree } from "./worktree.ts"

describe("Runner", () => {
  it.effect("prints the selected implementation issue before setup output", () =>
    Effect.gen(function* () {
      const runner = yield* Runner
      const error = yield* Effect.flip(runner.runNext)

      expect(error).toBeInstanceOf(RunStateBusyError)
      expect(yield* TestConsole.logLines).toEqual([
        "Tackling ENG-1 First issue",
        "https://linear.app/orca/issue/ENG-1/first-issue",
        "setup output",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestConsole.layer,
          makeRunnerLayer({
            issues: [
              linearIssue({
                id: "issue-1",
                identifier: "ENG-1",
                isOrcaTagged: true,
                title: "First issue",
                url: "https://linear.app/orca/issue/ENG-1/first-issue",
              }),
            ],
            pullRequests: [],
            worktreeService: Worktree.of({
              create: () =>
                Effect.gen(function* () {
                  yield* Console.log("setup output")
                  return managedWorktree("orca/eng-1-first-issue")
                }),
              resume: () => Effect.die("not used in this test"),
            }),
          }),
        ),
      ),
    ))

  it.effect("prints the selected review issue before setup output", () =>
    Effect.gen(function* () {
      const runner = yield* Runner
      const error = yield* Effect.flip(runner.runNext)

      expect(error).toBeInstanceOf(RunStateBusyError)
      expect(yield* TestConsole.logLines).toEqual([
        "Reviewing ENG-9 Existing issue",
        "https://linear.app/orca/issue/ENG-9/existing-issue",
        "setup output",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestConsole.layer,
          makeRunnerLayer({
            issues: [],
            issueUrls: {
              "issue-9": "https://linear.app/orca/issue/ENG-9/existing-issue",
            },
            pullRequests: [
              new OrcaManagedPullRequest({
                branch: "orca/eng-9-existing-issue",
                createdAtMs: 1,
                issueDescription: "Existing issue description",
                issueId: "issue-9",
                issueIdentifier: "ENG-9",
                issueTitle: "Existing issue",
                lastReviewedAtMs: null,
                prNumber: 9,
                prUrl: "https://github.com/peterje/orca/pull/9",
                repo: "peterje/orca",
                updatedAtMs: 2,
              }),
            ],
            pullRequestFeedback: {
              9: pendingFeedback({
                url: "https://github.com/peterje/orca/pull/9",
              }),
            },
            worktreeService: Worktree.of({
              create: () => Effect.die("not used in this test"),
              resume: () =>
                Effect.gen(function* () {
                  yield* Console.log("setup output")
                  return managedWorktree("orca/eng-9-existing-issue")
                }),
            }),
          }),
        ),
      ),
    ))
})

const makeRunnerLayer = (options: {
  readonly issues: ReadonlyArray<LinearIssue>
  readonly issueUrls?: Record<string, string>
  readonly pullRequests: ReadonlyArray<OrcaManagedPullRequest>
  readonly pullRequestFeedback?: Record<number, PullRequestFeedback>
  readonly worktreeService: typeof Worktree.Service
}) =>
  RunnerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        Layer.succeed(
          AgentRunner,
          AgentRunner.of({
            run: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          GitHub,
          GitHub.of({
            createPullRequest: () => Effect.die("not used in this test"),
            detectRepo: Effect.die("not used in this test"),
            readPullRequestFeedback: ({ pullRequestNumber }) =>
              options.pullRequestFeedback?.[pullRequestNumber]
                ? Effect.succeed(options.pullRequestFeedback[pullRequestNumber]!)
                : Effect.die(`missing feedback for pull request ${pullRequestNumber}`),
            removePullRequestLabel: () => Effect.die("not used in this test"),
            viewCurrentPullRequest: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          Linear,
          Linear.of({
            authenticate: Effect.die("not used in this test"),
            commentOnIssue: () => Effect.die("not used in this test"),
            issueUrl: (issueId) => Effect.succeed(options.issueUrls?.[issueId] ?? null),
            issues: Effect.succeed(options.issues),
            markIssueInProgress: () => Effect.die("not used in this test"),
            viewer: Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          PromptGen,
          PromptGen.of({
            buildImplementationPrompt: () => Effect.die("not used in this test"),
            buildReviewPrompt: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          PullRequestStore,
          PullRequestStore.of({
            list: Effect.succeed(options.pullRequests),
            markReviewHandled: () => Effect.die("not used in this test"),
            upsert: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          RepoConfig,
          RepoConfig.of({
            bootstrap: () => Effect.die("not used in this test"),
            configPath: Effect.die("not used in this test"),
            exists: Effect.die("not used in this test"),
            read: Effect.succeed(repoConfig()),
            readOption: Effect.die("not used in this test"),
            write: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          RunState,
          RunState.of({
            acquire: () => Effect.fail(new RunStateBusyError({ message: "busy" })),
            clear: Effect.void,
            current: Effect.succeed(null),
            update: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(Verifier, Verifier.of({ run: () => Effect.die("not used in this test") })),
        Layer.succeed(Worktree, options.worktreeService),
      ),
    ),
  )

const repoConfig = () =>
  new RepoConfigData({
    agent: "opencode",
    agentArgs: [],
    agentTimeoutMinutes: 45,
    baseBranch: "main",
    branchPrefix: "orca",
    cleanupWorktreeOnSuccess: false,
    draftPr: true,
    linearLabel: "Orca",
    repo: "peterje/orca",
    setup: ["bun install"],
    stallTimeoutMinutes: 10,
    verify: [],
  })

const managedWorktree = (branch: string): ManagedWorktree => ({
  branch,
  directory: `/tmp/${branch}`,
  remove: Effect.void,
  run: () => Effect.die("not used in this test"),
  runString: () => Effect.die("not used in this test"),
})

const linearIssue = (overrides: Partial<LinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title" | "url">): LinearIssue => ({
  blockedBy: overrides.blockedBy ?? [],
  childIds: overrides.childIds ?? [],
  createdAtMs: overrides.createdAtMs ?? 1,
  description: overrides.description ?? "",
  id: overrides.id,
  identifier: overrides.identifier,
  isOrcaTagged: overrides.isOrcaTagged ?? false,
  labels: overrides.labels ?? [],
  parentId: overrides.parentId ?? null,
  priority: overrides.priority ?? 0,
  state: overrides.state ?? "unstarted",
  stateId: overrides.stateId ?? "state-1",
  stateName: overrides.stateName ?? "Backlog",
  teamStates: overrides.teamStates ?? [{ id: "state-started", name: "In Progress", type: "started" }],
  title: overrides.title,
  url: overrides.url,
})

const pendingFeedback = (overrides?: Partial<PullRequestFeedback>): PullRequestFeedback => ({
  comments: overrides?.comments ?? [],
  isDraft: overrides?.isDraft ?? true,
  labels: overrides?.labels ?? ["orca-review"],
  number: overrides?.number ?? 9,
  reviewThreads: overrides?.reviewThreads ?? [
    {
      comments: [
        {
          authorLogin: "reviewer",
          body: "Please update this.",
          createdAtMs: 10,
          diffHunk: "@@ -1,1 +1,1 @@",
          id: "thread-1",
          isBot: false,
          originalLine: 1,
          path: "apps/cli/src/runner.ts",
        },
      ],
      isCollapsed: false,
      isResolved: false,
    },
  ],
  reviews: overrides?.reviews ?? [],
  state: overrides?.state ?? "OPEN",
  url: overrides?.url ?? "https://github.com/peterje/orca/pull/9",
})
