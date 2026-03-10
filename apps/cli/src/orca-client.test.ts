import { describe, expect, it } from "@effect/vitest"
import { formatTimeoutDuration, toRunNextTimeoutMs } from "./orca-client.ts"

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
})
