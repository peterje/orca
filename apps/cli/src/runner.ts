import { Console, Data, Effect, FileSystem, Layer, Option, ServiceMap } from "effect"
import { AgentRunner, AgentRunnerError, AgentRunnerStalledError, AgentRunnerTimeoutError } from "./agent-runner.ts"
import { GitHub, GitHubError, type GitHubService, type PullRequestInfo } from "./github.ts"
import { planIssues, type IssuePlan, type PlannedIssue } from "./issue-planner.ts"
import { Linear, type LinearService } from "./linear.ts"
import { PromptGen, PromptGenError } from "./prompt-gen.ts"
import { PullRequestStore, PullRequestStoreError, type OrcaManagedPullRequest } from "./pull-request-store.ts"
import { RepoConfig, RepoConfigData, RepoConfigError } from "./repo-config.ts"
import { findLatestGreptileReviewScore, type PendingPullRequestReview } from "./review-queue.ts"
import { RunState, RunStateBusyError, RunStateError, formatActiveRunStage, type ActiveRunStage } from "./run-state.ts"
import { loadTrackedPullRequestQueue } from "./tracked-pull-request-queue.ts"
import { VerificationError, Verifier } from "./verifier.ts"
import { Worktree, WorktreeError, slugifyIssueTitle, type ManagedWorktree } from "./worktree.ts"

export type RunnerResult = {
  readonly issueIdentifier: string
  readonly mode: "implementation" | "review"
  readonly pullRequestUrl: string
  readonly worktreePath: string
}

export type RunnerWorkItem =
  | {
      readonly id: string
      readonly issueIdentifier: string
      readonly kind: "implementation"
      readonly title: string
    }
  | {
      readonly id: string
      readonly issueIdentifier: string
      readonly kind: "review"
      readonly pullRequestNumber: number
      readonly pullRequestUrl: string
      readonly title: string
    }

export type RunnerService = {
  readonly pollWaitingPullRequests: Effect.Effect<void, RunnerFailure>
  readonly peekNext: Effect.Effect<Option.Option<RunnerWorkItem>, RunnerFailure | RepoConfigError>
  readonly runNext: Effect.Effect<RunnerResult, RunnerFailure | RunnerNoWorkError | RepoConfigError | RunStateBusyError>
}

export const Runner = ServiceMap.Service<RunnerService>("orca/Runner")

type RunnerConfig = typeof RepoConfigData.Type

type SelectedWork =
  | {
      readonly config: RunnerConfig
      readonly issue: PlannedIssue
      readonly kind: "implementation"
      readonly plan: IssuePlan
    }
  | {
      readonly config: RunnerConfig
      readonly kind: "review"
      readonly review: PendingPullRequestReview
    }

type FinalizedPullRequest = {
  readonly pullRequest: PullRequestInfo
  readonly wasCreated: boolean
}

type WaitingForGreptileReviewPullRequest = OrcaManagedPullRequest & {
  readonly greptileCompletedAtMs: null
  readonly waitingForGreptileReviewSinceMs: number
}

