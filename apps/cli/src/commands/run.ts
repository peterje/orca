import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { Runner } from "../runner.ts"

const commandRunNext = Command.make(
  "next",
  {},
  Effect.fn("commandRunNext")(function* () {
    const runner = yield* Runner
    const result = yield* runner.runNext
    yield* Console.log(`Opened PR for ${result.issueIdentifier}: ${result.pullRequestUrl}`)
  }),
).pipe(Command.withDescription("Execute the top actionable Linear issue once."))

export const commandRun = Command.make("run").pipe(
  Command.withDescription("Execute Orca work from Linear."),
  Command.withSubcommands([commandRunNext]),
)
