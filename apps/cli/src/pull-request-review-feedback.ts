import type {
  PullRequestComment,
  PullRequestFeedback,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread,
} from "./github.ts"

export type PendingGreptileReviewScore = {
  readonly maximum: number
  readonly value: number
}

export type GreptileReviewScore = {
  readonly achieved: number
  readonly createdAtMs: number
  readonly total: number
}

export type PullRequestReviewPromptInput = {
  readonly feedbackMarkdown: string
  readonly latestFeedbackAtMs: number
  readonly reviewScore: PendingGreptileReviewScore | null
}

type ReviewFeedbackSource = "greptile" | "human"

type ReviewFeedbackComment = PullRequestComment & {
  readonly source: ReviewFeedbackSource
}

type ReviewFeedbackReview = PullRequestReview & {
  readonly source: ReviewFeedbackSource
}

type ReviewFeedbackReviewComment = PullRequestReviewComment & {
  readonly source: ReviewFeedbackSource
}

type ReviewFeedbackThread = {
  readonly comments: ReadonlyArray<ReviewFeedbackReviewComment>
  readonly latestActivityAtMs: number
}

type GreptileScoreEntry =
  | ({ readonly kind: "comment" } & PullRequestComment)
  | ({ readonly kind: "review" } & PullRequestReview)

export const buildPullRequestReviewPromptInput = (options: {
  readonly feedback: PullRequestFeedback
  readonly greptileSince: number
  readonly humanSince: number
}): PullRequestReviewPromptInput | null => {
  const unresolvedThreads = options.feedback.reviewThreads
    .filter((thread) => !thread.isCollapsed && !thread.isResolved)
    .map(classifyReviewThread)
    .filter((thread): thread is ReviewFeedbackThread => thread !== null)
    .sort(compareReviewThreads)

  const humanThreads = unresolvedThreads.filter((thread) => thread.comments.some((comment) => comment.source === "human"))
  const greptileThreads = unresolvedThreads.filter((thread) => thread.comments.every((comment) => comment.source === "greptile"))

  const humanComments = options.feedback.comments
    .filter((comment) => comment.body.trim().length > 0)
    .map(classifyComment)
    .filter((comment) => comment.source === "human" && getEntryActivityAtMs(comment) > options.humanSince)
    .sort(compareEntries)
  const humanReviews = options.feedback.reviews
    .filter((review) => review.body.trim().length > 0)
    .map(classifyReview)
    .filter((review) => review.source === "human" && getEntryActivityAtMs(review) > options.humanSince)
    .sort(compareEntries)

  const greptileComments = options.feedback.comments
    .filter((comment) => comment.body.trim().length > 0)
    .map(classifyComment)
    .filter((comment) => comment.source === "greptile" && getEntryActivityAtMs(comment) > options.greptileSince)
    .sort(compareEntries)
  const greptileReviews = options.feedback.reviews
    .filter((review) => review.body.trim().length > 0)
    .map(classifyReview)
    .filter((review) => review.source === "greptile" && getEntryActivityAtMs(review) > options.greptileSince)
    .sort(compareEntries)

  const latestGreptileScoreEntry = findLatestGreptileScoreEntry(options.feedback)
  const latestGreptileScoreEntryAtMs = latestGreptileScoreEntry === null ? 0 : getEntryActivityAtMs(latestGreptileScoreEntry)
  const reviewScore = latestGreptileScoreEntry === null
    ? null
    : parsePendingGreptileReviewScore(latestGreptileScoreEntry.body)
  const activeGreptileScore = reviewScore !== null && reviewScore.value < reviewScore.maximum ? reviewScore : null

  const promptGreptileComments = activeGreptileScore === null
    ? []
    : includeLatestGreptileScoreComment(greptileComments, latestGreptileScoreEntry, activeGreptileScore)
  const promptGreptileReviews = activeGreptileScore === null
    ? []
    : includeLatestGreptileScoreReview(greptileReviews, latestGreptileScoreEntry, activeGreptileScore)
  const promptGreptileThreads = activeGreptileScore === null ? [] : greptileThreads
  const freshHumanThreadFeedbackAtMs = getFreshThreadActivityAtMs(humanThreads, options.humanSince, "human")
  const freshGreptileThreadFeedbackAtMs = getFreshThreadActivityAtMs(unresolvedThreads, options.greptileSince, "greptile")
  // Once a human thread is in scope, any fresh reply on that thread should advance the
  // review watermark so we do not re-queue the same mixed thread on the next poll.
  const freshHumanThreadWatermarkAtMs = getFreshThreadActivityAtMs(humanThreads, options.humanSince)
  const freshPromptGreptileThreadActivityAtMs = getFreshThreadActivityAtMs(promptGreptileThreads, options.greptileSince)

  const hasFreshHumanFeedback = humanComments.length > 0
    || humanReviews.length > 0
    || freshHumanThreadFeedbackAtMs.length > 0
  const hasFreshGreptileFeedback = activeGreptileScore !== null && (
    latestGreptileScoreEntryAtMs > options.greptileSince
    || greptileComments.length > 0
    || greptileReviews.length > 0
    || freshGreptileThreadFeedbackAtMs.length > 0
  )

  if (!hasFreshHumanFeedback && !hasFreshGreptileFeedback) {
    return null
  }

  const latestFeedbackAtMs = findLatestNumber([
    ...humanComments.map(getEntryActivityAtMs),
    ...humanReviews.map(getEntryActivityAtMs),
    ...freshHumanThreadWatermarkAtMs,
    ...promptGreptileComments.map(getEntryActivityAtMs),
    ...promptGreptileReviews.map(getEntryActivityAtMs),
    ...freshPromptGreptileThreadActivityAtMs,
  ])

  if (latestFeedbackAtMs === null) {
    return null
  }

  return {
    feedbackMarkdown: renderPullRequestReviewMarkdown({
      greptileComments: promptGreptileComments,
      greptileReviews: promptGreptileReviews,
      greptileThreads: promptGreptileThreads,
      humanComments,
      humanReviews,
      humanThreads,
      reviewScore: activeGreptileScore,
    }),
    latestFeedbackAtMs,
    reviewScore: activeGreptileScore,
  }
}

