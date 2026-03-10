import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { OrcaClient } from "../orca-client.ts"

const commandRunNext = Command.make(
  "next",
  {},
  Effect.fn("commandRunNext")(function* () {
    const client = yield* OrcaClient
    const result = yield* client.runNext
    yield* Console.log(`${result.mode === "review" ? "Updated" : "Opened"} PR for ${result.issueIdentifier}: ${result.pullRequestUrl}`)
  }),
).pipe(Command.withDescription("Execute the next Orca work item once."))

export const commandRun = Command.make("run").pipe(
  Command.withDescription("Execute Orca work from Linear."),
  Command.withSubcommands([commandRunNext]),
)
