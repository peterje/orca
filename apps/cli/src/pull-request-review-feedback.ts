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
  readonly latestGreptileActivityAtMs: number | null
  readonly latestHumanActivityAtMs: number | null
  readonly latestActivityAtMs: number
}

type PromptReviewThread = {
  readonly freshness: "fresh" | "carried-forward"
  readonly thread: ReviewFeedbackThread
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

  // Mixed threads stay in the human section so the latest human direction remains the
  // primary instruction, but fresh Greptile replies on those threads still count as
  // fresh Greptile feedback when deciding whether to requeue review work.
  const humanThreads = unresolvedThreads.filter((thread) => hasThreadSource(thread, "human"))
  const greptileThreads = unresolvedThreads.filter((thread) => !hasThreadSource(thread, "human") && hasThreadSource(thread, "greptile"))

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
  const freshGreptileScoreEntry = latestGreptileScoreEntryAtMs > options.greptileSince
    ? latestGreptileScoreEntry
    : null
  const freshGreptileReviewScore = freshGreptileScoreEntry === null
    ? null
    : parsePendingGreptileReviewScore(freshGreptileScoreEntry.body)
  const activeGreptileScore = freshGreptileReviewScore !== null && freshGreptileReviewScore.value < freshGreptileReviewScore.maximum
    ? freshGreptileReviewScore
    : null

  const freshHumanThreads = filterFreshThreads(humanThreads, options.humanSince, "human")
  const freshHumanThreadTimestampsMs = getFreshThreadTimestampsMs(freshHumanThreads, options.humanSince, "human")

  const freshGreptileThreads = filterFreshThreads(greptileThreads, options.greptileSince)
  const freshGreptileThreadTimestampsMs = getFreshThreadTimestampsMs(freshGreptileThreads, options.greptileSince)
  const freshGreptileHumanThreadTimestampsMs = getFreshThreadTimestampsMs(humanThreads, options.greptileSince, "greptile")
  // Combine standalone Greptile threads with Greptile follow-ups on human-owned threads
  // so either source can reopen review work after the last Greptile checkpoint.
  const latestFreshGreptileThreadAtMs = findLatestNumber([
    ...freshGreptileThreadTimestampsMs,
    ...freshGreptileHumanThreadTimestampsMs,
  ])

  const hasFreshHumanFeedback = humanComments.length > 0
    || humanReviews.length > 0
    || freshHumanThreadTimestampsMs.length > 0
  const hasFreshGreptileThreadFeedback = latestFreshGreptileThreadAtMs !== null
    && latestFreshGreptileThreadAtMs > latestGreptileScoreEntryAtMs
  // Fresh standalone Greptile summaries stay suppressed unless there is still an
  // active score or a newer unresolved Greptile thread to act on.
  const hasFreshGreptileFeedback = activeGreptileScore !== null
    || hasFreshGreptileThreadFeedback
  const promptHumanThreads = buildPromptHumanThreads({
    greptileSince: options.greptileSince,
    hasFreshGreptileFeedback,
    humanSince: options.humanSince,
    threads: humanThreads,
  })
  const promptGreptileComments = hasFreshGreptileFeedback
    ? includeLatestGreptileScoreComment(greptileComments, freshGreptileScoreEntry, activeGreptileScore)
    : []
  const promptGreptileReviews = hasFreshGreptileFeedback
    ? includeLatestGreptileScoreReview(greptileReviews, freshGreptileScoreEntry, activeGreptileScore)
    : []
  const promptGreptileThreads = hasFreshGreptileFeedback ? freshGreptileThreads.map(toFreshPromptThread) : []
  const activeGreptileScoreForPrompt = hasFreshGreptileFeedback ? activeGreptileScore : null
  const freshPromptGreptileThreadTimestampsMs = hasFreshGreptileFeedback ? freshGreptileThreadTimestampsMs : []

  if (!hasFreshHumanFeedback && !hasFreshGreptileFeedback) {
    return null
  }

  // Carried-forward human threads remain in the prompt while fresh Greptile feedback is
  // active, but only newly-arrived activity should advance the review checkpoint.
  const latestFeedbackTimestampCandidates = [
    ...humanComments.map(getEntryActivityAtMs),
    ...humanReviews.map(getEntryActivityAtMs),
    ...freshHumanThreadTimestampsMs,
    ...(hasFreshGreptileFeedback ? freshGreptileHumanThreadTimestampsMs : []),
    ...promptGreptileComments.map(getEntryActivityAtMs),
    ...promptGreptileReviews.map(getEntryActivityAtMs),
    ...freshPromptGreptileThreadTimestampsMs,
    ...(hasFreshGreptileFeedback && freshGreptileScoreEntry !== null ? [latestGreptileScoreEntryAtMs] : []),
  ]
  const latestFeedbackAtMs = findLatestNumber(latestFeedbackTimestampCandidates)

  // Invariant: at least one timestamp source is present whenever fresh feedback exists.
  // The mixed-thread-only Greptile path contributes via freshGreptileHumanThreadTimestampsMs.
  if (latestFeedbackAtMs === null) {
    throw new Error("Expected fresh pull request review feedback.")
  }

  return {
    feedbackMarkdown: renderPullRequestReviewMarkdown({
      greptileComments: promptGreptileComments,
      greptileReviews: promptGreptileReviews,
      greptileThreads: promptGreptileThreads,
      humanComments,
      humanReviews,
      humanThreads: promptHumanThreads,
      reviewScore: activeGreptileScoreForPrompt,
    }),
    latestFeedbackAtMs,
    reviewScore: activeGreptileScoreForPrompt,
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
    latestGreptileActivityAtMs: findLatestEntryActivityAtMs(comments.filter((comment) => comment.source === "greptile")),
    latestHumanActivityAtMs: findLatestEntryActivityAtMs(comments.filter((comment) => comment.source === "human")),
    latestActivityAtMs,
  }
}

