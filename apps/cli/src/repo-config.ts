import { Data, Effect, FileSystem, Layer, Ref, Result, Schema, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"

export type RepoAgent = "opencode" | "codex"

type RepoConfigErrorCode =
  | "workflow-already-exists"
  | "workflow-config-invalid"
  | "workflow-config-validation-failed"
  | "workflow-file-missing"
  | "workflow-front-matter-invalid"
  | "workflow-front-matter-not-map"
  | "workflow-read-failed"
  | "workflow-write-failed"

export class RepoConfigError extends Data.TaggedError("RepoConfigError")<{
  readonly code: RepoConfigErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export class RepoConfigData extends Schema.Class<RepoConfigData>("orca/RepoConfigData")({
  agent: Schema.Literals(["opencode", "codex"]),
  agentArgs: Schema.Array(Schema.String),
  agentTimeoutMinutes: Schema.Number,
  baseBranch: Schema.String,
  branchPrefix: Schema.String,
  cleanupWorktreeOnSuccess: Schema.Boolean,
  draftPr: Schema.Boolean,
  greptilePollIntervalSeconds: Schema.Number,
  linearLabel: Schema.String,
  linearWorkspace: Schema.optional(Schema.String),
  maxWaitingPullRequests: Schema.Number,
  repo: Schema.String,
  setup: Schema.Array(Schema.String),
  stallTimeoutMinutes: Schema.Number,
  verify: Schema.Array(Schema.String),
}) {}

export class WorkflowFrontMatter {
  constructor(readonly raw: Readonly<Record<string, unknown>>) {}

  string(key: string, defaultValue?: string): Effect.Effect<string | undefined, RepoConfigError> {
    const rawValue = lookupFrontMatterValue(this.raw, key)
    if (rawValue === undefined || rawValue === null) {
      return Effect.succeed(defaultValue)
    }

    const resolved = resolveMaybeEnvReference(rawValue)
    if (resolved === undefined) {
      return Effect.succeed(defaultValue)
    }
    if (typeof resolved !== "string") {
      return invalidWorkflowValue(key, "a string", resolved)
    }

    return Effect.succeed(resolved.trim())
  }

  number(key: string, defaultValue: number): Effect.Effect<number, RepoConfigError> {
    const rawValue = lookupFrontMatterValue(this.raw, key)
    if (rawValue === undefined || rawValue === null) {
      return Effect.succeed(defaultValue)
    }

    const resolved = resolveMaybeEnvReference(rawValue)
    if (resolved === undefined) {
      return Effect.succeed(defaultValue)
    }
    if (typeof resolved === "number" && Number.isFinite(resolved)) {
      return Effect.succeed(resolved)
    }
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      const parsed = Number(resolved.trim())
      if (Number.isFinite(parsed)) {
        return Effect.succeed(parsed)
      }
    }

    return invalidWorkflowValue(key, "a number", resolved)
  }

  boolean(key: string, defaultValue: boolean): Effect.Effect<boolean, RepoConfigError> {
    const rawValue = lookupFrontMatterValue(this.raw, key)
    if (rawValue === undefined || rawValue === null) {
      return Effect.succeed(defaultValue)
    }

    const resolved = resolveMaybeEnvReference(rawValue)
    if (resolved === undefined) {
      return Effect.succeed(defaultValue)
    }
    if (typeof resolved === "boolean") {
      return Effect.succeed(resolved)
    }
    if (typeof resolved === "string") {
      const normalized = resolved.trim().toLowerCase()
      if (normalized === "true") {
        return Effect.succeed(true)
      }
      if (normalized === "false") {
        return Effect.succeed(false)
      }
    }

    return invalidWorkflowValue(key, "a boolean", resolved)
  }

  stringArray(key: string, defaultValue: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, RepoConfigError> {
    const rawValue = lookupFrontMatterValue(this.raw, key)
    if (rawValue === undefined || rawValue === null) {
      return Effect.succeed([...defaultValue])
    }

    const resolved = resolveMaybeEnvReference(rawValue)
    if (resolved === undefined) {
      return Effect.succeed([...defaultValue])
    }
    if (!Array.isArray(resolved) || resolved.some((value) => typeof value !== "string")) {
      return invalidWorkflowValue(key, "an array of strings", resolved)
    }

    return Effect.succeed(resolved.map((value) => value.trim()))
  }

  path(key: string, defaultValue?: string): Effect.Effect<string | undefined, RepoConfigError> {
    const rawValue = lookupFrontMatterValue(this.raw, key)
    if (rawValue === undefined || rawValue === null) {
      return Effect.succeed(resolveOptionalPath(defaultValue))
    }

    const resolved = resolveMaybeEnvReference(rawValue)
    if (resolved === undefined) {
      return Effect.succeed(resolveOptionalPath(defaultValue))
    }
    if (typeof resolved !== "string") {
      return invalidWorkflowValue(key, "a path string", resolved)
    }

    const trimmed = resolved.trim()
    return Effect.succeed(trimmed.length === 0 ? resolveOptionalPath(defaultValue) : resolveAbsolutePath(trimmed))
  }
}

export type WorkflowDocument = {
  readonly config: WorkflowFrontMatter
  readonly path: string
  readonly prompt: string
  // Preserve the repo-owned body for rewrites; this stays equal to `prompt`
  // until strict workflow template rendering lands.
  readonly promptTemplate: string
}

export const defaultGreptilePollIntervalSeconds = 30
export const defaultMaxWaitingPullRequests = 4
export const defaultWorkflowFileName = "WORKFLOW.md"
export const workflowPathEnvironmentVariable = "ORCA_WORKFLOW_PATH"
export const defaultWorkflowPromptTemplate = [
  "You are working on the current Orca issue in this repository.",
  "",
  "- implement the selected issue end-to-end",
  "- keep changes focused on the selected work",
  "- run the configured verification commands before handing off",
  "- avoid mutating unrelated git state",
].join("\n")

export type RepoConfigService = {
  configPath: Effect.Effect<string>
  document: Effect.Effect<WorkflowDocument, RepoConfigError>
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
    readonly linearWorkspace?: string | undefined
    readonly repo?: string | undefined
  }) => Effect.Effect<RepoConfigData, RepoConfigError>
}

