import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { OrcaServerEventData, type OrcaServerEvent } from "./orca-server-protocol.ts"

describe("OrcaServerEventData", () => {
  it("round trips every server event variant", () => {
    const events: Array<OrcaServerEvent> = [
      { pid: 42, startedAtMs: 1, type: "server-ready" },
      {
        initialStage: "implementing",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        mode: "implementation",
        type: "run-started",
      },
      {
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        stage: "verifying",
        type: "run-stage-changed",
      },
      {
        result: {
          issueIdentifier: "ENG-1",
          mode: "review",
          pullRequestUrl: "https://github.com/peterje/orca/pull/42",
          worktreePath: "/tmp/orca-worktree",
        },
        type: "run-completed",
        worktreeRemoved: true,
      },
      {
        issueIdentifier: "ENG-1",
        message: "Run failed.",
        type: "run-failed",
      },
    ]

    const encode = Schema.encodeUnknownSync(OrcaServerEventData)
    const decode = Schema.decodeUnknownSync(OrcaServerEventData)

    expect(events.map((event) => decode(encode(event)))).toEqual(events)
  })
})
