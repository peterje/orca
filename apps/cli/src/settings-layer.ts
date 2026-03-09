import { Layer } from "effect"
import { layerKvs } from "./kvs.ts"
import { SettingsLive } from "./settings.ts"

export const SettingsLayer = SettingsLive.pipe(Layer.provide(layerKvs))
