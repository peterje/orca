import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Linear, LinearApiError, LinearLive } from "./linear.ts"
import { LinearTokens, TokenManager } from "./linear/token-manager.ts"

describe("Linear", () => {
  it.effect("fetches paginated issues and maps Orca labels and blockers", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const issues = yield* linear.issues

      expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-3", "ENG-2", "ENG-1"])
      expect(issues[2]).toMatchObject({
        blockedBy: ["blocker-open"],
        childIds: ["child-open"],
        identifier: "ENG-1",
        isOrcaTagged: true,
        parentId: null,
      })
      expect(issues[1]).toMatchObject({
        identifier: "ENG-2",
        parentId: "direct-1",
      })
    }).pipe(Effect.provide(makeLinearTestLayer(makeGraphqlClient()))))

  it.effect("surfaces GraphQL errors as LinearApiError", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* Effect.flip(linear.viewer)

      expect(error).toBeInstanceOf(LinearApiError)
      expect(error.message).toBe("Linear exploded")
    }).pipe(Effect.provide(makeLinearTestLayer(makeGraphqlClient({ mode: "error" })))))

  it.effect("suggests reauth when Linear rejects a write operation for missing scope", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const issues = yield* linear.issues
      const error = yield* Effect.flip(linear.markIssueInProgress(issues[0]!))

      expect(error).toBeInstanceOf(LinearApiError)
      expect(error.message).toContain("Invalid scope")
      expect(error.message).toContain("orca linear auth")
    }).pipe(Effect.provide(makeLinearTestLayer(makeGraphqlClient({ mode: "missing-scope" })))))
})

const makeLinearTestLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  LinearLive.pipe(
    Layer.provide([
      httpClientLayer,
      Layer.succeed(
        TokenManager,
        TokenManager.of({
          authenticate: Effect.succeed(tokens("test-token", Date.now() + 60_000)),
          clear: Effect.void,
          get: Effect.succeed(tokens("test-token", Date.now() + 60_000)),
        }),
      ),
    ]),
  )

const makeGraphqlClient = (options?: { readonly mode?: "success" | "error" | "missing-scope" }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url) => {
      const body = decodeRequestBody(request)
      const query = String(body.query ?? "")

      if (options?.mode === "error") {
        return Effect.succeed(jsonResponse(request, { data: null, errors: [{ message: "Linear exploded" }] }))
      }

      if (options?.mode === "missing-scope" && query.includes("mutation OrcaIssueUpdate")) {
        return Effect.succeed(jsonResponse(request, { errors: [{ message: "Invalid scope: `write` required" }] }, 400))
      }

      if (query.includes("query Viewer")) {
        return Effect.succeed(
          jsonResponse(request, {
            data: {
              viewer: {
                email: "orca@example.com",
                id: "viewer-1",
                name: "Orca",
              },
            },
            errors: [],
          }),
        )
      }

      const after = body.variables?.after ?? null
      if (after === null) {
        return Effect.succeed(
          jsonResponse(request, {
            data: {
              issues: {
                nodes: [
                  linearNode({
                    createdAt: "2026-03-01T00:00:00.000Z",
                    id: "direct-1",
                    identifier: "ENG-1",
                    inverseRelations: {
                      nodes: [
                        relation("blocker-open", "ENG-2", "unstarted"),
                        relation("blocker-done", "ENG-9", "completed"),
                      ],
                    },
                    children: {
                      nodes: [
                        childNode("child-open", "ENG-2", "unstarted"),
                        childNode("child-done", "ENG-8", "completed"),
                      ],
                    },
                    description: "Direct issue description",
                    labels: { nodes: [{ id: "label-1", name: "oRcA" }] },
                    priority: 2,
                    title: "Direct Orca issue",
                  }),
                  linearNode({
                    createdAt: "2026-03-03T00:00:00.000Z",
                    id: "unrelated-1",
                    identifier: "ENG-3",
                    labels: { nodes: [] },
                    priority: 4,
                    title: "Unrelated issue",
                  }),
                ],
                pageInfo: {
                  endCursor: "page-2",
                  hasNextPage: true,
                },
              },
            },
            errors: [],
          }),
        )
      }

      return Effect.succeed(
        jsonResponse(request, {
          data: {
            issues: {
              nodes: [
                linearNode({
                  createdAt: "2026-03-02T00:00:00.000Z",
                  id: "child-open",
                  identifier: "ENG-2",
                  labels: { nodes: [] },
                  parent: {
                    id: "direct-1",
                    identifier: "ENG-1",
                  },
                  priority: 3,
                  title: "Open child",
                }),
              ],
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
              },
            },
          },
          errors: [],
        }),
      )
    }),
  )

const decodeRequestBody = (request: HttpClientRequest.HttpClientRequest): any => {
  const body = request.body as { readonly _tag: string; readonly body?: Uint8Array; toJSON(): unknown }
  if (body._tag === "Uint8Array" && body.body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body.body))
  }

  const json = body.toJSON() as { readonly body?: string }
  return typeof json.body === "string" ? JSON.parse(json.body) : {}
}

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  )

const relation = (id: string, identifier: string, stateType: string) => ({
  issue: {
    id,
    identifier,
    state: {
      id: `${id}-state`,
      name: stateType,
      type: stateType,
    },
  },
  type: "blocks",
})

const childNode = (id: string, identifier: string, stateType: string) => ({
  id,
  identifier,
  state: {
    id: `${id}-state`,
    name: stateType,
    type: stateType,
  },
})

type GraphqlIssueNode = ReturnType<typeof baseLinearNode>

const linearNode = (overrides: Partial<GraphqlIssueNode>): GraphqlIssueNode => ({
  ...baseLinearNode(),
  ...overrides,
})

const baseLinearNode = () => ({
  children: { nodes: [] as Array<ReturnType<typeof childNode>> },
  createdAt: "2026-03-01T00:00:00.000Z",
  description: null as null | string,
  id: "issue-1",
  identifier: "ENG-0",
  inverseRelations: { nodes: [] as Array<ReturnType<typeof relation>> },
  labels: { nodes: [] as Array<{ id: string; name: string }> },
  parent: null as null | { id: string; identifier: string },
  priority: 0,
  state: {
    id: "state-1",
    name: "Unstarted",
    type: "unstarted",
  },
  team: {
    states: {
      nodes: [
        {
          id: "state-backlog",
          name: "Backlog",
          type: "backlog",
        },
        {
          id: "state-started",
          name: "In Progress",
          type: "started",
        },
      ],
    },
  },
  title: "Issue",
})

const tokens = (accessToken: string, expiresAtMs: number) =>
  new LinearTokens({
    accessToken,
    expiresAtMs,
    refreshToken: "refresh-token",
  })
