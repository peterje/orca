import { describe, expect, it } from "@effect/vitest"
import type { PullRequestFeedback } from "./github.ts"
import { findLatestGreptileReviewScore, findPendingPullRequestReview, hasLatestGreptileReviewScore } from "./review-queue.ts"

describe("review queue", () => {
  it("selects failing Greptile feedback after the latest review request", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "greptile-apps[bot]", body: "Please keep this branch scoped.", createdAtMs: 60, isBot: true })],
        reviewThreads: [
          {
            comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 55, isBot: true })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 50, isBot: true })],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 20 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toEqual({ maximum: 5, value: 4 })
    expect(pending?.feedbackMarkdown).toMatch(/^## Greptile feedback/)
    expect(pending?.feedbackMarkdown).not.toContain("# Pull request review feedback")
    expect(pending?.feedbackMarkdown).toContain("Confidence: 4/5")
    expect(pending?.feedbackMarkdown).toContain("Please rename this helper.")
    expect(pending?.feedbackMarkdown).toContain("Please keep this branch scoped.")
  })

  it("selects failing Greptile feedback when the score arrives as a general comment", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [
          comment({
            authorLogin: "greptile-apps[bot]",
            body: "Confidence Score: 4/5\n\nPlease keep this branch scoped.",
            createdAtMs: 60,
            isBot: true,
          }),
        ],
        reviewThreads: [
          {
            comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 55, isBot: true })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 20 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toEqual({ maximum: 5, value: 4 })
    expect(pending?.feedbackMarkdown).toContain("Confidence: 4/5")
    expect(pending?.feedbackMarkdown).toContain("Please rename this helper.")
    expect(pending?.feedbackMarkdown).toContain("Please keep this branch scoped.")
  })

  it("treats an edited Greptile score comment as fresh feedback", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [
          comment({
            authorLogin: "greptile-apps[bot]",
            body: "Confidence Score: 4/5\n\nPlease keep this branch scoped.",
            createdAtMs: 10,
            isBot: true,
            updatedAtMs: 120,
          }),
        ],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 100 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.latestFeedbackAtMs).toBe(120)
    expect(pending?.reviewScore).toEqual({ maximum: 5, value: 4 })
  })

  it("creates pending review work from human feedback", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "reviewer", body: "Please rename this helper.", createdAtMs: 60 })],
        reviewThreads: [
          {
            comments: [reviewComment({ authorLogin: "reviewer", body: "Please rename this helper.", createdAtMs: 55 })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({ authorLogin: "reviewer", body: "Confidence: 4/5", createdAtMs: 50 })],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 20 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain("source=\"human\"")
    expect(pending?.feedbackMarkdown).toContain("Please rename this helper.")
    expect(pending?.feedbackMarkdown).not.toContain("If human and Greptile feedback conflict")
  })

  it("keeps unresolved human feedback alongside a later Greptile round", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [
              reviewComment({ authorLogin: "reviewer", body: "Use the human naming here.", createdAtMs: 60 }),
              reviewComment({ authorLogin: "greptile-apps[bot]", body: "I would rename this to use the bot naming.", createdAtMs: 65, isBot: true, id: "review-comment-2" }),
            ],
            isCollapsed: false,
            isResolved: false,
          },
          {
            comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please simplify this branch.", createdAtMs: 118, isBot: true, id: "review-comment-3" })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 120, id: "review-2", isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 80, waitingForGreptileReviewSinceMs: 100 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toEqual({ maximum: 5, value: 4 })
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain("Use the human naming here.")
    expect(pending?.feedbackMarkdown).toContain("source=\"greptile\"")
    expect(pending?.feedbackMarkdown).toContain("## Greptile feedback")
    expect(pending?.feedbackMarkdown).toContain("Confidence: 4/5")
    expect(pending?.latestFeedbackAtMs).toBe(120)
  })

  it("keeps human feedback that arrived before the latest Greptile request", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "reviewer", body: "Please keep the reviewer-approved wording.", createdAtMs: 90 })],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 120, id: "review-2", isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 80, waitingForGreptileReviewSinceMs: 100 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain("Please keep the reviewer-approved wording.")
    expect(pending?.feedbackMarkdown).not.toContain("## Greptile feedback")
    expect(pending?.latestFeedbackAtMs).toBe(90)
  })

  it("omits stale Greptile scores when only human feedback is fresh", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "reviewer", body: "Please keep the reviewer-approved wording.", createdAtMs: 70 })],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 3/5", createdAtMs: 50, id: "review-2", isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 55, waitingForGreptileReviewSinceMs: 60 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain("Please keep the reviewer-approved wording.")
    expect(pending?.feedbackMarkdown).not.toContain("If human and Greptile feedback conflict")
    expect(pending?.feedbackMarkdown).not.toContain("## Greptile feedback")
    expect(pending?.feedbackMarkdown).not.toContain("Confidence: 3/5")
    expect(pending?.latestFeedbackAtMs).toBe(70)
  })

  it("does not treat a Greptile reply on a mixed thread as fresh human feedback", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [
              reviewComment({ authorLogin: "reviewer", body: "Use the reviewer naming here.", createdAtMs: 10 }),
              reviewComment({
                authorLogin: "greptile-apps[bot]",
                body: "I still prefer the bot naming here.",
                createdAtMs: 30,
                id: "review-comment-2",
                isBot: true,
              }),
            ],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({
          authorLogin: "greptile-apps[bot]",
          body: "Confidence: 4/5\n\nPlease keep the stale bot guidance.",
          createdAtMs: 15,
          id: "review-2",
          isBot: true,
        })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 20 }),
    })

    expect(pending).toBeNull()
  })

  it("does not requeue the same mixed thread while waiting for the next Greptile pass", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [
              reviewComment({ authorLogin: "reviewer", body: "Use the reviewer naming here.", createdAtMs: 10 }),
              reviewComment({
                authorLogin: "greptile-apps[bot]",
                body: "I still prefer the bot naming here.",
                createdAtMs: 30,
                id: "review-comment-2",
                isBot: true,
              }),
            ],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({
          authorLogin: "greptile-apps[bot]",
          body: "Confidence: 4/5\n\nPlease keep the stale bot guidance.",
          createdAtMs: 15,
          id: "review-2",
          isBot: true,
        })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 30, waitingForGreptileReviewSinceMs: 40 }),
    })

    expect(pending).toBeNull()
  })

  it("surfaces the human reply first when Greptile opens a mixed thread", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [
              reviewComment({
                authorLogin: "greptile-apps[bot]",
                body: "Use the bot naming here.",
                createdAtMs: 10,
                id: "review-comment-1",
                isBot: true,
              }),
              reviewComment({
                authorLogin: "reviewer",
                body: "Keep the reviewer-approved naming instead.",
                createdAtMs: 30,
                id: "review-comment-2",
              }),
            ],
            isCollapsed: false,
            isResolved: false,
          },
        ],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 5 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain('<comment author="reviewer" path="apps/cli/src/runner.ts" priority="human" source="human">')
    expect(pending?.feedbackMarkdown).toContain('<comment author="greptile-apps[bot]" source="greptile">')
    expect(pending?.feedbackMarkdown).not.toContain('<comment author="greptile-apps[bot]" path="apps/cli/src/runner.ts" priority="human" source="greptile">')
  })

  it("omits stale Greptile threads once the latest score is complete", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "reviewer", body: "Please keep the reviewer wording.", createdAtMs: 60 })],
        reviewThreads: [
          {
            comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Old Greptile thread", createdAtMs: 10, isBot: true })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 30, isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 50 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).not.toContain("## Greptile feedback")
    expect(pending?.feedbackMarkdown).not.toContain("Old Greptile thread")
  })

  it("does not treat fresh Greptile threads without a fresh score as actionable", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 120, isBot: true })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 80, isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 100 }),
    })

    expect(pending).toBeNull()
  })

  it("ignores empty review threads when building mixed feedback prompts", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "reviewer", body: "Please keep this helper focused.", createdAtMs: 60 })],
        reviewThreads: [
          {
            comments: [],
            isCollapsed: false,
            isResolved: false,
          },
        ],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 20 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.feedbackMarkdown).toContain("Please keep this helper focused.")
  })

  it("suppresses duplicate review requests while Greptile has not responded yet", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ authorLogin: "greptile-apps[bot]", body: "Please avoid failing the run for a missing issue URL.", createdAtMs: 50, isBot: true })],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 40, isBot: true })],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 100 }),
    })

    expect(pending).toBeNull()
  })

  it("omits a stale Greptile score when only a later Greptile comment is fresh", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [
          comment({ authorLogin: "reviewer", body: "Keep the human-approved wording.", createdAtMs: 130 }),
          comment({ authorLogin: "greptile-apps[bot]", body: "Please tighten the helper name.", createdAtMs: 120, id: "comment-2", isBot: true }),
        ],
        reviews: [review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 3/5", createdAtMs: 80, id: "review-2", isBot: true })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 100, waitingForGreptileReviewSinceMs: 110 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.reviewScore).toBeNull()
    expect(pending?.feedbackMarkdown).toContain("## Human feedback (highest priority)")
    expect(pending?.feedbackMarkdown).toContain("Keep the human-approved wording.")
    expect(pending?.feedbackMarkdown).not.toContain("## Greptile feedback")
    expect(pending?.feedbackMarkdown).not.toContain("Confidence: 3/5")
    expect(pending?.feedbackMarkdown).not.toContain("Please tighten the helper name.")
    expect(pending?.latestFeedbackAtMs).toBe(130)
  })

  it("uses the latest Greptile review score when deciding whether follow-up work is needed", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviews: [
          review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 4/5", createdAtMs: 50, isBot: true, id: "review-1" }),
          review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 70, isBot: true, id: "review-2" }),
        ],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 20 }),
    })

    expect(pending).toBeNull()
  })

  it("requires an explicit confidence or score label when parsing Greptile review scores", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviews: [
          review({
            authorLogin: "greptile-apps[bot]",
            body: "Updated 3/5 files while reviewing this pull request.",
            createdAtMs: 50,
            isBot: true,
          }),
        ],
      }),
      pullRequest: pullRequest({ waitingForGreptileReviewSinceMs: 20 }),
    })

    expect(pending).toBeNull()
  })

  it("parses the score from the latest Greptile review only", () => {
    const latestScore = findLatestGreptileReviewScore(feedback({
      reviews: [
        review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 3/5", createdAtMs: 10, id: "review-1" }),
        review({ authorLogin: "reviewer", body: "human review", createdAtMs: 15, id: "review-2" }),
        review({ authorLogin: "greptile-apps-staging[bot]", body: "Confidence: 5/5", createdAtMs: 20, id: "review-3" }),
      ],
    }))

    expect(latestScore).toMatchObject({
      achieved: 5,
      total: 5,
    })
    expect(hasLatestGreptileReviewScore(feedback({
      reviews: [
        review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 3/5", createdAtMs: 10, id: "review-1" }),
        review({ authorLogin: "greptile-apps-staging[bot]", body: "Confidence: 5/5", createdAtMs: 20, id: "review-3" }),
      ],
    }), 5, 5)).toBe(true)
  })

  it("parses the latest Greptile score from general comments", () => {
    const latestScore = findLatestGreptileReviewScore(feedback({
      comments: [
        comment({ authorLogin: "greptile-apps[bot]", body: "Confidence: 3/5", createdAtMs: 10, id: "comment-1", isBot: true }),
        comment({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 20, id: "comment-2", isBot: true }),
      ],
      reviews: [
        review({ authorLogin: "reviewer", body: "human review", createdAtMs: 15, id: "review-1" }),
      ],
    }))

    expect(latestScore).toMatchObject({
      achieved: 5,
      createdAtMs: 20,
      total: 5,
    })
    expect(hasLatestGreptileReviewScore(feedback({
      comments: [
        comment({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 20, id: "comment-2", isBot: true }),
      ],
    }), 5, 5)).toBe(true)
  })

  it("does not let older unresolved Greptile comments block a latest 5/5 review", () => {
    const latestScore = findLatestGreptileReviewScore(feedback({
      reviewThreads: [
        {
          comments: [reviewComment({ authorLogin: "greptile-apps[bot]", body: "Please rename this helper.", createdAtMs: 10 })],
          isCollapsed: false,
          isResolved: false,
        },
      ],
      reviews: [
        review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 2/5", createdAtMs: 20, id: "review-1" }),
        review({ authorLogin: "greptile-apps[bot]", body: "Confidence: 5/5", createdAtMs: 30, id: "review-2" }),
      ],
    }))

    expect(latestScore).toMatchObject({
      achieved: 5,
      total: 5,
    })
  })

  it("parses the labeled confidence score instead of earlier fractions", () => {
    const latestScore = findLatestGreptileReviewScore(feedback({
      reviews: [
        review({
          authorLogin: "greptile-apps[bot]",
          body: [
            "Resolved 3/4 open threads.",
            "Only 2/5 files still need attention.",
            "Confidence Score: 5/5",
          ].join("\n"),
          createdAtMs: 30,
          id: "review-4",
          isBot: true,
        }),
      ],
    }))

    expect(latestScore).toMatchObject({
      achieved: 5,
      total: 5,
    })
  })
})

