import { Data, Effect, Layer, Option, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type PullRequestInfo = {
  readonly isDraft: boolean
  readonly number: number
  readonly state: string
  readonly url: string
}

export type PullRequestComment = {
  readonly authorLogin: string
  readonly body: string
  readonly createdAtMs: number
  readonly id: string
  readonly isBot: boolean
}

export type PullRequestReview = {
  readonly authorLogin: string
  readonly body: string
  readonly createdAtMs: number
  readonly id: string
  readonly isBot: boolean
}

export type PullRequestReviewComment = PullRequestComment & {
  readonly diffHunk: string
  readonly originalLine: number | null
  readonly path: string
}

export type PullRequestReviewThread = {
  readonly comments: ReadonlyArray<PullRequestReviewComment>
  readonly isCollapsed: boolean
  readonly isResolved: boolean
}

export type PullRequestFeedback = PullRequestInfo & {
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly labels: ReadonlyArray<string>
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>
  readonly reviews: ReadonlyArray<PullRequestReview>
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
  readPullRequestFeedback: (options: {
    readonly pullRequestNumber: number
    readonly repo: string
  }) => Effect.Effect<PullRequestFeedback, GitHubError>
  removePullRequestLabel: (options: {
    readonly label: string
    readonly pullRequestNumber: number
    readonly repo: string
  }) => Effect.Effect<void, GitHubError>
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

  const readPullRequestFeedback = (options: {
    readonly pullRequestNumber: number
    readonly repo: string
  }) =>
    Effect.gen(function* () {
      const [owner, repo] = parseRepo(options.repo)
      const output = yield* ChildProcess.make(
        "gh",
        [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          `pr=${options.pullRequestNumber}`,
          "-f",
          `query=${pullRequestFeedbackQuery}`,
        ],
        {
          stderr: "pipe",
          stdout: "pipe",
        },
      ).pipe(
        spawner.string,
        Effect.mapError((cause) => new GitHubError({ message: "Failed to read pull request feedback from github.", cause })),
      )

      return yield* Effect.try({
        try: () => parsePullRequestFeedback(output),
        catch: (cause) => new GitHubError({ message: "GitHub returned pull request feedback in an unexpected shape.", cause }),
      })
    })

  const removePullRequestLabel = (options: {
    readonly label: string
    readonly pullRequestNumber: number
    readonly repo: string
  }) =>
    ChildProcess.make(
      "gh",
      [
        "pr",
        "edit",
        String(options.pullRequestNumber),
        "--repo",
        options.repo,
        "--remove-label",
        options.label,
      ],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    ).pipe(
      spawner.exitCode,
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(new GitHubError({ message: `Failed to remove label ${options.label} from pull request #${options.pullRequestNumber}.` }))),
      Effect.mapError((cause) =>
        cause instanceof GitHubError
          ? cause
          : new GitHubError({
              message: `Failed to remove label ${options.label} from pull request #${options.pullRequestNumber}.`,
              cause,
            })),
    )

  return GitHub.of({ createPullRequest, detectRepo, readPullRequestFeedback, removePullRequestLabel, viewCurrentPullRequest })
})

export const GitHubLayer = Layer.effect(GitHub, GitHubLive)

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const commonBotUserPrefixes = ["dependabot", "github", "changeset", "renovate", "snyk", "coderabbit"]

