import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  defaultGreptilePollIntervalSeconds,
  defaultMaxWaitingPullRequests,
  defaultWorkflowFileName,
  RepoConfig,
  RepoConfigData,
  RepoConfigError,
  RepoConfigLayer,
  workflowPathEnvironmentVariable,
  WorkflowFrontMatter,
} from "./repo-config.ts"

const makeTestFileSystem = () => ({
  exists: (path: string) => Effect.sync(() => existsSync(path)),
  makeDirectory: (path: string, options?: { readonly recursive?: boolean | undefined }) =>
    Effect.sync(() => {
      mkdirSync(path, { recursive: options?.recursive ?? false })
    }),
  readFileString: (path: string) => Effect.sync(() => readFileSync(path, "utf8")),
  writeFileString: (path: string, data: string) =>
    Effect.sync(() => {
      writeFileSync(path, data)
    }),
})

const makeTestPlatformLayer = (fileSystem = makeTestFileSystem() as unknown as FileSystem.FileSystem) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("not used in this test")),
    ),
  )

const makeRepoConfigLayer = (fileSystem = makeTestFileSystem() as unknown as FileSystem.FileSystem) =>
  RepoConfigLayer.pipe(Layer.provide(makeTestPlatformLayer(fileSystem)))

const repoConfigLayer = makeRepoConfigLayer()

