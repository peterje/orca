import { Data, Effect, Layer, Option, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type PullRequestInfo = {
  readonly isDraft: boolean
  readonly number: number
  readonly state: string
  readonly url: string
}

export type GitHubService = {
  createPullRequest: (options: {
    readonly baseBranch: string
    readonly body: string
    readonly cwd: string
    readonly draft: boolean
    readonly repo: string
    readonly title: string
  }) => Effect.Effect<PullRequestInfo, GitHubError>
  detectRepo: Effect.Effect<string, GitHubError>
  viewCurrentPullRequest: (cwd: string) => Effect.Effect<Option.Option<PullRequestInfo>, GitHubError>
}

export const GitHub = ServiceMap.Service<GitHubService>("orca/GitHub")

export const GitHubLive = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const detectRepo = ChildProcess.make("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stderr: "pipe",
    stdout: "pipe",
  }).pipe(
    spawner.string,
    Effect.map((value) => value.trim()),
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new GitHubError({
              message: "Failed to detect the current github repository. Ensure `gh` is authenticated for this repo.",
            }),
          )),
    Effect.mapError((cause) =>
      cause instanceof GitHubError
        ? cause
        : new GitHubError({
            message: "Failed to detect the current github repository. Ensure `gh` is authenticated for this repo.",
            cause,
          })),
  )

  const viewCurrentPullRequest = (cwd: string) =>
    ChildProcess.make("gh", ["pr", "view", "--json", "number,url,state,isDraft"], {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(
      spawner.string,
      Effect.map((value) => value.trim()),
      Effect.flatMap((value) => {
        if (value.length === 0) {
          return Effect.succeed(Option.none<PullRequestInfo>())
        }

        return Effect.try({
          try: () => Option.some(JSON.parse(value) as PullRequestInfo),
          catch: () => Option.none<PullRequestInfo>(),
        })
      }),
      Effect.catch(() => Effect.succeed(Option.none<PullRequestInfo>())),
    )

  const createPullRequest = (options: {
    readonly baseBranch: string
    readonly body: string
    readonly cwd: string
    readonly draft: boolean
    readonly repo: string
    readonly title: string
  }) =>
    ChildProcess.make(
      "gh",
      [
        "pr",
        "create",
        ...(options.draft ? ["--draft"] : []),
        "--repo",
        options.repo,
        "--base",
        options.baseBranch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      {
        cwd: options.cwd,
        stderr: "pipe",
        stdout: "pipe",
      },
    ).pipe(
      spawner.string,
      Effect.map((value) => value.trim()),
      Effect.flatMap(() => viewCurrentPullRequest(options.cwd)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new GitHubError({ message: "Pull request was created but could not be inspected." }),
            ),
          onSome: (pullRequest) => Effect.succeed(pullRequest),
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof GitHubError
          ? cause
          : new GitHubError({ message: "Failed to create a github pull request.", cause }),
      ),
    )

  return GitHub.of({ createPullRequest, detectRepo, viewCurrentPullRequest })
})

export const GitHubLayer = Layer.effect(GitHub, GitHubLive)

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
