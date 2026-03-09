import { Effect, Path } from "effect"

export const resolveOrcaDirectory = Effect.fn("resolveOrcaDirectory")(function* () {
  const path = yield* Path.Path
  return path.join(process.cwd(), ".orca")
})