export const RepoConfig = ServiceMap.Service<RepoConfigService>("orca/RepoConfig")

type WorkflowStamp = {
  readonly hash: number
  readonly size: number
}

type LoadedWorkflowState = {
  readonly config: RepoConfigData
  readonly document: WorkflowDocument
  readonly path: string
  readonly stamp: WorkflowStamp
}

export const RepoConfigLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cache = yield* Ref.make<LoadedWorkflowState | null>(null)

  const configPath = resolveWorkflowPath()

  const exists = resolveWorkflowPath().pipe(
    Effect.flatMap((path) =>
      fs.exists(path).pipe(
        Effect.mapError((cause) => new RepoConfigError({
          code: "workflow-read-failed",
          message: `Failed to inspect workflow file at ${path}.`,
          cause,
        })),
      )),
  )

  const refresh = Effect.gen(function* () {
    const path = yield* resolveWorkflowPath()
    const cached = yield* Ref.get(cache)
    const sourceResult = yield* Effect.result(readWorkflowSource(fs, path))

    if (Result.isFailure(sourceResult)) {
      if (cached !== null) {
        yield* logInvalidReload(path, sourceResult.failure)
        return cached
      }
      return yield* Effect.fail(sourceResult.failure)
    }

    const source = sourceResult.success

    if (cached !== null && cached.path === path && workflowStampEquals(cached.stamp, source.stamp)) {
      return cached
    }

    const loadedResult = yield* Effect.result(loadWorkflowState(path, source))
    if (Result.isFailure(loadedResult)) {
      if (cached !== null) {
        yield* logInvalidReload(path, loadedResult.failure)
        return cached
      }
      return yield* Effect.fail(loadedResult.failure)
    }

    yield* Ref.set(cache, loadedResult.success)
    return loadedResult.success
  })

  const document = refresh.pipe(Effect.map((state) => state.document))
  const read = refresh.pipe(Effect.map((state) => state.config))

  const readOption = read.pipe(
    Effect.matchEffect({
      onFailure: (error: RepoConfigError) =>
      error.code === "workflow-file-missing"
        ? Effect.succeed(null)
        : Effect.fail(error),
      onSuccess: (config) => Effect.succeed(config),
    }),
  )

  const write = (config: RepoConfigData) =>
    Effect.gen(function* () {
      const path = yield* resolveWorkflowPath()
      const promptTemplate = yield* document.pipe(
        Effect.map((loadedWorkflow) => loadedWorkflow.promptTemplate),
        Effect.orElseSucceed(() => defaultWorkflowPromptTemplate),
      )
      const payload = renderWorkflowDocument(config, promptTemplate)

      yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
        Effect.mapError((cause) => new RepoConfigError({
          code: "workflow-write-failed",
          message: `Failed to create ${dirname(path)}.`,
          cause,
        })),
      )

      yield* fs.writeFileString(path, payload).pipe(
        Effect.mapError((cause) => new RepoConfigError({
          code: "workflow-write-failed",
          message: `Failed to write ${path}.`,
          cause,
        })),
      )

      const state = yield* loadWorkflowState(path, { raw: payload, stamp: makeWorkflowStamp(payload) })
      yield* Ref.set(cache, state)
    })

  const bootstrap = (options?: {
    readonly agent?: RepoAgent | undefined
    readonly baseBranch?: string | undefined
    readonly branchPrefix?: string | undefined
    readonly draftPr?: boolean | undefined
    readonly force?: boolean | undefined
    readonly linearLabel?: string | undefined
    readonly linearWorkspace?: string | undefined
    readonly repo?: string | undefined
  }) =>
    Effect.gen(function* () {
      const path = yield* resolveWorkflowPath()
      const alreadyExists = yield* exists
      if (alreadyExists && options?.force !== true) {
        return yield* Effect.fail(new RepoConfigError({
          code: "workflow-already-exists",
          message: `Workflow already exists at ${path}. Re-run with --force to overwrite it.`,
        }))
      }

      const repo = options?.repo ?? (yield* detectRepo(spawner))
      const baseBranch = options?.baseBranch ?? (yield* detectCurrentBranch(spawner)) ?? "main"
      const verify = yield* inferVerifyCommands(fs)
      const linearWorkspace = normalizeLinearWorkspace(options?.linearWorkspace)
      const config = new RepoConfigData({
        agent: options?.agent ?? "opencode",
        agentArgs: [],
        agentTimeoutMinutes: 45,
        baseBranch,
        branchPrefix: options?.branchPrefix ?? "orca",
        cleanupWorktreeOnSuccess: true,
        draftPr: options?.draftPr ?? true,
        greptilePollIntervalSeconds: defaultGreptilePollIntervalSeconds,
        linearLabel: options?.linearLabel ?? "Orca",
        ...(linearWorkspace === undefined ? {} : { linearWorkspace }),
        maxWaitingPullRequests: defaultMaxWaitingPullRequests,
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
    document,
    exists,
    read,
    readOption,
    write,
  })
})

