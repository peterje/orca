import { describe, expect, it } from "@effect/vitest"
import { renderMissionControl, type MissionControlSnapshot } from "./mission-control.ts"

describe("mission control", () => {
  it("renders base sync and merge conflict stages", () => {
    expect(renderMissionControl(snapshot({
      current: { issueIdentifier: "ENG-1", issueTitle: "Existing PR", stage: "resolving-merge-conflicts" },
      next: { issueIdentifier: "ENG-2", issueTitle: "Another PR", stage: "syncing-with-base" },
    }))).toEqual([
      "Mission control",
      "- current: ENG-1 Existing PR - resolving merge conflicts",
      "- next: ENG-2 Another PR - syncing with base",
      "- issue queue: 0 ready to pick up, 0 blocked",
      "- review queue: 0 waiting for review, 0 ready for follow-up",
    ])
  })
})

const snapshot = (overrides?: Partial<MissionControlSnapshot>): MissionControlSnapshot => ({
  current: overrides?.current ?? null,
  issues: overrides?.issues ?? { blockedCount: 0, readyToPickUpCount: 0 },
  next: overrides?.next ?? null,
  reviews: overrides?.reviews ?? { readyForFollowUpCount: 0, waitingForReviewCount: 0 },
})
