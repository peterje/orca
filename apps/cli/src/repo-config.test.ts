import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultGreptilePollIntervalSeconds,
  defaultMaxWaitingPullRequests,
  RepoConfig,
  RepoConfigLayer,
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
  Path.layer,
  Layer.succeed(FileSystem.FileSystem, makeTestFileSystem() as unknown as FileSystem.FileSystem),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("not used in this test")),
  ),
)

const repoConfigLayer = RepoConfigLayer.pipe(Layer.provide(testPlatformLayer))

describe("RepoConfig", () => {
  it.effect("bootstraps Greptile config defaults", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.bootstrap({
          baseBranch: "main",
          linearWorkspace: "  PeterEdm ",
          repo: "peterje/orca",
        })

        expect(config.greptilePollIntervalSeconds).toBe(defaultGreptilePollIntervalSeconds)
        expect(config.linearWorkspace).toBe("peteredm")
        expect(config.maxWaitingPullRequests).toBe(defaultMaxWaitingPullRequests)
        expect(JSON.parse(readFileSync(join(tempDirectory, ".orca/repo.json"), "utf8"))).toMatchObject({
          greptilePollIntervalSeconds: defaultGreptilePollIntervalSeconds,
          linearWorkspace: "peteredm",
          maxWaitingPullRequests: defaultMaxWaitingPullRequests,
        })
      }).pipe(Effect.provide(repoConfigLayer)),
    ))

  it.effect("reads legacy repo configs with Greptile defaults", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        mkdirSync(join(tempDirectory, ".orca"), { recursive: true })
        writeFileSync(
          join(tempDirectory, ".orca/repo.json"),
          JSON.stringify({
            agent: "opencode",
            agentArgs: [],
            agentTimeoutMinutes: 45,
            baseBranch: "main",
            branchPrefix: "orca",
            cleanupWorktreeOnSuccess: true,
            draftPr: true,
            linearLabel: "Orca",
            repo: "peterje/orca",
            setup: ["bun install"],
            stallTimeoutMinutes: 10,
            verify: ["bun run check"],
          }, null, 2),
        )

        const repoConfig = yield* RepoConfig
        const config = yield* repoConfig.read

        expect(config.greptilePollIntervalSeconds).toBe(defaultGreptilePollIntervalSeconds)
        expect(config.maxWaitingPullRequests).toBe(defaultMaxWaitingPullRequests)
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