export const RepoConfigLayer = Layer.effect(RepoConfig, RepoConfigLive)

const loadWorkflowState = (path: string, source: { readonly raw: string; readonly stamp: WorkflowStamp }) =>
  Effect.gen(function* () {
    const document = yield* parseWorkflowDocument(path, source.raw)
    const config = yield* decodeRepoConfig(document.config)
    return {
      config,
      document,
      path,
      stamp: source.stamp,
    } satisfies LoadedWorkflowState
  })

const readWorkflowSource = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const present = yield* fs.exists(path).pipe(
      Effect.mapError((cause) => new RepoConfigError({
        code: "workflow-read-failed",
        message: `Failed to inspect workflow file at ${path}.`,
        cause,
      })),
    )

    if (!present) {
      return yield* Effect.fail(new RepoConfigError({
        code: "workflow-file-missing",
        message: `Workflow file not found at ${path}.`,
      }))
    }

    const raw = yield* fs.readFileString(path).pipe(
      Effect.mapError((cause) => new RepoConfigError({
        code: "workflow-read-failed",
        message: `Failed to read ${path}.`,
        cause,
      })),
    )

    return {
      raw,
      stamp: makeWorkflowStamp(raw),
    }
  })

const parseWorkflowDocument = (path: string, raw: string) =>
  Effect.gen(function* () {
    const split = splitWorkflowDocument(raw)
    const rawConfig = yield* decodeWorkflowFrontMatter(path, split.frontMatter)
    const promptTemplate = split.prompt

    return {
      config: new WorkflowFrontMatter(rawConfig),
      path,
      prompt: promptTemplate,
      promptTemplate,
    } satisfies WorkflowDocument
  })

