#!/usr/bin/env bun

import { rm } from "node:fs/promises"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { AgentRunnerLayer } from "../../cli/src/agent-runner.ts"
import { GitHubLayer } from "../../cli/src/github.ts"
import { planIssues } from "../../cli/src/issue-planner.ts"
import { LinearLayer } from "../../cli/src/linear-layer.ts"
import { Linear } from "../../cli/src/linear.ts"
import { MissionControl, MissionControlLayer } from "../../cli/src/mission-control.ts"
import { OrcaEvents, OrcaEventsLayer } from "../../cli/src/orca-events.ts"
import { resolveOrcaDirectory } from "../../cli/src/orca-directory.ts"
import { OrcaServerControlData, OrcaServerErrorResponse, type OrcaServerEvent } from "../../cli/src/orca-server-protocol.ts"
import { PromptGenLayer } from "../../cli/src/prompt-gen.ts"
import { PullRequestStoreLayer } from "../../cli/src/pull-request-store.ts"
import { RepoConfig, RepoConfigLayer } from "../../cli/src/repo-config.ts"
import { Runner, RunnerLayer } from "../../cli/src/runner.ts"
import { RunStateLayer } from "../../cli/src/run-state.ts"
import { PlatformServices } from "../../cli/src/shared/platform.ts"
import { VerifierLayer } from "../../cli/src/verifier.ts"
import { WorktreeLayer } from "../../cli/src/worktree.ts"

type ServerReadyEvent = Extract<OrcaServerEvent, { readonly type: "server-ready" }>

const supportLayer = Layer.mergeAll(
  RepoConfigLayer,
  RunStateLayer,
  WorktreeLayer,
  AgentRunnerLayer,
  PromptGenLayer,
  PullRequestStoreLayer,
  VerifierLayer,
  GitHubLayer,
).pipe(Layer.provide(PlatformServices))

const linearLayer = LinearLayer.pipe(Layer.provide(PlatformServices))

const executionLayer = RunnerLayer.pipe(Layer.provide([linearLayer, supportLayer]))
const missionControlLayer = MissionControlLayer.pipe(Layer.provide([linearLayer, supportLayer]))

const appLayer = Layer.mergeAll(
  linearLayer,
  supportLayer,
  executionLayer,
  missionControlLayer,
  OrcaEventsLayer,
).pipe(Layer.provideMerge(PlatformServices))

const runtime = ManagedRuntime.make(appLayer)
type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>
let runtimeDisposed = false
let startupCleanup: (() => Promise<void>) | null = null

const disposeRuntimeOnce = async () => {
  if (runtimeDisposed) {
    return
  }

  runtimeDisposed = true
  await runtime.dispose()
}

const main = async () => {
  const startedAtMs = Date.now()
  const token = crypto.randomUUID()
  const serverReadyEvent: ServerReadyEvent = { pid: process.pid, startedAtMs, type: "server-ready" }
  let cleanedUp = false
  let pollingWaitingPullRequests = false
  let shuttingDown = false

  const server = Bun.serve({
    fetch: (request) => handleRequest(request, {
      isShuttingDown: () => shuttingDown,
      runPollWaitingPullRequests: (effect) => {
        if (pollingWaitingPullRequests) {
          return Promise.resolve(new Response(null, { status: 204 }))
        }

        pollingWaitingPullRequests = true
        return runVoid(effect).finally(() => {
          pollingWaitingPullRequests = false
        })
      },
      serverReadyEvent,
      token,
    }),
    hostname: "127.0.0.1",
    port: 0,
  })

  let controlFile: string | null = null

  const cleanup = async () => {
    if (cleanedUp) {
      return
    }

    cleanedUp = true
    shuttingDown = true

    try {
      if (controlFile !== null) {
        await rm(controlFile, { force: true })
      }
    } finally {
      try {
        await disposeRuntimeOnce()
      } finally {
        await server.stop(true)
      }
    }
  }

  startupCleanup = cleanup

  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(0))
  })
  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0))
  })

  const control = new OrcaServerControlData({
    baseUrl: `http://${server.hostname}:${server.port}`,
    pid: process.pid,
    startedAtMs,
    token,
  })
  const orcaDirectory = await runtime.runPromise(resolveOrcaDirectory())
  controlFile = `${orcaDirectory}/server.json`

  await runtime.runPromise(writeServerControl(control, orcaDirectory))
}

