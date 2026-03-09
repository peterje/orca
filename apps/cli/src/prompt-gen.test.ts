import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import type { IssuePlan, PlannedIssue } from "./issue-planner.ts"
import { PromptGen, PromptGenLayer } from "./prompt-gen.ts"

describe("PromptGen", () => {
  it.effect("includes the updated pull request guidance in implementation prompts", () =>
    Effect.gen(function* () {
      const promptGen = yield* PromptGen
      const result = yield* promptGen.buildImplementationPrompt({
        baseBranch: "main",
        branch: "orca/pet-20-improve-pr-styling",
        issue: plannedIssue,
        plan,
        verify: ["bun run check", "bun run test"],
      })

      expect(result.promptFileContents).toContain("- Use a conventional commit title in lowercase if you open a pull request, for example `feat: improve pr styling`.")
      expect(result.promptFileContents).toContain("- Use `gh pr create` with a HEREDOC so multi-line formatting is preserved.")
      expect(result.promptFileContents).toContain("- End the pull request body with `closes PET-20`.")
      expect(result.promptFileContents).toContain("- If you open a PR, follow the pull request guidance above.")
      expect(result.promptFileContents).not.toContain("Refs PET-20")
      expect(result.promptFileContents).not.toContain("PET-20: Improve PR styling")
    }).pipe(Effect.provide(testPromptGenLayer)),
  )
})

const testPromptGenLayer = PromptGenLayer.pipe(
  Layer.provide(Layer.succeed(FileSystem.FileSystem, {
    exists: () => Effect.succeed(false),
    readFileString: () => Effect.die("not used in this test"),
  } as unknown as FileSystem.FileSystem)),
)

const plannedIssue: PlannedIssue = {
  blockedBy: [],
  blocking: [],
  blockingIssues: [],
  childIds: [],
  createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
  description: "Update Orca's pull request output.",
  effectivePriority: 0,
  id: "issue-1",
  identifier: "PET-20",
  includedBecause: "direct",
  inheritedFrom: [],
  isOrcaTagged: true,
  labels: ["Orca"],
  parentId: null,
  priority: 0,
  state: "unstarted",
  stateId: "state-1",
  stateName: "Unstarted",
  teamStates: [],
  title: "Improve PR styling",
}

const plan: IssuePlan = {
  actionable: [plannedIssue],
  blocked: [],
  work: [plannedIssue],
}