const decodeWorkflowFrontMatter = (path: string, rawFrontMatter: string) => {
  if (rawFrontMatter.trim().length === 0) {
    return Effect.succeed({} as Readonly<Record<string, unknown>>)
  }

  return Effect.try({
    try: () => parseYaml(rawFrontMatter),
    catch: (cause) => new RepoConfigError({
      code: "workflow-front-matter-invalid",
      message: `Failed to parse YAML front matter in ${path}.`,
      cause,
    }),
  }).pipe(
    Effect.flatMap((decoded) =>
      isWorkflowMap(decoded)
        ? Effect.succeed(decoded)
        : Effect.fail(new RepoConfigError({
            code: "workflow-front-matter-not-map",
            message: `Workflow front matter in ${path} must decode to a YAML map.`,
          }))),
  )
}

const decodeRepoConfig = (frontMatter: WorkflowFrontMatter) =>
  Effect.gen(function* () {
    const agentValue = yield* frontMatter.string("agent", "opencode")
    const agent = agentValue === "codex" ? "codex" : agentValue === "opencode" ? "opencode" : null
    if (agent === null) {
      return yield* Effect.fail(new RepoConfigError({
        code: "workflow-config-invalid",
        message: `Workflow field \"agent\" must be one of: opencode, codex.`,
      }))
    }

    const linearWorkspace = normalizeLinearWorkspace(yield* frontMatter.string("linearWorkspace"))
    const config = new RepoConfigData({
      agent,
      agentArgs: [...(yield* frontMatter.stringArray("agentArgs", []))],
      agentTimeoutMinutes: yield* frontMatter.number("agentTimeoutMinutes", 45),
      baseBranch: (yield* frontMatter.string("baseBranch", "main")) ?? "main",
      branchPrefix: (yield* frontMatter.string("branchPrefix", "orca")) ?? "orca",
      cleanupWorktreeOnSuccess: yield* frontMatter.boolean("cleanupWorktreeOnSuccess", true),
      draftPr: yield* frontMatter.boolean("draftPr", true),
      greptilePollIntervalSeconds: yield* frontMatter.number(
        "greptilePollIntervalSeconds",
        defaultGreptilePollIntervalSeconds,
      ),
      linearLabel: (yield* frontMatter.string("linearLabel", "Orca")) ?? "Orca",
      ...(linearWorkspace === undefined ? {} : { linearWorkspace }),
      maxWaitingPullRequests: yield* frontMatter.number("maxWaitingPullRequests", defaultMaxWaitingPullRequests),
      repo: (yield* frontMatter.string("repo", "owner/name")) ?? "owner/name",
      setup: [...(yield* frontMatter.stringArray("setup", ["bun install"]))],
      stallTimeoutMinutes: yield* frontMatter.number("stallTimeoutMinutes", 10),
      verify: [...(yield* frontMatter.stringArray("verify", []))],
    })

    yield* validateDispatchCriticalConfig(config)
    return config
  })

