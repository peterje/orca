import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { PromptGen, PromptGenLayer } from "./prompt-gen.ts"

describe("PromptGen", () => {
  it.effect("guides new pull requests toward the updated formatting", () =>
    Effect.gen(function* () {
      const promptGen = yield* PromptGen
      const result = yield* promptGen.buildImplementationPrompt({
        baseBranch: "main",
        branch: "orca/pet-20-improve-pr-styling",
        issue: {
          blockedBy: [],
          blocking: [],
          blockingIssues: [],
          childIds: [],
          createdAtMs: 1,
          description: "Improve the automated pull request copy.",
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
        },
        plan: {
          actionable: [],
          blocked: [],
          work: [],
        },
        verify: ["bun run check", "bun run test"],
      })

      expect(result.promptFileContents).toContain("- If you open a PR, use a lowercase conventional commit title.")
      expect(result.promptFileContents).toContain("- Create the PR with `gh pr create` and a HEREDOC body so the formatting is preserved.")
      expect(result.promptFileContents).toContain("- Write the PR body in lowercase narrative prose, use only `###` and `####` headings, include the verification commands you ran under `### verification`, and end with `closes PET-20`.")
    }).pipe(Effect.provide(makePromptGenLayer())))
})

const makePromptGenLayer = () =>
  PromptGenLayer.pipe(
    Layer.provide(
      Layer.succeed(FileSystem.FileSystem, {
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed("Use bun."),
      } as unknown as FileSystem.FileSystem),
    ),
  )
