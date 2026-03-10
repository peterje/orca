import { Data, Effect, FileSystem, Layer, Schema, ServiceMap } from "effect"
import { resolveOrcaDirectory } from "./orca-directory.ts"

export class OrcaManagedPullRequest extends Schema.Class<OrcaManagedPullRequest>("orca/OrcaManagedPullRequest")({
  branch: Schema.String,
  createdAtMs: Schema.Number,
  greptileCompletedAtMs: Schema.NullOr(Schema.Number),
  greptileReviewLimitReachedAtMs: Schema.NullOr(Schema.Number),
  greptileReviewRequestCount: Schema.Number,
  issueDescription: Schema.String,
  issueId: Schema.String,
  issueIdentifier: Schema.String,
  issueTitle: Schema.String,
  lastReviewedAtMs: Schema.NullOr(Schema.Number),
  prNumber: Schema.Number,
  prUrl: Schema.String,
  repo: Schema.String,
  updatedAtMs: Schema.Number,
  waitingForGreptileReviewSinceMs: Schema.NullOr(Schema.Number),
}) {}

const StoredPullRequests = Schema.Array(OrcaManagedPullRequest)

export type PullRequestStoreService = {
  readonly list: Effect.Effect<ReadonlyArray<OrcaManagedPullRequest>, PullRequestStoreError>
  readonly markGreptileCompleted: (options: {
    readonly completedAtMs: number
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
  }) => Effect.Effect<OrcaManagedPullRequest | null, PullRequestStoreError>
  readonly markGreptileReviewLimitReached: (options: {
    readonly prNumber: number
    readonly reachedAtMs: number
    readonly repo: string
  }) => Effect.Effect<OrcaManagedPullRequest | null, PullRequestStoreError>
  readonly markGreptileReviewRequested: (options: {
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
    readonly waitingForGreptileReviewSinceMs: number
  }) => Effect.Effect<OrcaManagedPullRequest | null, PullRequestStoreError>
  readonly remove: (options: {
    readonly prNumber: number
    readonly repo: string
  }) => Effect.Effect<boolean, PullRequestStoreError>
  readonly upsert: (record: {
    readonly branch: string
    readonly issueDescription: string
    readonly issueId: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly prNumber: number
    readonly prUrl: string
    readonly repo: string
    readonly greptileCompletedAtMs?: number | null | undefined
    readonly greptileReviewLimitReachedAtMs?: number | null | undefined
    readonly greptileReviewRequestCount?: number | undefined
    readonly waitingForGreptileReviewSinceMs?: number | null | undefined
  }) => Effect.Effect<OrcaManagedPullRequest, PullRequestStoreError>
}

export const PullRequestStore = ServiceMap.Service<PullRequestStoreService>("orca/PullRequestStore")

