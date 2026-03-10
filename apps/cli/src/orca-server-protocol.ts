import { Schema } from "effect"
import { activeRunModes, activeRunStages } from "./run-state.ts"

const ActiveRunModeSchema = Schema.Literals(activeRunModes)
const ActiveRunStageSchema = Schema.Literals(activeRunStages)

export class OrcaServerControlData extends Schema.Class<OrcaServerControlData>("orca/OrcaServerControlData")({
  baseUrl: Schema.String,
  pid: Schema.Number,
  startedAtMs: Schema.Number,
  token: Schema.String,
}) {}

export class OrcaServerErrorResponse extends Schema.Class<OrcaServerErrorResponse>("orca/OrcaServerErrorResponse")({
  message: Schema.String,
  tag: Schema.optional(Schema.String),
}) {}

export const RunnerResultData = Schema.Struct({
  issueIdentifier: Schema.String,
  mode: ActiveRunModeSchema,
  pullRequestUrl: Schema.String,
  worktreePath: Schema.String,
})

export const OrcaServerEventData = Schema.Union([
  Schema.Struct({
    pid: Schema.Number,
    startedAtMs: Schema.Number,
    type: Schema.Literal("server-ready"),
  }),
  Schema.Struct({
    issueIdentifier: Schema.String,
    issueTitle: Schema.String,
    mode: ActiveRunModeSchema,
    type: Schema.Literal("run-started"),
  }),
  Schema.Struct({
    issueIdentifier: Schema.String,
    issueTitle: Schema.String,
    stage: ActiveRunStageSchema,
    type: Schema.Literal("run-stage-changed"),
  }),
  Schema.Struct({
    result: RunnerResultData,
    type: Schema.Literal("run-completed"),
  }),
  Schema.Struct({
    issueIdentifier: Schema.String,
    message: Schema.String,
    type: Schema.Literal("run-failed"),
  }),
])

export type OrcaServerEvent = typeof OrcaServerEventData.Type
