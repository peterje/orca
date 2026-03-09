import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { AgentRunner } from "./agent-runner.ts"
import type { PullRequestFeedback, PullRequestInfo } from "./github.ts"
import { GitHub } from "./github.ts"
import { Linear, type LinearIssue } from "./linear.ts"
import { PromptGen } from "./prompt-gen.ts"
import { PullRequestStore, OrcaManagedPullRequest } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigData } from "./repo-config.ts"
import { RunState } from "./run-state.ts"
import { Runner, RunnerLayer, RunnerNoWorkError } from "./runner.ts"
import { Verifier } from "./verifier.ts"
import { Worktree } from "./worktree.ts"

describe("Runner", () => {
  it.effect("keeps selecting implementation work while Greptile is still pending below the cap", () =>
    Effect.gen(function* () {
      const runner = yield* Runner
      const status = yield* runner.peekStatus

      expect(status).toMatchObject({
        id: "issue-2",
        issueIdentifier: "ENG-2",
        kind: "implementation",
        title: "Ship next task",
      })
    }).pipe(
      Effect.provide(
        makeRunnerTestLayer({
          config: config(),
          feedback: [
            feedback({
              number: 11,
              state: "OPEN",
            }),
          ],
          issues: [
            issue({
              id: "issue-2",
              identifier: "ENG-2",
              isOrcaTagged: true,
              priority: 2,
              title: "Ship next task",
            }),
          ],
          pullRequests: [pullRequest({ issueIdentifier: "ENG-1", prNumber: 11 })],
        }),
      ),
    ))

  it.effect("pauses implementation work when waiting Greptile PRs reach the configured cap", () =>
    Effect.gen(function* () {
      const runner = yield* Runner
      const status = yield* runner.peekStatus
      const error = yield* Effect.flip(runner.runNext)

      expect(status).toEqual({
        kind: "paused",
        maxWaitingGreptilePrs: 4,
        waitingGreptilePrCount: 4,
      })
      expect(error).toBeInstanceOf(RunnerNoWorkError)
      expect(error.message).toContain("configured cap of 4")
    }).pipe(
      Effect.provide(
        makeRunnerTestLayer({
          config: config(),
          feedback: [
            feedback({ number: 11, state: "OPEN" }),
            feedback({ number: 12, state: "OPEN" }),
            feedback({ number: 13, state: "OPEN" }),
            feedback({ number: 14, state: "OPEN" }),
          ],
          issues: [
            issue({
              id: "issue-5",
              identifier: "ENG-5",
              isOrcaTagged: true,
              priority: 2,
              title: "Ready implementation work",
            }),
          ],
          pullRequests: [
            pullRequest({ issueIdentifier: "ENG-1", prNumber: 11 }),
            pullRequest({ issueIdentifier: "ENG-2", prNumber: 12 }),
            pullRequest({ issueIdentifier: "ENG-3", prNumber: 13 }),
            pullRequest({ issueIdentifier: "ENG-4", prNumber: 14 }),
          ],
        }),
      ),
    ))

  it.effect("prioritizes actionable review work ahead of new implementation work", () =>
    Effect.gen(function* () {
      const runner = yield* Runner
      const status = yield* runner.peekStatus

      expect(status).toMatchObject({
        issueIdentifier: "ENG-5",
        kind: "review",
        pullRequestNumber: 15,
        pullRequestUrl: "https://github.com/peterje/orca/pull/15",
        title: "Needs review follow-up",
      })
    }).pipe(
      Effect.provide(
        makeRunnerTestLayer({
          config: config(),
          feedback: [
            feedback({ number: 11, state: "OPEN" }),
            feedback({ number: 12, state: "OPEN" }),
            feedback({ number: 13, state: "OPEN" }),
            feedback({ number: 14, state: "OPEN" }),
            feedback({
              number: 15,
              reviews: [
                {
                  authorLogin: "greptile-apps",
                  body: "Please tighten the scheduler selection around waiting PRs.",
                  createdAtMs: 100,
                  id: "review-15",
                  isBot: false,
                },
              ],
              state: "OPEN",
            }),
          ],
          issues: [
            issue({
              id: "issue-6",
              identifier: "ENG-6",
              isOrcaTagged: true,
              priority: 2,
              title: "Fresh implementation work",
            }),
          ],
          pullRequests: [
            pullRequest({ issueIdentifier: "ENG-1", prNumber: 11 }),
            pullRequest({ issueIdentifier: "ENG-2", prNumber: 12 }),
            pullRequest({ issueIdentifier: "ENG-3", prNumber: 13 }),
            pullRequest({ issueIdentifier: "ENG-4", prNumber: 14 }),
            pullRequest({ issueIdentifier: "ENG-5", issueTitle: "Needs review follow-up", prNumber: 15 }),
          ],
        }),
      ),
    ))
})

