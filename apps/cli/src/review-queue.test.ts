import { describe, expect, it } from "@effect/vitest"
import type { PullRequestFeedback } from "./github.ts"
import { findPendingPullRequestReview } from "./review-queue.ts"

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
    expect(pending?.feedbackMarkdown).toContain("Confidence: 4/5")
    expect(pending?.feedbackMarkdown).toContain("Please rename this helper.")
    expect(pending?.feedbackMarkdown).toContain("Please keep this branch scoped.")
  })

  it("ignores human review feedback in the Greptile loop", () => {
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

    expect(pending).toBeNull()
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
})

const pullRequest = (overrides?: Partial<{
  readonly lastReviewedAtMs: number | null
  readonly terminalState: "closed" | "greptile-approved" | "merged" | null
  readonly waitingForGreptileReviewSinceMs: number | null
}>) => ({
  branch: "orca/eng-1",
  createdAtMs: 1,
  issueDescription: "",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueTitle: "Example issue",
  lastReviewedAtMs: overrides?.lastReviewedAtMs ?? null,
  prNumber: 1,
  prUrl: "https://github.com/peterje/orca/pull/1",
  repo: "peterje/orca",
  terminalState: overrides?.terminalState ?? null,
  updatedAtMs: 1,
  waitingForGreptileReviewSinceMs: overrides?.waitingForGreptileReviewSinceMs ?? null,
})

const feedback = (overrides?: Partial<PullRequestFeedback>): PullRequestFeedback => ({
  authorLogin: overrides?.authorLogin ?? "author",
  comments: overrides?.comments ?? [],
  isDraft: true,
  labels: overrides?.labels ?? [],
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
})

const review = (overrides?: Partial<PullRequestFeedback["reviews"][number]>) => ({
  authorLogin: overrides?.authorLogin ?? "reviewer",
  body: overrides?.body ?? "Review",
  createdAtMs: overrides?.createdAtMs ?? 1,
  id: overrides?.id ?? "review-1",
  isBot: overrides?.isBot ?? false,
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
})
