import { Effect, Layer, Schedule, Schema, ServiceMap } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  LinearAuthRequiredError,
  LinearOAuthError,
  TokenManager,
  TokenManagerLive,
} from "./linear/token-manager.ts"

export type LinearIssue = {
  readonly blockedBy: ReadonlyArray<string>
  readonly childIds: ReadonlyArray<string>
  readonly createdAtMs: number
  readonly id: string
  readonly identifier: string
  readonly isOrcaTagged: boolean
  readonly labels: ReadonlyArray<string>
  readonly parentId: string | null
  readonly priority: number
  readonly state: string
  readonly title: string
}

export type LinearService = {
  authenticate: Effect.Effect<LinearViewer, LinearApiError | LinearOAuthError>
  issues: Effect.Effect<ReadonlyArray<LinearIssue>, LinearApiError | LinearAuthRequiredError>
  viewer: Effect.Effect<LinearViewer, LinearApiError | LinearAuthRequiredError>
}

export const Linear = ServiceMap.Service<LinearService>("orca/Linear")

export const LinearLive = Layer.effect(
  Linear,
  Effect.gen(function* () {
    const tokenManager = yield* TokenManager
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.acceptJson,
      ),
      HttpClient.retryTransient({
        schedule: Schedule.spaced("1 second"),
        times: 3,
      }),
    )

    const gql = <A, I, RD, RE>(
      schema: Schema.Codec<A, I, RD, RE>,
      query: string,
      variables?: Record<string, unknown>,
    ): Effect.Effect<A, LinearApiError | LinearAuthRequiredError, RD | RE> =>
      Effect.gen(function* () {
        const tokens = yield* tokenManager.get
        return yield* gqlWithAccessToken(tokens.accessToken, schema, query, variables)
      })

    const viewer = gql(ViewerData, viewerQuery).pipe(Effect.map((data) => data.viewer))

    const authenticate = tokenManager.authenticate.pipe(
      Effect.flatMap((tokens) =>
        gqlWithAccessToken(tokens.accessToken, ViewerData, viewerQuery).pipe(
          Effect.map((data) => data.viewer),
        ),
      ),
    )

    function gqlWithAccessToken<A, I, RD, RE>(
      accessToken: string,
      schema: Schema.Codec<A, I, RD, RE>,
      query: string,
      variables?: Record<string, unknown>,
    ): Effect.Effect<A, LinearApiError, RD | RE> {
      return Effect.gen(function* () {
        const json = yield* HttpClientRequest.post("https://api.linear.app/graphql").pipe(
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          httpClient.execute,
          Effect.flatMap((response) => response.json),
          Effect.mapError(
            (cause) =>
              new LinearApiError({
                message: "Failed to fetch data from Linear.",
                cause,
              }),
          ),
        )

        const envelope = yield* Schema.decodeUnknownEffect(GraphqlEnvelope)(json).pipe(
          Effect.mapError(
            (cause) =>
              new LinearApiError({
                message: "Linear returned an unexpected GraphQL response.",
                cause,
              }),
          ),
        )

        const errors = envelope.errors ?? []
        if (errors.length > 0) {
          return yield* Effect.fail(
            new LinearApiError({
              message: errors.map((error) => error.message).join("\n"),
            }),
          )
        }

        return yield* Schema.decodeUnknownEffect(schema)(envelope.data).pipe(
          Effect.mapError(
            (cause) =>
              new LinearApiError({
                message: "Linear returned data in an unexpected shape.",
                cause,
              }),
          ),
        )
      })
    }

    const issues = Effect.gen(function* () {
      const collected: Array<typeof LinearIssueNode.Type> = []
      let after: string | null = null

      while (true) {
        const page: typeof IssuesPageData.Type = yield* gql(IssuesPageData, issuesQuery, { after })
        collected.push(...page.issues.nodes)

        if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) {
          break
        }

        after = page.issues.pageInfo.endCursor
      }

      return mapLinearIssues(collected).sort(compareLinearIssues)
    })

    return Linear.of({ authenticate, issues, viewer })
  }),
)

export type LinearViewer = typeof Viewer.Type

export class LinearApiError extends Schema.TaggedErrorClass<LinearApiError>()(
  "LinearApiError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const Viewer = Schema.Struct({
  email: Schema.String,
  id: Schema.String,
  name: Schema.String,
})

const ViewerData = Schema.Struct({
  viewer: Viewer,
})

const IssueState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
})

const LabelNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

const BlockerNode = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    identifier: Schema.String,
    state: IssueState,
  }),
  type: Schema.String,
})

const LinearIssueNode = Schema.Struct({
  children: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        identifier: Schema.String,
        state: IssueState,
      }),
    ),
  }),
  createdAt: Schema.String,
  id: Schema.String,
  identifier: Schema.String,
  inverseRelations: Schema.Struct({
    nodes: Schema.Array(BlockerNode),
  }),
  labels: Schema.Struct({
    nodes: Schema.Array(LabelNode),
  }),
  parent: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      identifier: Schema.String,
    }),
  ),
  priority: Schema.Number,
  state: IssueState,
  title: Schema.String,
})

const IssuesPageData = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(LinearIssueNode),
    pageInfo: Schema.Struct({
      endCursor: Schema.NullOr(Schema.String),
      hasNextPage: Schema.Boolean,
    }),
  }),
})

const GraphqlEnvelope = Schema.Struct({
  data: Schema.Unknown,
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
      }),
    ),
  ),
})

const mapLinearIssues = (
  issues: ReadonlyArray<typeof LinearIssueNode.Type>,
): Array<LinearIssue> =>
  issues.map((issue) => ({
    blockedBy: issue.inverseRelations.nodes
      .filter((relation) => relation.type.toLowerCase() === "blocks")
      .filter((relation) => !isTerminalState(relation.issue.state.type))
      .map((relation) => relation.issue.id),
    childIds: issue.children.nodes
      .filter((child) => !isTerminalState(child.state.type))
      .map((child) => child.id),
    createdAtMs: Date.parse(issue.createdAt),
    id: issue.id,
    identifier: issue.identifier,
    isOrcaTagged: issue.labels.nodes.some(
      (label) => label.name.toLowerCase() === "orca",
    ),
    labels: issue.labels.nodes.map((label) => label.name),
    parentId: issue.parent?.id ?? null,
    priority: issue.priority,
    state: issue.state.type,
    title: issue.title,
  }))

const compareLinearIssues = (left: LinearIssue, right: LinearIssue) =>
  right.createdAtMs - left.createdAtMs || left.identifier.localeCompare(right.identifier)

const isTerminalState = (stateType: string) => {
  const normalized = stateType.toLowerCase()
  return normalized === "completed" || normalized === "canceled"
}

const viewerQuery = `query Viewer {
  viewer {
    id
    name
    email
  }
}`

const issuesQuery = `query OrcaIssues($after: String) {
  issues(
    first: 250
    after: $after
    filter: {
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      identifier
      title
      priority
      createdAt
      parent {
        id
        identifier
      }
      children(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes {
          id
          identifier
          state {
            id
            name
            type
          }
        }
      }
      state {
        id
        name
        type
      }
      labels {
        nodes {
          id
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              id
              name
              type
            }
          }
        }
      }
    }
  }
}`