describe("RepoConfig", () => {
  it.effect("bootstraps a workflow scaffold with repo defaults", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.bootstrap({
          baseBranch: "main",
          linearWorkspace: "  PeterEdm ",
          repo: "peterje/orca",
        })
        const workflow = yield* repoConfig.document
        const workflowContent = readFileSync(join(tempDirectory, defaultWorkflowFileName), "utf8")

        expect(config.greptilePollIntervalSeconds).toBe(defaultGreptilePollIntervalSeconds)
        expect(config.linearWorkspace).toBe("peteredm")
        expect(config.maxWaitingPullRequests).toBe(defaultMaxWaitingPullRequests)
        expect(workflow.path).toBe(realpathSync(join(tempDirectory, defaultWorkflowFileName)))
        expect(workflow.prompt).toContain("You are working on the current Orca issue")
        expect(workflowContent).toContain("linear-workspace: peteredm")
        expect(workflowContent).toContain("agent-args:\nagent-timeout-minutes: 45")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("prefers the explicit workflow path over the cwd default", () =>
    withTempCwd((tempDirectory) =>
      withEnv(
        {
          ORCA_CUSTOM_WORKFLOW: "./config/custom-workflow.md",
          [workflowPathEnvironmentVariable]: "$ORCA_CUSTOM_WORKFLOW",
        },
        Effect.gen(function* () {
          writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
            frontMatter: 'linear-label: Default\nrepo: owner/default',
            prompt: "Default workflow",
          })
          writeWorkflowFile(join(tempDirectory, "config", "custom-workflow.md"), {
            frontMatter: 'linear-label: Custom\nrepo: owner/custom',
            prompt: "Custom workflow",
          })

          const repoConfig = yield* RepoConfig
          const configPath = yield* repoConfig.configPath
          const config = yield* repoConfig.read

          expect(configPath).toBe(realpathSync(join(tempDirectory, "config", "custom-workflow.md")))
          expect(config.linearLabel).toBe("Custom")
          expect(config.repo).toBe("owner/custom")
        }).pipe(Effect.provide(repoConfigLayer)),
      ),
    ))

  it.effect("parses prompt-only workflow files and falls back to defaults", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeFileSync(join(tempDirectory, defaultWorkflowFileName), "Prompt only\n")

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document
        const config = yield* repoConfig.read

        expect(workflow.promptTemplate).toBe("Prompt only")
        expect(workflow.prompt).toBe("Prompt only")
        expect(config.linearLabel).toBe("Orca")
        expect(config.repo).toBe("owner/name")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("parses flow-style yaml arrays in front matter", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            'agent-args: ["--model", "gpt-5",]',
            'setup: ["bun install", "bun run check",]',
            "repo: owner/name",
          ].join("\n"),
          prompt: "Flow arrays should parse",
        })

        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.read

        expect(config.agentArgs).toEqual(["--model", "gpt-5"])
        expect(config.setup).toEqual(["bun install", "bun run check"])
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("preserves quoted whitespace inside string arrays", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            'verify: ["  bun run check  ", "bun run test"]',
            "repo: owner/name",
          ].join("\n"),
          prompt: "Quoted command whitespace should be preserved",
        })

        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.read

        expect(config.verify).toEqual(["  bun run check  ", "bun run test"])
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("ignores unknown top-level front matter keys", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            "linear-label: Autowrite",
            "repo: owner/name",
            "future-setting:",
            "  nested: true",
          ].join("\n"),
          prompt: "Unknown keys should be ignored",
        })

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document
        const config = yield* repoConfig.read

        expect(config.linearLabel).toBe("Autowrite")
        expect(workflow.config.raw["future-setting"]).toEqual({ nested: true })
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("rejects non-map yaml front matter with a typed error", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "- not-a-map",
          prompt: "Prompt body",
        })

        const repoConfig = yield* RepoConfig
        const error = yield* repoConfig.document.pipe(Effect.flip)

        expect(error).toBeInstanceOf(RepoConfigError)
        expect(error.code).toBe("workflow-front-matter-not-map")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("keeps the last known good config on invalid reloads and updates on the next valid reload", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "linear-label: Orca\nrepo: owner/name",
          prompt: "Initial workflow",
        })

        const repoConfig = yield* RepoConfig
        const initial = yield* repoConfig.read

        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "- broken",
          prompt: "Broken workflow",
        })

        const afterInvalidReload = yield* repoConfig.read

        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "linear-label: Autowrite\nrepo: owner/name",
          prompt: "Updated workflow",
        })

        const afterValidReload = yield* repoConfig.read

        expect(initial.linearLabel).toBe("Orca")
        expect(afterInvalidReload.linearLabel).toBe("Orca")
        expect(afterValidReload.linearLabel).toBe("Autowrite")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("writes to the latest workflow path after env changes while waiting on refresh", () =>
    withTempCwd((tempDirectory) =>
      withEnv(
        { [workflowPathEnvironmentVariable]: `./${defaultWorkflowFileName}` },
        (() => {
          const firstPath = join(tempDirectory, defaultWorkflowFileName)
          const secondPath = join(tempDirectory, "config", "custom-workflow.md")
          const readStarted = makeSignal()
          const releaseRead = makeSignal()
          let shouldBlockNextRead = true

          const instrumentedFileSystem = {
            ...makeTestFileSystem(),
            readFileString: (path: string) =>
              shouldBlockNextRead
                ? Effect.gen(function* () {
                    shouldBlockNextRead = false
                    readStarted.resolve()
                    yield* Effect.promise(() => releaseRead.promise)
                    return readFileSync(path, "utf8")
                  })
                : Effect.sync(() => readFileSync(path, "utf8")),
          } as unknown as FileSystem.FileSystem

          return Effect.gen(function* () {
            writeWorkflowFile(firstPath, {
              frontMatter: "linear-label: First\nrepo: owner/first",
              prompt: "First prompt",
            })
            writeWorkflowFile(secondPath, {
              frontMatter: "linear-label: Second\nrepo: owner/second",
              prompt: "Second prompt",
            })

            const repoConfig = yield* RepoConfig

            yield* Effect.all([
              repoConfig.read,
              Effect.promise(() => readStarted.promise).pipe(
                Effect.tap(() => Effect.sync(() => {
                  process.env[workflowPathEnvironmentVariable] = "./config/custom-workflow.md"
                  releaseRead.resolve()
                })),
                Effect.flatMap(() => repoConfig.write(new RepoConfigData({
                  agent: "opencode",
                  agentArgs: [],
                  agentTimeoutMinutes: 45,
                  baseBranch: "main",
                  branchPrefix: "orca",
                  cleanupWorktreeOnSuccess: true,
                  draftPr: true,
                  greptilePollIntervalSeconds: defaultGreptilePollIntervalSeconds,
                  linearLabel: "Updated",
                  maxWaitingPullRequests: defaultMaxWaitingPullRequests,
                  repo: "owner/updated",
                  setup: ["bun install"],
                  stallTimeoutMinutes: 10,
                  verify: [],
                }))),
              ),
            ], { concurrency: "unbounded" })

            const workflow = yield* repoConfig.document
            const config = yield* repoConfig.read

            expect(workflow.path).toBe(realpathSync(secondPath))
            expect(workflow.promptTemplate).toBe("Second prompt")
            expect(config.linearLabel).toBe("Updated")
            expect(config.repo).toBe("owner/updated")
            expect(readFileSync(firstPath, "utf8")).toContain("linear-label: First")
            expect(readFileSync(secondPath, "utf8")).toContain("linear-label: Updated")
            expect(readFileSync(secondPath, "utf8")).toContain("Second prompt")
          }).pipe(Effect.provide(makeRepoConfigLayer(instrumentedFileSystem)))
        })(),
      ),
    ))

  it.effect("preserves the existing prompt template when writing with a cold cache", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "linear-label: Orca\nrepo: owner/name",
          prompt: "Keep this repo-owned prompt",
        })

        const repoConfig = yield* RepoConfig
        yield* repoConfig.write(new RepoConfigData({
          agent: "opencode",
          agentArgs: [],
          agentTimeoutMinutes: 45,
          baseBranch: "main",
          branchPrefix: "orca",
          cleanupWorktreeOnSuccess: true,
          draftPr: true,
          greptilePollIntervalSeconds: defaultGreptilePollIntervalSeconds,
          linearLabel: "Autowrite",
          maxWaitingPullRequests: defaultMaxWaitingPullRequests,
          repo: "owner/name",
          setup: ["bun install"],
          stallTimeoutMinutes: 10,
          verify: ["bun run check"],
        }))

        const workflow = yield* repoConfig.document
        const workflowContent = readFileSync(join(tempDirectory, defaultWorkflowFileName), "utf8")

        expect(workflow.promptTemplate).toBe("Keep this repo-owned prompt")
        expect(workflow.prompt).toBe("Keep this repo-owned prompt")
        expect(workflowContent).toContain("Keep this repo-owned prompt")
        expect(workflowContent).toContain("linear-label: Autowrite")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("serializes concurrent refreshes across document and read", () =>
    withTempCwd((tempDirectory) => {
      let activeReads = 0
      let maxActiveReads = 0

      const instrumentedFileSystem = {
        ...makeTestFileSystem(),
        readFileString: (path: string) =>
          Effect.gen(function* () {
            activeReads += 1
            maxActiveReads = Math.max(maxActiveReads, activeReads)
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)))
            return readFileSync(path, "utf8")
          }).pipe(
            Effect.ensuring(Effect.sync(() => {
              activeReads -= 1
            })),
          ),
      } as unknown as FileSystem.FileSystem

      return Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "linear-label: Orca\nrepo: owner/name",
          prompt: "Concurrent workflow",
        })

        const repoConfig = yield* RepoConfig
        const [workflow, config] = yield* Effect.all([repoConfig.document, repoConfig.read], { concurrency: "unbounded" })

        expect(workflow.prompt).toBe("Concurrent workflow")
        expect(config.linearLabel).toBe("Orca")
        expect(maxActiveReads).toBe(1)
      }).pipe(Effect.provide(makeRepoConfigLayer(instrumentedFileSystem)))
    }))

  it.effect("serializes workflow writes against concurrent refreshes", () =>
    withTempCwd((tempDirectory) => {
      let activeOperations = 0
      let maxActiveOperations = 0
      const writeStarted = makeSignal()

      const instrumentedFileSystem = {
        ...makeTestFileSystem(),
        readFileString: (path: string) =>
          Effect.gen(function* () {
            activeOperations += 1
            maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
            const snapshot = readFileSync(path, "utf8")
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
            return snapshot
          }).pipe(
            Effect.ensuring(Effect.sync(() => {
              activeOperations -= 1
            })),
          ),
        writeFileString: (path: string, data: string) =>
          Effect.gen(function* () {
            activeOperations += 1
            maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
            writeStarted.resolve()
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
            writeFileSync(path, data)
          }).pipe(
            Effect.ensuring(Effect.sync(() => {
              activeOperations -= 1
            })),
          ),
      } as unknown as FileSystem.FileSystem

      return Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: "linear-label: Orca\nrepo: owner/name",
          prompt: "Concurrent workflow",
        })

        const repoConfig = yield* RepoConfig
        const currentConfig = yield* repoConfig.read

        const [, concurrentRead] = yield* Effect.all([
          repoConfig.write(new RepoConfigData({
            ...currentConfig,
            linearLabel: "Autowrite",
          })),
          Effect.promise(() => writeStarted.promise).pipe(Effect.flatMap(() => repoConfig.read)),
        ], { concurrency: "unbounded" })

        const workflow = yield* repoConfig.document

        expect(concurrentRead.linearLabel).toBe("Autowrite")
        expect(workflow.promptTemplate).toBe("Concurrent workflow")
        expect(maxActiveOperations).toBe(1)
      }).pipe(Effect.provide(makeRepoConfigLayer(instrumentedFileSystem)))
    }))

  it.effect("rejects blank agent args entries during workflow validation", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: 'agent-args: ["--model", ""]\nrepo: owner/name',
          prompt: "Blank agent args should fail validation",
        })

        const repoConfig = yield* RepoConfig
        const error = yield* repoConfig.read.pipe(Effect.flip)

        expect(error).toBeInstanceOf(RepoConfigError)
        expect(error.code).toBe("workflow-config-validation-failed")
        expect(error.message).toContain('"agentArgs" entries must not be blank or contain newlines.')
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("rejects embedded newlines in agent args, setup, and verify entries during workflow validation", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            'agent-args: ["--prompt\\ncontinue"]',
            'setup: ["bun install\\n bun run check"]',
            'verify: ["bun run check\\n bun run test"]',
            "repo: owner/name",
          ].join("\n"),
          prompt: "Command strings should stay single-line",
        })

        const repoConfig = yield* RepoConfig
        const error = yield* repoConfig.read.pipe(Effect.flip)

        expect(error).toBeInstanceOf(RepoConfigError)
        expect(error.code).toBe("workflow-config-validation-failed")
        expect(error.message).toContain('"agentArgs" entries must not be blank or contain newlines.')
        expect(error.message).toContain('"setup" entries must not be blank or contain newlines.')
        expect(error.message).toContain('"verify" entries must not be blank or contain newlines.')
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("rejects writing newline-containing commands without mutating the workflow file", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        const workflowPath = join(tempDirectory, defaultWorkflowFileName)
        writeWorkflowFile(workflowPath, {
          frontMatter: [
            "repo: owner/name",
            'setup: ["bun install"]',
          ].join("\n"),
          prompt: "Keep this workflow intact",
        })

        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.read
        const initialWorkflowContent = readFileSync(workflowPath, "utf8")

        const error = yield* repoConfig.write(new RepoConfigData({
          ...config,
          setup: ["bun install\n bun run check"],
        })).pipe(Effect.flip)

        expect(error).toBeInstanceOf(RepoConfigError)
        expect(error.code).toBe("workflow-config-validation-failed")
        expect(error.message).toContain('"setup" entries must not be blank or contain newlines.')
        expect(readFileSync(workflowPath, "utf8")).toBe(initialWorkflowContent)
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("workflow front matter getters resolve defaults, env indirection, and home-relative paths", () =>
    withEnv(
      {
        ORCA_FRONT_MATTER_DRAFT_PR: "false",
        ORCA_FRONT_MATTER_WORKSPACE_ROOT: "~/orca-workspaces",
      },
      Effect.gen(function* () {
        const frontMatter = new WorkflowFrontMatter({
          "draft-pr": "$ORCA_FRONT_MATTER_DRAFT_PR",
          "workspace-root": "$ORCA_FRONT_MATTER_WORKSPACE_ROOT",
        })

        expect(yield* frontMatter.boolean("draftPr", true)).toBe(false)
        expect(yield* frontMatter.number("greptilePollIntervalSeconds", 30)).toBe(30)
        expect(yield* frontMatter.path("workspaceRoot", "./fallback-workspaces")).toBe(
          resolve(homedir(), "orca-workspaces"),
        )
      }),
    ))

  it.effect("parses double-quoted yaml escape sequences in unknown workflow fields", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            'future-setting: "hello\\nworld"',
            'future-list: ["bun run check\\n bun run test"]',
            "repo: owner/name",
          ].join("\n"),
          prompt: "Escaped values should round-trip",
        })

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document

        expect(workflow.config.raw["future-setting"]).toBe("hello\nworld")
        expect(workflow.config.raw["future-list"]).toEqual(["bun run check\n bun run test"])
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("parses quoted yaml keys containing colons in unknown workflow fields", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            '"https://example.com/workflow": true',
            "'scope:setting': value",
            "repo: owner/name",
          ].join("\n"),
          prompt: "Quoted keys should parse",
        })

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document

        expect(workflow.config.raw["https://example.com/workflow"]).toBe(true)
        expect(workflow.config.raw["scope:setting"]).toBe("value")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("strips inline yaml comments without touching quoted values", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            "agent: opencode # keep the default agent",
            "agent-timeout-minutes: 45 # default timeout",
            "draft-pr: false # open a ready review",
            'linear-label: "Orca # triage" # keep the hash in the value',
            'verify: ["bun run check", "bun run test"] # required checks',
            "repo: owner/name # fixture repo",
          ].join("\n"),
          prompt: "Inline comments should parse",
        })

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document
        const config = yield* repoConfig.read

        expect(config.agent).toBe("opencode")
        expect(config.agentTimeoutMinutes).toBe(45)
        expect(config.draftPr).toBe(false)
        expect(config.verify).toEqual(["bun run check", "bun run test"])
        expect(workflow.config.raw["linear-label"]).toBe("Orca # triage")
      }).pipe(Effect.provide(repoConfigLayer)),
    ))
})

const withTempCwd = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previousCwd = process.cwd()
      const tempDirectory = mkdtempSync(join(tmpdir(), "orca-repo-config-"))
      process.chdir(tempDirectory)
      return { previousCwd, tempDirectory }
    }),
    ({ previousCwd, tempDirectory }) =>
      Effect.sync(() => {
        process.chdir(previousCwd)
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(({ tempDirectory }) => use(tempDirectory)))

const withEnv = <A, E, R>(
  overrides: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key])
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  ).pipe(Effect.flatMap(() => effect))

const makeSignal = () => {
  let resolved = false
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }
  })

  return {
    promise,
    resolve: resolvePromise,
  }
}

const writeWorkflowFile = (
  path: string,
  options: {
    readonly frontMatter?: string | undefined
    readonly prompt?: string | undefined
  },
) => {
  mkdirSync(dirname(path), { recursive: true })

  if (options.frontMatter === undefined) {
    writeFileSync(path, `${options.prompt ?? ""}\n`)
    return
  }

  const prompt = options.prompt?.trim() ?? ""
  const content = prompt.length === 0
    ? `---\n${options.frontMatter}\n---\n`
    : `---\n${options.frontMatter}\n---\n\n${prompt}\n`
  writeFileSync(path, content)
}
