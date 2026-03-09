import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Sink, Stream } from "effect"
import type { Command as ChildProcessCommand } from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worktree, WorktreeError, WorktreeLayer, slugifyIssueTitle } from "./worktree.ts"

describe("Worktree", () => {
  it.effect("fetches the latest remote base branch before creating a worktree", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        const issueIdentifier = "PET-25"
        const issueTitle = "Create worktrees from latest origin base branch"
        const worktreeName = `${issueIdentifier}-${slugifyIssueTitle(issueTitle)}`
        const branch = `orca/${worktreeName}`
        const commands: Array<string> = []

        const managed = yield* createWorktree({
          baseBranch: "main",
          issueIdentifier,
          issueTitle,
        }, {
          exitCode: (command) => {
            commands.push(command.shellCommand)

            if (command.shellCommand === `git fetch origin ${shellQuote(`+refs/heads/main:refs/remotes/origin/main`)}`) {
              return 0
            }

            if (command.shellCommand === `git show-ref --verify --quiet ${shellQuote("refs/remotes/origin/main")}`) {
              return 0
            }

            if (command.shellCommand === `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`) {
              return 1
            }

            if (command.shellCommand.startsWith(`git worktree add -b ${shellQuote(branch)} `) && command.shellCommand.endsWith(` ${shellQuote("origin/main")}`)) {
              return 0
            }

            if (command.shellCommand.startsWith("git worktree remove --force ")) {
              return 0
            }

            throw new Error(`Unexpected command: ${command.shellCommand}`)
          },
        })

        expect(managed.branch).toBe(branch)
        expect(managed.directory.endsWith(`/.orca/worktrees/${worktreeName}`)).toBe(true)
        expect(commands.slice(0, 4)).toEqual([
          `git fetch origin ${shellQuote(`+refs/heads/main:refs/remotes/origin/main`)}`,
          `git show-ref --verify --quiet ${shellQuote("refs/remotes/origin/main")}`,
          `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
          `git worktree add -b ${shellQuote(branch)} ${shellQuote(managed.directory)} ${shellQuote("origin/main")}`,
        ])
      }),
    ))

  it.effect("supports non-main configured base branches", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        const issueIdentifier = "PET-25"
        const issueTitle = "Create worktrees from latest origin base branch"
        const worktreeName = `${issueIdentifier}-${slugifyIssueTitle(issueTitle)}`
        const branch = `orca/${worktreeName}`
        const commands: Array<string> = []
        const baseBranch = "release/2026-q1"

        yield* createWorktree({
          baseBranch,
          issueIdentifier,
          issueTitle,
        }, {
          exitCode: (command) => {
            commands.push(command.shellCommand)

            if (command.shellCommand === `git fetch origin ${shellQuote(`+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`)}`) {
              return 0
            }

            if (command.shellCommand === `git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${baseBranch}`)}`) {
              return 0
            }

            if (command.shellCommand === `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`) {
              return 1
            }

            if (command.shellCommand.startsWith(`git worktree add -b ${shellQuote(branch)} `) && command.shellCommand.endsWith(` ${shellQuote(`origin/${baseBranch}`)}`)) {
              return 0
            }

            if (command.shellCommand.startsWith("git worktree remove --force ")) {
              return 0
            }

            throw new Error(`Unexpected command: ${command.shellCommand}`)
          },
        })

        expect(commands[0]).toBe(`git fetch origin ${shellQuote(`+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`)}`)
        expect(commands[1]).toBe(`git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${baseBranch}`)}`)
        expect(commands[2]).toBe(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`)
        expect(commands[3]).toMatch(new RegExp(`${escapeRegExp(shellQuote(`origin/${baseBranch}`))}$`))
      }),
    ))

  it.effect("fails with a clear error when fetching the remote base branch fails", () =>
    withTempCwd(() =>
      Effect.gen(function* () {
        const error = yield* createWorktree({
          baseBranch: "missing",
          issueIdentifier: "PET-25",
          issueTitle: "Create worktrees from latest origin base branch",
        }, {
          exitCode: () => 1,
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(WorktreeError)
        expect(error.message).toBe("Failed to fetch remote base branch origin/missing.")
      }),
    ))
})

const createWorktree = (
  options: {
    readonly baseBranch: string
    readonly issueIdentifier: string
    readonly issueTitle: string
  },
  spawnerOptions: {
    readonly exitCode: (command: CommandInvocation) => number
  },
) =>
  Effect.gen(function* () {
    const worktree = yield* Worktree
    return yield* worktree.create({
      baseBranch: options.baseBranch,
      branchPrefix: "orca",
      issueIdentifier: options.issueIdentifier,
      issueTitle: options.issueTitle,
      setup: [],
    })
  }).pipe(Effect.provide(makeWorktreeLayer(spawnerOptions)))

const makeWorktreeLayer = (spawnerOptions: {
  readonly exitCode: (command: CommandInvocation) => number
}) =>
  WorktreeLayer.pipe(
    Layer.provide(Layer.mergeAll(
      Path.layer,
      Layer.succeed(FileSystem.FileSystem, makeTestFileSystem() as unknown as FileSystem.FileSystem),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeTestChildProcessSpawner(spawnerOptions)),
    )),
  )

const makeTestFileSystem = () => ({
  exists: (path: string) => Effect.sync(() => existsSync(path)),
  makeDirectory: (path: string, options?: { readonly recursive?: boolean | undefined }) =>
    Effect.sync(() => {
      mkdirSync(path, { recursive: options?.recursive ?? false })
    }),
})

type CommandInvocation = {
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly shellCommand: string
}

const makeTestChildProcessSpawner = (options: {
  readonly exitCode: (command: CommandInvocation) => number
}) =>
  ChildProcessSpawner.make((command: ChildProcessCommand) => {
    const invocation = toCommandInvocation(command)

    return Effect.succeed(ChildProcessSpawner.makeHandle({
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode(invocation))),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(1),
      stderr: Stream.empty,
      stdin: Sink.drain,
      stdout: Stream.empty,
    }))
  })

const toCommandInvocation = (command: ChildProcessCommand): CommandInvocation => {
  if (command._tag !== "StandardCommand") {
    throw new Error(`Unexpected command type: ${command._tag}`)
  }

  return {
    args: command.args,
    command: command.command,
    shellCommand: command.command === "/bin/bash" && command.args[0] === "-lc"
      ? (command.args[1] ?? "")
      : [command.command, ...command.args].join(" "),
  }
}

const withTempCwd = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previousCwd = process.cwd()
      const tempDirectory = mkdtempSync(join(tmpdir(), "orca-worktree-"))
      process.chdir(tempDirectory)
      return { previousCwd, tempDirectory }
    }),
    ({ previousCwd, tempDirectory }) =>
      Effect.sync(() => {
        process.chdir(previousCwd)
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(({ tempDirectory }) => use(tempDirectory)))

const shellQuote = (value: string) => `'${value.replace(/'/g, `"'"'`)}'`

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