const handleRequest = async (
  request: Request,
  context: {
    readonly isShuttingDown: () => boolean
    readonly runPollWaitingPullRequests: <E>(effect: Effect.Effect<void, E, AppServices>) => Promise<Response>
    readonly serverReadyEvent: ServerReadyEvent
    readonly token: string
  },
): Promise<Response> => {
  if (!isAuthorized(request, context.token)) {
    return jsonResponse(new OrcaServerErrorResponse({ message: "Unauthorized Orca server request.", tag: "Unauthorized" }), 401)
  }

  const url = new URL(request.url)

  if (context.isShuttingDown()) {
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: false, pid: process.pid, shuttingDown: true }, 503)
    }

    return jsonResponse(new OrcaServerErrorResponse({ message: "The local Orca server is shutting down.", tag: "ServerShuttingDown" }), 503)
  }

  switch (`${request.method} ${url.pathname}`) {
    case "GET /health":
      return jsonResponse({ ok: true, pid: process.pid })
    case "POST /linear/auth":
      return runJson(Effect.gen(function* () {
        const linear = yield* Linear
        return yield* linear.authenticate
      }))
    case "GET /issues/plan":
      return runJson(
        Effect.gen(function* () {
          const linear = yield* Linear
          const repoConfig = yield* RepoConfig
          const config = yield* repoConfig.readOption
          const issues = yield* linear.issues({ workspaceSlug: config?.linearWorkspace })
          return planIssues(issues, { linearLabel: config?.linearLabel })
        }),
      )
    case "GET /mission-control/snapshot":
      return runJson(Effect.gen(function* () {
        const missionControl = yield* MissionControl
        return yield* missionControl.snapshot
      }))
    case "POST /runner/poll-waiting-pull-requests":
      return context.runPollWaitingPullRequests(Effect.gen(function* () {
        const runner = yield* Runner
        yield* runner.pollWaitingPullRequests
      }))
    case "POST /runner/run-next":
      return runJson(Effect.gen(function* () {
        const runner = yield* Runner
        return yield* runner.runNext
      }))
    case "GET /events":
      return openEventStream(request, context.serverReadyEvent)
    default:
      return new Response("Not found", { status: 404 })
  }
}

const runJson = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<Response> => {
  try {
    const value = await runtime.runPromise(effect)
    return jsonResponse(value)
  } catch (error) {
    return errorResponse(error)
  }
}

const runVoid = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<Response> => {
  try {
    await runtime.runPromise(effect)
    return new Response(null, { status: 204 })
  } catch (error) {
    return errorResponse(error)
  }
}

const openEventStream = async (request: Request, serverReadyEvent: ServerReadyEvent): Promise<Response> => {
  try {
    const services = await runtime.services()
    const stream = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* OrcaEvents
        return events.stream.pipe(
          Stream.prepend([serverReadyEvent]),
          Stream.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          Stream.encodeText,
        )
      }),
    )
    const readableStream = Stream.toReadableStreamWith(stream, services)
    const cancelReadableStream = () => {
      void readableStream.cancel().catch(() => undefined)
    }

    if (request.signal.aborted) {
      cancelReadableStream()
    } else {
      request.signal.addEventListener("abort", cancelReadableStream, { once: true })
    }

    return new Response(readableStream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

const writeServerControl = (control: OrcaServerControlData, orcaDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(orcaDirectory, { recursive: true })
    yield* fs.writeFileString(
      `${orcaDirectory}/server.json`,
      JSON.stringify(Schema.encodeUnknownSync(OrcaServerControlData)(control), null, 2) + "\n",
    )
  })

const isAuthorized = (request: Request, token: string) => request.headers.get("authorization") === `Bearer ${token}`

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status,
  })

const errorResponse = (error: unknown) => {
  const errorTag = getErrorTag(error)
  const payload = new OrcaServerErrorResponse({
    message: getErrorMessage(error),
    ...(errorTag === undefined ? {} : { tag: errorTag }),
  })

  return jsonResponse(Schema.encodeUnknownSync(OrcaServerErrorResponse)(payload), statusForErrorTag(errorTag))
}

const getErrorMessage = (error: unknown) => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

const getErrorTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const statusByErrorTag: Record<string, number> = {
  LinearApiError: 502,
  LinearAuthRequiredError: 401,
  LinearOAuthError: 401,
  MissionControlError: 500,
  RepoConfigError: 400,
  RunnerFailure: 500,
  RunnerNoWorkError: 404,
  RunStateBusyError: 409,
  Unauthorized: 401,
}

const statusForErrorTag = (errorTag: string | undefined) => statusByErrorTag[errorTag ?? ""] ?? 500

await main().catch(async (error) => {
  console.error(getErrorMessage(error))
  try {
    if (startupCleanup !== null) {
      await startupCleanup()
    } else {
      await disposeRuntimeOnce()
    }
  } finally {
    process.exit(1)
  }
})