export const PullRequestStoreLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const orcaDirectory = yield* resolveOrcaDirectory()
  const file = `${orcaDirectory}/pull-requests.json`

  const decode = (raw: string) =>
    Effect.try({
      try: () => JSON.parse(raw),
      catch: (cause) => new PullRequestStoreError({ message: `Failed to parse ${file}.`, cause }),
    }).pipe(
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(StoredPullRequests)(normalizeStoredPullRequests(json)).pipe(
          Effect.mapError((cause) => new PullRequestStoreError({ message: `Failed to parse ${file}.`, cause })),
        )),
    )

  const list = Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => new PullRequestStoreError({ message: `Failed to inspect ${file}.`, cause })),
    )
    if (!exists) {
      return []
    }

    const raw = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => new PullRequestStoreError({ message: `Failed to read ${file}.`, cause })),
    )
    return yield* decode(raw)
  })

  const write = (records: ReadonlyArray<OrcaManagedPullRequest>) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(orcaDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new PullRequestStoreError({ message: `Failed to create ${orcaDirectory}.`, cause })),
      )
      const payload = JSON.stringify(Schema.encodeUnknownSync(StoredPullRequests)(records), null, 2) + "\n"
      yield* fs.writeFileString(file, payload).pipe(
        Effect.mapError((cause) => new PullRequestStoreError({ message: `Failed to write ${file}.`, cause })),
      )
    })

  const upsert = (record: {
    readonly branch: string
    readonly issueDescription: string
    readonly issueId: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly prNumber: number
    readonly prUrl: string
    readonly repo: string
    readonly greptileCompletedAtMs?: number | null | undefined
    readonly greptileReviewLimitReachedAtMs?: number | null | undefined
    readonly greptileReviewRequestCount?: number | undefined
    readonly waitingForGreptileReviewSinceMs?: number | null | undefined
  }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const records = yield* list
      const existing = records.find((candidate) => candidate.repo === record.repo && candidate.prNumber === record.prNumber) ?? null
      const next = new OrcaManagedPullRequest({
        branch: record.branch,
        createdAtMs: existing?.createdAtMs ?? now,
        greptileCompletedAtMs:
          record.greptileCompletedAtMs === undefined
            ? existing?.greptileCompletedAtMs ?? null
            : record.greptileCompletedAtMs,
        greptileReviewLimitReachedAtMs:
          record.greptileReviewLimitReachedAtMs === undefined
            ? existing?.greptileReviewLimitReachedAtMs ?? null
            : record.greptileReviewLimitReachedAtMs,
        greptileReviewRequestCount:
          record.greptileReviewRequestCount === undefined
            ? existing?.greptileReviewRequestCount
              ?? (record.waitingForGreptileReviewSinceMs === undefined || record.waitingForGreptileReviewSinceMs === null ? 0 : 1)
            : record.greptileReviewRequestCount,
        issueDescription: record.issueDescription,
        issueId: record.issueId,
        issueIdentifier: record.issueIdentifier,
        issueTitle: record.issueTitle,
        lastReviewedAtMs: existing?.lastReviewedAtMs ?? null,
        prNumber: record.prNumber,
        prUrl: record.prUrl,
        repo: record.repo,
        updatedAtMs: now,
        waitingForGreptileReviewSinceMs:
          record.waitingForGreptileReviewSinceMs === undefined
            ? existing?.waitingForGreptileReviewSinceMs ?? null
            : record.waitingForGreptileReviewSinceMs,
      })
      const nextRecords = [
        ...records.filter((candidate) => !(candidate.repo === record.repo && candidate.prNumber === record.prNumber)),
        next,
      ].sort(comparePullRequests)
      yield* write(nextRecords)
      return next
    })

  const markGreptileCompleted = (options: {
    readonly completedAtMs: number
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
  }) =>
    Effect.gen(function* () {
      const records = yield* list
      let updated: OrcaManagedPullRequest | null = null
      const nextRecords = records.map((record) => {
        if (!(record.repo === options.repo && record.prNumber === options.prNumber)) {
          return record
        }

        updated = new OrcaManagedPullRequest({
          ...record,
          greptileCompletedAtMs: options.completedAtMs,
          lastReviewedAtMs: options.lastReviewedAtMs,
          updatedAtMs: options.completedAtMs,
          waitingForGreptileReviewSinceMs: null,
        })
        return updated
      })
      if (updated === null) {
        return null
      }
      yield* write(nextRecords)
      return updated
    })

  const markGreptileReviewLimitReached = (options: {
    readonly prNumber: number
    readonly reachedAtMs: number
    readonly repo: string
  }) =>
    Effect.gen(function* () {
      const records = yield* list
      let updated: OrcaManagedPullRequest | null = null
      const nextRecords = records.map((record) => {
        if (!(record.repo === options.repo && record.prNumber === options.prNumber)) {
          return record
        }

        updated = new OrcaManagedPullRequest({
          ...record,
          greptileReviewLimitReachedAtMs: options.reachedAtMs,
          updatedAtMs: options.reachedAtMs,
          waitingForGreptileReviewSinceMs: null,
        })
        return updated
      })
      if (updated === null) {
        return null
      }
      yield* write(nextRecords)
      return updated
    })

  const markGreptileReviewRequested = (options: {
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
    readonly waitingForGreptileReviewSinceMs: number
  }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const records = yield* list
      let updated: OrcaManagedPullRequest | null = null
      const nextRecords = records.map((record) => {
        if (!(record.repo === options.repo && record.prNumber === options.prNumber)) {
          return record
        }

        updated = new OrcaManagedPullRequest({
          ...record,
          lastReviewedAtMs: options.lastReviewedAtMs,
          updatedAtMs: now,
          greptileReviewRequestCount: record.greptileReviewRequestCount + 1,
          waitingForGreptileReviewSinceMs: options.waitingForGreptileReviewSinceMs,
        })
        return updated
      })
      if (updated === null) {
        return null
      }
      yield* write(nextRecords)
      return updated
    })

  const remove = (options: {
    readonly prNumber: number
    readonly repo: string
  }) =>
    Effect.gen(function* () {
      const records = yield* list
      const nextRecords = records.filter((record) => !(record.repo === options.repo && record.prNumber === options.prNumber))
      if (nextRecords.length === records.length) {
        return false
      }
      yield* write(nextRecords)
      return true
    })

  return PullRequestStore.of({ list, markGreptileCompleted, markGreptileReviewLimitReached, markGreptileReviewRequested, remove, upsert })
})

export const PullRequestStoreLayer = Layer.effect(PullRequestStore, PullRequestStoreLive)

export class PullRequestStoreError extends Data.TaggedError("PullRequestStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const normalizeStoredPullRequests = (json: unknown) =>
  Array.isArray(json)
    ? json.map(normalizeStoredPullRequest)
    : json

const normalizeStoredPullRequest = (record: unknown) =>
  typeof record === "object" && record !== null
    ? {
        greptileCompletedAtMs: null,
        greptileReviewLimitReachedAtMs: null,
        greptileReviewRequestCount:
          "greptileReviewRequestCount" in record && typeof (record as { readonly greptileReviewRequestCount?: unknown }).greptileReviewRequestCount === "number"
            ? (record as { readonly greptileReviewRequestCount: number }).greptileReviewRequestCount
            : ("waitingForGreptileReviewSinceMs" in record
              && typeof (record as { readonly waitingForGreptileReviewSinceMs?: unknown }).waitingForGreptileReviewSinceMs === "number")
              || ("lastReviewedAtMs" in record && typeof (record as { readonly lastReviewedAtMs?: unknown }).lastReviewedAtMs === "number")
              || ("greptileCompletedAtMs" in record && typeof (record as { readonly greptileCompletedAtMs?: unknown }).greptileCompletedAtMs === "number")
              ? 1
              : 0,
        waitingForGreptileReviewSinceMs: null,
        ...record,
      }
    : record

const comparePullRequests = (left: OrcaManagedPullRequest, right: OrcaManagedPullRequest) =>
  right.updatedAtMs - left.updatedAtMs || left.issueIdentifier.localeCompare(right.issueIdentifier)