export const findLatestGreptileReviewScore = (feedback: PullRequestFeedback): GreptileReviewScore | null => {
  const latestReview = findLatestGreptileScoreEntry(feedback)

  if (latestReview === null) {
    return null
  }

  const score = parseGreptileScore(latestReview.body)
  if (score === null) {
    return null
  }

  return {
    ...score,
    createdAtMs: getEntryActivityAtMs(latestReview),
  }
}

export const hasLatestGreptileReviewScore = (feedback: PullRequestFeedback, achieved: number, total: number) => {
  const score = findLatestGreptileReviewScore(feedback)
  return score !== null && score.achieved === achieved && score.total === total
}

const greptileAuthorPrefixes = ["greptile-apps", "greptile-apps-staging"]

const isGreptileEntry = (entry: { readonly authorLogin: string }) =>
  greptileAuthorPrefixes.some((prefix) => entry.authorLogin.toLowerCase().startsWith(prefix))

const getEntrySource = (entry: { readonly authorLogin: string }): ReviewFeedbackSource =>
  isGreptileEntry(entry) ? "greptile" : "human"

const classifyComment = (comment: PullRequestComment): ReviewFeedbackComment => ({
  ...comment,
  source: getEntrySource(comment),
})

const classifyReview = (review: PullRequestReview): ReviewFeedbackReview => ({
  ...review,
  source: getEntrySource(review),
})

const classifyReviewComment = (comment: PullRequestReviewComment): ReviewFeedbackReviewComment => ({
  ...comment,
  source: getEntrySource(comment),
})

const classifyReviewThread = (thread: PullRequestReviewThread): ReviewFeedbackThread | null => {
  const comments = thread.comments.map(classifyReviewComment)
  const latestActivityAtMs = findLatestEntryActivityAtMs(comments)

  if (latestActivityAtMs === null) {
    return null
  }

  return {
    comments,
    latestActivityAtMs,
  }
}

const includeLatestGreptileScoreComment = (
  comments: ReadonlyArray<ReviewFeedbackComment>,
  scoreEntry: GreptileScoreEntry | null,
  reviewScore: PendingGreptileReviewScore | null,
) => {
  if (reviewScore === null || scoreEntry === null || scoreEntry.kind !== "comment" || scoreEntry.body.trim().length === 0) {
    return comments
  }

  return comments.some((comment) => comment.id === scoreEntry.id)
    ? comments
    : [classifyComment(scoreEntry), ...comments].sort(compareEntries)
}