const validateDispatchCriticalConfig = (config: RepoConfigData) => {
  const problems: Array<string> = []

  if (config.baseBranch.trim().length === 0) {
    problems.push('"baseBranch" must not be blank.')
  }
  if (config.branchPrefix.trim().length === 0) {
    problems.push('"branchPrefix" must not be blank.')
  }
  if (config.linearLabel.trim().length === 0) {
    problems.push('"linearLabel" must not be blank.')
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.repo.trim())) {
    problems.push('"repo" must use owner/name format.')
  }
  if (config.agentTimeoutMinutes <= 0) {
    problems.push('"agentTimeoutMinutes" must be greater than 0.')
  }
  if (config.greptilePollIntervalSeconds <= 0) {
    problems.push('"greptilePollIntervalSeconds" must be greater than 0.')
  }
  if (config.maxWaitingPullRequests <= 0) {
    problems.push('"maxWaitingPullRequests" must be greater than 0.')
  }
  if (config.stallTimeoutMinutes <= 0) {
    problems.push('"stallTimeoutMinutes" must be greater than 0.')
  }
  if (config.setup.some((command) => command.trim().length === 0)) {
    problems.push('"setup" entries must not be blank.')
  }
  if (config.verify.some((command) => command.trim().length === 0)) {
    problems.push('"verify" entries must not be blank.')
  }

  return problems.length === 0
    ? Effect.void
    : Effect.fail(new RepoConfigError({
        code: "workflow-config-validation-failed",
        message: `Invalid workflow config: ${problems.join(" ")}`,
      }))
}

const renderWorkflowDocument = (config: RepoConfigData, promptTemplate: string) => {
  const frontMatter = stringifyYaml(toWorkflowFrontMatter(config)).trimEnd()
  const prompt = promptTemplate.trim()
  return prompt.length === 0
    ? `---\n${frontMatter}\n---\n`
    : `---\n${frontMatter}\n---\n\n${prompt}\n`
}

const toWorkflowFrontMatter = (config: RepoConfigData) => ({
  agent: config.agent,
  "agent-args": config.agentArgs,
  "agent-timeout-minutes": config.agentTimeoutMinutes,
  "base-branch": config.baseBranch,
  "branch-prefix": config.branchPrefix,
  "cleanup-worktree-on-success": config.cleanupWorktreeOnSuccess,
  "draft-pr": config.draftPr,
  "greptile-poll-interval-seconds": config.greptilePollIntervalSeconds,
  "linear-label": config.linearLabel,
  ...(config.linearWorkspace === undefined ? {} : { "linear-workspace": config.linearWorkspace }),
  "max-waiting-pull-requests": config.maxWaitingPullRequests,
  repo: config.repo,
  setup: config.setup,
  "stall-timeout-minutes": config.stallTimeoutMinutes,
  verify: config.verify,
})

const splitWorkflowDocument = (raw: string) => {
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== "---") {
    return {
      frontMatter: "",
      prompt: raw.trim(),
    }
  }

  const delimiterIndex = lines.slice(1).findIndex((line) => line === "---")
  if (delimiterIndex === -1) {
    return {
      frontMatter: lines.slice(1).join("\n"),
      prompt: "",
    }
  }

  const closingLineIndex = delimiterIndex + 1
  return {
    frontMatter: lines.slice(1, closingLineIndex).join("\n"),
    prompt: lines.slice(closingLineIndex + 1).join("\n").trim(),
  }
}

const parseYaml = (raw: string): unknown => {
  const lines = raw.split(/\r?\n/)
  const nextLineIndex = findNextContentLine(lines, 0)
  if (nextLineIndex >= lines.length) {
    return {}
  }

  const indent = indentationOf(lines[nextLineIndex]!)
  if (indent !== 0) {
    throw new Error("yaml front matter must start at indentation 0")
  }

  const parsed = parseYamlBlock(lines, nextLineIndex, indent)
  const trailingContentIndex = findNextContentLine(lines, parsed.nextLineIndex)
  if (trailingContentIndex < lines.length) {
    throw new Error("unexpected trailing yaml content")
  }

  return parsed.value
}

