import { Data, Effect, FileSystem, Layer, Option, PlatformError, Schema, ServiceMap } from "effect"
import { IssuePlanData, type IssuePlan } from "./issue-planner.ts"
import { LinearViewerData, type LinearViewer } from "./linear.ts"
import { LinearApiError } from "./linear.ts"
import { LinearAuthRequiredError, LinearOAuthError } from "./linear/token-manager.ts"
import { MissionControlError, MissionControlSnapshotData, type MissionControlSnapshot } from "./mission-control.ts"
import { resolveOrcaDirectory } from "./orca-directory.ts"
import { OrcaServerControlData, OrcaServerErrorResponse, RunnerResultData } from "./orca-server-protocol.ts"
import { RepoConfigError } from "./repo-config.ts"
import { RunnerFailure, RunnerNoWorkError, type RunnerResult } from "./runner.ts"
import { RunStateBusyError } from "./run-state.ts"

type OrcaClientRequestError =
  | LinearApiError
  | LinearAuthRequiredError
  | LinearOAuthError
  | MissionControlError
  | OrcaClientError
  | RepoConfigError
  | RunnerFailure
  | RunnerNoWorkError
  | RunStateBusyError

export type OrcaClientService = {
  readonly authenticate: Effect.Effect<LinearViewer, OrcaClientRequestError>
  readonly issuePlan: Effect.Effect<IssuePlan, OrcaClientRequestError>
  readonly missionControlSnapshot: Effect.Effect<MissionControlSnapshot, OrcaClientRequestError>
  readonly pollWaitingPullRequests: Effect.Effect<void, OrcaClientRequestError>
  readonly runNext: Effect.Effect<RunnerResult, OrcaClientRequestError>
}

export const OrcaClient = ServiceMap.Service<OrcaClientService>("orca/OrcaClient")

