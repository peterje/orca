import { Flag, Command } from "effect/unstable/cli"

export const commandRoot = Command.make("orca").pipe(
  Command.withDescription("Plan Orca work from Linear."),
  Command.withSharedFlags({
    verbose: Flag.boolean("verbose").pipe(
      Flag.withAlias("v"),
      Flag.withDescription("Enable verbose output."),
    ),
  }),
)
