import { Effect } from "effect"
import type { GitHubService, PullRequestFeedback } from "./github.ts"
import type { OrcaManagedPullRequest, PullRequestStoreService } from "./pull-request-store.ts"
import { comparePendingPullRequestReviews, findPendingPullRequestReview, type PendingPullRequestReview } from "./review-queue.ts"

type TrackedPullRequestFeedback = {
  readonly feedback: PullRequestFeedback
  readonly pullRequest: OrcaManagedPullRequest
}

export type TrackedPullRequestQueue = {
  readonly openPullRequests: ReadonlyArray<OrcaManagedPullRequest>
  readonly pendingReviews: ReadonlyArray<PendingPullRequestReview>
  readonly pullRequestsNeedingBaseSync: ReadonlyArray<OrcaManagedPullRequest>
  readonly stalePullRequests: ReadonlyArray<OrcaManagedPullRequest>
  readonly waitingForReviewPullRequests: ReadonlyArray<OrcaManagedPullRequest>
}

export const loadTrackedPullRequestQueue = (options: {
  readonly github: Pick<GitHubService, "readPullRequestFeedback">
  readonly pullRequestStore: Pick<PullRequestStoreService, "list" | "remove">
}) =>
  Effect.gen(function* () {
    const trackedPullRequests = yield* options.pullRequestStore.list
    const trackedPullRequestFeedback = yield* Effect.forEach(
      trackedPullRequests,
      (pullRequest) =>
        options.github.readPullRequestFeedback({
          pullRequestNumber: pullRequest.prNumber,
          repo: pullRequest.repo,
        }).pipe(Effect.map((feedback) => ({ feedback, pullRequest }))),
      { concurrency: 1 },
    )
    const queue = summarizeTrackedPullRequestQueue(trackedPullRequestFeedback)

    yield* Effect.forEach(
      queue.stalePullRequests,
      (pullRequest) =>
        options.pullRequestStore.remove({
          prNumber: pullRequest.prNumber,
          repo: pullRequest.repo,
        }),
      { concurrency: 1, discard: true },
    )

    return queue
  })

export const summarizeTrackedPullRequestQueue = (
  trackedPullRequests: ReadonlyArray<TrackedPullRequestFeedback>,
): TrackedPullRequestQueue => {
  const openPullRequests: Array<OrcaManagedPullRequest> = []
  const pendingReviews: Array<PendingPullRequestReview> = []
  const pullRequestsNeedingBaseSync: Array<OrcaManagedPullRequest> = []
  const stalePullRequests: Array<OrcaManagedPullRequest> = []
  const waitingForReviewPullRequests: Array<OrcaManagedPullRequest> = []

  for (const trackedPullRequest of trackedPullRequests) {
    if (!isOpenPullRequest(trackedPullRequest.feedback)) {
      stalePullRequests.push(trackedPullRequest.pullRequest)
      continue
    }

    openPullRequests.push(trackedPullRequest.pullRequest)

    if (needsBaseSync(trackedPullRequest.feedback)) {
      pullRequestsNeedingBaseSync.push(trackedPullRequest.pullRequest)
      continue
    }

    const pendingReview = findPendingPullRequestReview(trackedPullRequest)
    if (pendingReview !== null) {
      pendingReviews.push(pendingReview)
      continue
    }

    if (!isTrackedForGreptileLoop(trackedPullRequest.pullRequest)) {
      continue
    }

    if (trackedPullRequest.pullRequest.waitingForGreptileReviewSinceMs !== null) {
      waitingForReviewPullRequests.push(trackedPullRequest.pullRequest)
    }
  }

  pendingReviews.sort(comparePendingPullRequestReviews)

  return {
    openPullRequests,
    pendingReviews,
    pullRequestsNeedingBaseSync,
    stalePullRequests,
    waitingForReviewPullRequests,
  }
}

const isOpenPullRequest = (feedback: PullRequestFeedback) => feedback.state.toUpperCase() === "OPEN"

const mergeStatesNeedingBaseSync = new Set(["BEHIND", "DIRTY"])

const needsBaseSync = (feedback: PullRequestFeedback) =>
  mergeStatesNeedingBaseSync.has(feedback.mergeStateStatus.toUpperCase())

const isTrackedForGreptileLoop = (pullRequest: OrcaManagedPullRequest) =>
  pullRequest.greptileCompletedAtMs === null
