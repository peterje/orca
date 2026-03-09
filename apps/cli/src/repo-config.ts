import { Data, Effect, FileSystem, Layer, Schema, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { resolveOrcaDirectory } from "./orca-directory.ts"

export type RepoAgent = "opencode" | "codex"

export class RepoConfigData extends Schema.Class<RepoConfigData>("orca/RepoConfigData")({
  agent: Schema.Literals(["opencode", "codex"]),
  agentArgs: Schema.Array(Schema.String),
  agentTimeoutMinutes: Schema.Number,
  baseBranch: Schema.String,
  branchPrefix: Schema.String,
  cleanupWorktreeOnSuccess: Schema.Boolean,
  draftPr: Schema.Boolean,
  linearLabel: Schema.String,
  maxWaitingGreptilePrs: Schema.Number,
  repo: Schema.String,
  setup: Schema.Array(Schema.String),
  stallTimeoutMinutes: Schema.Number,
  verify: Schema.Array(Schema.String),
}) {}

const defaultMaxWaitingGreptilePrs = 4

export type RepoConfigService = {
  configPath: Effect.Effect<string>
  exists: Effect.Effect<boolean, RepoConfigError>
  read: Effect.Effect<RepoConfigData, RepoConfigError>
  readOption: Effect.Effect<RepoConfigData | null, RepoConfigError>
  write: (config: RepoConfigData) => Effect.Effect<void, RepoConfigError>
  bootstrap: (options?: {
    readonly agent?: RepoAgent | undefined
    readonly baseBranch?: string | undefined
    readonly branchPrefix?: string | undefined
    readonly draftPr?: boolean | undefined
    readonly force?: boolean | undefined
    readonly linearLabel?: string | undefined
    readonly repo?: string | undefined
  }) => Effect.Effect<RepoConfigData, RepoConfigError>
}

export const RepoConfig = ServiceMap.Service<RepoConfigService>("orca/RepoConfig")

export const RepoConfigLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const orcaDirectory = yield* resolveOrcaDirectory()
  const file = `${orcaDirectory}/repo.json`

  const configPath = Effect.succeed(file)

  const exists = fs.exists(file).pipe(
    Effect.mapError((cause) => new RepoConfigError({ message: "Failed to inspect Orca repo config.", cause })),
  )

  const read = Effect.gen(function* () {
    const raw = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => new RepoConfigError({ message: `Failed to read ${file}.`, cause })),
    )
    const json = yield* Effect.try({
      try: () => JSON.parse(raw),
      catch: (cause) => new RepoConfigError({ message: `Failed to parse ${file} as JSON.`, cause }),
    })
    return yield* Schema.decodeUnknownEffect(RepoConfigData)(normalizeRepoConfigJson(json)).pipe(
      Effect.mapError((cause) => new RepoConfigError({ message: `Invalid Orca repo config in ${file}.`, cause })),
    )
  })

  const readOption = Effect.gen(function* () {
    const hasConfig = yield* exists
    return hasConfig ? yield* read : null
  })

  const write = (config: RepoConfigData) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(orcaDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new RepoConfigError({ message: `Failed to create ${orcaDirectory}.`, cause })),
      )
      const payload = JSON.stringify(Schema.encodeUnknownSync(RepoConfigData)(config), null, 2) + "\n"
      yield* fs.writeFileString(file, payload).pipe(
        Effect.mapError((cause) => new RepoConfigError({ message: `Failed to write ${file}.`, cause })),
      )
    })

  const bootstrap = (options?: {
    readonly agent?: RepoAgent | undefined
    readonly baseBranch?: string | undefined
    readonly branchPrefix?: string | undefined
    readonly draftPr?: boolean | undefined
    readonly force?: boolean | undefined
    readonly linearLabel?: string | undefined
    readonly repo?: string | undefined
  }) =>
    Effect.gen(function* () {
      const alreadyExists = yield* exists
      if (alreadyExists && options?.force !== true) {
        return yield* Effect.fail(
          new RepoConfigError({
            message: `Repo config already exists at ${file}. Re-run with --force to overwrite it.`,
          }),
        )
      }

      const repo = options?.repo ?? (yield* detectRepo(spawner))
      const baseBranch = options?.baseBranch ?? (yield* detectCurrentBranch(spawner)) ?? "main"
      const verify = yield* inferVerifyCommands(fs)
      const config = new RepoConfigData({
        agent: options?.agent ?? "opencode",
        agentArgs: [],
        agentTimeoutMinutes: 45,
        baseBranch,
        branchPrefix: options?.branchPrefix ?? "orca",
        cleanupWorktreeOnSuccess: true,
        draftPr: options?.draftPr ?? true,
        linearLabel: options?.linearLabel ?? "Orca",
        maxWaitingGreptilePrs: defaultMaxWaitingGreptilePrs,
        repo,
        setup: ["bun install"],
        stallTimeoutMinutes: 10,
        verify,
      })

      yield* write(config)
      return config
    })

  return RepoConfig.of({
    bootstrap,
    configPath,
    exists,
    read,
    readOption,
    write,
  })
})

export const RepoConfigLayer = Layer.effect(RepoConfig, RepoConfigLive)

export class RepoConfigError extends Data.TaggedError("RepoConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const normalizeRepoConfigJson = (json: unknown) =>
  typeof json === "object" && json !== null && !Array.isArray(json)
    ? { maxWaitingGreptilePrs: defaultMaxWaitingGreptilePrs, ...json }
    : json

const detectRepo = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ChildProcess.make("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stderr: "pipe",
    stdout: "pipe",
  }).pipe(
    spawner.string,
    Effect.map((value) => value.trim()),
    Effect.catch(() => Effect.succeed("owner/name")),
    Effect.map((value) => (value.length > 0 ? value : "owner/name")),
  )

const detectCurrentBranch = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ChildProcess.make("git", ["branch", "--show-current"], {
    stderr: "pipe",
    stdout: "pipe",
  }).pipe(
    spawner.string,
    Effect.map((value) => {
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : null
    }),
    Effect.catch(() => Effect.succeed(null)),
  )

const inferVerifyCommands = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const hasPackageJson = yield* fs.exists("package.json").pipe(Effect.orElseSucceed(() => false))
    if (!hasPackageJson) {
      return []
    }

    const raw = yield* fs.readFileString("package.json").pipe(Effect.orElseSucceed(() => "{}"))
    const json = yield* Effect.sync(() => {
      try {
        return JSON.parse(raw) as { readonly scripts?: Record<string, string> }
      } catch {
        return {} as { readonly scripts?: Record<string, string> }
      }
    })
    const scripts = json.scripts ?? {}
    const commands: Array<string> = []
    if (typeof scripts.check === "string") {
      commands.push("bun run check")
    }
    if (typeof scripts.test === "string") {
      commands.push("bun run test")
    }
    if (typeof scripts.build === "string") {
      commands.push("bun run build")
    }
    return commands
  })