const parseYamlBlock = (
  lines: ReadonlyArray<string>,
  startLineIndex: number,
  indent: number,
): { readonly value: unknown; readonly nextLineIndex: number } => {
  const line = lines[startLineIndex]
  if (line === undefined) {
    return { value: {}, nextLineIndex: startLineIndex }
  }

  return line.slice(indent).startsWith("- ")
    ? parseYamlArray(lines, startLineIndex, indent)
    : parseYamlObject(lines, startLineIndex, indent)
}

const parseYamlObject = (
  lines: ReadonlyArray<string>,
  startLineIndex: number,
  indent: number,
): { readonly value: Record<string, unknown>; readonly nextLineIndex: number } => {
  const value: Record<string, unknown> = {}
  let lineIndex = startLineIndex

  while (lineIndex < lines.length) {
    const nextContentLineIndex = findNextContentLine(lines, lineIndex)
    if (nextContentLineIndex >= lines.length) {
      return { value, nextLineIndex: nextContentLineIndex }
    }

    const line = lines[nextContentLineIndex]!
    const lineIndent = indentationOf(line)
    if (lineIndent < indent) {
      return { value, nextLineIndex: nextContentLineIndex }
    }
    if (lineIndent > indent) {
      throw new Error(`unexpected indentation at line ${nextContentLineIndex + 1}`)
    }

    const content = line.slice(indent)
    if (content.startsWith("- ")) {
      return { value, nextLineIndex: nextContentLineIndex }
    }

    const separatorIndex = content.indexOf(":")
    if (separatorIndex === -1) {
      throw new Error(`invalid yaml mapping at line ${nextContentLineIndex + 1}`)
    }

    const key = content.slice(0, separatorIndex).trim()
    if (key.length === 0) {
      throw new Error(`yaml keys must not be blank at line ${nextContentLineIndex + 1}`)
    }

    const remainder = content.slice(separatorIndex + 1).trim()
    if (remainder.length > 0) {
      value[key] = parseYamlScalar(remainder)
      lineIndex = nextContentLineIndex + 1
      continue
    }

    const childLineIndex = findNextContentLine(lines, nextContentLineIndex + 1)
    if (childLineIndex >= lines.length || indentationOf(lines[childLineIndex]!) <= indent) {
      value[key] = null
      lineIndex = nextContentLineIndex + 1
      continue
    }

    const childIndent = indentationOf(lines[childLineIndex]!)
    const parsedChild = parseYamlBlock(lines, childLineIndex, childIndent)
    value[key] = parsedChild.value
    lineIndex = parsedChild.nextLineIndex
  }

  return { value, nextLineIndex: lineIndex }
}

const parseYamlArray = (
  lines: ReadonlyArray<string>,
  startLineIndex: number,
  indent: number,
): { readonly value: Array<unknown>; readonly nextLineIndex: number } => {
  const value: Array<unknown> = []
  let lineIndex = startLineIndex

  while (lineIndex < lines.length) {
    const nextContentLineIndex = findNextContentLine(lines, lineIndex)
    if (nextContentLineIndex >= lines.length) {
      return { value, nextLineIndex: nextContentLineIndex }
    }

    const line = lines[nextContentLineIndex]!
    const lineIndent = indentationOf(line)
    if (lineIndent < indent) {
      return { value, nextLineIndex: nextContentLineIndex }
    }
    if (lineIndent > indent) {
      throw new Error(`unexpected indentation at line ${nextContentLineIndex + 1}`)
    }

    const content = line.slice(indent)
    if (!content.startsWith("- ")) {
      return { value, nextLineIndex: nextContentLineIndex }
    }

    const remainder = content.slice(2).trim()
    if (remainder.length > 0) {
      value.push(parseYamlScalar(remainder))
      lineIndex = nextContentLineIndex + 1
      continue
    }

    const childLineIndex = findNextContentLine(lines, nextContentLineIndex + 1)
    if (childLineIndex >= lines.length || indentationOf(lines[childLineIndex]!) <= indent) {
      value.push(null)
      lineIndex = nextContentLineIndex + 1
      continue
    }

    const childIndent = indentationOf(lines[childLineIndex]!)
    const parsedChild = parseYamlBlock(lines, childLineIndex, childIndent)
    value.push(parsedChild.value)
    lineIndex = parsedChild.nextLineIndex
  }

  return { value, nextLineIndex: lineIndex }
}

