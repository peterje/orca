import type {
  PullRequestComment,
  PullRequestFeedback,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread,
} from "./github.ts"
import type { OrcaManagedPullRequest } from "./pull-request-store.ts"

type PendingGreptileReviewScore = {
  readonly maximum: number
  readonly value: number
}

export type PendingPullRequestReview = {
  readonly feedback: PullRequestFeedback
  readonly feedbackMarkdown: string
  readonly latestFeedbackAtMs: number
  readonly pullRequest: OrcaManagedPullRequest
  readonly reviewScore: PendingGreptileReviewScore
}

export type GreptileReviewScore = {
  readonly achieved: number
  readonly review: PullRequestReview
  readonly total: number
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

  const since = Math.max(
    options.pullRequest.lastReviewedAtMs ?? 0,
    options.pullRequest.waitingForGreptileReviewSinceMs ?? 0,
  )
  const greptileReviews = options.feedback.reviews.filter((review) => review.body.trim().length > 0 && isGreptileEntry(review))
  const latestGreptileReview = findLatestEntry(greptileReviews)
  if (latestGreptileReview === null || latestGreptileReview.createdAtMs <= since) {
    return null
  }

  const reviewScore = parsePendingGreptileReviewScore(latestGreptileReview.body)
  if (reviewScore === null || reviewScore.value >= reviewScore.maximum) {
    return null
  }

  const unresolvedThreads = options.feedback.reviewThreads
    .map(stripGreptileThreadComments)
    .filter((thread): thread is PullRequestReviewThread => thread !== null)
    .filter((thread) => !thread.isCollapsed && !thread.isResolved)
  const recentUnresolvedThreads = unresolvedThreads.filter((thread) =>
    thread.comments.some((comment) => comment.createdAtMs > since))
  const recentComments = options.feedback.comments.filter(
    (comment) => comment.createdAtMs > since && isGreptileEntry(comment),
  )
  const recentReviews = greptileReviews.filter((review) => review.createdAtMs > since)
  const feedbackPresent = recentUnresolvedThreads.length > 0
    || recentComments.length > 0
    || recentReviews.length > 0

  if (!feedbackPresent) {
    return null
  }

  const latestFeedbackAtMs = Math.max(
    latestGreptileReview.createdAtMs,
    ...recentComments.map((comment) => comment.createdAtMs),
    ...recentReviews.map((review) => review.createdAtMs),
    ...recentUnresolvedThreads.flatMap((thread) => thread.comments.map((comment) => comment.createdAtMs)),
  )

  return {
    feedback: options.feedback,
    feedbackMarkdown: renderGreptileReviewMarkdown({
      comments: recentComments,
      reviews: recentReviews,
      reviewScore,
      unresolvedThreads: recentUnresolvedThreads,
    }),
    latestFeedbackAtMs,
    pullRequest: options.pullRequest,
    reviewScore,
  }
}

export const findLatestGreptileReviewScore = (feedback: PullRequestFeedback): GreptileReviewScore | null => {
  const latestReview = findLatestEntry(feedback.reviews.filter((review) => review.body.trim().length > 0 && isGreptileEntry(review)))

  if (latestReview === null) {
    return null
  }

  const score = parseGreptileScore(latestReview.body)
  if (score === null) {
    return null
  }

  return {
    ...score,
    review: latestReview,
  }
}

export const hasLatestGreptileReviewScore = (feedback: PullRequestFeedback, achieved: number, total: number) => {
  const score = findLatestGreptileReviewScore(feedback)
  return score !== null && score.achieved === achieved && score.total === total
}

const greptileAuthorPrefixes = ["greptile-apps", "greptile-apps-staging"]

const isGreptileEntry = (entry: { readonly authorLogin: string }) =>
  greptileAuthorPrefixes.some((prefix) => entry.authorLogin.toLowerCase().startsWith(prefix))

const stripGreptileThreadComments = (thread: PullRequestReviewThread): PullRequestReviewThread | null => {
  const comments = thread.comments.filter(isGreptileEntry)
  if (comments.length === 0) {
    return null
  }
  return {
    ...thread,
    comments,
  }
}

const renderGreptileReviewMarkdown = (options: {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly reviews: ReadonlyArray<PullRequestReview>
  readonly reviewScore: PendingGreptileReviewScore
  readonly unresolvedThreads: ReadonlyArray<PullRequestReviewThread>
}) => {
  const sections = [
    "# Greptile review",
    "",
    `Confidence: ${options.reviewScore.value}/${options.reviewScore.maximum}`,
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
    sections.push("", "No Greptile feedback found.")
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

const findLatestEntry = <A extends { readonly createdAtMs: number }>(entries: ReadonlyArray<A>): A | null => {
  let latest: A | null = null

  for (const entry of entries) {
    if (latest === null || entry.createdAtMs > latest.createdAtMs) {
      latest = entry
    }
  }

  return latest
}

const parsePendingGreptileReviewScore = (body: string): PendingGreptileReviewScore | null => {
  const score = parseGreptileScore(body)
  return score === null ? null : { maximum: score.total, value: score.achieved }
}

const parseGreptileScore = (body: string): Omit<GreptileReviewScore, "review"> | null => {
  const match = body.match(/\b(?:confidence|score)\b[^\d]*(\d+)\s*\/\s*(\d+)\b/i)
  if (match === null) {
    return null
  }

  const achieved = Number(match[1])
  const total = Number(match[2])

  if (!Number.isFinite(achieved) || !Number.isFinite(total) || total <= 0) {
    return null
  }

  return { achieved, total }
}
