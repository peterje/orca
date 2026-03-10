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

const testPlatformLayer = Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem, makeTestFileSystem() as unknown as FileSystem.FileSystem),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("not used in this test")),
  ),
)

const repoConfigLayer = RepoConfigLayer.pipe(Layer.provide(testPlatformLayer))

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

  it.effect("parses double-quoted yaml escape sequences", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        writeWorkflowFile(join(tempDirectory, defaultWorkflowFileName), {
          frontMatter: [
            'future-setting: "hello\\nworld"',
            'verify: ["bun run check\\n bun run test"]',
            "repo: owner/name",
          ].join("\n"),
          prompt: "Escaped values should round-trip",
        })

        const repoConfig = yield* RepoConfig
        const workflow = yield* repoConfig.document

        expect(workflow.config.raw["future-setting"]).toBe("hello\nworld")
        expect(workflow.config.raw.verify).toEqual(["bun run check\n bun run test"])
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