const pullRequest = (overrides?: Partial<{
  readonly greptileCompletedAtMs: number | null
  readonly lastReviewedAtMs: number | null
  readonly waitingForGreptileReviewSinceMs: number | null
}>) => ({
  branch: "orca/eng-1",
  createdAtMs: 1,
  greptileCompletedAtMs: overrides?.greptileCompletedAtMs ?? null,
  issueDescription: "",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueTitle: "Example issue",
  lastReviewedAtMs: overrides?.lastReviewedAtMs ?? null,
  prNumber: 1,
  prUrl: "https://github.com/peterje/orca/pull/1",
  repo: "peterje/orca",
  updatedAtMs: 1,
  waitingForGreptileReviewSinceMs: overrides?.waitingForGreptileReviewSinceMs ?? null,
})

const feedback = (overrides?: Partial<PullRequestFeedback>): PullRequestFeedback => ({
  authorLogin: overrides?.authorLogin ?? "author",
  comments: overrides?.comments ?? [],
  isDraft: true,
  labels: overrides?.labels ?? [],
  mergeStateStatus: overrides?.mergeStateStatus ?? "CLEAN",
  number: overrides?.number ?? 1,
  reviewThreads: overrides?.reviewThreads ?? [],
  reviews: overrides?.reviews ?? [],
  state: overrides?.state ?? "OPEN",
  url: overrides?.url ?? "https://github.com/peterje/orca/pull/1",
})