const makeRunnerTestLayer = (options: {
  readonly config: RepoConfigData
  readonly feedback: ReadonlyArray<PullRequestFeedback>
  readonly issues: ReadonlyArray<LinearIssue>
  readonly pullRequests: ReadonlyArray<OrcaManagedPullRequest>
}) => {
  const feedbackByPullRequest = new Map(options.feedback.map((item) => [item.number, item]))

  return RunnerLayer.pipe(
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
            readPullRequestFeedback: ({ pullRequestNumber }) => {
              const value = feedbackByPullRequest.get(pullRequestNumber)
              return value ? Effect.succeed(value) : Effect.die(`missing feedback for pull request ${pullRequestNumber}`)
            },
            removePullRequestLabel: () => Effect.die("not used in this test"),
            viewCurrentPullRequest: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          Linear,
          Linear.of({
            authenticate: Effect.die("not used in this test"),
            commentOnIssue: () => Effect.die("not used in this test"),
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
            read: Effect.succeed(options.config),
            readOption: Effect.succeed(options.config),
            write: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          RunState,
          RunState.of({
            acquire: () => Effect.die("not used in this test"),
            clear: Effect.void,
            current: Effect.succeed(null),
            update: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          Verifier,
          Verifier.of({
            run: () => Effect.die("not used in this test"),
          }),
        ),
        Layer.succeed(
          Worktree,
          Worktree.of({
            create: () => Effect.die("not used in this test"),
            resume: () => Effect.die("not used in this test"),
          }),
        ),
      ),
    ),
  )
}

const config = () =>
  new RepoConfigData({
    agent: "opencode",
    agentArgs: [],
    agentTimeoutMinutes: 45,
    baseBranch: "main",
    branchPrefix: "orca",
    cleanupWorktreeOnSuccess: true,
    draftPr: true,
    linearLabel: "Orca",
    maxWaitingGreptilePrs: 4,
    repo: "peterje/orca",
    setup: ["bun install"],
    stallTimeoutMinutes: 10,
    verify: ["bun run check"],
  })

const pullRequest = (overrides: {
  readonly issueIdentifier: string
  readonly issueTitle?: string | undefined
  readonly prNumber: number
}) =>
  new OrcaManagedPullRequest({
    branch: `orca/${overrides.issueIdentifier.toLowerCase()}`,
    createdAtMs: Date.parse("2026-03-01T00:00:00.000Z"),
    issueDescription: "Tracked by Orca.",
    issueId: `${overrides.issueIdentifier.toLowerCase()}-id`,
    issueIdentifier: overrides.issueIdentifier,
    issueTitle: overrides.issueTitle ?? `Issue ${overrides.issueIdentifier}`,
    lastReviewedAtMs: null,
    prNumber: overrides.prNumber,
    prUrl: `https://github.com/peterje/orca/pull/${overrides.prNumber}`,
    repo: "peterje/orca",
    updatedAtMs: Date.parse("2026-03-01T00:00:00.000Z"),
  })

const feedback = (overrides: Partial<PullRequestFeedback> & Pick<PullRequestFeedback, "number" | "state">): PullRequestFeedback => ({
  authorLogin: overrides.authorLogin ?? "orca-author",
  comments: overrides.comments ?? [],
  isDraft: overrides.isDraft ?? true,
  labels: overrides.labels ?? [],
  number: overrides.number,
  reviewThreads: overrides.reviewThreads ?? [],
  reviews: overrides.reviews ?? [],
  state: overrides.state,
  url: overrides.url ?? `https://github.com/peterje/orca/pull/${overrides.number}`,
}) satisfies PullRequestInfo & PullRequestFeedback

const issue = (overrides: Partial<LinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title">): LinearIssue => ({
  blockedBy: overrides.blockedBy ?? [],
  childIds: overrides.childIds ?? [],
  createdAtMs: overrides.createdAtMs ?? Date.parse("2026-03-01T00:00:00.000Z"),
  description: overrides.description ?? "",
  id: overrides.id,
  identifier: overrides.identifier,
  isOrcaTagged: overrides.isOrcaTagged ?? false,
  labels: overrides.labels ?? [],
  parentId: overrides.parentId ?? null,
  priority: overrides.priority ?? 0,
  stateId: overrides.stateId ?? `${overrides.id}-state`,
  stateName: overrides.stateName ?? "Unstarted",
  state: overrides.state ?? "unstarted",
  teamStates: overrides.teamStates ?? [],
  title: overrides.title,
})