const includeLatestGreptileScoreReview = (
  reviews: ReadonlyArray<ReviewFeedbackReview>,
  scoreEntry: GreptileScoreEntry | null,
  reviewScore: PendingGreptileReviewScore | null,
) => {
  if (reviewScore === null || scoreEntry === null || scoreEntry.kind !== "review" || scoreEntry.body.trim().length === 0) {
    return reviews
  }

  return reviews.some((review) => review.id === scoreEntry.id)
    ? reviews
    : [classifyReview(scoreEntry), ...reviews].sort(compareEntries)
}

const getFreshThreadActivityAtMs = (
  threads: ReadonlyArray<ReviewFeedbackThread>,
  since: number,
  source?: ReviewFeedbackSource,
) =>
  threads.flatMap((thread) => {
    const latest = thread.comments
      .filter((comment) => (source === undefined || comment.source === source) && getEntryActivityAtMs(comment) > since)
      .map(getEntryActivityAtMs)

    return latest.length === 0 ? [] : [Math.max(...latest)]
  })

const renderPullRequestReviewMarkdown = (options: {
  readonly greptileComments: ReadonlyArray<ReviewFeedbackComment>
  readonly greptileReviews: ReadonlyArray<ReviewFeedbackReview>
  readonly greptileThreads: ReadonlyArray<ReviewFeedbackThread>
  readonly humanComments: ReadonlyArray<ReviewFeedbackComment>
  readonly humanReviews: ReadonlyArray<ReviewFeedbackReview>
  readonly humanThreads: ReadonlyArray<ReviewFeedbackThread>
  readonly reviewScore: PendingGreptileReviewScore | null
}) => {
  const hasHumanFeedback = options.humanThreads.length > 0 || options.humanReviews.length > 0 || options.humanComments.length > 0
  const hasGreptileFeedback = options.reviewScore !== null
    || options.greptileThreads.length > 0
    || options.greptileReviews.length > 0
    || options.greptileComments.length > 0
  const sections: Array<string> = []
  const pushSection = (...lines: Array<string>) => {
    if (sections.length > 0) {
      sections.push("")
    }

    sections.push(...lines)
  }

  if (hasHumanFeedback && hasGreptileFeedback) {
    pushSection(
      "If human and Greptile feedback conflict, follow the human feedback first and keep only the Greptile guidance that still fits.",
    )
  }

  if (hasHumanFeedback) {
    pushSection("## Human feedback (highest priority)")

    if (options.humanThreads.length > 0) {
      sections.push("", "### Unresolved review threads", "")
      sections.push(...options.humanThreads.map(renderReviewThread))
    }

    if (options.humanReviews.length > 0) {
      sections.push("", "### Reviews", "", "<reviews>")
      sections.push(...options.humanReviews.map(renderReview))
      sections.push("</reviews>")
    }

    if (options.humanComments.length > 0) {
      sections.push("", "### General comments", "", "<comments>")
      sections.push(...options.humanComments.map(renderGeneralComment))
      sections.push("</comments>")
    }
  }

  if (hasGreptileFeedback) {
    pushSection("## Greptile feedback")

    if (options.reviewScore !== null) {
      sections.push("", `Confidence: ${options.reviewScore.value}/${options.reviewScore.maximum}`)
    }

    if (options.greptileThreads.length > 0) {
      sections.push("", "### Unresolved review threads", "")
      sections.push(...options.greptileThreads.map(renderReviewThread))
    }

    if (options.greptileReviews.length > 0) {
      sections.push("", "### Reviews", "", "<reviews>")
      sections.push(...options.greptileReviews.map(renderReview))
      sections.push("</reviews>")
    }

    if (options.greptileComments.length > 0) {
      sections.push("", "### General comments", "", "<comments>")
      sections.push(...options.greptileComments.map(renderGeneralComment))
      sections.push("</comments>")
    }
  }

  return sections.join("\n")
}

