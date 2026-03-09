import { Effect, Layer, Path } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { PlatformServices } from "./shared/platform.ts"

export const resolveOrcaDirectory = Effect.fn("resolveOrcaDirectory")(function* () {
  const path = yield* Path.Path
  return path.join(process.cwd(), ".orca")
})

export const layerKvs = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = yield* resolveOrcaDirectory()
    return KeyValueStore.layerFileSystem(path.join(directory, "config"))
  }),
).pipe(Layer.provide(PlatformServices))
