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
  readonly description: string
  readonly id: string
  readonly identifier: string
  readonly isOrcaTagged: boolean
  readonly labels: ReadonlyArray<string>
  readonly parentId: string | null
  readonly priority: number
  readonly stateId: string
  readonly stateName: string
  readonly state: string
  readonly teamStates: ReadonlyArray<LinearWorkflowState>
  readonly title: string
  readonly workspaceSlug?: string | undefined
}

export type LinearWorkflowState = {
  readonly id: string
  readonly name: string
  readonly type: string
}

export type LinearService = {
  authenticate: Effect.Effect<LinearViewer, LinearApiError | LinearOAuthError>
  commentOnIssue: (options: {
    readonly body: string
    readonly issueId: string
  }) => Effect.Effect<void, LinearApiError | LinearAuthRequiredError>
  issues: (options?: {
    readonly workspaceSlug?: string | undefined
  }) => Effect.Effect<ReadonlyArray<LinearIssue>, LinearApiError | LinearAuthRequiredError>
  markIssueInProgress: (issue: LinearIssue) => Effect.Effect<void, LinearApiError | LinearAuthRequiredError>
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

    const mutation = <A, I, RD, RE>(
      schema: Schema.Codec<A, I, RD, RE>,
      query: string,
      variables?: Record<string, unknown>,
    ) => gql(schema, query, variables)

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

        const envelope = yield* decodeGraphqlEnvelope(json)
        const errors = envelope.errors ?? []
        if (errors.length > 0) {
          const errorMessage = errors.map((error) => error.message).join("\n")
          return yield* Effect.fail(
            new LinearApiError({
              message: shouldSuggestReauth(errorMessage)
                ? `${errorMessage}\nRun \`orca linear auth\` again to refresh your Linear token with write access.`
                : errorMessage,
            }),
          )
        }

        if (!("data" in envelope) || envelope.data === undefined) {
          return yield* Effect.fail(
            new LinearApiError({
              message: "Linear returned an unexpected GraphQL response.",
              cause: envelope,
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

    const issues = (options?: { readonly workspaceSlug?: string | undefined }) => Effect.gen(function* () {
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

      const normalizedWorkspaceSlug = normalizeWorkspaceSlug(options?.workspaceSlug)

      return mapLinearIssues(collected)
        .filter((issue) => normalizedWorkspaceSlug === undefined || issue.workspaceSlug === normalizedWorkspaceSlug)
        .sort(compareLinearIssues)
    })

    const commentOnIssue = (options: {
      readonly body: string
      readonly issueId: string
    }) =>
      mutation(CommentCreatePayload, commentCreateMutation, {
        body: options.body,
        issueId: options.issueId,
      }).pipe(Effect.asVoid)

    const markIssueInProgress = (issue: LinearIssue) => {
      const nextState = findInProgressState(issue.teamStates)

      if (!nextState || nextState.id === issue.stateId) {
        return Effect.void
      }

      return mutation(IssueUpdatePayload, issueUpdateMutation, {
        id: issue.id,
        stateId: nextState.id,
      }).pipe(Effect.asVoid)
    }

    return Linear.of({ authenticate, commentOnIssue, issues, markIssueInProgress, viewer })
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

const TeamStates = Schema.Struct({
  nodes: Schema.Array(IssueState),
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
  description: Schema.NullOr(Schema.String),
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
  team: Schema.Struct({
    organization: Schema.Struct({
      urlKey: Schema.String,
    }),
    states: TeamStates,
  }),
  title: Schema.String,
})

type LinearIssueWithWorkspace = LinearIssue & {
  readonly workspaceSlug: string
}

const CommentCreatePayload = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
  }),
})

const IssueUpdatePayload = Schema.Struct({
  issueUpdate: Schema.Struct({
    success: Schema.Boolean,
  }),
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
  data: Schema.optional(Schema.Unknown),
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
): Array<LinearIssueWithWorkspace> =>
  issues.map((issue) => ({
    blockedBy: issue.inverseRelations.nodes
      .filter((relation) => relation.type.toLowerCase() === "blocks")
      .filter((relation) => !isTerminalState(relation.issue.state.type))
      .map((relation) => relation.issue.id),
    childIds: issue.children.nodes
      .filter((child) => !isTerminalState(child.state.type))
      .map((child) => child.id),
    createdAtMs: Date.parse(issue.createdAt),
    description: issue.description ?? "",
    id: issue.id,
    identifier: issue.identifier,
    isOrcaTagged: issue.labels.nodes.some(
      (label) => label.name.toLowerCase() === "orca",
    ),
    labels: issue.labels.nodes.map((label) => label.name),
    parentId: issue.parent?.id ?? null,
    priority: issue.priority,
    stateId: issue.state.id,
    stateName: issue.state.name,
    state: issue.state.type,
    teamStates: issue.team.states.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
    })),
    title: issue.title,
    workspaceSlug: normalizeWorkspaceSlug(issue.team.organization.urlKey) ?? issue.team.organization.urlKey,
  }))

const compareLinearIssues = (left: LinearIssue, right: LinearIssue) =>
  right.createdAtMs - left.createdAtMs || left.identifier.localeCompare(right.identifier)

const findInProgressState = (teamStates: ReadonlyArray<LinearWorkflowState>) => {
  const namedMatch = teamStates.find(
    (state) => state.type.toLowerCase() === "started" && normalizeWorkflowStateName(state.name) === "in progress",
  )
  if (namedMatch) {
    return namedMatch
  }

  const startedStates = teamStates.filter((state) => state.type.toLowerCase() === "started")
  if (startedStates.length === 1) {
    return isReviewState(startedStates[0]!.name) ? undefined : startedStates[0]
  }

  return startedStates.find((state) => !isReviewState(state.name))
}

const normalizeWorkflowStateName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")

const isReviewState = (name: string) => /\breview\b/i.test(name)

const isTerminalState = (stateType: string) => {
  const normalized = stateType.toLowerCase()
  return normalized === "completed" || normalized === "canceled"
}

const normalizeWorkspaceSlug = (workspaceSlug: string | undefined) => {
  const normalized = workspaceSlug?.trim().toLowerCase()
  return normalized && normalized.length > 0 ? normalized : undefined
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
      description
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
      team {
        organization {
          urlKey
        }
        states(first: 50) {
          nodes {
            id
            name
            type
          }
        }
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

const issueUpdateMutation = `mutation OrcaIssueUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}`

const commentCreateMutation = `mutation OrcaCommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`

const decodeGraphqlEnvelope = (json: unknown) =>
  Schema.decodeUnknownEffect(GraphqlEnvelope)(json).pipe(
    Effect.mapError(
      (cause) =>
        new LinearApiError({
          message: "Linear returned an unexpected GraphQL response.",
          cause,
        }),
    ),
  )

const shouldSuggestReauth = (message: string) => /invalid scope/i.test(message)
