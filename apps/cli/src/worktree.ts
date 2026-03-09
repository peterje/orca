import { Data, Effect, FileSystem, Layer, Path, ServiceMap } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { resolveOrcaDirectory } from "./orca-directory.ts"
import { makeShellCommand } from "./shared/shell.ts"

export type ManagedWorktree = {
  readonly branch: string
  readonly directory: string
  readonly remove: Effect.Effect<void, WorktreeError>
  readonly run: (command: string, options?: { readonly env?: Record<string, string> | undefined }) => Effect.Effect<number, WorktreeError>
  readonly runString: (command: string, options?: { readonly env?: Record<string, string> | undefined }) => Effect.Effect<string, WorktreeError>
}

export type WorktreeService = {
  create: (options: {
    readonly baseBranch: string
    readonly branchPrefix: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly setup: ReadonlyArray<string>
  }) => Effect.Effect<ManagedWorktree, WorktreeError>
  resume: (options: {
    readonly branch: string
    readonly setup: ReadonlyArray<string>
  }) => Effect.Effect<ManagedWorktree, WorktreeError>
}

export const Worktree = ServiceMap.Service<WorktreeService>("orca/Worktree")

export const WorktreeLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const repoRoot = process.cwd()
  const orcaDirectory = yield* resolveOrcaDirectory()
  const worktreesRoot = path.join(orcaDirectory, "worktrees")

  const create = (options: {
    readonly baseBranch: string
    readonly branchPrefix: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly setup: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(worktreesRoot, { recursive: true }).pipe(
        Effect.mapError((cause) => new WorktreeError({ message: `Failed to create ${worktreesRoot}.`, cause })),
      )

      const startPoint = yield* ensureRemoteBaseBranch({
        baseBranch: options.baseBranch,
        repoRoot,
        spawner,
      })

      const { branch, directory } = yield* allocateCandidate({
        baseDirectory: worktreesRoot,
        baseName: makeIssueName(options.issueIdentifier, options.issueTitle),
        branchPrefix: options.branchPrefix,
        fs,
        path,
        repoRoot,
        spawner,
      })

      const addExitCode = yield* spawner.exitCode(
        makeShellCommand({
          command: `git worktree add -b ${shellQuote(branch)} ${shellQuote(directory)} ${shellQuote(startPoint)}`,
          cwd: repoRoot,
        }),
      ).pipe(
        Effect.mapError((cause) => new WorktreeError({ message: `Failed to create worktree ${directory}.`, cause })),
      )

      if (addExitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeError({ message: `git worktree add exited with status ${addExitCode}.` }),
        )
      }

      const managed = makeManagedWorktree({ branch, directory, repoRoot, spawner })
      yield* runSetup(managed, options.setup)

      return managed
    })

  const resume = (options: {
    readonly branch: string
    readonly setup: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(worktreesRoot, { recursive: true }).pipe(
        Effect.mapError((cause) => new WorktreeError({ message: `Failed to create ${worktreesRoot}.`, cause })),
      )

      yield* ensureLocalBranch({ branch: options.branch, repoRoot, spawner })

      const directory = yield* allocateResumeDirectory({
        baseDirectory: worktreesRoot,
        branch: options.branch,
        fs,
        path,
      })

      const addExitCode = yield* spawner.exitCode(
        makeShellCommand({
          command: `git worktree add ${shellQuote(directory)} ${shellQuote(options.branch)}`,
          cwd: repoRoot,
        }),
      ).pipe(
        Effect.mapError((cause) => new WorktreeError({ message: `Failed to resume worktree ${directory}.`, cause })),
      )

      if (addExitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeError({ message: `git worktree add exited with status ${addExitCode}.` }),
        )
      }

      const managed = makeManagedWorktree({ branch: options.branch, directory, repoRoot, spawner })
      yield* runSetup(managed, options.setup)

      return managed
    })

  return Worktree.of({ create, resume })
})

export const WorktreeLayer = Layer.effect(Worktree, WorktreeLive)

export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const slugifyIssueTitle = (title: string) => {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  const slug = normalized.length > 0 ? normalized : "issue"
  return slug.slice(0, 48).replace(/-+$/g, "") || "issue"
}

const makeIssueName = (identifier: string, title: string) => `${identifier}-${slugifyIssueTitle(title)}`

const makeBranchWorktreeName = (branch: string) => slugifyIssueTitle(branch.replace(/\//g, "-"))

export const makeRemoteBaseRef = (baseBranch: string) => `origin/${baseBranch}`

const makeRemoteBranchRef = (baseBranch: string) => `refs/heads/${baseBranch}`

const makeRemoteTrackingRef = (baseBranch: string) => `refs/remotes/origin/${baseBranch}`

const allocateCandidate = (options: {
  readonly baseDirectory: string
  readonly baseName: string
  readonly branchPrefix: string
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly repoRoot: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}) =>
  Effect.gen(function* () {
    for (let index = 1; index < 1_000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`
      const name = `${options.baseName}${suffix}`
      const directory = options.path.join(options.baseDirectory, name)
      const branch = `${options.branchPrefix}/${name}`
      const dirExists = yield* options.fs.exists(directory).pipe(Effect.orElseSucceed(() => false))
      if (dirExists) {
        continue
      }
      const branchExists = yield* options.spawner.exitCode(
        makeShellCommand({
          command: `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
          cwd: options.repoRoot,
        }),
      ).pipe(Effect.orElseSucceed(() => 1))
      if (branchExists === 0) {
        continue
      }
      return { branch, directory }
    }

    return yield* Effect.fail(new WorktreeError({ message: "Failed to allocate a unique Orca worktree." }))
  })

