import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import type { Command as ChildProcessCommand } from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process"
import { GitHub, GitHubLayer, greptileReviewCommentBody } from "./github.ts"

describe("GitHub", () => {
  it.effect("returns none when gh pr view emits no json", () =>
    Effect.gen(function* () {
      const github = yield* GitHub
      const pullRequest = yield* github.viewCurrentPullRequest(process.cwd())
      expect(pullRequest._tag).toBe("None")
    }).pipe(Effect.provide(makeGitHubLayer({ stdout: () => "" }))))

  it.effect("parses the current pull request when gh returns json", () =>
    Effect.gen(function* () {
      const github = yield* GitHub
      const pullRequest = yield* github.viewCurrentPullRequest(process.cwd())
      expect(pullRequest).toMatchObject({
        _tag: "Some",
        value: {
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/peterje/orca/pull/42",
        },
      })
    }).pipe(
      Effect.provide(
        makeGitHubLayer({
          stdout: () => '{"number":42,"url":"https://github.com/peterje/orca/pull/42","state":"OPEN","isDraft":true}',
        }),
      ),
    ))

  it.effect("reads pull request review feedback", () =>
    Effect.gen(function* () {
      const github = yield* GitHub
      const feedback = yield* github.readPullRequestFeedback({
        pullRequestNumber: 42,
        repo: "peterje/orca",
      })

      expect(feedback).toMatchObject({
        authorLogin: "author",
        labels: ["orca-review"],
        number: 42,
        reviews: [
          {
            authorLogin: "reviewer",
            body: "Please tighten this up.",
          },
        ],
        state: "OPEN",
        url: "https://github.com/peterje/orca/pull/42",
      })
      expect(feedback.reviewThreads[0]).toMatchObject({
        comments: [
          {
            authorLogin: "reviewer",
            body: "@orca please revisit this branch.",
            originalLine: 12,
            path: "apps/cli/src/runner.ts",
          },
        ],
        isCollapsed: false,
        isResolved: false,
      })
    }).pipe(
      Effect.provide(
        makeGitHubLayer({
          stdout: () => JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  author: { login: "author" },
                  comments: {
                    nodes: [
                      {
                        author: { login: "commenter" },
                        body: "General note",
                        createdAt: "2026-01-01T00:00:00.000Z",
                        id: "comment-1",
                      },
                    ],
                  },
                  isDraft: true,
                  labels: {
                    nodes: [{ name: "orca-review" }],
                  },
                  number: 42,
                  reviewThreads: {
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              author: { login: "reviewer" },
                              body: "@orca please revisit this branch.",
                              createdAt: "2026-01-02T00:00:00.000Z",
                              diffHunk: "@@ -1,1 +1,1 @@",
                              id: "thread-comment-1",
                              originalLine: 12,
                              path: "apps/cli/src/runner.ts",
                            },
                          ],
                        },
                        isCollapsed: false,
                        isResolved: false,
                      },
                    ],
                  },
                  reviews: {
                    nodes: [
                      {
                        author: { login: "reviewer" },
                        body: "Please tighten this up.",
                        createdAt: "2026-01-03T00:00:00.000Z",
                        id: "review-1",
                      },
                    ],
                  },
                  state: "OPEN",
                  url: "https://github.com/peterje/orca/pull/42",
                },
              },
            },
          }),
        }),
      ),
    ))

  it.effect("posts the Greptile review trigger comment", () => {
    const commands: Array<CommandInvocation> = []

    return Effect.gen(function* () {
      const github = yield* GitHub

      yield* github.requestPullRequestReview({
        pullRequestNumber: 42,
        repo: "peterje/orca",
      })

      expect(commands).toContainEqual({
        args: ["pr", "comment", "42", "--repo", "peterje/orca", "--body", greptileReviewCommentBody],
        command: "gh",
      })
    }).pipe(
      Effect.provide(
        makeGitHubLayer({
          onCommand: (command) => {
            commands.push(command)
          },
        }),
      ),
    )
  })
})

type CommandInvocation = {
  readonly args: ReadonlyArray<string>
  readonly command: string
}

const makeGitHubLayer = (options?: {
  readonly onCommand?: ((command: CommandInvocation) => void) | undefined
  readonly stdout?: ((command: CommandInvocation) => string) | undefined
}) =>
  GitHubLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command: ChildProcessCommand) => {
          const invocation = toCommandInvocation(command)
          options?.onCommand?.(invocation)
          const encoded = new TextEncoder().encode(options?.stdout?.(invocation) ?? "")
          return Effect.succeed(ChildProcessSpawner.makeHandle({
            all: Stream.fromIterable([encoded]),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            pid: 1 as never,
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout: Stream.fromIterable([encoded]),
          }))
        }),
      ),
    ),
  )

const toCommandInvocation = (command: ChildProcessCommand): CommandInvocation => {
  if (command._tag !== "StandardCommand") {
    throw new Error(`Unexpected command type: ${command._tag}`)
  }

  return {
    args: command.args,
    command: command.command,
  }
}
