import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { resolveOrcaDirectory } from "../kvs.ts"
import { Linear } from "../linear.ts"

const commandLinearAuth = Command.make(
  "auth",
  {},
  Effect.fn("commandLinearAuth")(
    function* () {
      const linear = yield* Linear
      const viewer = yield* linear.authenticate
      const directory = yield* resolveOrcaDirectory()

      yield* Console.log(`Authenticated with Linear as ${viewer.name} <${viewer.email}>.`)
      yield* Console.log(`Stored session in ${directory}.`)
    },
  ),
).pipe(Command.withDescription("Authenticate Orca with Linear."))

export const commandLinear = Command.make("linear").pipe(
  Command.withDescription("Linear account commands."),
  Command.withSubcommands([commandLinearAuth]),
)
