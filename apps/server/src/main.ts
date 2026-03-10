#!/usr/bin/env bun

import { Effect, FileSystem, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { AgentRunnerLayer } from "../../cli/src/agent-runner.ts"
import { GitHubLayer } from "../../cli/src/github.ts"
import { planIssues } from "../../cli/src/issue-planner.ts"
import { LinearLayer } from "../../cli/src/linear-layer.ts"
import { Linear } from "../../cli/src/linear.ts"
import { MissionControl, MissionControlLayer } from "../../cli/src/mission-control.ts"
import { OrcaEvents, OrcaEventsLayer } from "../../cli/src/orca-events.ts"
import { resolveOrcaDirectory } from "../../cli/src/orca-directory.ts"
import { OrcaServerControlData, OrcaServerErrorResponse } from "../../cli/src/orca-server-protocol.ts"
import { PromptGenLayer } from "../../cli/src/prompt-gen.ts"
import { PullRequestStoreLayer } from "../../cli/src/pull-request-store.ts"
import { RepoConfig, RepoConfigLayer, RepoConfigError } from "../../cli/src/repo-config.ts"
import { Runner, RunnerLayer } from "../../cli/src/runner.ts"
import { RunStateBusyError, RunStateLayer } from "../../cli/src/run-state.ts"
import { PlatformServices } from "../../cli/src/shared/platform.ts"
import { VerifierLayer } from "../../cli/src/verifier.ts"
import { WorktreeLayer } from "../../cli/src/worktree.ts"

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

const main = async () => {
  const startedAtMs = Date.now()
  const token = crypto.randomUUID()
  let cleanedUp = false

  const server = Bun.serve({
    fetch: (request) => handleRequest(request, token),
    hostname: "127.0.0.1",
    port: 0,
  })

  const control = new OrcaServerControlData({
    baseUrl: `http://${server.hostname}:${server.port}`,
    pid: process.pid,
    startedAtMs,
    token,
  })

  await runtime.runPromise(writeServerControl(control))
  await runtime.runPromise(
    Effect.gen(function* () {
      const events = yield* OrcaEvents
      yield* events.publish({ pid: process.pid, startedAtMs, type: "server-ready" })
    }),
  )

  const cleanup = async () => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    server.stop(true)
    await runtime.runPromise(removeServerControl().pipe(Effect.orElseSucceed(() => undefined)))
    await runtime.dispose()
  }

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0))
  })
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0))
  })
}

const handleRequest = async (request: Request, token: string): Promise<Response> => {
  if (!isAuthorized(request, token)) {
    return jsonResponse(new OrcaServerErrorResponse({ message: "Unauthorized Orca server request.", tag: "Unauthorized" }), 401)
  }

  const url = new URL(request.url)

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
      return runVoid(Effect.gen(function* () {
        const runner = yield* Runner
        yield* runner.pollWaitingPullRequests
      }))
    case "POST /runner/run-next":
      return runJson(Effect.gen(function* () {
        const runner = yield* Runner
        return yield* runner.runNext
      }))
    case "GET /events":
      return openEventStream()
    default:
      return new Response("Not found", { status: 404 })
  }
}

const runJson = async <A, E>(effect: Effect.Effect<A, E, any>): Promise<Response> => {
  try {
    const value = await runtime.runPromise(effect)
    return jsonResponse(value)
  } catch (error) {
    return errorResponse(error)
  }
}

const runVoid = async <A, E>(effect: Effect.Effect<A, E, any>): Promise<Response> => {
  try {
    await runtime.runPromise(effect)
    return new Response(null, { status: 204 })
  } catch (error) {
    return errorResponse(error)
  }
}

const openEventStream = async (): Promise<Response> => {
  try {
    const stream = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* OrcaEvents
        return events.stream.pipe(
          Stream.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          Stream.encodeText,
        )
      }),
    )

    return new Response(Stream.toReadableStream(stream), {
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

const writeServerControl = (control: OrcaServerControlData) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const orcaDirectory = yield* resolveOrcaDirectory()
    yield* fs.makeDirectory(orcaDirectory, { recursive: true })
    yield* fs.writeFileString(
      `${orcaDirectory}/server.json`,
      JSON.stringify(Schema.encodeUnknownSync(OrcaServerControlData)(control), null, 2) + "\n",
    )
  })

const removeServerControl = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const orcaDirectory = yield* resolveOrcaDirectory()
    yield* fs.remove(`${orcaDirectory}/server.json`).pipe(Effect.catch(() => Effect.void))
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
  const payload = new OrcaServerErrorResponse({
    message: getErrorMessage(error),
    ...(getErrorTag(error) === undefined ? {} : { tag: getErrorTag(error) }),
  })

  return jsonResponse(Schema.encodeUnknownSync(OrcaServerErrorResponse)(payload), statusForError(error))
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

const statusForError = (error: unknown) => {
  if (error instanceof RepoConfigError) {
    return 400
  }
  if (error instanceof RunStateBusyError) {
    return 409
  }
  const tag = getErrorTag(error)
  switch (tag) {
    case "LinearAuthRequiredError":
      return 401
    case "RunnerNoWorkError":
      return 404
    default:
      return 500
  }
}

await main().catch(async (error) => {
  console.error(getErrorMessage(error))
  await runtime.dispose()
  process.exit(1)
})
