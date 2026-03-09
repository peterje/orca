import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LinearLive } from "./linear.ts"
import { TokenManagerLayer } from "./linear/token-manager-layer.ts"

export const LinearLayer = LinearLive.pipe(
  Layer.provide([TokenManagerLayer, FetchHttpClient.layer]),
)