export const RunnerLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const agentRunner = yield* AgentRunner
  const github = yield* GitHub
  const linear = yield* Linear
  const promptGen = yield* PromptGen
  const pullRequestStore = yield* PullRequestStore
  const repoConfig = yield* RepoConfig
  const runState = yield* RunState
  const verifier = yield* Verifier
  const worktree = yield* Worktree

  const selectNextWork = Effect.gen(function* () {
    const config = yield* repoConfig.read
    const trackedPullRequestQueue = yield* loadTrackedPullRequestQueue({ github, pullRequestStore }).pipe(
      Effect.mapError(toRunnerFailure),
    )
    const trackedIssueIds = new Set(trackedPullRequestQueue.openPullRequests.map((pullRequest) => pullRequest.issueId))
    const review = trackedPullRequestQueue.pendingReviews[0]

    if (review) {
      return Option.some({ config, kind: "review", review } satisfies SelectedWork)
    }

    const issues = yield* linear.issues.pipe(Effect.mapError(toRunnerFailure))
    const plan = planIssues(issues, { linearLabel: config.linearLabel })
    const issue = plan.actionable.find((candidate) => !trackedIssueIds.has(candidate.id))
    if (!issue) {
      return Option.none<SelectedWork>()
    }

    if (trackedPullRequestQueue.waitingForReviewPullRequests.length >= config.maxWaitingPullRequests) {
      return Option.none<SelectedWork>()
    }

    return Option.some({ config, issue, kind: "implementation", plan } satisfies SelectedWork)
  })

  const pollWaitingPullRequests = Effect.gen(function* () {
    const storedPullRequests = yield* pullRequestStore.list.pipe(Effect.mapError(toRunnerFailure))

    yield* Effect.forEach(
      storedPullRequests.filter(isWaitingForGreptileReview),
      (pullRequest) =>
        Effect.gen(function* () {
          const waitingSince = pullRequest.waitingForGreptileReviewSinceMs
          const feedback = yield* github.readPullRequestFeedback({
            pullRequestNumber: pullRequest.prNumber,
            repo: pullRequest.repo,
          }).pipe(Effect.mapError(toRunnerFailure))
          if (feedback.state.toUpperCase() !== "OPEN") {
            yield* pullRequestStore.remove({
              prNumber: pullRequest.prNumber,
              repo: pullRequest.repo,
            }).pipe(Effect.mapError(toRunnerFailure))
            return
          }

          const latestGreptileReview = findLatestGreptileReviewScore(feedback)

          if (
            latestGreptileReview === null
            || latestGreptileReview.review.createdAtMs < waitingSince
            || latestGreptileReview.achieved !== 5
            || latestGreptileReview.total !== 5
          ) {
            return
          }

          if (feedback.isDraft) {
            yield* github.markPullRequestReadyForReview({
              pullRequestNumber: pullRequest.prNumber,
              repo: pullRequest.repo,
            }).pipe(Effect.mapError(toRunnerFailure))
          }

          const updatedPullRequest = yield* pullRequestStore.markGreptileCompleted({
            completedAtMs: Date.now(),
            lastReviewedAtMs: latestGreptileReview.review.createdAtMs,
            prNumber: pullRequest.prNumber,
            repo: pullRequest.repo,
          }).pipe(Effect.mapError(toRunnerFailure))

          if (updatedPullRequest === null) {
            return yield* Effect.fail(new RunnerFailure({
              message: `PR #${pullRequest.prNumber} in ${pullRequest.repo} was not found in the store when marking Greptile complete.`,
            }))
          }
        }),
      { concurrency: 1, discard: true },
    )
  })

  const peekNext = selectNextWork.pipe(
    Effect.map(
      Option.map((selected): RunnerWorkItem =>
        selected.kind === "review"
          ? {
              id: `${selected.review.pullRequest.repo}#${selected.review.pullRequest.prNumber}`,
              issueIdentifier: selected.review.pullRequest.issueIdentifier,
              kind: "review",
              pullRequestNumber: selected.review.pullRequest.prNumber,
              pullRequestUrl: selected.review.pullRequest.prUrl,
              title: selected.review.pullRequest.issueTitle,
            }
          : {
              id: selected.issue.id,
              issueIdentifier: selected.issue.identifier,
              kind: "implementation",
              title: selected.issue.title,
            }),
    ),
  )

  const runNext = Effect.gen(function* () {
    const selected = yield* selectNextWork
    if (Option.isNone(selected)) {
      return yield* Effect.fail(
        new RunnerNoWorkError({ message: "No pending pull request reviews or actionable Orca issues are currently available." }),
      )
    }

    return yield* (selected.value.kind === "review"
      ? runReview({
          agentRunner,
          config: selected.value.config,
          fs,
          github,
          linear,
          promptGen,
          pullRequestStore,
          review: selected.value.review,
          runState,
          verifier,
          worktree,
        })
      : runImplementation({
          agentRunner,
          config: selected.value.config,
          fs,
          github,
          issue: selected.value.issue,
          linear,
          plan: selected.value.plan,
          promptGen,
          pullRequestStore,
          runState,
          verifier,
          worktree,
        }))
  })

  return Runner.of({ peekNext, pollWaitingPullRequests, runNext })
})

export const RunnerLayer = Layer.effect(Runner, RunnerLive)

export class RunnerFailure extends Data.TaggedError("RunnerFailure")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RunnerNoWorkError extends Data.TaggedError("RunnerNoWorkError")<{
  readonly message: string
}> {}