export const OrcaClientLayer = Layer.effect(
  OrcaClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const orcaDirectory = yield* resolveOrcaDirectory()
    const controlFile = `${orcaDirectory}/server.json`
    const lockFile = `${orcaDirectory}/server.lock`

    const readControlOption = Effect.gen(function* () {
      const exists = yield* fs.exists(controlFile).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Failed to inspect ${controlFile}.`, cause })),
      )

      if (!exists) {
        return Option.none<typeof OrcaServerControlData.Type>()
      }

      const raw = yield* fs.readFileString(controlFile).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Failed to read ${controlFile}.`, cause })),
      )

      const json = yield* Effect.try({
        try: () => JSON.parse(raw),
        catch: (cause) => new OrcaClientError({ message: `Failed to parse ${controlFile}.`, cause }),
      })

      const control = yield* Schema.decodeUnknownEffect(OrcaServerControlData)(json).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Invalid Orca server control file at ${controlFile}.`, cause })),
      )

      return Option.some(control)
    }).pipe(
      Effect.catch(() =>
        Effect.andThen(
          fs.remove(controlFile).pipe(Effect.catch(() => Effect.void)),
          Effect.succeed(Option.none<typeof OrcaServerControlData.Type>()),
        )),
    )

    const readStartupLockOption = Effect.gen(function* () {
      const raw = yield* fs.readFileString(lockFile).pipe(Effect.orElseSucceed(() => null))
      if (raw === null) {
        return Option.none<typeof OrcaServerStartupLockData.Type>()
      }

      const json = (() => {
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      })()

      if (json === null) {
        return Option.none<typeof OrcaServerStartupLockData.Type>()
      }

      const lock = yield* Schema.decodeUnknownEffect(OrcaServerStartupLockData)(json).pipe(Effect.orElseSucceed(() => null))
      if (lock === null) {
        return Option.none<typeof OrcaServerStartupLockData.Type>()
      }

      return Option.some(lock)
    })

    const removeControlFile = fs.remove(controlFile).pipe(Effect.catch(() => Effect.void))
    const removeLockFile = fs.remove(lockFile).pipe(Effect.catch(() => Effect.void))

    const isServerReady = (control: typeof OrcaServerControlData.Type) =>
      Effect.gen(function* () {
        if (!isPidRunning(control.pid)) {
          return false
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${control.baseUrl}/health`, {
              headers: {
                authorization: `Bearer ${control.token}`,
              },
            }),
          catch: () => false,
        }).pipe(
          Effect.catch(() => Effect.succeed(false as const)),
        )

        return response !== false && response.ok
      })

    const spawnServer = Effect.gen(function* () {
      const hasDistBinary = yield* fs.exists("dist/orca-server").pipe(Effect.orElseSucceed(() => false))
      const command = hasDistBinary ? ["./dist/orca-server"] : ["bun", "run", "./apps/server/src/main.ts"]

      yield* Effect.try({
        try: () =>
          Bun.spawn(command, {
            cwd: process.cwd(),
            stderr: "inherit",
            stdin: "ignore",
            stdout: "ignore",
          }),
        catch: (cause) => new OrcaClientError({ message: "Failed to start the local Orca server.", cause }),
      })
    })

    const acquireSpawnLock = Effect.gen(function* () {
      yield* fs.makeDirectory(orcaDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Failed to create ${orcaDirectory}.`, cause })),
      )

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const acquired = yield* fs.writeFileString(
          lockFile,
          JSON.stringify(Schema.encodeUnknownSync(OrcaServerStartupLockData)({ pid: process.pid, startedAtMs: Date.now() }), null, 2) + "\n",
          { flag: "wx" },
        ).pipe(
          Effect.as(true as const),
          Effect.catch((cause) =>
            isFileAlreadyExistsError(cause)
              ? Effect.succeed(false as const)
              : Effect.fail(new OrcaClientError({ message: `Failed to acquire ${lockFile}.`, cause }))),
        )

        if (acquired) {
          return true as const
        }

        const controlOption = yield* readControlOption
        if (Option.isSome(controlOption) && (yield* isServerReady(controlOption.value))) {
          return false as const
        }

        const startupLockOption = yield* readStartupLockOption
        if (Option.isSome(startupLockOption) && !isPidRunning(startupLockOption.value.pid)) {
          yield* removeLockFile
          continue
        }

        yield* Effect.sleep("100 millis")
      }

      return yield* Effect.fail(
        new OrcaClientError({ message: "Timed out waiting for another Orca process to finish starting the local server." }),
      )
    })

    const waitForServer = Effect.gen(function* () {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const controlOption = yield* readControlOption
        if (Option.isSome(controlOption) && (yield* isServerReady(controlOption.value))) {
          return controlOption.value
        }
        yield* Effect.sleep("100 millis")
      }

      return yield* Effect.fail(new OrcaClientError({ message: "Timed out waiting for the local Orca server to start." }))
    })

    const ensureServer = Effect.gen(function* () {
      const controlOption = yield* readControlOption
      if (Option.isSome(controlOption) && (yield* isServerReady(controlOption.value))) {
        return controlOption.value
      }

      const acquiredSpawnLock = yield* acquireSpawnLock
      if (!acquiredSpawnLock) {
        return yield* waitForServer
      }

      return yield* Effect.gen(function* () {
        const currentControlOption = yield* readControlOption
        if (Option.isSome(currentControlOption) && (yield* isServerReady(currentControlOption.value))) {
          return currentControlOption.value
        }

        yield* removeControlFile
        yield* spawnServer
        return yield* waitForServer
      }).pipe(Effect.ensuring(removeLockFile))
    })

    const request = <A>(options: {
      readonly decode: (json: unknown) => Effect.Effect<A, OrcaClientRequestError>
      readonly method: "GET" | "POST"
      readonly path: string
    }) =>
      Effect.gen(function* () {
        const control = yield* ensureServer
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${control.baseUrl}${options.path}`, {
              headers: {
                authorization: `Bearer ${control.token}`,
              },
              method: options.method,
            }),
          catch: (cause) => new OrcaClientError({ message: `Failed to contact the local Orca server at ${control.baseUrl}.`, cause }),
        })

        if (!response.ok) {
          return yield* Effect.fail(yield* decodeErrorResponse(response))
        }

        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new OrcaClientError({ message: `The local Orca server returned invalid JSON for ${options.method} ${options.path}.`, cause }),
        })

        return yield* options.decode(json)
      })

    const requestVoid = (path: string) =>
      Effect.gen(function* () {
        const control = yield* ensureServer
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${control.baseUrl}${path}`, {
              headers: {
                authorization: `Bearer ${control.token}`,
              },
              method: "POST",
            }),
          catch: (cause) => new OrcaClientError({ message: `Failed to contact the local Orca server at ${control.baseUrl}.`, cause }),
        })

        if (!response.ok) {
          return yield* Effect.fail(yield* decodeErrorResponse(response))
        }
      })

    const authenticate = request({
      decode: decodeJson(LinearViewerData, "The local Orca server returned an invalid Linear viewer payload."),
      method: "POST",
      path: "/linear/auth",
    })

    const issuePlan = request({
      decode: decodeJson(IssuePlanData, "The local Orca server returned an invalid issue plan."),
      method: "GET",
      path: "/issues/plan",
    })

    const missionControlSnapshot = request({
      decode: decodeJson(MissionControlSnapshotData, "The local Orca server returned an invalid mission control snapshot."),
      method: "GET",
      path: "/mission-control/snapshot",
    })

    const pollWaitingPullRequests = requestVoid("/runner/poll-waiting-pull-requests")

    const runNext = request({
      decode: decodeJson(RunnerResultData, "The local Orca server returned an invalid runner result."),
      method: "POST",
      path: "/runner/run-next",
    })

    return OrcaClient.of({
      authenticate,
      issuePlan,
      missionControlSnapshot,
      pollWaitingPullRequests,
      runNext,
    })
  }),
)

export class OrcaClientError extends Data.TaggedError("OrcaClientError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const OrcaServerStartupLockData = Schema.Struct({
  pid: Schema.Number,
  startedAtMs: Schema.Number,
})

const decodeJson = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>, message: string) => (json: unknown) =>
  Schema.decodeUnknownEffect(schema)(json).pipe(
    Effect.mapError((cause) => new OrcaClientError({ message, cause })),
  )

const isFileAlreadyExistsError = (cause: unknown) => {
  if (!(cause instanceof PlatformError.PlatformError) && !hasTag(cause, "PlatformError")) {
    return false
  }

  if (!hasReason(cause)) {
    return false
  }

  const reason = cause.reason

  return reason === "AlreadyExists"
    || reason instanceof PlatformError.SystemError && reason._tag === "AlreadyExists"
    || hasTag(reason, "AlreadyExists")
}

const decodeErrorResponse = (response: Response) =>
  Effect.gen(function* () {
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new OrcaClientError({ message: `The local Orca server returned an invalid error response with status ${response.status}.`, cause }),
    })

    const payload = yield* Schema.decodeUnknownEffect(OrcaServerErrorResponse)(json).pipe(
      Effect.mapError((cause) => new OrcaClientError({ message: "The local Orca server returned an unreadable error payload.", cause })),
    )

    return toClientError(payload)
  })

const toClientError = (payload: OrcaServerErrorResponse) => {
  switch (payload.tag) {
    case "LinearApiError":
      return new LinearApiError({ message: payload.message })
    case "LinearAuthRequiredError":
      return new LinearAuthRequiredError({ message: payload.message })
    case "LinearOAuthError":
      return new LinearOAuthError({ message: payload.message })
    case "MissionControlError":
      return new MissionControlError({ message: payload.message })
    case "RepoConfigError":
      return new RepoConfigError({ message: payload.message })
    case "RunnerFailure":
      return new RunnerFailure({ message: payload.message })
    case "RunnerNoWorkError":
      return new RunnerNoWorkError({ message: payload.message })
    case "RunStateBusyError":
      return new RunStateBusyError({ message: payload.message })
    default:
      return new OrcaClientError({ message: payload.message })
  }
}

const isPidRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasCode(error, "ESRCH")
  }
}

const hasTag = <Tag extends string>(value: unknown, tag: Tag): value is { readonly _tag: Tag } =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag

const hasCode = <Code extends string>(value: unknown, code: Code): value is { readonly code: Code } =>
  typeof value === "object" && value !== null && "code" in value && value.code === code

const hasReason = (value: unknown): value is { readonly reason: unknown } =>
  typeof value === "object" && value !== null && "reason" in value