const findLatestGreptileScoreEntry = (feedback: PullRequestFeedback): GreptileScoreEntry | null =>
  findLatestEntry([
    ...feedback.comments
      .filter((comment) => comment.body.trim().length > 0 && isGreptileEntry(comment) && parseGreptileScore(comment.body) !== null)
      .map((comment) => ({ ...comment, kind: "comment" as const })),
    ...feedback.reviews
      .filter((review) => review.body.trim().length > 0 && isGreptileEntry(review) && parseGreptileScore(review.body) !== null)
      .map((review) => ({ ...review, kind: "review" as const })),
  ])

const getEntryActivityAtMs = (entry: { readonly createdAtMs: number; readonly updatedAtMs: number }) =>
  Math.max(entry.createdAtMs, entry.updatedAtMs)

const compareEntries = <A extends { readonly createdAtMs: number; readonly updatedAtMs: number }>(left: A, right: A) =>
  getEntryActivityAtMs(right) - getEntryActivityAtMs(left)

const compareReviewThreads = (left: ReviewFeedbackThread, right: ReviewFeedbackThread) =>
  getThreadPriority(left) - getThreadPriority(right)
  || right.latestActivityAtMs - left.latestActivityAtMs

const getThreadPriority = (thread: ReviewFeedbackThread) =>
  thread.comments.some((comment) => comment.source === "human") ? 0 : 1

const renderReviewThread = (thread: ReviewFeedbackThread) => {
  const priority = getThreadPriority(thread) === 0 ? "human" : "greptile"
  const primaryComment = getPrimaryThreadComment(thread, priority)

  return renderReviewComment(
    primaryComment,
    thread.comments.filter((comment) => comment.id !== primaryComment.id),
    priority,
  )
}

const getPrimaryThreadComment = (thread: ReviewFeedbackThread, priority: ReviewFeedbackSource) => {
  if (priority === "greptile") {
    return thread.comments[0]!
  }

  return findLatestEntry(thread.comments.filter((comment) => comment.source === "human")) ?? thread.comments[0]!
}

const renderReviewComment = (
  comment: ReviewFeedbackReviewComment,
  followup: ReadonlyArray<ReviewFeedbackReviewComment>,
  priority: ReviewFeedbackSource,
) => `<comment author="${comment.authorLogin}" path="${comment.path}" priority="${priority}" source="${comment.source}">
  <diffHunk><![CDATA[
${comment.diffHunk}
  ]]></diffHunk>
  ${comment.originalLine === null ? "" : `<lineNumber>${comment.originalLine}</lineNumber>`}
  <body>${comment.body}</body>${followup.length === 0 ? "" : `

  <followup>${followup
    .map(
      (item) => `
    <comment author="${item.authorLogin}" source="${item.source}">
      <body>${item.body}</body>
    </comment>`,
    )
    .join("")}
  </followup>`}
</comment>`

const renderReview = (review: ReviewFeedbackReview) => `<review author="${review.authorLogin}" source="${review.source}">
  <body>${review.body}</body>
</review>`

const renderGeneralComment = (comment: ReviewFeedbackComment) => `  <comment author="${comment.authorLogin}" source="${comment.source}">
    <body>${comment.body}</body>
  </comment>`

const findLatestEntry = <A extends { readonly createdAtMs: number; readonly updatedAtMs: number }>(entries: ReadonlyArray<A>): A | null => {
  let latest: A | null = null

  for (const entry of entries) {
    if (latest === null || getEntryActivityAtMs(entry) > getEntryActivityAtMs(latest)) {
      latest = entry
    }
  }

  return latest
}

const findLatestEntryActivityAtMs = <A extends { readonly createdAtMs: number; readonly updatedAtMs: number }>(entries: ReadonlyArray<A>) =>
  findLatestNumber(entries.map(getEntryActivityAtMs))

const findLatestNumber = (values: ReadonlyArray<number>): number | null => {
  let latest: number | null = null

  for (const value of values) {
    if (latest === null || value > latest) {
      latest = value
    }
  }

  return latest
}

const parsePendingGreptileReviewScore = (body: string): PendingGreptileReviewScore | null => {
  const score = parseGreptileScore(body)
  return score === null ? null : { maximum: score.total, value: score.achieved }
}

const parseGreptileScore = (body: string): Omit<GreptileReviewScore, "createdAtMs"> | null => {
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