const parseYamlScalar = (raw: string): unknown => {
  if (raw === "true") {
    return true
  }
  if (raw === "false") {
    return false
  }
  if (raw === "null") {
    return null
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw)
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return parseYamlDoubleQuotedString(raw)
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return parseYamlFlowArray(raw)
  }
  return raw
}

const parseYamlDoubleQuotedString = (raw: string) => {
  try {
    return JSON.parse(raw) as string
  } catch (cause) {
    throw new Error(`invalid double-quoted yaml string: ${String(cause)}`)
  }
}

const parseYamlFlowArray = (raw: string): Array<unknown> => {
  const inner = raw.slice(1, -1).trim()
  if (inner.length === 0) {
    return []
  }

  return splitYamlFlowSequenceEntries(inner).map((entry) => parseYamlScalar(entry))
}

const splitYamlFlowSequenceEntries = (raw: string): Array<string> => {
  const entries: Array<string> = []
  let current = ""
  let depth = 0
  let inDoubleQuotes = false
  let inSingleQuotes = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!

    if (inDoubleQuotes) {
      current += character
      if (character === "\\") {
        index += 1
        if (index >= raw.length) {
          throw new Error("unterminated escape sequence in yaml flow array")
        }
        current += raw[index]
        continue
      }
      if (character === '"') {
        inDoubleQuotes = false
      }
      continue
    }

    if (inSingleQuotes) {
      current += character
      if (character === "'") {
        if (raw[index + 1] === "'") {
          current += raw[index + 1]
          index += 1
          continue
        }
        inSingleQuotes = false
      }
      continue
    }

    if (character === '"') {
      inDoubleQuotes = true
      current += character
      continue
    }
    if (character === "'") {
      inSingleQuotes = true
      current += character
      continue
    }
    if (character === "[" || character === "{") {
      depth += 1
      current += character
      continue
    }
    if (character === "]" || character === "}") {
      if (depth === 0) {
        throw new Error("unexpected closing token in yaml flow array")
      }
      depth -= 1
      current += character
      continue
    }
    if (character === "," && depth === 0) {
      const entry = current.trim()
      if (entry.length === 0) {
        throw new Error("yaml flow arrays must not contain empty entries")
      }
      entries.push(entry)
      current = ""
      continue
    }

    current += character
  }

  if (inDoubleQuotes || inSingleQuotes || depth !== 0) {
    throw new Error("unterminated yaml flow array")
  }

  const finalEntry = current.trim()
  if (finalEntry.length > 0) {
    entries.push(finalEntry)
  }
  return entries
}

const stringifyYaml = (value: unknown, indent = 0): string => {
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyYamlArrayEntry(entry, indent)).join("\n")
  }
  if (isWorkflowMap(value)) {
    return Object.entries(value)
      .map(([key, entry]) => stringifyYamlObjectEntry(key, entry, indent))
      .join("\n")
  }
  return `${" ".repeat(indent)}${stringifyYamlScalar(value)}`
}

const stringifyYamlObjectEntry = (key: string, value: unknown, indent: number) => {
  const prefix = `${" ".repeat(indent)}${key}:`
  if (Array.isArray(value) && value.length === 0) {
    return prefix
  }
  if (isYamlComplexValue(value)) {
    return `${prefix}\n${stringifyYaml(value, indent + 2)}`
  }
  return `${prefix} ${stringifyYamlScalar(value)}`
}

const stringifyYamlArrayEntry = (value: unknown, indent: number) => {
  const prefix = `${" ".repeat(indent)}-`
  if (isYamlComplexValue(value)) {
    return `${prefix}\n${stringifyYaml(value, indent + 2)}`
  }
  return `${prefix} ${stringifyYamlScalar(value)}`
}

