import type {
  PullRequestFeedback,
} from "./github.ts"
import type { OrcaManagedPullRequest } from "./pull-request-store.ts"
import {
  buildPullRequestReviewPromptInput,
  findLatestGreptileReviewScore,
  hasLatestGreptileReviewScore,
  type GreptileReviewScore,
  type PendingGreptileReviewScore,
} from "./pull-request-review-feedback.ts"

export { findLatestGreptileReviewScore, hasLatestGreptileReviewScore }
export type { GreptileReviewScore, PendingGreptileReviewScore }

export type PendingPullRequestReview = {
  readonly feedback: PullRequestFeedback
  readonly feedbackMarkdown: string
  readonly latestFeedbackAtMs: number
  readonly pullRequest: OrcaManagedPullRequest
  readonly reviewScore: PendingGreptileReviewScore | null
}

export const comparePendingPullRequestReviews = (left: PendingPullRequestReview, right: PendingPullRequestReview) =>
  right.latestFeedbackAtMs - left.latestFeedbackAtMs
  || left.pullRequest.issueIdentifier.localeCompare(right.pullRequest.issueIdentifier)

export const findPendingPullRequestReview = (options: {
  readonly feedback: PullRequestFeedback
  readonly pullRequest: OrcaManagedPullRequest
}): PendingPullRequestReview | null => {
  if (options.feedback.state.toUpperCase() !== "OPEN") {
    return null
  }

  const lastReviewedAtMs = options.pullRequest.lastReviewedAtMs ?? 0
  const reviewPromptInput = buildPullRequestReviewPromptInput({
    feedback: options.feedback,
    greptileSince: Math.max(
      lastReviewedAtMs,
      options.pullRequest.waitingForGreptileReviewSinceMs ?? 0,
    ),
    humanSince: lastReviewedAtMs,
  })

  if (reviewPromptInput === null) {
    return null
  }

  return {
    feedback: options.feedback,
    feedbackMarkdown: reviewPromptInput.feedbackMarkdown,
    latestFeedbackAtMs: reviewPromptInput.latestFeedbackAtMs,
    pullRequest: options.pullRequest,
    reviewScore: reviewPromptInput.reviewScore,
  }
}
