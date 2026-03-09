import { Effect, Layer, Path } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { resolveOrcaDirectory } from "./orca-directory.ts"
import { PlatformServices } from "./shared/platform.ts"

export const layerKvs = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = yield* resolveOrcaDirectory()
    return KeyValueStore.layerFileSystem(path.join(directory, "config"))
  }),
).pipe(Layer.provide(PlatformServices))
