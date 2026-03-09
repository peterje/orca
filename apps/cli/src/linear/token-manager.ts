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
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orca connected to Linear</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --bg-deep: #efe4d2;
        --surface: rgba(255, 251, 244, 0.84);
        --surface-strong: #fffaf2;
        --line: rgba(30, 45, 56, 0.12);
        --text: #14212b;
        --muted: #53616d;
        --accent: #127a72;
        --accent-soft: rgba(18, 122, 114, 0.14);
        --accent-warm: #ef8354;
        --shadow: 0 28px 80px rgba(19, 36, 45, 0.16);
        --radius: 28px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        overflow: hidden;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(18, 122, 114, 0.22), transparent 34%),
          radial-gradient(circle at bottom right, rgba(239, 131, 84, 0.24), transparent 30%),
          linear-gradient(160deg, var(--bg) 0%, var(--bg-deep) 100%);
        color: var(--text);
        font-family: Georgia, "Times New Roman", serif;
      }

      .scene {
        position: relative;
        width: min(100%, 680px);
      }

      .glow {
        position: absolute;
        inset: auto;
        border-radius: 999px;
        filter: blur(10px);
        pointer-events: none;
        animation: drift 16s ease-in-out infinite;
      }

      .glow-one {
        top: -32px;
        left: -12px;
        width: 144px;
        height: 144px;
        background: rgba(18, 122, 114, 0.16);
      }

      .glow-two {
        right: 18px;
        bottom: -40px;
        width: 180px;
        height: 180px;
        background: rgba(239, 131, 84, 0.16);
        animation-delay: -6s;
      }

      .card {
        position: relative;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 28px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), var(--surface));
        backdrop-filter: blur(16px);
        box-shadow: var(--shadow);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font: 600 0.78rem/1.1 Helvetica, Arial, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .eyebrow-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 0 6px rgba(18, 122, 114, 0.12);
      }

      .header {
        display: grid;
        gap: 18px;
        margin-top: 20px;
      }

      .hero {
        display: grid;
        gap: 18px;
        align-items: start;
      }

      .icon {
        width: 72px;
        height: 72px;
        display: grid;
        place-items: center;
        border-radius: 22px;
        background: linear-gradient(180deg, #153847 0%, #0f5660 100%);
        color: #f9fffd;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }

      h1 {
        margin: 0;
        font-size: clamp(2.2rem, 6vw, 3.7rem);
        line-height: 0.95;
        letter-spacing: -0.05em;
      }

      p {
        margin: 0;
      }

      .lede {
        max-width: 34rem;
        color: var(--muted);
        font: 500 1.05rem/1.7 Helvetica, Arial, sans-serif;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        margin-top: 26px;
      }

      .detail {
        padding: 16px 18px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.56);
        border: 1px solid rgba(20, 33, 43, 0.08);
      }

      .detail-label {
        margin-bottom: 8px;
        color: var(--muted);
        font: 600 0.75rem/1.2 Helvetica, Arial, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .detail-value {
        font: 600 1rem/1.5 Helvetica, Arial, sans-serif;
      }

      .command {
        display: inline-flex;
        align-items: center;
        margin-top: 24px;
        padding: 12px 16px;
        border-radius: 16px;
        background: #13242d;
        color: #f5f1ea;
        font: 600 0.95rem/1.2 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      }

      .footer {
        margin-top: 22px;
        color: var(--muted);
        font: 500 0.95rem/1.6 Helvetica, Arial, sans-serif;
      }

      .footer strong {
        color: var(--text);
      }

      @keyframes drift {
        0%,
        100% {
          transform: translate3d(0, 0, 0);
        }

        50% {
          transform: translate3d(0, 12px, 0);
        }
      }

      @media (min-width: 640px) {
        .hero {
          grid-template-columns: auto 1fr;
        }

        .card {
          padding: 34px;
        }
      }

      @media (max-width: 639px) {
        body {
          padding: 18px;
        }

        .card {
          padding: 22px;
          border-radius: 24px;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .command {
          width: 100%;
          justify-content: center;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .glow {
          animation: none;
        }
      }
    </style>
  </head>
  <body>
    <main class="scene">
      <div class="glow glow-one"></div>
      <div class="glow glow-two"></div>

      <section class="card" aria-label="Linear OAuth success">
        <div class="eyebrow">
          <span class="eyebrow-dot" aria-hidden="true"></span>
          Linear connected
        </div>

        <div class="header">
          <div class="hero">
            <div class="icon" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 17.5L14.5 22L24.5 12" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>

            <div>
              <h1>Orca is ready to plan work.</h1>
              <p class="lede">Your Linear account is connected on this machine. Head back to the terminal to inspect the queue, pick the next issue, or close this tab and keep moving.</p>
            </div>
          </div>

          <div class="grid">
            <div class="detail">
              <div class="detail-label">Status</div>
              <div class="detail-value">OAuth callback received and verified.</div>
            </div>
            <div class="detail">
              <div class="detail-label">Next step</div>
              <div class="detail-value">Return to Orca and continue from your terminal.</div>
            </div>
          </div>

          <div class="command">orca issues list</div>

          <p class="footer"><strong>All set.</strong> You can close this window whenever you are ready.</p>
        </div>
      </section>
    </main>
  </body>
</html>`
