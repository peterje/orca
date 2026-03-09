import { Deferred, Effect, Encoding, Layer, Option, Schedule, Schema, ServiceMap } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Setting, Settings } from "../settings.ts"

const defaultLinearClientId = "852ed0906088135c1f591d234a4eaa4b"
const linearRedirectPort = 34338
const linearRedirectUri = `http://localhost:${linearRedirectPort}/callback`

export type TokenManagerService = {
  authenticate: Effect.Effect<LinearTokens, LinearOAuthError>
  clear: Effect.Effect<void>
  get: Effect.Effect<LinearTokens, LinearAuthRequiredError>
}

export const TokenManager = ServiceMap.Service<TokenManagerService>(
  "orca/linear/TokenManager",
)

export const TokenManagerLive = Layer.effect(
  TokenManager,
  Effect.gen(function* () {
    const settings = yield* Settings
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: Schedule.spaced("1 second"),
        times: 3,
      }),
    )

    let currentTokens = yield* settings.get(linearTokensSetting)

    const store = Effect.fn("TokenManager.store")(function* (
      tokens: Option.Option<LinearTokens>,
    ) {
      yield* settings.set(linearTokensSetting, tokens)
      currentTokens = tokens
    })

    const exchangeCode = Effect.fn("TokenManager.exchangeCode")(
      function* (verifier: string, code: string): Effect.fn.Return<LinearTokens, LinearOAuthError> {
        const response = yield* HttpClientRequest.post(
          "https://api.linear.app/oauth/token",
        ).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: resolveLinearClientId(),
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: linearRedirectUri,
          }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
          Effect.mapError(
            (cause) =>
              new LinearOAuthError({
                message: "Failed to exchange the Linear authorization code.",
                cause,
              }),
          ),
        )

        return LinearTokens.fromTokenResponse(response)
      },
    )

    const refresh = Effect.fn("TokenManager.refresh")(
      function* (tokens: LinearTokens): Effect.fn.Return<LinearTokens, LinearAuthRequiredError> {
        const refreshed = yield* HttpClientRequest.post(
          "https://api.linear.app/oauth/token",
        ).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: resolveLinearClientId(),
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken,
          }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
          Effect.map(LinearTokens.fromTokenResponse),
          Effect.catch((cause) =>
            Effect.andThen(
              store(Option.none()),
              Effect.fail(
                new LinearAuthRequiredError({
                  message: "Your stored Linear session expired. Run `orca linear auth` again.",
                  cause,
                }),
              ),
            ),
          ),
        )

        yield* store(Option.some(refreshed))
        return refreshed
      },
    )

    const authenticate = Effect.scoped(
      Effect.gen(function* () {
        const callback = yield* Deferred.make<typeof CallbackParams.Type>()
        const verifier = crypto.randomUUID()
        const digest = yield* Effect.tryPromise({
          try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
          catch: (cause) =>
            new LinearOAuthError({
              message: "Failed to create a PKCE verifier for Linear OAuth.",
              cause,
            }),
        })
        const challenge = Encoding.encodeBase64Url(new Uint8Array(digest))

        const server = yield* Effect.try({
          try: () =>
            Bun.serve({
              port: linearRedirectPort,
              fetch(request) {
                const url = new URL(request.url)
                if (url.pathname !== "/callback") {
                  return new Response("Not found", { status: 404 })
                }

                try {
                  const params = Schema.decodeUnknownSync(CallbackParams)({
                    code: url.searchParams.get("code"),
                    error: url.searchParams.get("error"),
                    errorDescription: url.searchParams.get("error_description"),
                  })
                  Effect.runFork(Deferred.succeed(callback, params))
                  return new Response(successHtml, {
                    headers: {
                      "content-type": "text/html; charset=utf-8",
                    },
                  })
                } catch {
                  return new Response("Invalid OAuth callback.", { status: 400 })
                }
              },
            }),
          catch: (cause) =>
            new LinearOAuthError({
              message: `Unable to start the Linear OAuth callback server on port ${linearRedirectPort}.`,
              cause,
            }),
        })

        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

        const url = new URL("https://linear.app/oauth/authorize")
        url.searchParams.set("client_id", resolveLinearClientId())
        url.searchParams.set("redirect_uri", linearRedirectUri)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("scope", "read,write")
        url.searchParams.set("code_challenge", challenge)
        url.searchParams.set("code_challenge_method", "S256")

        yield* Effect.sync(() => {
          console.log("Open this URL to authenticate with Linear:")
          console.log(url.toString())
        })

        const params = yield* Deferred.await(callback)
        if (params.error !== null) {
          return yield* Effect.fail(
            new LinearOAuthError({
              message: params.errorDescription
                ? `Linear OAuth failed: ${params.errorDescription}`
                : `Linear OAuth failed: ${params.error}`,
            }),
          )
        }

        const code = params.code ?? ""
        if (code.length === 0) {
          return yield* Effect.fail(
            new LinearOAuthError({
              message: "Linear OAuth completed without an authorization code.",
            }),
          )
        }

        const tokens = yield* exchangeCode(verifier, code)
        yield* store(Option.some(tokens))
        return tokens
      }),
    )

    const get = Effect.gen(function* () {
      if (Option.isNone(currentTokens)) {
        return yield* Effect.fail(
          new LinearAuthRequiredError({
            message: "No Linear session found. Run `orca linear auth` first.",
          }),
        )
      }

      if (currentTokens.value.isExpired()) {
        return yield* refresh(currentTokens.value)
      }

      return currentTokens.value
    })

    const clear = store(Option.none())

    return TokenManager.of({ authenticate, clear, get })
  }),
)

export class LinearTokens extends Schema.Class<LinearTokens>("orca/LinearTokens")({
  accessToken: Schema.String,
  expiresAtMs: Schema.Number,
  refreshToken: Schema.String,
}) {
  static fromTokenResponse(response: typeof TokenResponse.Type): LinearTokens {
    return new LinearTokens({
      accessToken: response.access_token,
      expiresAtMs: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token,
    })
  }

  isExpired(): boolean {
    return Date.now() >= this.expiresAtMs - 30 * 60 * 1000
  }
}

export class LinearAuthRequiredError extends Schema.TaggedErrorClass<LinearAuthRequiredError>()(
  "LinearAuthRequiredError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class LinearOAuthError extends Schema.TaggedErrorClass<LinearOAuthError>()(
  "LinearOAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.String,
  scope: Schema.String,
  token_type: Schema.String,
})

const CallbackParams = Schema.Struct({
  code: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  errorDescription: Schema.NullOr(Schema.String),
})

const linearTokensSetting = new Setting("linear.tokens", LinearTokens)

const resolveLinearClientId = () =>
  (typeof Bun !== "undefined" ? Bun.env.LINEAR_CLIENT_ID : process.env.LINEAR_CLIENT_ID) ?? defaultLinearClientId

const successHtml = `<!doctype html>
<html>
  <body style="font-family: sans-serif; text-align: center; margin-top: 48px;">
    <h1>Orca login successful</h1>
    <p>You can close this window now.</p>
  </body>
</html>`
