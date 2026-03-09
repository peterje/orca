import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { PullRequestFeedback } from "./github.ts"
import { OrcaManagedPullRequest } from "./pull-request-store.ts"
import { loadTrackedPullRequestQueue } from "./tracked-pull-request-queue.ts"

describe("tracked pull request queue", () => {
  it.effect("prunes stale tracked pull requests and keeps waiting and follow-up states separate", () =>
    Effect.gen(function* () {
      const removedPullRequests: Array<string> = []
      const queue = yield* loadTrackedPullRequestQueue({
        github: {
          readPullRequestFeedback: ({ pullRequestNumber, repo }) =>
            Effect.succeed(
              feedbackByKey[`${repo}#${pullRequestNumber}`]
              ?? pullRequestFeedback({ number: pullRequestNumber, url: `https://github.com/${repo}/pull/${pullRequestNumber}` }),
            ),
        },
        pullRequestStore: {
          list: Effect.succeed([
            trackedPullRequest({ issueId: "issue-1", issueIdentifier: "ENG-1", prNumber: 41, prUrl: "https://github.com/peterje/orca/pull/41", waitingForGreptileReviewSinceMs: 1 }),
            trackedPullRequest({ issueId: "issue-2", issueIdentifier: "ENG-2", prNumber: 42, prUrl: "https://github.com/peterje/orca/pull/42", waitingForGreptileReviewSinceMs: 2 }),
            trackedPullRequest({ issueId: "issue-3", issueIdentifier: "ENG-3", prNumber: 43, prUrl: "https://github.com/peterje/orca/pull/43", waitingForGreptileReviewSinceMs: 3, lastReviewedAtMs: 5 }),
            trackedPullRequest({ issueId: "issue-4", issueIdentifier: "ENG-4", prNumber: 44, prUrl: "https://github.com/peterje/orca/pull/44", waitingForGreptileReviewSinceMs: 4 }),
          ]),
          remove: ({ prNumber, repo }) =>
            Effect.sync(() => {
              removedPullRequests.push(`${repo}#${prNumber}`)
              return true
            }),
        },
      })

      expect(removedPullRequests).toEqual(["peterje/orca#41", "peterje/orca#42"])
      expect(queue.openPullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-3", "ENG-4"])
      expect(queue.pendingReviews.map((review) => review.pullRequest.issueIdentifier)).toEqual(["ENG-3"])
      expect(queue.waitingForReviewPullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-4"])
      expect(queue.stalePullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-1", "ENG-2"])
    }))
})

const feedbackByKey: Readonly<Record<string, PullRequestFeedback>> = {
  "peterje/orca#41": pullRequestFeedback({ number: 41, state: "CLOSED", url: "https://github.com/peterje/orca/pull/41" }),
  "peterje/orca#42": pullRequestFeedback({ number: 42, state: "MERGED", url: "https://github.com/peterje/orca/pull/42" }),
  "peterje/orca#43": pullRequestFeedback({
    authorLogin: "author",
    comments: [
      {
        authorLogin: "reviewer",
        body: "Please rerun this after the rename.",
        createdAtMs: 10,
        id: "comment-1",
        isBot: false,
      },
    ],
    number: 43,
    reviews: [
      {
        authorLogin: "greptile-apps[bot]",
        body: "Confidence: 4/5",
        createdAtMs: 10,
        id: "review-43",
        isBot: true,
      },
    ],
    url: "https://github.com/peterje/orca/pull/43",
  }),
  "peterje/orca#44": pullRequestFeedback({ number: 44, url: "https://github.com/peterje/orca/pull/44" }),
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

function pullRequestFeedback(overrides?: Partial<PullRequestFeedback>): PullRequestFeedback {
  return {
    authorLogin: overrides?.authorLogin ?? "author",
    comments: overrides?.comments ?? [],
    isDraft: overrides?.isDraft ?? true,
    labels: overrides?.labels ?? [],
    number: overrides?.number ?? 1,
    reviewThreads: overrides?.reviewThreads ?? [],
    reviews: overrides?.reviews ?? [],
    state: overrides?.state ?? "OPEN",
    url: overrides?.url ?? "https://github.com/peterje/orca/pull/1",
  }
}
