import type {
  PullRequestComment,
  PullRequestFeedback,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread,
} from "./github.ts"
import type { OrcaManagedPullRequest } from "./pull-request-store.ts"

export const reviewTriggerLabel = "orca-review"

export type PendingPullRequestReview = {
  readonly feedback: PullRequestFeedback
  readonly feedbackMarkdown: string
  readonly latestFeedbackAtMs: number
  readonly pullRequest: OrcaManagedPullRequest
  readonly trigger: "label" | "mention"
  readonly triggerLabelPresent: boolean
}

export const findPendingPullRequestReview = (options: {
  readonly feedback: PullRequestFeedback
  readonly pullRequest: OrcaManagedPullRequest
}): PendingPullRequestReview | null => {
  if (options.feedback.state.toUpperCase() !== "OPEN") {
    return null
  }

  const since = options.pullRequest.lastReviewedAtMs ?? 0
  const triggerLabelPresent = options.feedback.labels.some((label) => label.toLowerCase() === reviewTriggerLabel)
  const unresolvedThreads = options.feedback.reviewThreads
    .map(stripBotOnlyThread)
    .filter((thread): thread is PullRequestReviewThread => thread !== null)
    .filter((thread) => !thread.isCollapsed && !thread.isResolved)
  const recentComments = options.feedback.comments.filter((comment) => !comment.isBot && comment.createdAtMs > since)
  const recentReviews = options.feedback.reviews.filter(
    (review) => !review.isBot && review.body.trim().length > 0 && review.createdAtMs > since,
  )
  const mentionTriggered = hasMentionTrigger({
    comments: recentComments,
    reviews: recentReviews,
    threads: unresolvedThreads,
    since,
  })

  if (!triggerLabelPresent && !mentionTriggered) {
    return null
  }

  if (unresolvedThreads.length === 0 && recentComments.length === 0 && recentReviews.length === 0) {
    return null
  }

  const latestFeedbackAtMs = Math.max(
    0,
    ...recentComments.map((comment) => comment.createdAtMs),
    ...recentReviews.map((review) => review.createdAtMs),
    ...unresolvedThreads.flatMap((thread) => thread.comments.map((comment) => comment.createdAtMs)),
  )

  return {
    feedback: options.feedback,
    feedbackMarkdown: renderReviewFeedbackMarkdown({
      comments: recentComments,
      reviews: recentReviews,
      triggerLabelPresent,
      unresolvedThreads,
    }),
    latestFeedbackAtMs,
    pullRequest: options.pullRequest,
    trigger: triggerLabelPresent ? "label" : "mention",
    triggerLabelPresent,
  }
}

const hasMentionTrigger = (options: {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly reviews: ReadonlyArray<PullRequestReview>
  readonly since: number
  readonly threads: ReadonlyArray<PullRequestReviewThread>
}) =>
  options.comments.some((comment) => comment.createdAtMs > options.since && containsOrcaMention(comment.body))
  || options.reviews.some((review) => review.createdAtMs > options.since && containsOrcaMention(review.body))
  || options.threads.some((thread) =>
    thread.comments.some((comment) => comment.createdAtMs > options.since && containsOrcaMention(comment.body)))

const containsOrcaMention = (body: string) => /(^|\W)@orca\b/i.test(body)

const stripBotOnlyThread = (thread: PullRequestReviewThread): PullRequestReviewThread | null => {
  const comments = thread.comments.filter((comment) => !comment.isBot)
  if (comments.length === 0) {
    return null
  }
  return {
    ...thread,
    comments,
  }
}

const renderReviewFeedbackMarkdown = (options: {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly reviews: ReadonlyArray<PullRequestReview>
  readonly triggerLabelPresent: boolean
  readonly unresolvedThreads: ReadonlyArray<PullRequestReviewThread>
}) => {
  const sections = [
    "# PR feedback",
    "",
    `Trigger: ${options.triggerLabelPresent ? `label \`${reviewTriggerLabel}\`` : "recent `@orca` mention"}`,
  ]

  if (options.unresolvedThreads.length > 0) {
    sections.push("", "## Unresolved review threads", "")
    sections.push(...options.unresolvedThreads.map(renderReviewThread))
  }

  if (options.reviews.length > 0) {
    sections.push("", "## Reviews", "", "<reviews>")
    sections.push(...options.reviews.map(renderReview))
    sections.push("</reviews>")
  }

  if (options.comments.length > 0) {
    sections.push("", "## General comments", "", "<comments>")
    sections.push(...options.comments.map(renderGeneralComment))
    sections.push("</comments>")
  }

  if (sections.length === 3) {
    sections.push("", "No review feedback found.")
  }

  return sections.join("\n")
}

const renderReviewThread = (thread: PullRequestReviewThread) =>
  renderReviewComment(thread.comments[0]!, thread.comments.slice(1))

const renderReviewComment = (
  comment: PullRequestReviewComment,
  followup: ReadonlyArray<PullRequestReviewComment>,
) => `<comment author="${comment.authorLogin}" path="${comment.path}">
  <diffHunk><![CDATA[
${comment.diffHunk}
  ]]></diffHunk>
  ${comment.originalLine === null ? "" : `<lineNumber>${comment.originalLine}</lineNumber>`}
  <body>${comment.body}</body>${followup.length === 0 ? "" : `

  <followup>${followup
    .map(
      (item) => `
    <comment author="${item.authorLogin}">
      <body>${item.body}</body>
    </comment>`,
    )
    .join("")}
  </followup>`}
</comment>`

const renderReview = (review: PullRequestReview) => `<review author="${review.authorLogin}">
  <body>${review.body}</body>
</review>`

const renderGeneralComment = (comment: PullRequestComment) => `  <comment author="${comment.authorLogin}">
    <body>${comment.body}</body>
  </comment>`
