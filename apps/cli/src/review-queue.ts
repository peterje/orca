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
  readonly trigger: "feedback" | "label" | "mention"
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
  const isExternalReviewer = (entry: { readonly authorLogin: string; readonly isBot: boolean }) =>
    entry.authorLogin !== options.feedback.authorLogin && !entry.isBot
  const unresolvedThreads = options.feedback.reviewThreads
    .map((thread) => stripAuthorOnlyThread(thread, options.feedback.authorLogin))
    .filter((thread): thread is PullRequestReviewThread => thread !== null)
    .filter((thread) => !thread.isCollapsed && !thread.isResolved)
  const recentComments = options.feedback.comments.filter(
    (comment) => comment.createdAtMs > since && isExternalReviewer(comment),
  )
  const recentReviews = options.feedback.reviews.filter(
    (review) => review.body.trim().length > 0 && review.createdAtMs > since && isExternalReviewer(review),
  )
  const mentionTriggered = hasMentionTrigger({
    comments: options.feedback.comments,
    reviews: options.feedback.reviews,
    threads: options.feedback.reviewThreads,
    since,
  })
  const automaticFeedbackPresent = unresolvedThreads.length > 0 || recentComments.length > 0 || recentReviews.length > 0

  if (!automaticFeedbackPresent) {
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
      trigger: triggerLabelPresent ? "label" : mentionTriggered ? "mention" : "feedback",
      triggerLabelPresent,
      unresolvedThreads,
    }),
    latestFeedbackAtMs,
    pullRequest: options.pullRequest,
    trigger: triggerLabelPresent ? "label" : mentionTriggered ? "mention" : "feedback",
    triggerLabelPresent,
  }
}

const hasMentionTrigger = (options: {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly reviews: ReadonlyArray<PullRequestReview>
  readonly since: number
  readonly threads: ReadonlyArray<PullRequestReviewThread>
}) =>
  options.comments.some((comment) => !comment.isBot && comment.createdAtMs > options.since && containsOrcaMention(comment.body))
  || options.reviews.some((review) => !review.isBot && review.createdAtMs > options.since && containsOrcaMention(review.body))
  || options.threads.some((thread) =>
    thread.comments.some((comment) => !comment.isBot && comment.createdAtMs > options.since && containsOrcaMention(comment.body)))

const containsOrcaMention = (body: string) => /(^|\W)@orca\b/i.test(body)

const stripAuthorOnlyThread = (thread: PullRequestReviewThread, authorLogin: string): PullRequestReviewThread | null => {
  const comments = thread.comments.filter((comment) => comment.authorLogin !== authorLogin && !comment.isBot)
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
  readonly trigger: PendingPullRequestReview["trigger"]
  readonly triggerLabelPresent: boolean
  readonly unresolvedThreads: ReadonlyArray<PullRequestReviewThread>
}) => {
  const sections = [
    "# PR feedback",
    "",
    `Trigger: ${renderTrigger(options.trigger)}`,
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

const renderTrigger = (trigger: PendingPullRequestReview["trigger"]) => {
  switch (trigger) {
    case "label":
      return `label \`${reviewTriggerLabel}\``
    case "mention":
      return "recent `@orca` mention"
    case "feedback":
      return "recent reviewer feedback"
  }
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
