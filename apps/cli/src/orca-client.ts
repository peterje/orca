import { fileURLToPath } from "node:url"
import { Clock, Data, Effect, FileSystem, Layer, Option, PlatformError, Schema, ServiceMap } from "effect"
import { IssuePlanData, type IssuePlan } from "./issue-planner.ts"
import { LinearViewerData, type LinearViewer } from "./linear.ts"
import { LinearApiError } from "./linear.ts"
import { LinearAuthRequiredError, LinearOAuthError } from "./linear/token-manager.ts"
import { MissionControlError, MissionControlSnapshotData, type MissionControlSnapshot } from "./mission-control.ts"
import { resolveOrcaDirectory } from "./orca-directory.ts"
import { OrcaServerControlData, OrcaServerErrorResponse, RunnerResultData } from "./orca-server-protocol.ts"
import { RepoConfig, RepoConfigError, type RepoConfigData } from "./repo-config.ts"
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
    const repoConfig = yield* RepoConfig
    const controlFile = `${orcaDirectory}/server.json`
    const lockFile = `${orcaDirectory}/server.lock`
    const serverLogFile = `${orcaDirectory}/server.log`

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
      Effect.catchDefect(() =>
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

      const json = yield* Effect.try({
        try: () => JSON.parse(raw),
        catch: (cause) => new OrcaClientError({ message: `Failed to parse ${lockFile}.`, cause }),
      }).pipe(
        // Another process may observe the lock file before its first write completes.
        Effect.orElseSucceed(() => null),
      )

      if (json === null) {
        return Option.none<typeof OrcaServerStartupLockData.Type>()
      }

      const lock = yield* Schema.decodeUnknownEffect(OrcaServerStartupLockData)(json).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Invalid Orca server startup lock at ${lockFile}.`, cause })),
        Effect.orElseSucceed(() => null),
      )

      if (lock === null) {
        return Option.none<typeof OrcaServerStartupLockData.Type>()
      }

      return Option.some(lock)
    })

    const removeControlFile = fs.remove(controlFile).pipe(Effect.catch(() => Effect.void))
    const removeLockFile = fs.remove(lockFile).pipe(Effect.catch(() => Effect.void))
    const prepareServerLogFile = fs.writeFileString(serverLogFile, "").pipe(
      Effect.mapError((cause) => new OrcaClientError({ message: `Failed to prepare ${serverLogFile}.`, cause })),
    )

    const logServerStartup = (message: string) => Effect.sync(() => process.stderr.write(`${message}\n`))

    const sleepUntilNextServerStartupPoll = (deadlineMs: number) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => {
          const remainingMs = deadlineMs - nowMs
          if (remainingMs <= 0) {
            return Effect.succeed(false as const)
          }

          return Effect.sleep(Math.min(serverStartupPollIntervalMs, remainingMs)).pipe(Effect.as(true as const))
        }),
      )

    const isServerReady = (control: typeof OrcaServerControlData.Type) =>
      Effect.gen(function* () {
        if (!isPidRunning(control.pid)) {
          return false
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            fetchWithTimeout(
              `${control.baseUrl}/health`,
              {
                headers: {
                  authorization: `Bearer ${control.token}`,
                },
              },
              {
                message: "Timed out waiting 5 seconds for the local Orca server health check.",
                timeoutMs: defaultServerHealthCheckTimeoutMs,
              },
            ),
          catch: () => false,
        }).pipe(
          Effect.catch(() => Effect.succeed(false as const)),
        )

        return response !== false && response.ok
      })

    const spawnDetachedProcess = (command: Array<string>) =>
      Effect.try({
        try: () => {
          const child = Bun.spawn(command, {
            cwd: process.cwd(),
            detached: true,
            stderr: Bun.file(serverLogFile),
            stdin: "ignore",
            stdout: "ignore",
          })
          child.unref()
        },
        catch: (cause) => cause,
      })

    const spawnServer = Effect.gen(function* () {
      const hasDistBinary = yield* fs.exists(serverBinaryPath).pipe(Effect.orElseSucceed(() => false))
      const hasSourceEntry = yield* fs.exists(serverSourceEntryPath).pipe(Effect.orElseSucceed(() => false))

      if (!hasDistBinary && !hasSourceEntry) {
        return yield* Effect.fail(new OrcaClientError({
          message: `Could not locate the local Orca server binary or source entrypoint. Checked ${serverBinaryPath} and ${serverSourceEntryPath}.`,
        }))
      }

      if (hasDistBinary) {
        const spawnedDistBinary = yield* spawnDetachedProcess([serverBinaryPath]).pipe(
          Effect.as(true as const),
          Effect.catch((cause) =>
            isPermissionDeniedError(cause)
              ? Effect.succeed(false as const)
              : Effect.fail(new OrcaClientError({ message: "Failed to start the local Orca server.", cause }))),
        )

        if (spawnedDistBinary) {
          return
        }

        return yield* spawnDetachedProcess(["bun", "run", serverBinaryPath]).pipe(
          Effect.mapError((cause) => new OrcaClientError({ message: "Failed to start the local Orca server.", cause })),
        )
      }

      yield* spawnDetachedProcess(["bun", "run", serverSourceEntryPath]).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: "Failed to start the local Orca server.", cause })),
      )
    })

    const acquireSpawnLock = Effect.gen(function* () {
      yield* fs.makeDirectory(orcaDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new OrcaClientError({ message: `Failed to create ${orcaDirectory}.`, cause })),
      )

      const deadlineMs = (yield* Clock.currentTimeMillis) + serverStartupTimeoutMs

      for (let attempt = 0; ; attempt += 1) {
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

        if (attempt === 0) {
          yield* logServerStartup("Waiting for another Orca process to finish starting the local server...")
        } else if (attempt % serverStartupLogIntervalAttempts === 0) {
          yield* logServerStartup("Still waiting for the local Orca server to start...")
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

        const shouldContinue = yield* sleepUntilNextServerStartupPoll(deadlineMs)
        if (!shouldContinue) {
          break
        }
      }

      return yield* Effect.fail(
        new OrcaClientError({
          message: `Timed out waiting ${formatTimeoutDuration(serverStartupTimeoutMs)} for another Orca process to finish starting the local server. Check ${serverLogFile} for startup logs.`,
        }),
      )
    })

    const waitForServer = Effect.gen(function* () {
      const deadlineMs = (yield* Clock.currentTimeMillis) + serverStartupTimeoutMs

      for (let attempt = 0; ; attempt += 1) {
        const controlOption = yield* readControlOption
        if (Option.isSome(controlOption) && (yield* isServerReady(controlOption.value))) {
          return controlOption.value
        }

        if (attempt === 0) {
          yield* logServerStartup("Waiting for the local Orca server to be ready...")
        } else if (attempt % serverStartupLogIntervalAttempts === 0) {
          yield* logServerStartup("Still waiting for the local Orca server to start...")
        }

        const shouldContinue = yield* sleepUntilNextServerStartupPoll(deadlineMs)
        if (!shouldContinue) {
          break
        }
      }

      return yield* Effect.fail(
        new OrcaClientError({ message: `Timed out waiting ${formatTimeoutDuration(serverStartupTimeoutMs)} for the local Orca server to start. Check ${serverLogFile} for startup logs.` }),
      )
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
        yield* prepareServerLogFile
        yield* logServerStartup("Starting local Orca server...")
        yield* spawnServer
        return yield* waitForServer
      }).pipe(Effect.ensuring(removeLockFile))
    })

    const fetchServerResponse = (options: {
      readonly control: typeof OrcaServerControlData.Type
      readonly method: "GET" | "POST"
      readonly path: string
      readonly timeoutMs?: number
    }) =>
      Effect.tryPromise({
        try: () =>
          fetchWithTimeout(
            `${options.control.baseUrl}${options.path}`,
            {
              headers: {
                authorization: `Bearer ${options.control.token}`,
              },
              method: options.method,
            },
            options.timeoutMs === undefined
              ? undefined
              : {
                  message: `Timed out waiting ${formatTimeoutDuration(options.timeoutMs)} for the local Orca server to respond to ${options.method} ${options.path}.`,
                  timeoutMs: options.timeoutMs,
                },
          ),
        catch: (cause) =>
          cause instanceof OrcaClientError
            ? cause
            : new OrcaClientError({ message: `Failed to contact the local Orca server at ${options.control.baseUrl}.`, cause }),
      })

    const request = <A>(options: {
      readonly decode: (json: unknown) => Effect.Effect<A, OrcaClientRequestError>
      readonly method: "GET" | "POST"
      readonly path: string
      readonly timeoutMs?: number
    }) =>
      Effect.gen(function* () {
        const control = yield* ensureServer
        const response = yield* fetchServerResponse({
          control,
          method: options.method,
          path: options.path,
          timeoutMs: options.timeoutMs ?? defaultServerRequestTimeoutMs,
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
        const response = yield* fetchServerResponse({
          control,
          method: "POST",
          path,
          timeoutMs: defaultServerRequestTimeoutMs,
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

    const runNext = Effect.gen(function* () {
      const config = yield* repoConfig.read

      return yield* request({
        decode: decodeJson(RunnerResultData, "The local Orca server returned an invalid runner result."),
        method: "POST",
        path: "/runner/run-next",
        timeoutMs: toRunNextTimeoutMs(config),
      })
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

const defaultServerHealthCheckTimeoutMs = 5_000
const defaultServerRequestTimeoutMs = 60_000
const defaultRunNextTimeoutBufferMinutes = 5
const serverStartupPollIntervalMs = 100
const serverStartupLogIntervalAttempts = 10
const serverStartupTimeoutMs = 30_000
const serverBinaryPath = fileURLToPath(new URL("./orca-server", import.meta.url))
const serverSourceEntryPath = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url))

const OrcaServerStartupLockData = Schema.Struct({
  pid: Schema.Number,
  startedAtMs: Schema.Number,
})

const decodeJson = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>, message: string) => (json: unknown) =>
  Schema.decodeUnknownEffect(schema)(json).pipe(
    Effect.mapError((cause) => new OrcaClientError({ message, cause })),
  )

export const toRunNextTimeoutMs = (config: Pick<RepoConfigData, "agentTimeoutMinutes" | "stallTimeoutMinutes">) =>
  (config.agentTimeoutMinutes + config.stallTimeoutMinutes + defaultRunNextTimeoutBufferMinutes) * 60_000

export const formatTimeoutDuration = (timeoutMs: number) => {
  if (timeoutMs < 60_000) {
    const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`
  }

  const totalMinutes = Math.round(timeoutMs / 60_000)
  return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`
}

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeout:
    | {
        readonly message: string
        readonly timeoutMs: number
      }
    | undefined,
) => {
  if (timeout === undefined) {
    return fetch(url, init)
  }

  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout.timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (cause) {
    if (timedOut) {
      throw new OrcaClientError({ message: timeout.message, cause })
    }
    throw cause
  } finally {
    clearTimeout(timeoutId)
  }
}

const isFileAlreadyExistsError = (cause: unknown) => {
  if (!(cause instanceof PlatformError.PlatformError) && !hasTag(cause, "PlatformError")) {
    return false
  }

  if (!hasReason(cause)) {
    return false
  }

  const reason = cause.reason

  return reason === "AlreadyExists" || hasTag(reason, "AlreadyExists")
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

const isPermissionDeniedError = (value: unknown) => hasCode(value, "EACCES")

const hasReason = (value: unknown): value is { readonly reason: unknown } =>
  typeof value === "object" && value !== null && "reason" in value
