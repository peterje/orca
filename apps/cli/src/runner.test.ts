import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunner } from "./agent-runner.ts"
import { GitHub, type PullRequestFeedback, type PullRequestInfo } from "./github.ts"
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
      readonly greptileCompletedAtMs?: number | null | undefined
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
              "**closes**",
              "[ENG-1](https://linear.app/peteredm/issue/ENG-1)",
              "",
              "**summary**",
              "this updates example issue so the pull request stays tied to the ticket and gives reviewers a clear explanation of the requested outcome.",
              "",
              "**verification**",
              "- `bun run check`",
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

  it.effect("marks waiting pull requests ready for review when the latest Greptile review is 5/5", () => {
    const greptileCompletedPullRequests: Array<{
      readonly completedAtMs: number
      readonly lastReviewedAtMs: number
      readonly prNumber: number
      readonly repo: string
    }> = []
    const readyForReviewRequests: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []

    return withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner

        expect(yield* runner.peekNext).toEqual(Option.none())

        yield* runner.pollWaitingPullRequests

        expect(readyForReviewRequests).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(greptileCompletedPullRequests).toHaveLength(1)
        expect(greptileCompletedPullRequests[0]).toMatchObject({
          lastReviewedAtMs: 30,
          prNumber: 42,
          repo: "peterje/orca",
        })
        expect(Option.getOrNull(yield* runner.peekNext)).toMatchObject({
          id: "issue-2",
          issueIdentifier: "ENG-2",
          kind: "implementation",
        })
      }).pipe(Effect.provide(makeRunnerLayer({
        config: { maxWaitingPullRequests: 1 },
        greptileCompletedPullRequests,
        issues: [
          issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Existing work" }),
          issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, title: "Next work" }),
        ],
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            isDraft: true,
            number: 42,
            reviewThreads: [
              {
                comments: [
                  {
                    authorLogin: "greptile-apps[bot]",
                    body: "Please rename this helper.",
                    createdAtMs: 5,
                    diffHunk: "@@ -1,1 +1,1 @@",
                    id: "thread-comment-1",
                    isBot: true,
                    originalLine: 1,
                    path: "apps/cli/src/runner.ts",
                  },
                ],
                isCollapsed: false,
                isResolved: false,
              },
            ],
            reviews: [
              {
                authorLogin: "greptile-apps[bot]",
                body: "Confidence: 2/5",
                createdAtMs: 20,
                id: "review-1",
                isBot: true,
              },
              {
                authorLogin: "greptile-apps[bot]",
                body: "Confidence: 5/5",
                createdAtMs: 30,
                id: "review-2",
                isBot: true,
              },
            ],
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        readyForReviewRequests,
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
    )
  })

  it.effect("marks waiting pull requests ready for review when the latest Greptile score is posted as a comment", () => {
    const greptileCompletedPullRequests: Array<{
      readonly completedAtMs: number
      readonly lastReviewedAtMs: number
      readonly prNumber: number
      readonly repo: string
    }> = []
    const readyForReviewRequests: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []

    return withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner

        expect(yield* runner.peekNext).toEqual(Option.none())

        yield* runner.pollWaitingPullRequests

        expect(readyForReviewRequests).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(greptileCompletedPullRequests).toHaveLength(1)
        expect(greptileCompletedPullRequests[0]).toMatchObject({
          lastReviewedAtMs: 30,
          prNumber: 42,
          repo: "peterje/orca",
        })
      }).pipe(Effect.provide(makeRunnerLayer({
        greptileCompletedPullRequests,
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            comments: [
              comment({
                authorLogin: "greptile-apps[bot]",
                body: "Confidence Score: 5/5\n\nSafe to merge.",
                createdAtMs: 30,
                id: "comment-2",
                isBot: true,
              }),
            ],
            isDraft: true,
            number: 42,
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        readyForReviewRequests,
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
    )
  })

  it.effect("fails polling when a completed Greptile review cannot be recorded in the store", () => {
    const readyForReviewRequests: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []

    return withTempDirectory((tempDirectory) =>
      Effect.gen(function* () {
        const runner = yield* Runner
        const failure = yield* runner.pollWaitingPullRequests.pipe(Effect.flip)

        expect(readyForReviewRequests).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(failure.message).toBe("PR #42 in peterje/orca was not found in the store when marking Greptile complete.")
      }).pipe(Effect.provide(makeRunnerLayer({
        markGreptileCompletedReturnsNull: true,
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            isDraft: true,
            number: 42,
            reviews: [
              {
                authorLogin: "greptile-apps[bot]",
                body: "Confidence: 5/5",
                createdAtMs: 30,
                id: "review-2",
                isBot: true,
              },
            ],
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        readyForReviewRequests,
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
    )
  })

  it.effect("reads waiting pull request feedback once during runNext selection", () => {
    const readPullRequestFeedbackRequests: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner

        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-2",
          mode: "implementation",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(readPullRequestFeedbackRequests).toEqual([{ pullRequestNumber: 41, repo: "peterje/orca" }])
      }).pipe(Effect.provide(makeRunnerLayer({
        issues: [
          issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Existing work" }),
          issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, title: "Next work" }),
        ],
        pullRequestFeedbackByKey: {
          "peterje/orca#41": pullRequestFeedback({
            isDraft: true,
            number: 41,
            url: "https://github.com/peterje/orca/pull/41",
          }),
        },
        readPullRequestFeedbackRequests,
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            prNumber: 41,
            prUrl: "https://github.com/peterje/orca/pull/41",
            waitingForGreptileReviewSinceMs: 1,
          }),
        ],
        worktreeDirectory,
      })))
    })
  })

  it.effect("syncs tracked pull requests with the base branch before new implementation work", () => {
    const agentRunRequests: Array<{
      readonly agent: string
      readonly cwd: string
      readonly prompt: string
      readonly promptFilePath: string
    }> = []
    const mergeConflictPromptRequests: Array<{
      readonly baseBranch: string
      readonly branch: string
      readonly conflictFiles: ReadonlyArray<string>
      readonly issueDescription: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly pullRequestUrl: string
      readonly verify: ReadonlyArray<string>
    }> = []
    const requestedReviews: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []
    const storedPullRequests: Array<{
      readonly branch: string
      readonly greptileCompletedAtMs?: number | null | undefined
      readonly issueDescription: string
      readonly issueId: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly prNumber: number
      readonly prUrl: string
      readonly repo: string
      readonly waitingForGreptileReviewSinceMs?: number | null | undefined
    }> = []
    const worktreeCommandLog: Array<string> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-1",
          mode: "maintenance",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(agentRunRequests).toEqual([])
        expect(mergeConflictPromptRequests).toEqual([])
        expect(requestedReviews).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(storedPullRequests[0]).toMatchObject({
          greptileCompletedAtMs: null,
          issueIdentifier: "ENG-1",
          prNumber: 42,
          repo: "peterje/orca",
        })
        expect(typeof storedPullRequests[0]?.waitingForGreptileReviewSinceMs).toBe("number")
        expect(worktreeCommandLog).toContain("git fetch origin 'main'")
        expect(worktreeCommandLog).toContain("git merge --no-commit --no-ff 'origin/main'")
      }).pipe(Effect.provide(makeRunnerLayer({
        agentRunRequests,
        currentPullRequest: {
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/peterje/orca/pull/42",
        },
        issues: [issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, title: "New work" })],
        mergeConflictPromptRequests,
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            mergeStateStatus: "BEHIND",
            number: 42,
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        requestedReviews,
        storedPullRequests,
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            prNumber: 42,
            prUrl: "https://github.com/peterje/orca/pull/42",
            waitingForGreptileReviewSinceMs: 10,
          }),
        ],
        worktreeCommandLog,
        worktreeDirectory,
      })))
    })
  })

  it.effect("lets weave resolve dirty tracked pull request syncs without invoking the agent", () => {
    const agentRunRequests: Array<{
      readonly agent: string
      readonly cwd: string
      readonly prompt: string
      readonly promptFilePath: string
    }> = []
    const mergeConflictPromptRequests: Array<{
      readonly baseBranch: string
      readonly branch: string
      readonly conflictFiles: ReadonlyArray<string>
      readonly issueDescription: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly pullRequestUrl: string
      readonly verify: ReadonlyArray<string>
    }> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-1",
          mode: "maintenance",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(agentRunRequests).toEqual([])
        expect(mergeConflictPromptRequests).toEqual([])
      }).pipe(Effect.provide(makeRunnerLayer({
        agentRunRequests,
        currentPullRequest: {
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/peterje/orca/pull/42",
        },
        mergeConflictPromptRequests,
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            mergeStateStatus: "DIRTY",
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
            waitingForGreptileReviewSinceMs: 10,
          }),
        ],
        worktreeDirectory,
      })))
    })
  })

  it.effect("falls back to the agent when weave leaves merge conflicts unresolved", () => {
    const agentRunRequests: Array<{
      readonly agent: string
      readonly cwd: string
      readonly prompt: string
      readonly promptFilePath: string
    }> = []
    const mergeConflictPromptRequests: Array<{
      readonly baseBranch: string
      readonly branch: string
      readonly conflictFiles: ReadonlyArray<string>
      readonly issueDescription: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly pullRequestUrl: string
      readonly verify: ReadonlyArray<string>
    }> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-1",
          mode: "maintenance",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(agentRunRequests).toHaveLength(1)
        expect(agentRunRequests[0]?.prompt).toBe("Resolve the merge conflicts.")
        expect(mergeConflictPromptRequests).toEqual([
          {
            baseBranch: "main",
            branch: "orca/eng-1-example-issue",
            conflictFiles: ["apps/cli/src/runner.ts"],
            issueDescription: "Example issue description",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            pullRequestUrl: "https://github.com/peterje/orca/pull/42",
            verify: ["bun run check"],
          },
        ])
      }).pipe(Effect.provide(makeRunnerLayer({
        agentRunRequests,
        baseSyncMergeExitCode: 1,
        currentPullRequest: {
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/peterje/orca/pull/42",
        },
        mergeConflictPromptRequests,
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            mergeStateStatus: "DIRTY",
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
            waitingForGreptileReviewSinceMs: 10,
          }),
        ],
        unresolvedConflictFiles: ["apps/cli/src/runner.ts"],
        unresolvedConflictFilesAfterFirstRead: [],
        worktreeDirectory,
      })))
    })
  })

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
            comments: [comment({ authorLogin: "reviewer", body: "Human note", createdAtMs: 12 })],
            number: 42,
            reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 10, isBot: true })],
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

  it.effect("prioritizes actionable review work when Greptile posts the score as a comment", () =>
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
              comment({
                authorLogin: "greptile-apps[bot]",
                body: "Confidence Score: 4/5\n\nPlease tighten this up.",
                createdAtMs: 10,
                isBot: true,
              }),
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

  it.effect("ignores stale tracked pull requests when enforcing the waiting cap", () =>
    withTempDirectory((tempDirectory) => {
      const removedPullRequests: Array<string> = []

      return Effect.gen(function* () {
        const runner = yield* Runner
        const next = yield* runner.peekNext

        expect(Option.getOrNull(next)).toMatchObject({
          id: "issue-5",
          issueIdentifier: "ENG-5",
          kind: "implementation",
        })
        expect(removedPullRequests).toEqual(["peterje/orca#44"])
      }).pipe(Effect.provide(makeRunnerLayer({
        issues: [issue({ id: "issue-5", identifier: "ENG-5", isOrcaTagged: true, title: "Resumed work" })],
        pullRequestFeedbackByKey: {
          "peterje/orca#41": pullRequestFeedback({ number: 41, url: "https://github.com/peterje/orca/pull/41" }),
          "peterje/orca#42": pullRequestFeedback({ number: 42, url: "https://github.com/peterje/orca/pull/42" }),
          "peterje/orca#43": pullRequestFeedback({ number: 43, url: "https://github.com/peterje/orca/pull/43" }),
          "peterje/orca#44": pullRequestFeedback({ number: 44, state: "MERGED", url: "https://github.com/peterje/orca/pull/44" }),
        },
        removedPullRequests,
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
      })))
    }))

  it.effect("does not requeue review work until a new Greptile review arrives", () =>
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
            comments: [comment({ authorLogin: "greptile-apps[bot]", body: "Please tighten this up.", createdAtMs: 80, isBot: true })],
            number: 42,
            reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 70, isBot: true })],
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
            waitingForGreptileReviewSinceMs: 100,
          }),
        ],
        worktreeDirectory: join(tempDirectory, "worktree"),
      }))),
    ))

  it.effect("requeues Greptile after fixing a failing review", () => {
    const createdPullRequests: Array<{
      readonly baseBranch: string
      readonly body: string
      readonly cwd: string
      readonly draft: boolean
      readonly repo: string
      readonly title: string
    }> = []
    const recordedGreptileReviewRequests: Array<{
      readonly lastReviewedAtMs: number
      readonly prNumber: number
      readonly repo: string
      readonly waitingForGreptileReviewSinceMs: number
    }> = []
    const requestedReviews: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []
    const reviewPromptRequests: Array<{
      readonly baseBranch: string
      readonly branch: string
      readonly issueDescription: string
      readonly issueIdentifier: string
      readonly issueTitle: string
      readonly pullRequestUrl: string
      readonly reviewFeedback: string
      readonly verify: ReadonlyArray<string>
    }> = []

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        const result = yield* runner.runNext

        expect(result).toMatchObject({
          issueIdentifier: "ENG-1",
          mode: "review",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
        })
        expect(createdPullRequests).toEqual([])
        expect(requestedReviews).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(recordedGreptileReviewRequests).toHaveLength(1)
        expect(recordedGreptileReviewRequests[0]).toMatchObject({
          lastReviewedAtMs: 60,
          prNumber: 42,
          repo: "peterje/orca",
        })
        expect(typeof recordedGreptileReviewRequests[0]?.waitingForGreptileReviewSinceMs).toBe("number")
        expect(reviewPromptRequests).toHaveLength(1)
        expect(reviewPromptRequests[0]?.reviewFeedback).toContain("Confidence: 4/5")
        expect(reviewPromptRequests[0]?.reviewFeedback).toContain("Please rename this helper.")
        expect(reviewPromptRequests[0]?.reviewFeedback).not.toContain("Human note")
      }).pipe(Effect.provide(makeRunnerLayer({
        createdPullRequests,
        currentPullRequest: {
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/peterje/orca/pull/42",
        },
        pullRequestFeedbackByKey: {
          "peterje/orca#42": pullRequestFeedback({
            comments: [
              comment({ authorLogin: "reviewer", body: "Human note", createdAtMs: 59 }),
              comment({ authorLogin: "greptile-apps[bot]", body: "Please keep the error message actionable.", createdAtMs: 58, isBot: true }),
            ],
            number: 42,
            reviewThreads: [
              {
                comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 55, isBot: true })],
                isCollapsed: false,
                isResolved: false,
              },
            ],
            reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 60, id: "review-42", isBot: true })],
            url: "https://github.com/peterje/orca/pull/42",
          }),
        },
        recordedGreptileReviewRequests,
        requestedReviews,
        reviewPromptRequests,
        trackedPullRequests: [
          trackedPullRequest({
            issueId: "issue-1",
            issueIdentifier: "ENG-1",
            issueTitle: "Existing work",
            prNumber: 42,
            prUrl: "https://github.com/peterje/orca/pull/42",
            waitingForGreptileReviewSinceMs: 10,
          }),
        ],
        worktreeDirectory,
      })))
    })
  })

  it.effect("records the waiting timestamp after the Greptile review request completes", () => {
    const requestedReviews: Array<{ readonly pullRequestNumber: number; readonly repo: string }> = []
    const recordedGreptileReviewRequests: Array<{
      readonly lastReviewedAtMs: number
      readonly prNumber: number
      readonly repo: string
      readonly waitingForGreptileReviewSinceMs: number
    }> = []
    const originalDateNow = Date.now
    let reviewRequested = false

    Date.now = () => (reviewRequested ? 200 : 100)

    return withTempDirectory((tempDirectory) => {
      const worktreeDirectory = join(tempDirectory, "worktree")
      mkdirSync(worktreeDirectory, { recursive: true })

      return Effect.gen(function* () {
        const runner = yield* Runner
        yield* runner.runNext

        expect(requestedReviews).toEqual([{ pullRequestNumber: 42, repo: "peterje/orca" }])
        expect(recordedGreptileReviewRequests).toHaveLength(1)
        expect(recordedGreptileReviewRequests[0]?.waitingForGreptileReviewSinceMs).toBe(200)
      }).pipe(
        Effect.provide(makeRunnerLayer({
          currentPullRequest: {
            isDraft: true,
            number: 42,
            state: "OPEN",
            url: "https://github.com/peterje/orca/pull/42",
          },
          pullRequestFeedbackByKey: {
            "peterje/orca#42": pullRequestFeedback({
              number: 42,
              reviewThreads: [
                {
                  comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 55, isBot: true })],
                  isCollapsed: false,
                  isResolved: false,
                },
              ],
              reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 60, id: "review-42", isBot: true })],
              url: "https://github.com/peterje/orca/pull/42",
            }),
          },
          recordedGreptileReviewRequests,
          requestedReviews,
          requestPullRequestReview: (request: { readonly pullRequestNumber: number; readonly repo: string }) =>
            Effect.sync(() => {
              reviewRequested = true
              requestedReviews.push(request)
            }),
          trackedPullRequests: [
            trackedPullRequest({
              issueId: "issue-1",
              issueIdentifier: "ENG-1",
              issueTitle: "Existing work",
              prNumber: 42,
              prUrl: "https://github.com/peterje/orca/pull/42",
              waitingForGreptileReviewSinceMs: 10,
            }),
          ],
          worktreeDirectory,
        })),
        Effect.ensuring(Effect.sync(() => {
          Date.now = originalDateNow
        })),
      )
    })
  })

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
  readonly agentRunRequests?: Array<{
    readonly agent: string
    readonly cwd: string
    readonly prompt: string
    readonly promptFilePath: string
  }>
  readonly baseSyncMergeExitCode?: number
  readonly createdPullRequests?: Array<{
    readonly baseBranch: string
    readonly body: string
    readonly cwd: string
    readonly draft: boolean
    readonly repo: string
    readonly title: string
  }>
  readonly config?: Partial<typeof RepoConfigData.Type>
  readonly currentPullRequest?: PullRequestInfo | null | undefined
  readonly greptileCompletedPullRequests?: Array<{
    readonly completedAtMs: number
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
  }>
  readonly markGreptileCompletedReturnsNull?: boolean
  readonly mergeConflictPromptRequests?: Array<{
    readonly baseBranch: string
    readonly branch: string
    readonly conflictFiles: ReadonlyArray<string>
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
    readonly verify: ReadonlyArray<string>
  }>
  readonly issues?: ReadonlyArray<LinearIssue>
  readonly pullRequestFeedbackByKey?: Readonly<Record<string, PullRequestFeedback>>
  readonly removedPullRequests?: Array<string>
  readonly readPullRequestFeedbackRequests?: Array<{ readonly pullRequestNumber: number; readonly repo: string }>
  readonly readyForReviewRequests?: Array<{ readonly pullRequestNumber: number; readonly repo: string }>
  readonly recordedGreptileReviewRequests?: Array<{
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
    readonly waitingForGreptileReviewSinceMs: number
  }>
  readonly requestPullRequestReview?: (request: {
    readonly pullRequestNumber: number
    readonly repo: string
  }) => Effect.Effect<void>
  readonly reviewPromptRequests?: Array<{
    readonly baseBranch: string
    readonly branch: string
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
    readonly reviewFeedback: string
    readonly verify: ReadonlyArray<string>
  }>
  readonly requestedReviews?: Array<{ readonly pullRequestNumber: number; readonly repo: string }>
  readonly runStateAcquire?: (
    run: Omit<typeof ActiveRun.Type, "pid" | "prNumber" | "prUrl" | "startedAtMs">,
  ) => Effect.Effect<ActiveRun, RunStateBusyError>
  readonly storedPullRequests?: Array<{
    readonly branch: string
    readonly greptileCompletedAtMs?: number | null | undefined
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
  readonly unresolvedConflictFiles?: ReadonlyArray<string>
  readonly unresolvedConflictFilesAfterFirstRead?: ReadonlyArray<string>
  readonly weaveDriver?: string | null | undefined
  readonly weaveVersionExitCode?: number
  readonly worktreeCommandLog?: Array<string>
  readonly worktreeDirectory: string
  readonly worktreeStatus?: string
}) => {
  const worktree = makeManagedWorktree({
    baseSyncMergeExitCode: options.baseSyncMergeExitCode,
    directory: options.worktreeDirectory,
    unresolvedConflictFiles: options.unresolvedConflictFiles,
    unresolvedConflictFilesAfterFirstRead: options.unresolvedConflictFilesAfterFirstRead,
    weaveDriver: options.weaveDriver,
    weaveVersionExitCode: options.weaveVersionExitCode,
    worktreeCommandLog: options.worktreeCommandLog,
    worktreeStatus: options.worktreeStatus,
  })
  const agentRunRequests = options.agentRunRequests ?? []
  const createdPullRequests = options.createdPullRequests ?? []
  const mergeConflictPromptRequests = options.mergeConflictPromptRequests ?? []
  const removedPullRequests = options.removedPullRequests ?? []
  const greptileCompletedPullRequests = options.greptileCompletedPullRequests ?? []
  const readPullRequestFeedbackRequests = options.readPullRequestFeedbackRequests ?? []
  const readyForReviewRequests = options.readyForReviewRequests ?? []
  const recordedGreptileReviewRequests = options.recordedGreptileReviewRequests ?? []
  const reviewPromptRequests = options.reviewPromptRequests ?? []
  const requestedReviews = options.requestedReviews ?? []
  const storedPullRequests = options.storedPullRequests ?? []
  let trackedPullRequests = [...(options.trackedPullRequests ?? [])]
  let activeRun: ActiveRun | null = null

  return RunnerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        testFileSystemLayer,
        Layer.succeed(
          AgentRunner,
          AgentRunner.of({
            run: (request) =>
              Effect.sync(() => {
                agentRunRequests.push({
                  agent: request.agent,
                  cwd: request.cwd,
                  prompt: request.prompt,
                  promptFilePath: request.promptFilePath,
                })
              }),
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
            markPullRequestReadyForReview: (request) =>
              Effect.sync(() => {
                readyForReviewRequests.push(request)
              }),
            readPullRequestFeedback: (request) =>
              Effect.sync(() => {
                readPullRequestFeedbackRequests.push(request)
                return options.pullRequestFeedbackByKey?.[makePullRequestKey(request)]
                  ?? pullRequestFeedback({
                    number: request.pullRequestNumber,
                    url: `https://github.com/${request.repo}/pull/${request.pullRequestNumber}`,
                  })
              }),
            removePullRequestLabel: () => Effect.die("not used in this test"),
            requestPullRequestReview: options.requestPullRequestReview
              ?? ((request) =>
                Effect.sync(() => {
                  requestedReviews.push(request)
                })),
            viewCurrentPullRequest: () =>
              Effect.succeed(
                options.currentPullRequest === undefined || options.currentPullRequest === null
                  ? Option.none()
                  : Option.some(options.currentPullRequest),
              ),
          }),
        ),
        Layer.succeed(
          Linear,
          Linear.of({
            authenticate: Effect.die("not used in this test"),
            commentOnIssue: () => Effect.void,
            issues: (request) =>
              Effect.succeed(filterIssuesByWorkspace(
                options.issues ?? [issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, title: "Example issue" })],
                request?.workspaceSlug,
              )),
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
            buildMergeConflictPrompt: (request) =>
              Effect.sync(() => {
                mergeConflictPromptRequests.push(request)
                return {
                  prompt: "Resolve the merge conflicts.",
                  promptFileContents: "# Pull request merge conflict\n\nIdentifier: ENG-1\n",
                }
              }),
            buildReviewPrompt: (request) =>
              Effect.sync(() => {
                reviewPromptRequests.push(request)
                return {
                  prompt: "Address the Greptile review.",
                  promptFileContents: "# Pull request review\n\nIdentifier: ENG-1\n",
                }
              }),
          }),
        ),
        Layer.succeed(
          PullRequestStore,
          PullRequestStore.of({
            list: Effect.sync(() => trackedPullRequests),
            markGreptileCompleted: (record) =>
              Effect.sync(() => {
                greptileCompletedPullRequests.push(record)
                if (options.markGreptileCompletedReturnsNull) {
                  return null
                }
                const existing = trackedPullRequests.find((pullRequest) => pullRequest.repo === record.repo && pullRequest.prNumber === record.prNumber) ?? null
                if (existing === null) {
                  return null
                }
                const updated = new OrcaManagedPullRequest({
                  ...existing,
                  greptileCompletedAtMs: record.completedAtMs,
                  lastReviewedAtMs: record.lastReviewedAtMs,
                  updatedAtMs: record.completedAtMs,
                  waitingForGreptileReviewSinceMs: null,
                })
                trackedPullRequests = trackedPullRequests.map((pullRequest) =>
                  pullRequest.repo === record.repo && pullRequest.prNumber === record.prNumber ? updated : pullRequest)
                return updated
              }),
            markGreptileReviewRequested: (request) =>
              Effect.sync(() => {
                recordedGreptileReviewRequests.push(request)
                const existing = trackedPullRequests.find((candidate) => candidate.repo === request.repo && candidate.prNumber === request.prNumber) ?? null
                if (existing === null) {
                  return null
                }
                const updated = new OrcaManagedPullRequest({
                  ...existing,
                  lastReviewedAtMs: request.lastReviewedAtMs,
                  updatedAtMs: 1,
                  waitingForGreptileReviewSinceMs: request.waitingForGreptileReviewSinceMs,
                })
                trackedPullRequests = trackedPullRequests.map((pullRequest) =>
                  pullRequest.repo === request.repo && pullRequest.prNumber === request.prNumber ? updated : pullRequest)
                return updated
              }),
            remove: ({ prNumber, repo }) =>
              Effect.sync(() => {
                removedPullRequests.push(`${repo}#${prNumber}`)
                const nextTrackedPullRequests = trackedPullRequests.filter(
                  (pullRequest) => !(pullRequest.repo === repo && pullRequest.prNumber === prNumber),
                )
                const removed = nextTrackedPullRequests.length !== trackedPullRequests.length
                trackedPullRequests = nextTrackedPullRequests
                return removed
              }),
            upsert: (record) =>
              Effect.sync(() => {
                storedPullRequests.push(record)
                const created = new OrcaManagedPullRequest({
                  branch: record.branch,
                  createdAtMs: 1,
                  greptileCompletedAtMs: record.greptileCompletedAtMs ?? null,
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
                trackedPullRequests = [
                  ...trackedPullRequests.filter(
                    (pullRequest) => !(pullRequest.repo === created.repo && pullRequest.prNumber === created.prNumber),
                  ),
                  created,
                ]
                return created
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
              linearWorkspace: undefined,
              maxWaitingPullRequests: 4,
              repo: "peterje/orca",
              setup: ["bun install"],
              stallTimeoutMinutes: 10,
              verify: ["bun run check"],
              ...options.config,
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
            resume: () => Effect.succeed(worktree),
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
    greptileCompletedAtMs: overrides.greptileCompletedAtMs ?? null,
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
  mergeStateStatus: overrides?.mergeStateStatus ?? "CLEAN",
  number: overrides?.number ?? 1,
  reviewThreads: overrides?.reviewThreads ?? [],
  reviews: overrides?.reviews ?? [],
  state: overrides?.state ?? "OPEN",
  url: overrides?.url ?? "https://github.com/peterje/orca/pull/1",
})

const makePullRequestKey = (pullRequest: { readonly prNumber?: number; readonly pullRequestNumber?: number; readonly repo: string }) =>
  `${pullRequest.repo}#${pullRequest.prNumber ?? pullRequest.pullRequestNumber}`

const comment = (overrides?: Partial<PullRequestFeedback["comments"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Comment",
  createdAtMs: overrides?.createdAtMs ?? 1,
  id: overrides?.id ?? "comment-1",
  isBot: overrides?.isBot ?? false,
})

const review = (overrides?: Partial<PullRequestFeedback["reviews"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Review",
  createdAtMs: overrides?.createdAtMs ?? 1,
  id: overrides?.id ?? "review-1",
  isBot: overrides?.isBot ?? false,
})

const reviewComment = (overrides?: Partial<PullRequestFeedback["reviewThreads"][number]["comments"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Review comment",
  createdAtMs: overrides?.createdAtMs ?? 1,
  diffHunk: overrides?.diffHunk ?? "@@ -1,1 +1,1 @@",
  id: overrides?.id ?? "review-comment-1",
  isBot: overrides?.isBot ?? false,
  originalLine: overrides?.originalLine ?? 1,
  path: overrides?.path ?? "apps/cli/src/runner.ts",
})

const makeManagedWorktree = (options: {
  readonly baseSyncMergeExitCode?: number | undefined
  readonly directory: string
  readonly unresolvedConflictFiles?: ReadonlyArray<string> | undefined
  readonly unresolvedConflictFilesAfterFirstRead?: ReadonlyArray<string> | undefined
  readonly weaveDriver?: string | null | undefined
  readonly weaveVersionExitCode?: number | undefined
  readonly worktreeCommandLog?: Array<string> | undefined
  readonly worktreeStatus?: string | undefined
}): ManagedWorktree => {
  let unresolvedConflictReadCount = 0

  return {
    branch: "orca/eng-1-example-issue",
    directory: options.directory,
    remove: Effect.void,
    run: (command) =>
      Effect.sync(() => {
        options.worktreeCommandLog?.push(command)
        if (command === "weave --version >/dev/null 2>&1") {
          return options.weaveVersionExitCode ?? 0
        }
        if (command.startsWith("git merge --no-commit --no-ff ")) {
          return options.baseSyncMergeExitCode ?? 0
        }
        return 0
      }),
    runString: (command) => {
      if (command === "git status --porcelain --untracked-files=all") {
        return Effect.succeed(options.worktreeStatus ?? " M apps/cli/src/runner.ts\n")
      }
      if (command === "git config --get merge.weave.driver") {
        return Effect.succeed(options.weaveDriver === null ? "" : `${options.weaveDriver ?? "/usr/local/bin/weave-driver"}\n`)
      }
      if (command === "git diff --name-only --diff-filter=U") {
        unresolvedConflictReadCount += 1
        return Effect.succeed(
          (unresolvedConflictReadCount === 1 ? options.unresolvedConflictFiles : options.unresolvedConflictFilesAfterFirstRead)?.join("\n") ?? "",
        )
      }
      if (command.startsWith("git rev-list --count ")) {
        return Effect.succeed("0\n")
      }
      return Effect.die(`Unexpected command: ${command}`)
    },
  }
}

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
  workspaceSlug: overrides.workspaceSlug ?? "peteredm",
})

const filterIssuesByWorkspace = (issues: ReadonlyArray<LinearIssue>, workspaceSlug: string | undefined) => {
  const normalizedWorkspaceSlug = workspaceSlug?.trim().toLowerCase()

  return normalizedWorkspaceSlug === undefined || normalizedWorkspaceSlug.length === 0
    ? issues
    : issues.filter((issue) => ("workspaceSlug" in issue ? String((issue as LinearIssue & { readonly workspaceSlug?: string }).workspaceSlug ?? "").toLowerCase() : "") === normalizedWorkspaceSlug)
}

const withTempDirectory = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "orca-runner-"))),
    (tempDirectory) =>
      Effect.sync(() => {
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(use))
