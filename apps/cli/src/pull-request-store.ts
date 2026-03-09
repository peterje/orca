import { Data, Effect, FileSystem, Layer, Schema, ServiceMap } from "effect"
import { resolveOrcaDirectory } from "./orca-directory.ts"

export class OrcaManagedPullRequest extends Schema.Class<OrcaManagedPullRequest>("orca/OrcaManagedPullRequest")({
  branch: Schema.String,
  createdAtMs: Schema.Number,
  issueDescription: Schema.String,
  issueId: Schema.String,
  issueIdentifier: Schema.String,
  issueTitle: Schema.String,
  issueUrl: Schema.optional(Schema.String),
  lastReviewedAtMs: Schema.NullOr(Schema.Number),
  prNumber: Schema.Number,
  prUrl: Schema.String,
  repo: Schema.String,
  updatedAtMs: Schema.Number,
}) {}

const StoredPullRequests = Schema.Array(OrcaManagedPullRequest)

export type PullRequestStoreService = {
  readonly list: Effect.Effect<ReadonlyArray<OrcaManagedPullRequest>, PullRequestStoreError>
  readonly markReviewHandled: (options: {
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
  }) => Effect.Effect<OrcaManagedPullRequest | null, PullRequestStoreError>
  readonly upsert: (record: {
    readonly branch: string
    readonly issueDescription: string
    readonly issueId: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly issueUrl?: string | undefined
    readonly prNumber: number
    readonly prUrl: string
    readonly repo: string
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
        Schema.decodeUnknownEffect(StoredPullRequests)(json).pipe(
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
    readonly issueUrl?: string | undefined
    readonly prNumber: number
    readonly prUrl: string
    readonly repo: string
  }) =>
    Effect.gen(function* () {
      const now = Date.now()
      const records = yield* list
      const existing = records.find((candidate) => candidate.repo === record.repo && candidate.prNumber === record.prNumber) ?? null
      const next = new OrcaManagedPullRequest({
        branch: record.branch,
        createdAtMs: existing?.createdAtMs ?? now,
        issueDescription: record.issueDescription,
        issueId: record.issueId,
        issueIdentifier: record.issueIdentifier,
        issueTitle: record.issueTitle,
        issueUrl: record.issueUrl ?? existing?.issueUrl,
        lastReviewedAtMs: existing?.lastReviewedAtMs ?? null,
        prNumber: record.prNumber,
        prUrl: record.prUrl,
        repo: record.repo,
        updatedAtMs: now,
      })
      const nextRecords = [
        ...records.filter((candidate) => !(candidate.repo === record.repo && candidate.prNumber === record.prNumber)),
        next,
      ].sort(comparePullRequests)
      yield* write(nextRecords)
      return next
    })

  const markReviewHandled = (options: {
    readonly lastReviewedAtMs: number
    readonly prNumber: number
    readonly repo: string
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
        })
        return updated
      })
      if (updated === null) {
        return null
      }
      yield* write(nextRecords)
      return updated
    })

  return PullRequestStore.of({ list, markReviewHandled, upsert })
})

export const PullRequestStoreLayer = Layer.effect(PullRequestStore, PullRequestStoreLive)

export class PullRequestStoreError extends Data.TaggedError("PullRequestStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const comparePullRequests = (left: OrcaManagedPullRequest, right: OrcaManagedPullRequest) =>
  right.updatedAtMs - left.updatedAtMs || left.issueIdentifier.localeCompare(right.issueIdentifier)
