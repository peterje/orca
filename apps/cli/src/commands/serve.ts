import { Console, Duration, Effect, Option, Result } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { RunState } from "../run-state.ts"
import { Runner } from "../runner.ts"

const noWorkHeartbeatEvery = 10

export const commandServe = Command.make(
  "serve",
  {
    execute: Flag.boolean("execute").pipe(
      Flag.withDescription("Run the top actionable issue instead of only logging it."),
    ),
    intervalSeconds: Flag.integer("interval-seconds").pipe(
      Flag.withDescription("Polling interval in seconds."),
      Flag.withDefault(30),
    ),
  },
  Effect.fn("commandServe")(function* ({ execute, intervalSeconds }) {
    const runner = yield* Runner
    let previousTopIssueId: string | null = null
    let emptyPolls = 0
    let previouslyActiveRunId: string | null = null

    while (true) {
      if (execute) {
        const runState = yield* RunState
        const activeRun = yield* runState.current.pipe(Effect.orElseSucceed(() => null))
        if (activeRun !== null) {
          if (previouslyActiveRunId !== activeRun.issueId) {
            yield* Console.log(`Run already active: ${activeRun.issueIdentifier} (${activeRun.worktreePath})`)
            previouslyActiveRunId = activeRun.issueId
          }
          yield* Effect.sleep(Duration.seconds(intervalSeconds))
          continue
        }
        previouslyActiveRunId = null
      }

      const topWork = yield* runner.peekNext.pipe(Effect.map(Option.getOrNull))

      if (topWork) {
        emptyPolls = 0
        if (execute) {
          const result = yield* runner.runNext.pipe(Effect.result)
          yield* Result.match(result, {
            onFailure: (error) => {
              const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
              return Console.log(`Run failed: ${message}`)
            },
            onSuccess: (value) =>
              Console.log(`${value.mode === "review" ? "Updated" : "Opened"} PR for ${value.issueIdentifier}: ${value.pullRequestUrl}`),
          })
          previousTopIssueId = null
        } else if (topWork.id !== previousTopIssueId) {
          yield* Console.log(
            topWork.kind === "review"
              ? `Would review: ${topWork.issueIdentifier} ${topWork.title} (${topWork.pullRequestUrl})`
              : `Would implement: ${topWork.issueIdentifier} ${topWork.title}`,
          )
          previousTopIssueId = topWork.id
        }
      } else {
        emptyPolls += 1
        if (previousTopIssueId !== null || emptyPolls === 1 || emptyPolls % noWorkHeartbeatEvery === 0) {
          yield* Console.log("No actionable Orca work is currently available.")
          previousTopIssueId = null
        }
      }

      yield* Effect.sleep(Duration.seconds(intervalSeconds))
    }
  }),
).pipe(Command.withDescription("Poll Linear and print the next Orca issue."))
