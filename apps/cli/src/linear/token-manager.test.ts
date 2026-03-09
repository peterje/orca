import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Settings, type SettingsService } from "../settings.ts"
import {
  LinearAuthRequiredError,
  LinearTokens,
  TokenManager,
  TokenManagerLive,
} from "./token-manager.ts"

describe("TokenManager", () => {
  it.effect("reuses a valid stored token without refreshing", () =>
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, unknown>([["linear.tokens", tokens("stored-access", Date.now() + 2 * 60 * 60 * 1000)]]))
      const layer = makeTokenManagerLayer({
        httpClientLayer: unexpectedHttpClientLayer,
        settingsLayer: inMemorySettingsLayer(store),
      })

      const token = yield* TokenManager.use((manager) => manager.get).pipe(Effect.provide(layer))

      expect(token.accessToken).toBe("stored-access")
    }))

  it.effect("refreshes an expired token and persists the replacement", () =>
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, unknown>([["linear.tokens", tokens("expired", Date.now() - 1)]]))
      const layer = makeTokenManagerLayer({
        httpClientLayer: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "refreshed-access",
                    expires_in: 3600,
                    refresh_token: "refreshed-refresh",
                    scope: "read",
                    token_type: "Bearer",
                  }),
                  {
                    headers: { "content-type": "application/json" },
                  },
                ),
              ),
            ),
          ),
        ),
        settingsLayer: inMemorySettingsLayer(store),
      })

      const token = yield* TokenManager.use((manager) => manager.get).pipe(Effect.provide(layer))
      const stored = yield* Ref.get(store)

      expect(token.accessToken).toBe("refreshed-access")
      expect((stored.get("linear.tokens") as LinearTokens).accessToken).toBe("refreshed-access")
    }))

  it.effect("clears stored tokens when refresh fails", () =>
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, unknown>([["linear.tokens", tokens("expired", Date.now() - 1)]]))
      const layer = makeTokenManagerLayer({
        httpClientLayer: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("denied", { status: 401 }))),
          ),
        ),
        settingsLayer: inMemorySettingsLayer(store),
      })

      const error = yield* Effect.flip(TokenManager.use((manager) => manager.get).pipe(Effect.provide(layer)))
      const stored = yield* Ref.get(store)

      expect(error).toBeInstanceOf(LinearAuthRequiredError)
      expect(stored.has("linear.tokens")).toBe(false)
    }))
})

const unexpectedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected http call")),
)

const makeTokenManagerLayer = ({
  httpClientLayer,
  settingsLayer,
}: {
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>
  readonly settingsLayer: Layer.Layer<any>
}) => TokenManagerLive.pipe(Layer.provide([httpClientLayer, settingsLayer]))

const inMemorySettingsLayer = (store: Ref.Ref<Map<string, unknown>>) =>
  Layer.succeed(Settings, Settings.of(makeSettingsService(store)))

const makeSettingsService = (store: Ref.Ref<Map<string, unknown>>): SettingsService => ({
  get: (setting) =>
    Ref.get(store).pipe(
      Effect.map((entries) => Option.fromNullishOr(entries.get(setting.name)) as never),
    ),
  set: (setting, value) =>
    Ref.update(store, (entries) => {
      const next = new Map(entries)
      if (Option.isSome(value)) {
        next.set(setting.name, value.value)
      } else {
        next.delete(setting.name)
      }
      return next
    }),
})

const tokens = (accessToken: string, expiresAtMs: number) =>
  new LinearTokens({
    accessToken,
    expiresAtMs,
    refreshToken: "refresh-token",
  })
