import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { MissionControl, renderMissionControl } from "../mission-control.ts"

export const commandStatus = Command.make(
  "status",
  {},
  Effect.fn("commandStatus")(function* () {
    const missionControl = yield* MissionControl
    const snapshot = yield* missionControl.snapshot
    for (const line of renderMissionControl(snapshot)) {
      yield* Console.log(line)
    }
  }),
).pipe(Command.withDescription("Show the current Orca mission control snapshot."))
