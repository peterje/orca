import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { GitHub, GitHubLayer } from "./github.ts"

describe("GitHub", () => {
  it.effect("returns none when gh pr view emits no json", () =>
    Effect.gen(function* () {
      const github = yield* GitHub
      const pullRequest = yield* github.viewCurrentPullRequest(process.cwd())
      expect(pullRequest._tag).toBe("None")
    }).pipe(Effect.provide(makeGitHubLayer(() => ""))))

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
        makeGitHubLayer(
          () => '{"number":42,"url":"https://github.com/peterje/orca/pull/42","state":"OPEN","isDraft":true}',
        ),
      ),
    ))
})

const makeGitHubLayer = (stdout: () => string) =>
  GitHubLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          const encoded = new TextEncoder().encode(stdout())
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
