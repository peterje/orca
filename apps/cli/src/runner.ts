import { Data, Effect, FileSystem, Layer, Option, ServiceMap } from "effect"
import { AgentRunner, AgentRunnerError, AgentRunnerStalledError, AgentRunnerTimeoutError } from "./agent-runner.ts"
import { GitHub, GitHubError, type GitHubService, type PullRequestInfo } from "./github.ts"
import { planIssues } from "./issue-planner.ts"
import { Linear, type LinearIssue, type LinearService } from "./linear.ts"
import { PromptGen, PromptGenError } from "./prompt-gen.ts"
import { RepoConfig, RepoConfigError } from "./repo-config.ts"
import { RunState, RunStateBusyError, RunStateError } from "./run-state.ts"
import { VerificationError, Verifier } from "./verifier.ts"
import { Worktree, WorktreeError, slugifyIssueTitle } from "./worktree.ts"

export type RunnerResult = {
  readonly issueIdentifier: string
  readonly pullRequestUrl: string
  readonly worktreePath: string
}

export type RunnerService = {
  runNext: Effect.Effect<RunnerResult, RunnerFailure | RunnerNoWorkError | RepoConfigError | RunStateBusyError>
}

export const Runner = ServiceMap.Service<RunnerService>("orca/Runner")

export const RunnerLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const agentRunner = yield* AgentRunner
  const github = yield* GitHub
  const linear = yield* Linear
  const promptGen = yield* PromptGen
  const repoConfig = yield* RepoConfig
  const runState = yield* RunState
  const verifier = yield* Verifier
  const worktree = yield* Worktree

  const runNext = Effect.gen(function* () {
    const config = yield* repoConfig.read
    const issues = yield* linear.issues.pipe(Effect.mapError(toRunnerFailure))
    const plan = planIssues(issues, { linearLabel: config.linearLabel })
    const issue = plan.actionable[0]
    if (!issue) {
      return yield* Effect.fail(
        new RunnerNoWorkError({ message: `No actionable ${config.linearLabel} work is currently available.` }),
      )
    }

    const managedWorktree = yield* worktree.create({
      baseBranch: config.baseBranch,
      branchPrefix: config.branchPrefix,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      setup: config.setup,
    }).pipe(Effect.mapError(toRunnerFailure))

    yield* runState.acquire({
      branch: managedWorktree.branch,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      worktreePath: managedWorktree.directory,
    }).pipe(
      Effect.mapError((cause) => (cause instanceof RunStateBusyError ? cause : toRunnerFailure(cause))),
    )

    return yield* Effect.gen(function* () {
      yield* linear.markIssueInProgress(issue).pipe(Effect.mapError(toRunnerFailure))

      const prompt = yield* promptGen.buildImplementationPrompt({
        baseBranch: config.baseBranch,
        branch: managedWorktree.branch,
        issue,
        plan,
        verify: config.verify,
      }).pipe(Effect.mapError(toRunnerFailure))

      const promptDirectory = `${managedWorktree.directory}/.orca`
      const promptFilePath = `${promptDirectory}/issue.md`
      yield* fs.makeDirectory(promptDirectory, { recursive: true }).pipe(Effect.mapError(toRunnerFailure))
      yield* fs.writeFileString(promptFilePath, prompt.promptFileContents).pipe(Effect.mapError(toRunnerFailure))

      yield* agentRunner.run({
        agent: config.agent,
        agentArgs: config.agentArgs,
        cwd: managedWorktree.directory,
        prompt: prompt.prompt,
        promptFilePath,
        stallTimeoutMinutes: config.stallTimeoutMinutes,
        timeoutMinutes: config.agentTimeoutMinutes,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* verifier.run({
        commands: config.verify,
        cwd: managedWorktree.directory,
      }).pipe(Effect.mapError(toRunnerFailure))

      const pullRequest = yield* finalizeGitAndPullRequest({
        config,
        github,
        issue,
        worktree: managedWorktree,
      }).pipe(Effect.mapError(toRunnerFailure))

      yield* runState.update({ prNumber: pullRequest.number, prUrl: pullRequest.url }).pipe(
        Effect.mapError(toRunnerFailure),
      )
      yield* linear.commentOnIssue({
        body: [`Orca opened a pull request for ${issue.identifier}.`, "", `- PR: ${pullRequest.url}`].join("\n"),
        issueId: issue.id,
      }).pipe(Effect.mapError(toRunnerFailure))

      if (config.cleanupWorktreeOnSuccess) {
        yield* managedWorktree.remove.pipe(Effect.mapError(toRunnerFailure))
      }

      return {
        issueIdentifier: issue.identifier,
        pullRequestUrl: pullRequest.url,
        worktreePath: managedWorktree.directory,
      } satisfies RunnerResult
    }).pipe(
      Effect.tapError((error) => reportFailure({ error, issue, linear, github, managedWorktree })),
      Effect.ensuring(runState.clear.pipe(Effect.orElseSucceed(() => undefined))),
    )
  })

  return Runner.of({ runNext })
})

