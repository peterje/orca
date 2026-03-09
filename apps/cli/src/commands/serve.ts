import { Console, Duration, Effect, Result } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { MissionControl, renderMissionControl } from "../mission-control.ts"
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
    const missionControl = yield* MissionControl
    const runner = yield* Runner
    let previousSnapshotKey: string | null = null
    let emptyPolls = 0

    while (true) {
      const runState = yield* RunState
      const activeRun = yield* runState.current.pipe(Effect.orElseSucceed(() => null))
      const snapshot = yield* missionControl.snapshot
      const snapshotKey = JSON.stringify(snapshot)
      const shouldHeartbeat = activeRun === null && snapshot.next === null

      if (snapshot.current !== null || snapshot.next !== null) {
        emptyPolls = 0
        if (snapshotKey !== previousSnapshotKey) {
          for (const line of renderMissionControl(snapshot)) {
            yield* Console.log(line)
          }
          previousSnapshotKey = snapshotKey
        }
        if (execute && activeRun === null && snapshot.next !== null) {
          const result = yield* runner.runNext.pipe(Effect.result)
          yield* Result.match(result, {
            onFailure: (error) => {
              const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
              return Console.log(`Run failed: ${message}`)
            },
            onSuccess: (value) =>
              Console.log(`${value.mode === "review" ? "Updated" : "Opened"} PR for ${value.issueIdentifier}: ${value.pullRequestUrl}`),
          })
          previousSnapshotKey = null
        }
      } else {
        if (shouldHeartbeat) {
          emptyPolls += 1
        }
        if (snapshotKey !== previousSnapshotKey || emptyPolls === 1 || emptyPolls % noWorkHeartbeatEvery === 0) {
          for (const line of renderMissionControl(snapshot)) {
            yield* Console.log(line)
          }
          previousSnapshotKey = snapshotKey
        }
      }

      yield* Effect.sleep(Duration.seconds(intervalSeconds))
    }
  }),
).pipe(Command.withDescription("Poll Linear and print the next Orca issue."))
