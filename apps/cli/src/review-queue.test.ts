import { describe, expect, it } from "@effect/vitest"
import type { PullRequestFeedback } from "./github.ts"
import { findPendingPullRequestReview } from "./review-queue.ts"

describe("review queue", () => {
  it("selects label-triggered unresolved review threads", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        labels: ["orca-review"],
        reviewThreads: [
          {
            comments: [reviewComment({ body: "Please rename this helper.", createdAtMs: 10 })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 20 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.trigger).toBe("label")
    expect(pending?.feedbackMarkdown).toContain("Please rename this helper.")
  })

  it("requires an explicit trigger before queueing review work", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        reviewThreads: [
          {
            comments: [reviewComment({ body: "Please rename this helper.", createdAtMs: 10 })],
            isCollapsed: false,
            isResolved: false,
          },
        ],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: null }),
    })

    expect(pending).toBeNull()
  })

  it("selects recent @orca mentions from general comments", () => {
    const pending = findPendingPullRequestReview({
      feedback: feedback({
        comments: [comment({ body: "@orca can you address this?", createdAtMs: 50 })],
      }),
      pullRequest: pullRequest({ lastReviewedAtMs: 10 }),
    })

    expect(pending).not.toBeNull()
    expect(pending?.trigger).toBe("mention")
    expect(pending?.feedbackMarkdown).toContain("@orca can you address this?")
  })
})

const pullRequest = (overrides?: Partial<{
  readonly lastReviewedAtMs: number | null
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
  updatedAtMs: 1,
})

const feedback = (overrides?: Partial<PullRequestFeedback>): PullRequestFeedback => ({
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