const parseRepo = (repo: string) => {
  const [owner, name, ...rest] = repo.split("/")
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid github repo: ${repo}`)
  }
  return [owner, name] as const
}

const parsePullRequestFeedback = (raw: string): PullRequestFeedback => {
  const payload = JSON.parse(raw) as {
    readonly data?: {
      readonly repository?: {
        readonly pullRequest?: {
          readonly comments?: { readonly nodes?: ReadonlyArray<PullRequestNodeCommentJson> }
          readonly isDraft?: boolean
          readonly labels?: { readonly nodes?: ReadonlyArray<{ readonly name?: string }> }
          readonly number?: number
          readonly reviewThreads?: { readonly nodes?: ReadonlyArray<PullRequestNodeReviewThreadJson> }
          readonly reviews?: { readonly nodes?: ReadonlyArray<PullRequestNodeReviewJson> }
          readonly state?: string
          readonly url?: string
        } | null
      }
    }
  }

  const pullRequest = payload.data?.repository?.pullRequest
  if (!pullRequest || typeof pullRequest.number !== "number" || typeof pullRequest.url !== "string" || typeof pullRequest.state !== "string") {
    throw new Error("Pull request feedback payload was incomplete.")
  }

  return {
    comments: (pullRequest.comments?.nodes ?? []).map(mapComment),
    isDraft: pullRequest.isDraft === true,
    labels: (pullRequest.labels?.nodes ?? [])
      .map((label) => label.name)
      .filter((label): label is string => typeof label === "string" && label.trim().length > 0),
    number: pullRequest.number,
    reviewThreads: (pullRequest.reviewThreads?.nodes ?? []).map(mapReviewThread),
    reviews: (pullRequest.reviews?.nodes ?? []).map(mapReview),
    state: pullRequest.state,
    url: pullRequest.url,
  }
}

type PullRequestNodeCommentJson = {
  readonly author?: { readonly login?: string } | null
  readonly body?: string
  readonly createdAt?: string
  readonly id?: string
}

type PullRequestNodeReviewJson = PullRequestNodeCommentJson

type PullRequestNodeReviewCommentJson = PullRequestNodeCommentJson & {
  readonly diffHunk?: string
  readonly originalLine?: number | null
  readonly path?: string
}

type PullRequestNodeReviewThreadJson = {
  readonly comments?: { readonly nodes?: ReadonlyArray<PullRequestNodeReviewCommentJson> }
  readonly isCollapsed?: boolean
  readonly isResolved?: boolean
}

const mapComment = (comment: PullRequestNodeCommentJson): PullRequestComment => {
  const authorLogin = normalizeAuthorLogin(comment.author?.login)
  return {
    authorLogin,
    body: typeof comment.body === "string" ? comment.body : "",
    createdAtMs: parseDate(comment.createdAt),
    id: typeof comment.id === "string" ? comment.id : "",
    isBot: isBotLogin(authorLogin),
  }
}

const mapReview = (review: PullRequestNodeReviewJson): PullRequestReview => {
  const authorLogin = normalizeAuthorLogin(review.author?.login)
  return {
    authorLogin,
    body: typeof review.body === "string" ? review.body : "",
    createdAtMs: parseDate(review.createdAt),
    id: typeof review.id === "string" ? review.id : "",
    isBot: isBotLogin(authorLogin),
  }
}

const mapReviewThread = (thread: PullRequestNodeReviewThreadJson): PullRequestReviewThread => ({
  comments: (thread.comments?.nodes ?? []).map(mapReviewComment),
  isCollapsed: thread.isCollapsed === true,
  isResolved: thread.isResolved === true,
})

const mapReviewComment = (comment: PullRequestNodeReviewCommentJson): PullRequestReviewComment => {
  const authorLogin = normalizeAuthorLogin(comment.author?.login)
  return {
    authorLogin,
    body: typeof comment.body === "string" ? comment.body : "",
    createdAtMs: parseDate(comment.createdAt),
    diffHunk: typeof comment.diffHunk === "string" ? comment.diffHunk : "",
    id: typeof comment.id === "string" ? comment.id : "",
    isBot: isBotLogin(authorLogin),
    originalLine: typeof comment.originalLine === "number" ? comment.originalLine : null,
    path: typeof comment.path === "string" ? comment.path : "unknown",
  }
}

const normalizeAuthorLogin = (login: string | undefined) => (typeof login === "string" && login.length > 0 ? login : "ghost")

const parseDate = (value: string | undefined) => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const isBotLogin = (login: string) => commonBotUserPrefixes.some((prefix) => login.toLowerCase().startsWith(prefix))

const pullRequestFeedbackQuery = `
query PullRequestFeedback($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      number
      url
      state
      isDraft
      labels(first: 50) {
        nodes {
          name
        }
      }
      reviews(first: 100) {
        nodes {
          id
          body
          createdAt
          author {
            login
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isCollapsed
          isResolved
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              path
              originalLine
              diffHunk
              author {
                login
              }
            }
          }
        }
      }
      comments(first: 100) {
        nodes {
          id
          body
          createdAt
          author {
            login
          }
        }
      }
    }
  }
}
`
