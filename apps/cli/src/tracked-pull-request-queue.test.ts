import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { PullRequestFeedback } from "./github.ts"
import { OrcaManagedPullRequest } from "./pull-request-store.ts"
import { loadTrackedPullRequestQueue, summarizeTrackedPullRequestQueue } from "./tracked-pull-request-queue.ts"

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
      expect(queue.pullRequestsNeedingBaseSync).toEqual([])
      expect(queue.waitingForReviewPullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-4"])
      expect(queue.stalePullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-1", "ENG-2"])
    }))

  it.effect("keeps terminal pull requests out of the Greptile loop after reload", () =>
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
            trackedPullRequest({
              greptileCompletedAtMs: 20,
              issueId: "issue-5",
              issueIdentifier: "ENG-5",
              lastReviewedAtMs: 15,
              prNumber: 47,
              prUrl: "https://github.com/peterje/orca/pull/47",
            }),
          ]),
          remove: ({ prNumber, repo }) =>
            Effect.sync(() => {
              removedPullRequests.push(`${repo}#${prNumber}`)
              return true
            }),
        },
      })

      expect(queue.openPullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-5"])
      expect(queue.pendingReviews).toEqual([])
      expect(queue.waitingForReviewPullRequests).toEqual([])
      expect(queue.stalePullRequests).toEqual([])
      expect(removedPullRequests).toEqual([])
    }))

  it.effect("creates pending review work for completed pull requests with unresolved human feedback", () =>
    Effect.gen(function* () {
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
            trackedPullRequest({
              greptileCompletedAtMs: 30,
              issueId: "issue-8",
              issueIdentifier: "ENG-8",
              lastReviewedAtMs: 20,
              prNumber: 50,
              prUrl: "https://github.com/peterje/orca/pull/50",
            }),
          ]),
          remove: () => Effect.succeed(false),
        },
      })

      expect(queue.pendingReviews.map((review) => review.pullRequest.issueIdentifier)).toEqual(["ENG-8"])
      expect(queue.waitingForReviewPullRequests).toEqual([])
    }))

  it.effect("re-enters completed pull requests when human and Greptile feedback both arrive", () =>
    Effect.gen(function* () {
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
            trackedPullRequest({
              greptileCompletedAtMs: 30,
              issueId: "issue-9",
              issueIdentifier: "ENG-9",
              lastReviewedAtMs: 20,
              prNumber: 51,
              prUrl: "https://github.com/peterje/orca/pull/51",
            }),
          ]),
          remove: () => Effect.succeed(false),
        },
      })

      expect(queue.pendingReviews.map((review) => review.pullRequest.issueIdentifier)).toEqual(["ENG-9"])
      expect(queue.pendingReviews[0]?.reviewScore).toEqual({ maximum: 5, value: 4 })
      expect(queue.waitingForReviewPullRequests).toEqual([])
    }))

  it.effect("prunes terminal pull requests that were closed or merged before reload", () =>
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
            trackedPullRequest({
              greptileCompletedAtMs: 20,
              issueId: "issue-6",
              issueIdentifier: "ENG-6",
              lastReviewedAtMs: 15,
              prNumber: 48,
              prUrl: "https://github.com/peterje/orca/pull/48",
            }),
            trackedPullRequest({
              greptileCompletedAtMs: 21,
              issueId: "issue-7",
              issueIdentifier: "ENG-7",
              lastReviewedAtMs: 16,
              prNumber: 49,
              prUrl: "https://github.com/peterje/orca/pull/49",
            }),
          ]),
          remove: ({ prNumber, repo }) =>
            Effect.sync(() => {
              removedPullRequests.push(`${repo}#${prNumber}`)
              return true
            }),
        },
      })

      expect(queue.openPullRequests).toEqual([])
      expect(queue.pendingReviews).toEqual([])
      expect(queue.waitingForReviewPullRequests).toEqual([])
      expect(queue.stalePullRequests.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-6", "ENG-7"])
      expect(removedPullRequests).toEqual(["peterje/orca#48", "peterje/orca#49"])
    }))

  it.effect("separates tracked pull requests that need a base sync from review follow-up work", () =>
    Effect.gen(function* () {
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
            trackedPullRequest({ issueId: "issue-5", issueIdentifier: "ENG-5", prNumber: 45, prUrl: "https://github.com/peterje/orca/pull/45", waitingForGreptileReviewSinceMs: 5 }),
            trackedPullRequest({ issueId: "issue-6", issueIdentifier: "ENG-6", prNumber: 46, prUrl: "https://github.com/peterje/orca/pull/46", waitingForGreptileReviewSinceMs: 6 }),
          ]),
          remove: () => Effect.succeed(false),
        },
      })

      expect(queue.pullRequestsNeedingBaseSync.map((pullRequest) => pullRequest.issueIdentifier)).toEqual(["ENG-5", "ENG-6"])
      expect(queue.pendingReviews).toEqual([])
      expect(queue.waitingForReviewPullRequests).toEqual([])
    }))

  it("throws when a completed pull request still claims to be waiting for Greptile", () => {
    expect(() =>
      summarizeTrackedPullRequestQueue([
        {
          feedback: pullRequestFeedback({ number: 52, url: "https://github.com/peterje/orca/pull/52" }),
          pullRequest: trackedPullRequest({
            greptileCompletedAtMs: 30,
            issueId: "issue-10",
            issueIdentifier: "ENG-10",
            prNumber: 52,
            prUrl: "https://github.com/peterje/orca/pull/52",
            waitingForGreptileReviewSinceMs: 20,
          }),
        },
      ]),
    ).toThrow("marked greptile-complete but still waiting for greptile review")
  })
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
        updatedAtMs: 10,
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
        updatedAtMs: 10,
      },
    ],
    url: "https://github.com/peterje/orca/pull/43",
  }),
  "peterje/orca#44": pullRequestFeedback({ number: 44, url: "https://github.com/peterje/orca/pull/44" }),
  "peterje/orca#45": pullRequestFeedback({ mergeStateStatus: "BEHIND", number: 45, url: "https://github.com/peterje/orca/pull/45" }),
  "peterje/orca#46": pullRequestFeedback({ mergeStateStatus: "DIRTY", number: 46, url: "https://github.com/peterje/orca/pull/46" }),
  "peterje/orca#47": pullRequestFeedback({
    comments: [
      {
        authorLogin: "greptile-apps[bot]",
        body: "One more thing to tighten up.",
        createdAtMs: 25,
        id: "comment-47",
        isBot: true,
        updatedAtMs: 25,
      },
    ],
    number: 47,
    reviews: [
      {
        authorLogin: "greptile-apps[bot]",
        // 5/5 keeps this fixture out of pendingReviews after the queue checks for
        // fresh review work before it decides whether the PR is still waiting on Greptile.
        body: "Confidence: 5/5",
        createdAtMs: 24,
        id: "review-47",
        isBot: true,
        updatedAtMs: 24,
      },
    ],
    url: "https://github.com/peterje/orca/pull/47",
  }),
  "peterje/orca#48": pullRequestFeedback({ number: 48, state: "CLOSED", url: "https://github.com/peterje/orca/pull/48" }),
  "peterje/orca#49": pullRequestFeedback({ number: 49, state: "MERGED", url: "https://github.com/peterje/orca/pull/49" }),
  "peterje/orca#50": pullRequestFeedback({
    comments: [
      {
        authorLogin: "reviewer",
        body: "Please keep the human-approved wording here.",
        createdAtMs: 40,
        id: "comment-50",
        isBot: false,
        updatedAtMs: 40,
      },
    ],
    number: 50,
    url: "https://github.com/peterje/orca/pull/50",
  }),
  "peterje/orca#51": pullRequestFeedback({
    comments: [
      {
        authorLogin: "reviewer",
        body: "Keep the reviewer-approved copy.",
        createdAtMs: 40,
        id: "comment-51",
        isBot: false,
        updatedAtMs: 40,
      },
    ],
    number: 51,
    reviews: [
      {
        authorLogin: "greptile-apps[bot]",
        body: "Confidence: 4/5",
        createdAtMs: 45,
        id: "review-51",
        isBot: true,
        updatedAtMs: 45,
      },
    ],
    url: "https://github.com/peterje/orca/pull/51",
  }),
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

function pullRequestFeedback(overrides?: Partial<PullRequestFeedback>): PullRequestFeedback {
  return {
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
  }
}