const stringifyYamlScalar = (value: unknown) => {
  if (value === null) {
    return "null"
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value)
  }
  if (typeof value !== "string") {
    throw new Error(`unsupported yaml scalar: ${String(value)}`)
  }
  return shouldQuoteYamlString(value)
    ? JSON.stringify(value)
    : value
}

const shouldQuoteYamlString = (value: string) =>
  value.length === 0 || /[:#\[\]{}]|^[-?]|^\s|\s$/.test(value)

const isYamlComplexValue = (value: unknown) =>
  Array.isArray(value) || isWorkflowMap(value)

const findNextContentLine = (lines: ReadonlyArray<string>, startLineIndex: number) => {
  let lineIndex = startLineIndex
  while (lineIndex < lines.length) {
    const content = lines[lineIndex]?.trim()
    if (content !== undefined && content.length > 0 && !content.startsWith("#")) {
      return lineIndex
    }
    lineIndex += 1
  }
  return lineIndex
}

const indentationOf = (line: string) => {
  let indentation = 0
  while (indentation < line.length && line[indentation] === " ") {
    indentation += 1
  }
  return indentation
}

const resolveWorkflowPath = () =>
  Effect.sync(() =>
    resolvePathValue(process.env[workflowPathEnvironmentVariable], defaultWorkflowFileName),
  )

const resolvePathValue = (value: string | undefined, defaultValue: string) => {
  const trimmed = value?.trim()
  const resolved = trimmed === undefined || trimmed.length === 0
    ? undefined
    : resolveMaybeEnvReference(trimmed)

  if (typeof resolved === "string" && resolved.trim().length > 0) {
    return resolveAbsolutePath(resolved.trim())
  }

  return resolveAbsolutePath(defaultValue)
}

const resolveMaybeEnvReference = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value
  }

  const envName = parseEnvReference(value.trim())
  if (envName === null) {
    return value
  }

  const envValue = process.env[envName]?.trim()
  return envValue === undefined || envValue.length === 0 ? undefined : envValue
}

const parseEnvReference = (value: string) =>
  /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? value.slice(1)
    : null

const resolveOptionalPath = (value: string | undefined) =>
  value === undefined ? undefined : resolveAbsolutePath(value)

const resolveAbsolutePath = (value: string) =>
  resolvePath(expandHomeDirectory(value))

const expandHomeDirectory = (value: string) => {
  if (value === "~") {
    return homedir()
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${homedir()}${value.slice(1)}`
  }
  return value
}

const lookupFrontMatterValue = (raw: Readonly<Record<string, unknown>>, key: string) => {
  const candidates = new Set([key, toCamelCase(key), toKebabCase(key)])
  for (const candidate of candidates) {
    if (candidate in raw) {
      return raw[candidate]
    }
  }
  return undefined
}

const toCamelCase = (value: string) =>
  value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())

const toKebabCase = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()

const invalidWorkflowValue = (key: string, expected: string, actual: unknown) =>
  Effect.fail(new RepoConfigError({
    code: "workflow-config-invalid",
    message: `Workflow field \"${key}\" must be ${expected}. Received ${formatWorkflowValue(actual)}.`,
  }))

const formatWorkflowValue = (value: unknown) => {
  if (value === null) {
    return "null"
  }
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

const isWorkflowMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const makeWorkflowStamp = (raw: string): WorkflowStamp => ({
  hash: hashString(raw),
  size: raw.length,
})

const workflowStampEquals = (left: WorkflowStamp, right: WorkflowStamp) =>
  left.hash === right.hash && left.size === right.size

const hashString = (value: string) => {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

const logInvalidReload = (path: string, error: RepoConfigError) =>
  Effect.logWarning(
    `Failed to reload workflow at ${path}: ${error.message}. Keeping the last known good configuration.`,
  )

const normalizeLinearWorkspace = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 ? normalized : undefined
}

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