const comment = (overrides?: Partial<PullRequestFeedback["comments"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Comment",
  createdAtMs: overrides?.createdAtMs ?? 1,
  id: overrides?.id ?? "comment-1",
  isBot: overrides?.isBot ?? false,
  updatedAtMs: overrides?.updatedAtMs ?? overrides?.createdAtMs ?? 1,
})

const review = (overrides?: Partial<PullRequestFeedback["reviews"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Review",
  createdAtMs: overrides?.createdAtMs ?? 1,
  id: overrides?.id ?? "review-1",
  isBot: overrides?.isBot ?? false,
  updatedAtMs: overrides?.updatedAtMs ?? overrides?.createdAtMs ?? 1,
})

const reviewComment = (overrides?: Partial<PullRequestFeedback["reviewThreads"][number]["comments"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Review comment",
  createdAtMs: overrides?.createdAtMs ?? 1,
  diffHunk: overrides?.diffHunk ?? "@@ -1,1 +1,1 @@",
  id: overrides?.id ?? "review-comment-1",
  isBot: overrides?.isBot ?? false,
  originalLine: overrides?.originalLine ?? 1,
  path: overrides?.path ?? "apps/cli/src/runner.ts",
  updatedAtMs: overrides?.updatedAtMs ?? overrides?.createdAtMs ?? 1,
})