const buildPromptHumanThreads = (options: {
  readonly greptileSince: number
  readonly hasFreshGreptileFeedback: boolean
  readonly humanSince: number
  readonly threads: ReadonlyArray<ReviewFeedbackThread>
}): ReadonlyArray<PromptReviewThread> => {
  if (!options.hasFreshGreptileFeedback) {
    return options.threads
      .filter((thread) => hasFreshThreadActivity(thread, options.humanSince, "human"))
      .map(toFreshPromptThread)
  }

  return options.threads.map((thread) => ({
    freshness:
      hasFreshThreadActivity(thread, options.humanSince, "human")
      || hasFreshThreadActivity(thread, options.greptileSince, "greptile")
        ? "fresh"
        : "carried-forward",
    thread,
  }))
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

const getFreshThreadTimestampsMs = (
  threads: ReadonlyArray<ReviewFeedbackThread>,
  since: number,
  source?: ReviewFeedbackSource,
) =>
  threads.flatMap((thread) => {
    const latest = findLatestFreshThreadActivityAtMs(thread, since, source)

    return latest === null ? [] : [latest]
  })

const filterFreshThreads = (
  threads: ReadonlyArray<ReviewFeedbackThread>,
  since: number,
  source?: ReviewFeedbackSource,
) =>
  threads.filter((thread) => findLatestFreshThreadActivityAtMs(thread, since, source) !== null)

const hasThreadSource = (thread: ReviewFeedbackThread, source: ReviewFeedbackSource) =>
  getThreadActivityAtMs(thread, source) !== null

const hasFreshThreadActivity = (
  thread: ReviewFeedbackThread,
  since: number,
  source?: ReviewFeedbackSource,
) =>
  findLatestFreshThreadActivityAtMs(thread, since, source) !== null

const getThreadActivityAtMs = (thread: ReviewFeedbackThread, source?: ReviewFeedbackSource) => {
  if (source === "human") {
    return thread.latestHumanActivityAtMs
  }

  if (source === "greptile") {
    return thread.latestGreptileActivityAtMs
  }

  return thread.latestActivityAtMs
}

const findLatestFreshThreadActivityAtMs = (
  thread: ReviewFeedbackThread,
  since: number,
  source?: ReviewFeedbackSource,
) => {
  const latestActivityAtMs = getThreadActivityAtMs(thread, source)
  return latestActivityAtMs !== null && latestActivityAtMs > since ? latestActivityAtMs : null
}

const renderPullRequestReviewMarkdown = (options: {
  readonly greptileComments: ReadonlyArray<ReviewFeedbackComment>
  readonly greptileReviews: ReadonlyArray<ReviewFeedbackReview>
  readonly greptileThreads: ReadonlyArray<PromptReviewThread>
  readonly humanComments: ReadonlyArray<ReviewFeedbackComment>
  readonly humanReviews: ReadonlyArray<ReviewFeedbackReview>
  readonly humanThreads: ReadonlyArray<PromptReviewThread>
  readonly reviewScore: PendingGreptileReviewScore | null
}) => {
  const hasHumanFeedback = options.humanThreads.length > 0 || options.humanReviews.length > 0 || options.humanComments.length > 0
  const hasGreptileFollowupInHumanThreads = options.humanThreads.some((thread) => hasThreadSource(thread.thread, "greptile"))
  const hasStandaloneGreptileFeedback = options.reviewScore !== null
    || options.greptileThreads.length > 0
    || options.greptileReviews.length > 0
    || options.greptileComments.length > 0
  const hasGreptileFeedback = hasStandaloneGreptileFeedback
    || hasGreptileFollowupInHumanThreads
  const hasCarriedForwardHumanThreads = options.humanThreads.some((thread) => thread.freshness === "carried-forward")
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
      if (hasCarriedForwardHumanThreads) {
        sections.push("Threads marked `freshness=\"carried-forward\"` are older unresolved human context kept visible while newer Greptile feedback is active.", "")
      }
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

  if (hasStandaloneGreptileFeedback) {
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

const toFreshPromptThread = (thread: ReviewFeedbackThread): PromptReviewThread => ({ freshness: "fresh", thread })

const renderReviewThread = (promptThread: PromptReviewThread) => {
  const priority = getThreadPriority(promptThread.thread) === 0 ? "human" : "greptile"
  const primaryComment = getPrimaryThreadComment(promptThread.thread, priority)

  return renderReviewComment(
    primaryComment,
    promptThread.thread.comments.filter((comment) => comment.id !== primaryComment.id),
    promptThread.freshness,
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
  freshness: PromptReviewThread["freshness"],
  priority: ReviewFeedbackSource,
) => `<comment author="${comment.authorLogin}" path="${comment.path}" priority="${priority}" source="${comment.source}" freshness="${freshness}">
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
