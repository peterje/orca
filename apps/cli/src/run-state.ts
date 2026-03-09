import { Data, Effect, FileSystem, Layer, Schema, ServiceMap } from "effect"
import { resolveOrcaDirectory } from "./orca-directory.ts"

export const activeRunModes = ["implementation", "review"] as const
export type ActiveRunMode = (typeof activeRunModes)[number]

export const activeRunStages = [
  "implementing",
  "addressing-review-feedback",
  "verifying",
  "publishing-pull-request",
  "waiting-for-review",
] as const

export type ActiveRunStage = (typeof activeRunStages)[number]

const ActiveRunModeSchema = Schema.Literals(activeRunModes)
const ActiveRunStageSchema = Schema.Literals(activeRunStages)

export class ActiveRun extends Schema.Class<ActiveRun>("orca/ActiveRun")({
  branch: Schema.String,
  issueId: Schema.String,
  issueIdentifier: Schema.String,
  issueTitle: Schema.String,
  mode: ActiveRunModeSchema,
  pid: Schema.Number,
  prNumber: Schema.NullOr(Schema.Number),
  prUrl: Schema.NullOr(Schema.String),
  startedAtMs: Schema.Number,
  stage: ActiveRunStageSchema,
  worktreePath: Schema.String,
}) {}

export type RunStateService = {
  acquire: (run: Omit<typeof ActiveRun.Type, "pid" | "prNumber" | "prUrl" | "startedAtMs">) => Effect.Effect<ActiveRun, RunStateError | RunStateBusyError>
  clear: Effect.Effect<void, RunStateError>
  current: Effect.Effect<ActiveRun | null, RunStateError>
  update: (patch: Partial<Pick<typeof ActiveRun.Type, "prNumber" | "prUrl" | "stage">>) => Effect.Effect<ActiveRun | null, RunStateError>
}

export const RunState = ServiceMap.Service<RunStateService>("orca/RunState")

export const RunStateLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const orcaDirectory = yield* resolveOrcaDirectory()
  const file = `${orcaDirectory}/run.json`

  const decode = (raw: string) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(ActiveRun)(normalizeActiveRun(JSON.parse(raw))),
      catch: (cause) => new RunStateError({ message: `Failed to parse ${file}.`, cause }),
    })

  const write = (run: ActiveRun) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(orcaDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new RunStateError({ message: `Failed to create ${orcaDirectory}.`, cause })),
      )
      yield* fs.writeFileString(
        file,
        JSON.stringify(Schema.encodeUnknownSync(ActiveRun)(run), null, 2) + "\n",
      ).pipe(
        Effect.mapError((cause) => new RunStateError({ message: `Failed to write ${file}.`, cause })),
      )
    })

  const remove = fs.remove(file).pipe(
    Effect.catch(() => Effect.void),
    Effect.mapError((cause) => new RunStateError({ message: `Failed to remove ${file}.`, cause })),
  )

  const current = Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => new RunStateError({ message: `Failed to inspect ${file}.`, cause })),
    )
    if (!exists) {
      return null
    }

    const raw = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => new RunStateError({ message: `Failed to read ${file}.`, cause })),
    )
    const run = yield* decode(raw)
    if (!isPidRunning(run.pid)) {
      yield* remove
      return null
    }
    return run
  })

  const acquire = (run: Omit<typeof ActiveRun.Type, "pid" | "prNumber" | "prUrl" | "startedAtMs">) =>
    Effect.gen(function* () {
      const existing = yield* current
      if (existing !== null) {
        return yield* Effect.fail(
          new RunStateBusyError({
            message: `An Orca run is already active for ${existing.issueIdentifier} in ${existing.worktreePath}.`,
          }),
        )
      }

      const activeRun = new ActiveRun({
        ...run,
        pid: process.pid,
        prNumber: null,
        prUrl: null,
        startedAtMs: Date.now(),
      })
      yield* write(activeRun)
      return activeRun
    })

  const update = (patch: Partial<Pick<typeof ActiveRun.Type, "prNumber" | "prUrl" | "stage">>) =>
    Effect.gen(function* () {
      const existing = yield* current
      if (existing === null) {
        return null
      }
      const next = new ActiveRun({
        ...existing,
        prNumber: patch.prNumber ?? existing.prNumber,
        prUrl: patch.prUrl ?? existing.prUrl,
        stage: patch.stage ?? existing.stage,
      })
      yield* write(next)
      return next
    })

  return RunState.of({
    acquire,
    clear: remove,
    current,
    update,
  })
})

export const RunStateLayer = Layer.effect(RunState, RunStateLive)

export class RunStateError extends Data.TaggedError("RunStateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RunStateBusyError extends Data.TaggedError("RunStateBusyError")<{
  readonly message: string
}> {}

export const formatActiveRunStage = (stage: ActiveRunStage) => {
  switch (stage) {
    case "implementing":
      return "in implementation"
    case "addressing-review-feedback":
      return "addressing review feedback"
    case "verifying":
      return "running verification"
    case "publishing-pull-request":
      return "publishing pull request"
    case "waiting-for-review":
      return "waiting for review"
  }
}

const normalizeActiveRun = (json: unknown) =>
  typeof json === "object" && json !== null
    ? {
        issueTitle: "",
        mode: "implementation",
        stage: "implementing",
        ...json,
      }
    : json

const isPidRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