const allocateResumeDirectory = (options: {
  readonly baseDirectory: string
  readonly branch: string
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
}) =>
  Effect.gen(function* () {
    const baseName = makeBranchWorktreeName(options.branch)
    for (let index = 1; index < 1_000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`
      const directory = options.path.join(options.baseDirectory, `${baseName}${suffix}`)
      const exists = yield* options.fs.exists(directory).pipe(Effect.orElseSucceed(() => false))
      if (!exists) {
        return directory
      }
    }

    return yield* Effect.fail(new WorktreeError({ message: `Failed to allocate a worktree for ${options.branch}.` }))
  })

const ensureLocalBranch = (options: {
  readonly branch: string
  readonly repoRoot: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}) =>
  Effect.gen(function* () {
    const branchExists = yield* options.spawner.exitCode(
      makeShellCommand({
        command: `git show-ref --verify --quiet ${shellQuote(`refs/heads/${options.branch}`)}`,
        cwd: options.repoRoot,
      }),
    ).pipe(Effect.orElseSucceed(() => 1))
    if (branchExists === 0) {
      return
    }

    const fetchExitCode = yield* options.spawner.exitCode(
      makeShellCommand({
        command: `git fetch origin ${shellQuote(`refs/heads/${options.branch}:refs/heads/${options.branch}`)}`,
        cwd: options.repoRoot,
      }),
    ).pipe(
      Effect.mapError((cause) => new WorktreeError({ message: `Failed to fetch branch ${options.branch}.`, cause })),
    )
    if (fetchExitCode !== 0) {
      return yield* Effect.fail(
        new WorktreeError({ message: `Failed to fetch branch ${options.branch} from origin.` }),
      )
    }
  })

const ensureRemoteBaseBranch = (options: {
  readonly baseBranch: string
  readonly repoRoot: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}) =>
  Effect.gen(function* () {
    const remoteBaseRef = makeRemoteBaseRef(options.baseBranch)
    const remoteTrackingRef = makeRemoteTrackingRef(options.baseBranch)
    const fetchExitCode = yield* options.spawner.exitCode(
      makeShellCommand({
        command: `git fetch origin ${shellQuote(`+${makeRemoteBranchRef(options.baseBranch)}:${remoteTrackingRef}`)}`,
        cwd: options.repoRoot,
      }),
    ).pipe(
      Effect.mapError((cause) => new WorktreeError({ message: `Failed to fetch remote base branch ${remoteBaseRef}.`, cause })),
    )
    if (fetchExitCode !== 0) {
      return yield* Effect.fail(
        new WorktreeError({ message: `Failed to fetch remote base branch ${remoteBaseRef}.` }),
      )
    }

    const remoteBranchExists = yield* options.spawner.exitCode(
      makeShellCommand({
        command: `git show-ref --verify --quiet ${shellQuote(remoteTrackingRef)}`,
        cwd: options.repoRoot,
      }),
    ).pipe(
      Effect.mapError((cause) => new WorktreeError({ message: `Failed to verify remote base branch ${remoteBaseRef}.`, cause })),
    )
    if (remoteBranchExists !== 0) {
      return yield* Effect.fail(
        new WorktreeError({ message: `Remote base branch ${remoteBaseRef} is not available after fetch.` }),
      )
    }

    return remoteBaseRef
  })

const runSetup = (managed: ManagedWorktree, commands: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const command of commands) {
      const exitCode = yield* managed.run(command)
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeError({ message: `Setup command failed: ${command}` }),
        )
      }
    }
  })

const makeManagedWorktree = (options: {
  readonly branch: string
  readonly directory: string
  readonly repoRoot: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}): ManagedWorktree => ({
  branch: options.branch,
  directory: options.directory,
  remove: options.spawner.exitCode(
    makeShellCommand({
      command: `git worktree remove --force ${shellQuote(options.directory)}`,
      cwd: options.repoRoot,
    }),
  ).pipe(
    Effect.mapError((cause) => new WorktreeError({ message: `Failed to remove ${options.directory}.`, cause })),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(new WorktreeError({ message: `git worktree remove exited with status ${exitCode}.` }))),
  ),
  run: (command, runOptions) =>
    options.spawner.exitCode(
      makeShellCommand({
        command,
        cwd: options.directory,
        env: runOptions?.env,
        stderr: "inherit",
        stdout: "inherit",
      }),
    ).pipe(
      Effect.mapError((cause) => new WorktreeError({ message: `Failed to run command in ${options.directory}.`, cause })),
    ),
  runString: (command, runOptions) =>
    options.spawner.string(
      makeShellCommand({
        command,
        cwd: options.directory,
        env: runOptions?.env,
      }),
      { includeStderr: true },
    ).pipe(
      Effect.mapError((cause) => new WorktreeError({ message: `Failed to capture command output in ${options.directory}.`, cause })),
    ),
})

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
