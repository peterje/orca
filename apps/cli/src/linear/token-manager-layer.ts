import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsLayer } from "../settings-layer.ts"
import { TokenManagerLive } from "./token-manager.ts"

export const TokenManagerLayer = TokenManagerLive.pipe(
  Layer.provide([SettingsLayer, FetchHttpClient.layer]),
)
