import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { renderMissionControl } from "../mission-control.ts"
import { OrcaClient } from "../orca-client.ts"

export const commandStatus = Command.make(
  "status",
  {},
  Effect.fn("commandStatus")(function* () {
    const client = yield* OrcaClient
    const snapshot = yield* client.missionControlSnapshot
    for (const line of renderMissionControl(snapshot)) {
      yield* Console.log(line)
    }
  }),
).pipe(Command.withDescription("Show the current Orca mission control snapshot."))
