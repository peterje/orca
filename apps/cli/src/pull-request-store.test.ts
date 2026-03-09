import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PullRequestStore, PullRequestStoreLayer } from "./pull-request-store.ts"

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

const pullRequestStoreLayer = PullRequestStoreLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Path.layer,
      Layer.succeed(FileSystem.FileSystem, makeTestFileSystem() as unknown as FileSystem.FileSystem),
    ),
  ),
)

describe("PullRequestStore", () => {
  it.effect("persists Greptile wait state across restarts", () =>
    withTempCwd(() =>
      Effect.gen(function* () {
        const record = {
          branch: "orca/eng-1-example-issue",
          issueDescription: "Example issue description",
          issueId: "issue-1",
          issueIdentifier: "ENG-1",
          issueTitle: "Example issue",
          prNumber: 42,
          prUrl: "https://github.com/peterje/orca/pull/42",
          repo: "peterje/orca",
          waitingForGreptileReviewSinceMs: 1_700_000_000_000,
        } as const

        yield* withStore((store) => store.upsert(record))

        const reloaded = yield* withStore((store) => store.list)

        expect(reloaded).toHaveLength(1)
        expect(reloaded[0]?.waitingForGreptileReviewSinceMs).toBe(record.waitingForGreptileReviewSinceMs)
      }),
    ))

  it.effect("defaults missing Greptile wait state for legacy records", () =>
    withTempCwd((tempDirectory) =>
      Effect.gen(function* () {
        mkdirSync(join(tempDirectory, ".orca"), { recursive: true })
        writeFileSync(
          join(tempDirectory, ".orca/pull-requests.json"),
          JSON.stringify([
            {
              branch: "orca/eng-1-example-issue",
              createdAtMs: 1,
              issueDescription: "Example issue description",
              issueId: "issue-1",
              issueIdentifier: "ENG-1",
              issueTitle: "Example issue",
              lastReviewedAtMs: null,
              prNumber: 42,
              prUrl: "https://github.com/peterje/orca/pull/42",
              repo: "peterje/orca",
              updatedAtMs: 2,
            },
          ], null, 2),
        )

        const records = yield* withStore((store) => store.list)

        expect(records).toHaveLength(1)
        expect(records[0]?.waitingForGreptileReviewSinceMs).toBeNull()
      }),
    ))

  it.effect("removes tracked pull requests from storage", () =>
    withTempCwd(() =>
      Effect.gen(function* () {
        yield* withStore((store) => store.upsert({
          branch: "orca/eng-1-example-issue",
          issueDescription: "Example issue description",
          issueId: "issue-1",
          issueIdentifier: "ENG-1",
          issueTitle: "Example issue",
          prNumber: 42,
          prUrl: "https://github.com/peterje/orca/pull/42",
          repo: "peterje/orca",
          waitingForGreptileReviewSinceMs: 1_700_000_000_000,
        }))

        expect(yield* withStore((store) => store.remove({ prNumber: 42, repo: "peterje/orca" }))).toBe(true)
        expect(yield* withStore((store) => store.list)).toEqual([])
      }),
    ))
})

const withStore = <A, E>(use: (store: typeof PullRequestStore.Service) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* PullRequestStore
    return yield* use(store)
  }).pipe(Effect.provide(pullRequestStoreLayer))

const withTempCwd = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previousCwd = process.cwd()
      const tempDirectory = mkdtempSync(join(tmpdir(), "orca-pull-request-store-"))
      process.chdir(tempDirectory)
      return { previousCwd, tempDirectory }
    }),
    ({ previousCwd, tempDirectory }) =>
      Effect.sync(() => {
        process.chdir(previousCwd)
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(({ tempDirectory }) => use(tempDirectory)))
