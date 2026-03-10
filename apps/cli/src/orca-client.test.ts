import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrcaClient, OrcaClientLayer, formatTimeoutDuration, toRunNextTimeoutMs } from "./orca-client.ts"
import { OrcaServerControlData } from "./orca-server-protocol.ts"
import { RepoConfig } from "./repo-config.ts"

describe("OrcaClient", () => {
  it("formats sub-minute timeouts in seconds", () => {
    expect(formatTimeoutDuration(30_000)).toBe("30 seconds")
  })

  it("formats minute timeouts in minutes", () => {
    expect(formatTimeoutDuration(60_000)).toBe("1 minute")
    expect(formatTimeoutDuration(120_000)).toBe("2 minutes")
  })

  it("derives run-next timeouts from repo config", () => {
    expect(toRunNextTimeoutMs({ agentTimeoutMinutes: 30, stallTimeoutMinutes: 15 })).toBe(3_000_000)
  })

  it.effect("removes a stale control file after unauthorized server responses", () =>
    withMockFetch(async (input, init) => {
      const url = input.toString()
      const authorization = getAuthorizationHeader(init)

      if (url.endsWith("/health")) {
        expect(authorization).toBe("Bearer stale-token")
        return jsonResponse({ ok: true }, 200)
      }

      if (url.endsWith("/issues/plan")) {
        expect(authorization).toBe("Bearer stale-token")
        return jsonResponse({ message: "Unauthorized Orca server request.", tag: "Unauthorized" }, 401)
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    }, () =>
      withTempCwd((tempDirectory) =>
        Effect.gen(function* () {
          writeControl(tempDirectory, new OrcaServerControlData({
            baseUrl: "http://127.0.0.1:43101",
            pid: process.pid,
            startedAtMs: 1,
            token: "stale-token",
          }))

          const client = yield* OrcaClient
          const exit = yield* client.issuePlan.pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          expect(existsSync(controlFilePath(tempDirectory))).toBe(false)
        }).pipe(Effect.provide(orcaClientLayer)),
      ),
    ))

  it.effect("keeps a newer control file after unauthorized responses against cached control", () =>
    withTempCwd((tempDirectory) => {
      const staleControl = new OrcaServerControlData({
        baseUrl: "http://127.0.0.1:43102",
        pid: process.pid,
        startedAtMs: 1,
        token: "stale-token",
      })
      const freshControl = new OrcaServerControlData({
        baseUrl: "http://127.0.0.1:43103",
        pid: process.pid,
        startedAtMs: 2,
        token: "fresh-token",
      })

      writeControl(tempDirectory, staleControl)

      return withMockFetch(async (input, init) => {
        const url = input.toString()
        const authorization = getAuthorizationHeader(init)

        if (url === `${staleControl.baseUrl}/health`) {
          expect(authorization).toBe("Bearer stale-token")
          return jsonResponse({ ok: true }, 200)
        }

        if (url === `${staleControl.baseUrl}/issues/plan`) {
          expect(authorization).toBe("Bearer stale-token")
          writeControl(tempDirectory, freshControl)
          return jsonResponse({ message: "Unauthorized Orca server request.", tag: "Unauthorized" }, 401)
        }

        if (url === `${freshControl.baseUrl}/health`) {
          expect(authorization).toBe("Bearer fresh-token")
          return jsonResponse({ ok: true }, 200)
        }

        if (url === `${freshControl.baseUrl}/issues/plan`) {
          expect(authorization).toBe("Bearer fresh-token")
          return jsonResponse({ actionable: [], blocked: [], work: [] }, 200)
        }

        throw new Error(`Unexpected fetch URL: ${url}`)
      }, () =>
        Effect.gen(function* () {
          const client = yield* OrcaClient
          const failedExit = yield* client.issuePlan.pipe(Effect.exit)

          expect(Exit.isFailure(failedExit)).toBe(true)
          expect(readControl(tempDirectory)).toEqual(freshControl)

          const issuePlan = yield* client.issuePlan
          expect(issuePlan).toEqual({ actionable: [], blocked: [], work: [] })
        }).pipe(Effect.provide(orcaClientLayer)),
      )
    }))
})

const makeTestFileSystem = () => ({
  exists: (path: string) => Effect.sync(() => existsSync(path)),
  readFileString: (path: string) => Effect.sync(() => readFileSync(path, "utf8")),
  remove: (path: string) =>
    Effect.sync(() => {
      rmSync(path, { force: true, recursive: true })
    }),
  writeFileString: (path: string, data: string) =>
    Effect.sync(() => {
      writeFileSync(path, data)
    }),
})

const orcaClientLayer = OrcaClientLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Path.layer,
      Layer.succeed(FileSystem.FileSystem, makeTestFileSystem() as unknown as FileSystem.FileSystem),
      Layer.succeed(
        RepoConfig,
        RepoConfig.of({
          bootstrap: () => Effect.die("not used in this test"),
          configPath: Effect.die("not used in this test"),
          exists: Effect.die("not used in this test"),
          read: Effect.die("not used in this test"),
          readOption: Effect.die("not used in this test"),
          write: () => Effect.die("not used in this test"),
        }),
      ),
    ),
  ),
)

type FetchMock = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>

const withMockFetch = <A, E, R>(mockFetch: FetchMock, use: () => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mockFetch as typeof globalThis.fetch
      return originalFetch
    }),
    (originalFetch) =>
      Effect.sync(() => {
        globalThis.fetch = originalFetch
      }),
  ).pipe(Effect.flatMap(() => use()))

const withTempCwd = <A, E, R>(use: (tempDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previousCwd = process.cwd()
      const tempDirectory = mkdtempSync(join(tmpdir(), "orca-orca-client-"))
      process.chdir(tempDirectory)
      return { previousCwd, tempDirectory }
    }),
    ({ previousCwd, tempDirectory }) =>
      Effect.sync(() => {
        process.chdir(previousCwd)
        rmSync(tempDirectory, { force: true, recursive: true })
      }),
  ).pipe(Effect.flatMap(({ tempDirectory }) => use(tempDirectory)))

const controlFilePath = (tempDirectory: string) => join(tempDirectory, ".orca/server.json")

const writeControl = (tempDirectory: string, control: typeof OrcaServerControlData.Type) => {
  mkdirSync(join(tempDirectory, ".orca"), { recursive: true })
  writeFileSync(controlFilePath(tempDirectory), JSON.stringify(control, null, 2))
}

const readControl = (tempDirectory: string): typeof OrcaServerControlData.Type =>
  JSON.parse(readFileSync(controlFilePath(tempDirectory), "utf8"))

const getAuthorizationHeader = (init?: RequestInit) => {
  const headers = init?.headers
  if (headers === undefined) {
    return undefined
  }

  if (headers instanceof Headers) {
    return headers.get("authorization") ?? undefined
  }

  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === "authorization")?.[1]
  }

  return headers.authorization
}

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status,
  })
