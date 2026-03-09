import { Effect } from "effect"
import type { GitHubService, PullRequestFeedback } from "./github.ts"
import { isActiveTrackedPullRequest, PullRequestStore, type OrcaManagedPullRequest } from "./pull-request-store.ts"
import { findPullRequestTerminalState } from "./review-queue.ts"

export type ActiveTrackedPullRequest = {
  readonly feedback: PullRequestFeedback
  readonly pullRequest: OrcaManagedPullRequest
}

export const reconcileTrackedPullRequests = <E>(options: {
  readonly github: GitHubService
  readonly mapError: (cause: unknown) => E
  readonly pullRequestStore: typeof PullRequestStore.Service
  readonly pullRequests: ReadonlyArray<OrcaManagedPullRequest>
}) =>
  Effect.forEach(
    options.pullRequests,
    (pullRequest) => {
      if (!isActiveTrackedPullRequest(pullRequest)) {
        return Effect.succeed<ActiveTrackedPullRequest | null>(null)
      }

      return options.github.readPullRequestFeedback({
        pullRequestNumber: pullRequest.prNumber,
        repo: pullRequest.repo,
      }).pipe(
        Effect.flatMap((feedback) => {
          const terminalState = findPullRequestTerminalState(feedback)
          if (terminalState === null) {
            return Effect.succeed<ActiveTrackedPullRequest | null>({ feedback, pullRequest })
          }

          return options.pullRequestStore.markTerminal({
            lastReviewedAtMs: terminalState.lastReviewedAtMs,
            prNumber: pullRequest.prNumber,
            repo: pullRequest.repo,
            terminalState: terminalState.terminalState,
          }).pipe(Effect.as<ActiveTrackedPullRequest | null>(null))
        }),
        Effect.mapError(options.mapError),
      )
    },
    { concurrency: 1 },
  ).pipe(Effect.map((pullRequests) => pullRequests.filter((pullRequest): pullRequest is ActiveTrackedPullRequest => pullRequest !== null)))