export const RunnerLayer = Layer.effect(Runner, RunnerLive)

export class RunnerFailure extends Data.TaggedError("RunnerFailure")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RunnerNoWorkError extends Data.TaggedError("RunnerNoWorkError")<{
  readonly message: string
}> {}

const finalizeGitAndPullRequest = (options: {
  readonly config: {
    readonly baseBranch: string
    readonly draftPr: boolean
    readonly repo: string
    readonly verify: ReadonlyArray<string>
  }
  readonly github: GitHubService
  readonly issue: LinearIssue
  readonly worktree: {
    readonly branch: string
    readonly directory: string
    readonly run: (command: string, runOptions?: { readonly env?: Record<string, string> | undefined }) => Effect.Effect<number, WorktreeError>
    readonly runString: (command: string, runOptions?: { readonly env?: Record<string, string> | undefined }) => Effect.Effect<string, WorktreeError>
  }
}) =>
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

      const commitExit = yield* options.worktree.run(
        "git commit -m \"$ORCA_COMMIT_MESSAGE\"",
        {
          env: {
            ORCA_COMMIT_MESSAGE: makeCommitMessage(options.issue),
          },
        },
      ).pipe(Effect.mapError(toRunnerFailure))

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
      return existingPr.value
    }

    return yield* options.github.createPullRequest({
      baseBranch: options.config.baseBranch,
      body: makePullRequestBody(options.issue, options.config.verify),
      cwd: options.worktree.directory,
      draft: options.config.draftPr,
      repo: options.config.repo,
      title: `${options.issue.identifier}: ${options.issue.title}`,
    }).pipe(Effect.mapError(toRunnerFailure))
  })

const reportFailure = (options: {
  readonly error: RunnerFailure | RepoConfigError | RunStateBusyError | RunnerNoWorkError
  readonly github: GitHubService
  readonly issue: LinearIssue
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
      `Orca failed while working on ${options.issue.identifier}.`,
      "",
      `- Reason: ${options.error.message}`,
      `- Worktree: ${options.managedWorktree.directory}`,
    ]
    if (Option.isSome(existingPr)) {
      lines.push(`- Existing PR: ${existingPr.value.url}`)
    }

    yield* options.linear.commentOnIssue({
      body: lines.join("\n"),
      issueId: options.issue.id,
    }).pipe(Effect.orElseSucceed(() => undefined))
  })

const makeCommitMessage = (issue: LinearIssue) =>
  `feat: implement ${issue.identifier.toLowerCase()} ${slugifyIssueTitle(issue.title)}`

const makePullRequestBody = (issue: LinearIssue, verify: ReadonlyArray<string>) =>
  [
    "## Summary",
    `- Implement ${issue.identifier} automatically with Orca.`,
    "",
    "## Verification",
    ...(verify.length > 0
      ? verify.map((command) => `- \`${command}\``)
      : ["- No verification commands were configured."]),
    "",
    `Refs ${issue.identifier}`,
  ].join("\n")

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

const toRunnerFailure = (cause: unknown) =>
  cause instanceof RunnerFailure
    ? cause
    : new RunnerFailure({
        message: getErrorMessage(cause),
        cause,
      })

const getErrorMessage = (cause: unknown) => {
  if (
    cause instanceof RepoConfigError ||
    cause instanceof RunStateError ||
    cause instanceof WorktreeError ||
    cause instanceof PromptGenError ||
    cause instanceof AgentRunnerError ||
    cause instanceof AgentRunnerStalledError ||
    cause instanceof AgentRunnerTimeoutError ||
    cause instanceof VerificationError ||
    cause instanceof GitHubError ||
    cause instanceof RunnerFailure
  ) {
    return cause.message
  }
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
