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

  const since = options.pullRequest.lastReviewedAtMs ?? 0
  const triggerLabelPresent = options.feedback.labels.some((label) => label.toLowerCase() === reviewTriggerLabel)
  const isRelevantFeedback = isRelevantEntry(options.feedback.authorLogin)
  const unresolvedThreads = options.feedback.reviewThreads
    .map((thread) => stripRelevantThreadComments(thread, options.feedback.authorLogin))
    .filter((thread): thread is PullRequestReviewThread => thread !== null)
    .filter((thread) => !thread.isCollapsed && !thread.isResolved)
  const recentUnresolvedThreads = unresolvedThreads.filter((thread) =>
    thread.comments.some((comment) => comment.createdAtMs > since))
  const recentComments = options.feedback.comments.filter(
    (comment) => comment.createdAtMs > since && isRelevantFeedback(comment),
  )
  const recentReviews = options.feedback.reviews.filter(
    (review) => review.body.trim().length > 0 && review.createdAtMs > since && isRelevantFeedback(review),
  )
  const mentionTriggered = hasMentionTrigger({
    comments: recentComments,
    reviews: recentReviews,
    threads: recentUnresolvedThreads,
    since,
  })
  const feedbackPresent = (triggerLabelPresent ? unresolvedThreads : recentUnresolvedThreads).length > 0
    || recentComments.length > 0
    || recentReviews.length > 0

  if (!feedbackPresent) {
    return null
  }

  const trigger = triggerLabelPresent ? "label" : mentionTriggered ? "mention" : "feedback"

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
      trigger,
      triggerLabelPresent,
      unresolvedThreads: triggerLabelPresent ? unresolvedThreads : recentUnresolvedThreads,
    }),
    latestFeedbackAtMs,
    pullRequest: options.pullRequest,
    trigger,
    triggerLabelPresent,
  }
}

const hasMentionTrigger = (options: {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly reviews: ReadonlyArray<PullRequestReview>
  readonly since: number
  readonly threads: ReadonlyArray<PullRequestReviewThread>
}) =>
  options.comments.some((comment) => containsOrcaMention(comment.body))
  || options.reviews.some((review) => containsOrcaMention(review.body))
  || options.threads.some((thread) =>
    thread.comments.some((comment) => comment.createdAtMs > options.since && containsOrcaMention(comment.body)))

const containsOrcaMention = (body: string) => /(^|\W)@orca\b/i.test(body)

const isRelevantEntry = (authorLogin: string) =>
  (entry: { readonly authorLogin: string; readonly body: string; readonly isBot: boolean }) =>
    !entry.isBot && (entry.authorLogin !== authorLogin || containsOrcaMention(entry.body))

const stripRelevantThreadComments = (thread: PullRequestReviewThread, authorLogin: string): PullRequestReviewThread | null => {
  const comments = thread.comments.filter(isRelevantEntry(authorLogin))
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
