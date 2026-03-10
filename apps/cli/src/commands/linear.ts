import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { OrcaClient } from "../orca-client.ts"
import { resolveOrcaDirectory } from "../orca-directory.ts"

const commandLinearAuth = Command.make(
  "auth",
  {},
  Effect.fn("commandLinearAuth")(
    function* () {
      const client = yield* OrcaClient
      const viewer = yield* client.authenticate
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