const runImplementation = (options: {
  readonly agentRunner: typeof AgentRunner.Service
  readonly config: RunnerConfig
  readonly fs: FileSystem.FileSystem
  readonly github: GitHubService
  readonly issue: PlannedIssue
  readonly linear: LinearService
  readonly plan: IssuePlan
  readonly promptGen: typeof PromptGen.Service
  readonly pullRequestStore: typeof PullRequestStore.Service
  readonly runState: typeof RunState.Service
  readonly verifier: typeof Verifier.Service
  readonly worktree: typeof Worktree.Service
}) =>
  Effect.gen(function* () {
    const managedWorktree = yield* options.worktree.create({
      baseBranch: options.config.baseBranch,
      branchPrefix: options.config.branchPrefix,
      issueIdentifier: options.issue.identifier,
      issueTitle: options.issue.title,
      setup: options.config.setup,
    }).pipe(Effect.mapError(toRunnerFailure))

    yield* options.runState.acquire({
      branch: managedWorktree.branch,
      issueId: options.issue.id,
      issueIdentifier: options.issue.identifier,
      issueTitle: options.issue.title,
      mode: "implementation",
      stage: "implementing",
      worktreePath: managedWorktree.directory,
    }).pipe(
      Effect.mapError((cause) => (cause instanceof RunStateBusyError ? cause : toRunnerFailure(cause))),
    )

    return yield* Effect.gen(function* () {
      yield* announceRunStage({
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        stage: "implementing",
      })

      yield* options.linear.markIssueInProgress(options.issue).pipe(Effect.mapError(toRunnerFailure))

      const prompt = yield* options.promptGen.buildImplementationPrompt({
        baseBranch: options.config.baseBranch,
        branch: managedWorktree.branch,
        issue: options.issue,
        plan: options.plan,
        verify: options.config.verify,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* writePromptFile(options.fs, managedWorktree.directory, prompt.promptFileContents)

      yield* options.agentRunner.run({
        agent: options.config.agent,
        agentArgs: options.config.agentArgs,
        cwd: managedWorktree.directory,
        prompt: prompt.prompt,
        promptFilePath: `${managedWorktree.directory}/.orca/issue.md`,
        stallTimeoutMinutes: options.config.stallTimeoutMinutes,
        timeoutMinutes: options.config.agentTimeoutMinutes,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* setRunStage(options.runState, "verifying").pipe(Effect.mapError(toRunnerFailure))
      yield* announceRunStage({
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        stage: "verifying",
      })

      yield* options.verifier.run({
        commands: options.config.verify,
        cwd: managedWorktree.directory,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* setRunStage(options.runState, "publishing-pull-request").pipe(Effect.mapError(toRunnerFailure))
      yield* announceRunStage({
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        stage: "publishing-pull-request",
      })

      const finalizedPullRequest = yield* finalizeGitAndPullRequest({
        allowCreatePullRequest: true,
        commitMessage: makeImplementationCommitMessage(options.issue),
        config: options.config,
        github: options.github,
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        worktree: managedWorktree,
      }).pipe(Effect.mapError(toRunnerFailure))

      let waitingForGreptileReviewSinceMs: number | undefined = undefined

      if (finalizedPullRequest.wasCreated) {
        yield* options.github.requestPullRequestReview({
          pullRequestNumber: finalizedPullRequest.pullRequest.number,
          repo: options.config.repo,
        }).pipe(Effect.mapError(toRunnerFailure))
        waitingForGreptileReviewSinceMs = Date.now()
      }

      yield* options.pullRequestStore.upsert({
        branch: managedWorktree.branch,
        issueDescription: options.issue.description,
        issueId: options.issue.id,
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        prNumber: finalizedPullRequest.pullRequest.number,
        prUrl: finalizedPullRequest.pullRequest.url,
        repo: options.config.repo,
        waitingForGreptileReviewSinceMs,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* options.runState.update({
        prNumber: finalizedPullRequest.pullRequest.number,
        prUrl: finalizedPullRequest.pullRequest.url,
        stage: "waiting-for-review",
      }).pipe(
        Effect.mapError(toRunnerFailure),
      )
      yield* announceRunStage({
        issueIdentifier: options.issue.identifier,
        issueTitle: options.issue.title,
        stage: "waiting-for-review",
      })
      yield* options.linear.commentOnIssue({
        body: [`Orca opened a pull request for ${options.issue.identifier}.`, "", `- PR: ${finalizedPullRequest.pullRequest.url}`].join("\n"),
        issueId: options.issue.id,
      }).pipe(Effect.mapError(toRunnerFailure))

      if (options.config.cleanupWorktreeOnSuccess) {
        yield* managedWorktree.remove.pipe(Effect.mapError(toRunnerFailure))
      }

      return {
        issueIdentifier: options.issue.identifier,
        mode: "implementation",
        pullRequestUrl: finalizedPullRequest.pullRequest.url,
        worktreePath: managedWorktree.directory,
      } satisfies RunnerResult
    }).pipe(
      Effect.tapError((error) =>
        reportFailure({
          error,
          github: options.github,
          issue: {
            issueId: options.issue.id,
            issueIdentifier: options.issue.identifier,
          },
          linear: options.linear,
          managedWorktree,
        })),
      Effect.ensuring(options.runState.clear.pipe(Effect.orElseSucceed(() => undefined))),
    )
  })

const runReview = (options: {
  readonly agentRunner: typeof AgentRunner.Service
  readonly config: RunnerConfig
  readonly fs: FileSystem.FileSystem
  readonly github: GitHubService
  readonly linear: LinearService
  readonly promptGen: typeof PromptGen.Service
  readonly pullRequestStore: typeof PullRequestStore.Service
  readonly review: PendingPullRequestReview
  readonly runState: typeof RunState.Service
  readonly verifier: typeof Verifier.Service
  readonly worktree: typeof Worktree.Service
}) =>
  Effect.gen(function* () {
    const managedWorktree = yield* options.worktree.resume({
      branch: options.review.pullRequest.branch,
      setup: options.config.setup,
    }).pipe(Effect.mapError(toRunnerFailure))

    yield* options.runState.acquire({
      branch: managedWorktree.branch,
      issueId: options.review.pullRequest.issueId,
      issueIdentifier: options.review.pullRequest.issueIdentifier,
      issueTitle: options.review.pullRequest.issueTitle,
      mode: "review",
      stage: "addressing-review-feedback",
      worktreePath: managedWorktree.directory,
    }).pipe(
      Effect.mapError((cause) => (cause instanceof RunStateBusyError ? cause : toRunnerFailure(cause))),
    )

    return yield* Effect.gen(function* () {
      yield* announceRunStage({
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        stage: "addressing-review-feedback",
      })

      const prompt = yield* options.promptGen.buildReviewPrompt({
        baseBranch: options.config.baseBranch,
        branch: managedWorktree.branch,
        issueDescription: options.review.pullRequest.issueDescription,
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        pullRequestUrl: options.review.pullRequest.prUrl,
        reviewFeedback: options.review.feedbackMarkdown,
        verify: options.config.verify,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* writePromptFile(options.fs, managedWorktree.directory, prompt.promptFileContents)

      yield* options.agentRunner.run({
        agent: options.config.agent,
        agentArgs: options.config.agentArgs,
        cwd: managedWorktree.directory,
        prompt: prompt.prompt,
        promptFilePath: `${managedWorktree.directory}/.orca/issue.md`,
        stallTimeoutMinutes: options.config.stallTimeoutMinutes,
        timeoutMinutes: options.config.agentTimeoutMinutes,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* setRunStage(options.runState, "verifying").pipe(Effect.mapError(toRunnerFailure))
      yield* announceRunStage({
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        stage: "verifying",
      })

      yield* options.verifier.run({
        commands: options.config.verify,
        cwd: managedWorktree.directory,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* setRunStage(options.runState, "publishing-pull-request").pipe(Effect.mapError(toRunnerFailure))
      yield* announceRunStage({
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        stage: "publishing-pull-request",
      })

      const finalizedPullRequest = yield* finalizeGitAndPullRequest({
        allowCreatePullRequest: false,
        commitMessage: makeReviewCommitMessage(options.review.pullRequest),
        config: options.config,
        github: options.github,
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        worktree: managedWorktree,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* options.github.requestPullRequestReview({
        pullRequestNumber: options.review.pullRequest.prNumber,
        repo: options.review.pullRequest.repo,
      }).pipe(Effect.mapError(toRunnerFailure))

      const waitingForGreptileReviewSinceMs = Date.now()

      yield* options.pullRequestStore.markGreptileReviewRequested({
        lastReviewedAtMs: options.review.latestFeedbackAtMs,
        prNumber: options.review.pullRequest.prNumber,
        repo: options.review.pullRequest.repo,
        waitingForGreptileReviewSinceMs,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* options.runState.update({
        prNumber: finalizedPullRequest.pullRequest.number,
        prUrl: finalizedPullRequest.pullRequest.url,
        stage: "waiting-for-review",
      }).pipe(
        Effect.mapError(toRunnerFailure),
      )
      yield* announceRunStage({
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        issueTitle: options.review.pullRequest.issueTitle,
        stage: "waiting-for-review",
      })
      yield* options.linear.commentOnIssue({
        body: [
          `Orca updated the pull request for ${options.review.pullRequest.issueIdentifier} and requested another Greptile review.`,
          "",
          `- PR: ${finalizedPullRequest.pullRequest.url}`,
        ].join("\n"),
        issueId: options.review.pullRequest.issueId,
      }).pipe(Effect.mapError(toRunnerFailure))

      if (options.config.cleanupWorktreeOnSuccess) {
        yield* managedWorktree.remove.pipe(Effect.mapError(toRunnerFailure))
      }

      return {
        issueIdentifier: options.review.pullRequest.issueIdentifier,
        mode: "review",
        pullRequestUrl: finalizedPullRequest.pullRequest.url,
        worktreePath: managedWorktree.directory,
      } satisfies RunnerResult
    }).pipe(
      Effect.tapError((error) =>
        reportFailure({
          error,
          github: options.github,
          issue: options.review.pullRequest,
          linear: options.linear,
          managedWorktree,
        })),
      Effect.ensuring(options.runState.clear.pipe(Effect.orElseSucceed(() => undefined))),
    )
  })

const writePromptFile = (fs: FileSystem.FileSystem, worktreeDirectory: string, contents: string) =>
  Effect.gen(function* () {
    const promptDirectory = `${worktreeDirectory}/.orca`
    yield* fs.makeDirectory(promptDirectory, { recursive: true }).pipe(Effect.mapError(toRunnerFailure))
    yield* fs.writeFileString(`${promptDirectory}/issue.md`, contents).pipe(Effect.mapError(toRunnerFailure))
  })

const setRunStage = (runState: typeof RunState.Service, stage: ActiveRunStage) =>
  runState.update({ stage }).pipe(
    Effect.flatMap((run) =>
      run === null
        ? Effect.fail(new RunnerFailure({ message: "Active run state disappeared while Orca was working." }))
        : Effect.succeed(run)),
  )

const announceRunStage = (options: {
  readonly issueIdentifier: string
  readonly issueTitle: string
  readonly stage: ActiveRunStage
}) =>
  Console.log(`Mission control: ${formatIssueLabel(options.issueIdentifier, options.issueTitle)} - ${formatActiveRunStage(options.stage)}`)

const finalizeGitAndPullRequest = (options: {
  readonly allowCreatePullRequest: boolean
  readonly commitMessage: string
  readonly config: {
    readonly baseBranch: string
    readonly draftPr: boolean
    readonly repo: string
    readonly verify: ReadonlyArray<string>
  }
  readonly github: GitHubService
  readonly issueIdentifier: string
  readonly issueTitle: string
  readonly worktree: ManagedWorktree
}): Effect.Effect<FinalizedPullRequest, RunnerFailure> =>
  Effect.gen(function* () {
    const status = (yield* options.worktree.runString("git status --porcelain --untracked-files=all").pipe(Effect.mapError(toRunnerFailure))).trim()
    const aheadCount = Number(
      (yield* options.worktree.runString(`git rev-list --count ${shellQuote(options.config.baseBranch)}..HEAD`).pipe(Effect.mapError(toRunnerFailure))).trim() || "0",
    )

    if (status.length > 0) {
      const addExit = yield* options.worktree.run("git add -A").pipe(Effect.mapError(toRunnerFailure))
      if (addExit !== 0) {
        return yield* Effect.fail(new RunnerFailure({ message: "Failed to stage changes in the worktree." }))
      }

      const commitExit = yield* options.worktree.run("git commit -m \"$ORCA_COMMIT_MESSAGE\"", {
        env: {
          ORCA_COMMIT_MESSAGE: options.commitMessage,
        },
      }).pipe(Effect.mapError(toRunnerFailure))

      if (commitExit !== 0) {
        return yield* Effect.fail(new RunnerFailure({ message: "Failed to create a conventional commit." }))
      }
    } else if (aheadCount === 0) {
      return yield* Effect.fail(new RunnerFailure({ message: "The agent finished without producing any code changes." }))
    }

    const pushExit = yield* options.worktree.run(`git push -u origin ${shellQuote(options.worktree.branch)}`).pipe(Effect.mapError(toRunnerFailure))
    if (pushExit !== 0) {
      return yield* Effect.fail(new RunnerFailure({ message: "Failed to push the worktree branch to origin." }))
    }

    const existingPr = yield* options.github.viewCurrentPullRequest(options.worktree.directory).pipe(Effect.mapError(toRunnerFailure))
    if (Option.isSome(existingPr)) {
      return {
        pullRequest: existingPr.value,
        wasCreated: false,
      }
    }

    if (!options.allowCreatePullRequest) {
      return yield* Effect.fail(new RunnerFailure({ message: "Expected an existing pull request for review work, but none was found." }))
    }

    const pullRequest = yield* options.github.createPullRequest({
      baseBranch: options.config.baseBranch,
      body: makePullRequestBody(options.issueIdentifier, options.issueTitle, options.config.verify),
      cwd: options.worktree.directory,
      draft: options.config.draftPr,
      repo: options.config.repo,
      title: makePullRequestTitle(options.issueTitle),
    }).pipe(Effect.mapError(toRunnerFailure))

    return {
      pullRequest,
      wasCreated: true,
    }
  })

const reportFailure = (options: {
  readonly error: RunnerFailure | RepoConfigError | RunStateBusyError | RunnerNoWorkError
  readonly github: GitHubService
  readonly issue: {
    readonly issueId: string
    readonly issueIdentifier: string
  }
  readonly linear: LinearService
  readonly managedWorktree: {
    readonly directory: string
  }
}) =>
  Effect.gen(function* () {
    if (options.error instanceof RepoConfigError || options.error instanceof RunStateBusyError || options.error instanceof RunnerNoWorkError) {
      return
    }

    const existingPr = yield* options.github.viewCurrentPullRequest(options.managedWorktree.directory).pipe(
      Effect.orElseSucceed(() => Option.none<PullRequestInfo>()),
    )

    const lines = [
      `Orca failed while working on ${options.issue.issueIdentifier}.`,
      "",
      `- Reason: ${options.error.message}`,
      `- Worktree: ${options.managedWorktree.directory}`,
    ]
    if (Option.isSome(existingPr)) {
      lines.push(`- Existing PR: ${existingPr.value.url}`)
    }

    yield* options.linear.commentOnIssue({
      body: lines.join("\n"),
      issueId: options.issue.issueId,
    }).pipe(Effect.orElseSucceed(() => undefined))
  })

const makeImplementationCommitMessage = (issue: PlannedIssue) =>
  `feat: implement ${issue.identifier.toLowerCase()} ${slugifyIssueTitle(issue.title)}`

const makeReviewCommitMessage = (pullRequest: OrcaManagedPullRequest) =>
  `fix: address ${pullRequest.issueIdentifier.toLowerCase()} review feedback`

const makePullRequestTitle = (issueTitle: string) =>
  `feat: ${issueTitle.trim().toLowerCase()}`

const makePullRequestBody = (issueIdentifier: string, issueTitle: string, verify: ReadonlyArray<string>) =>
  [
    `this pr brings ${issueTitle.trim().toLowerCase()} into the repo so the requested behavior is ready for review.`,
    "",
    "### changes",
    `#### 1. deliver ${issueTitle.trim().toLowerCase()}`,
    "this keeps the branch focused on the requested outcome and ready for the usual review flow.",
    "",
    "### verification",
    ...(verify.length > 0
      ? verify.map((command) => `- \`${command}\``)
      : ["- no verification commands were configured."]),
    "",
    `closes ${issueIdentifier}`,
  ].join("\n")

const isWaitingForGreptileReview = (
  pullRequest: OrcaManagedPullRequest,
): pullRequest is WaitingForGreptileReviewPullRequest =>
  pullRequest.greptileCompletedAtMs === null && pullRequest.waitingForGreptileReviewSinceMs !== null
const formatIssueLabel = (issueIdentifier: string, issueTitle: string) =>
  issueTitle.trim().length > 0 ? `${issueIdentifier} ${issueTitle}` : issueIdentifier

const shellQuote = (value: string) => `'${value.replace(/'/g, `"'"'`)}'`

const toRunnerFailure = (cause: unknown) =>
  cause instanceof RunnerFailure
    ? cause
    : new RunnerFailure({
        message: getErrorMessage(cause),
        cause,
      })

const getErrorMessage = (cause: unknown) => {
  if (
    cause instanceof RepoConfigError
    || cause instanceof RunStateError
    || cause instanceof WorktreeError
    || cause instanceof PromptGenError
    || cause instanceof AgentRunnerError
    || cause instanceof AgentRunnerStalledError
    || cause instanceof AgentRunnerTimeoutError
    || cause instanceof VerificationError
    || cause instanceof GitHubError
    || cause instanceof PullRequestStoreError
    || cause instanceof RunnerFailure
  ) {
    return cause.message
  }
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
