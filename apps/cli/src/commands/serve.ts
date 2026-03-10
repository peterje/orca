import { Console, Duration, Effect, Result } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { renderMissionControl } from "../mission-control.ts"
import { OrcaClient } from "../orca-client.ts"

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
    const client = yield* OrcaClient
    let previousSnapshotKey: string | null = null
    let emptyPolls = 0

    while (true) {
      yield* client.pollWaitingPullRequests.pipe(
        Effect.tapError((error) => Console.log(`Failed to poll waiting pull requests: ${formatErrorMessage(error)}`)),
        Effect.orElseSucceed(() => undefined),
      )
      const snapshot = yield* client.missionControlSnapshot.pipe(
        Effect.tapError((error) => Console.log(`Failed to load mission control snapshot: ${formatErrorMessage(error)}`)),
        Effect.orElseSucceed(() => null),
      )

      if (snapshot === null) {
        yield* Effect.sleep(Duration.seconds(intervalSeconds))
        continue
      }

      const snapshotKey = JSON.stringify(snapshot)
      if (snapshot.current !== null || snapshot.next !== null) {
        emptyPolls = 0
        if (snapshotKey !== previousSnapshotKey) {
          for (const line of renderMissionControl(snapshot)) {
            yield* Console.log(line)
          }
          previousSnapshotKey = snapshotKey
        }
        if (execute && snapshot.current === null && snapshot.next !== null) {
          const result = yield* client.runNext.pipe(Effect.result)
          yield* Result.match(result, {
            onFailure: (error) => Console.log(`Run failed: ${formatErrorMessage(error)}`),
            onSuccess: (value) =>
              Console.log(`${value.mode === "review" ? "Updated" : "Opened"} PR for ${value.issueIdentifier}: ${value.pullRequestUrl}`),
          })
          previousSnapshotKey = null
        }
      } else {
        emptyPolls += 1
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

const formatErrorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
