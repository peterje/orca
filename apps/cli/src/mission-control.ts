import { Data, Effect, Layer, ServiceMap } from "effect"
import { GitHub, GitHubError } from "./github.ts"
import { planIssues } from "./issue-planner.ts"
import { Linear, LinearApiError } from "./linear.ts"
import { LinearAuthRequiredError } from "./linear/token-manager.ts"
import { PullRequestStore, PullRequestStoreError } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigError } from "./repo-config.ts"
import { RunState, RunStateError, formatActiveRunStage, type ActiveRunStage } from "./run-state.ts"
import { loadTrackedPullRequestQueue } from "./tracked-pull-request-queue.ts"

export type MissionControlSnapshot = {
  readonly current:
    | {
        readonly issueIdentifier: string
        readonly issueTitle: string
        readonly stage: ActiveRunStage
      }
    | null
  readonly issues: {
    readonly blockedCount: number
    readonly readyToPickUpCount: number
  }
  readonly next:
    | {
        readonly issueIdentifier: string
        readonly issueTitle: string
        readonly stage: "ready-to-pick-up" | "review-feedback-ready"
      }
    | null
  readonly reviews: {
    readonly readyForFollowUpCount: number
    readonly waitingForReviewCount: number
  }
}

export type MissionControlService = {
  readonly snapshot: Effect.Effect<MissionControlSnapshot, MissionControlError | RepoConfigError | LinearApiError | LinearAuthRequiredError>
}

export const MissionControl = ServiceMap.Service<MissionControlService>("orca/MissionControl")

export const MissionControlLive = Effect.gen(function* () {
  const github = yield* GitHub
  const linear = yield* Linear
  const pullRequestStore = yield* PullRequestStore
  const repoConfig = yield* RepoConfig
  const runState = yield* RunState

  const snapshot = Effect.gen(function* () {
    const config = yield* repoConfig.read
    const activeRun = yield* runState.current.pipe(Effect.mapError(toMissionControlError))
    const trackedPullRequestQueue = yield* loadTrackedPullRequestQueue({ github, pullRequestStore }).pipe(
      Effect.mapError(toMissionControlError),
    )
    const currentIssueId = activeRun?.issueId ?? null
    const pendingReviews = trackedPullRequestQueue.pendingReviews.filter((review) => review.pullRequest.issueId !== currentIssueId)
    const trackedIssueIds = new Set(trackedPullRequestQueue.openPullRequests.map((pullRequest) => pullRequest.issueId))
    const issues = yield* linear.issues
    const plan = planIssues(issues, { linearLabel: config.linearLabel })
    const actionableIssues = plan.actionable.filter((issue) => issue.id !== currentIssueId && !trackedIssueIds.has(issue.id))
    const blockedIssues = plan.blocked.filter((issue) => issue.id !== currentIssueId && !trackedIssueIds.has(issue.id))
    const waitingForReviewCount = trackedPullRequestQueue.waitingForReviewPullRequests.filter(
      (pullRequest) => pullRequest.issueId !== currentIssueId,
    ).length

    const next = pendingReviews[0]
      ? {
          issueIdentifier: pendingReviews[0].pullRequest.issueIdentifier,
          issueTitle: pendingReviews[0].pullRequest.issueTitle,
          stage: "review-feedback-ready" as const,
        }
      : waitingForReviewCount < config.maxWaitingPullRequests && actionableIssues[0]
        ? {
            issueIdentifier: actionableIssues[0].identifier,
            issueTitle: actionableIssues[0].title,
            stage: "ready-to-pick-up" as const,
          }
        : null

    return {
      current: activeRun === null
        ? null
        : {
            issueIdentifier: activeRun.issueIdentifier,
            issueTitle: activeRun.issueTitle,
            stage: activeRun.stage,
          },
      issues: {
        blockedCount: blockedIssues.length,
        readyToPickUpCount: actionableIssues.length,
      },
      next,
      reviews: {
        readyForFollowUpCount: pendingReviews.length,
        waitingForReviewCount,
      },
    } satisfies MissionControlSnapshot
  })

  return MissionControl.of({ snapshot })
})

export const MissionControlLayer = Layer.effect(MissionControl, MissionControlLive)

export class MissionControlError extends Data.TaggedError("MissionControlError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const renderMissionControl = (snapshot: MissionControlSnapshot): Array<string> => [
  "Mission control",
  `- current: ${snapshot.current === null ? "idle" : `${formatIssueLabel(snapshot.current.issueIdentifier, snapshot.current.issueTitle)} - ${formatActiveRunStage(snapshot.current.stage)}`}`,
  `- next: ${snapshot.next === null ? "nothing ready right now" : `${formatIssueLabel(snapshot.next.issueIdentifier, snapshot.next.issueTitle)} - ${formatQueuedStage(snapshot.next.stage)}`}`,
  `- issue queue: ${snapshot.issues.readyToPickUpCount} ready to pick up, ${snapshot.issues.blockedCount} blocked`,
  `- review queue: ${snapshot.reviews.waitingForReviewCount} waiting for review, ${snapshot.reviews.readyForFollowUpCount} ready for follow-up`,
]

const formatIssueLabel = (issueIdentifier: string, issueTitle: string) =>
  issueTitle.trim().length > 0 ? `${issueIdentifier} ${issueTitle}` : issueIdentifier

const formatQueuedStage = (stage: "ready-to-pick-up" | "review-feedback-ready") => {
  switch (stage) {
    case "ready-to-pick-up":
      return "ready to pick up"
    case "review-feedback-ready":
      return "review feedback ready"
  }
}

const toMissionControlError = (cause: unknown) =>
  cause instanceof MissionControlError
    ? cause
    : new MissionControlError({
        message: getErrorMessage(cause),
        cause,
      })

const getErrorMessage = (cause: unknown) => {
  if (
    cause instanceof GitHubError
    || cause instanceof PullRequestStoreError
    || cause instanceof RunStateError
    || cause instanceof MissionControlError
  ) {
    return cause.message
  }
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
