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
          workspaceSlug: "peteredm",
        },
        plan: {
          actionable: [],
          blocked: [],
          work: [],
        },
        verify: ["bun run check", "bun run test"],
      })

      expect(result.promptFileContents).toContain("- Use a conventional commit message if you create a commit.")
      expect(result.promptFileContents).toContain("- If you open a PR, use a lowercase conventional commit title.")
      expect(result.promptFileContents).toContain("- Create the PR with `gh pr create` and a HEREDOC body so the formatting is preserved.")
      expect(result.promptFileContents).toContain("- Write the PR body with bold section labels instead of markdown headings: `**closes**`, `**summary**`, and `**verification**`.")
      expect(result.promptFileContents).toContain("- Under `**closes**`, link the Linear ticket as `[PET-20](https://linear.app/peteredm/issue/PET-20)`.")
      expect(result.promptFileContents).toContain("- Make the `**summary**` section a readable narrative that explains what changed and why it matters, and avoid file-by-file implementation details.")
    }).pipe(Effect.provide(makePromptGenLayer())))

  it.effect("guides review follow-up without implying missing feedback sources", () =>
    Effect.gen(function* () {
      const promptGen = yield* PromptGen
      const result = yield* promptGen.buildReviewPrompt({
        baseBranch: "main",
        branch: "orca/pet-17-greptile-loop",
        issueDescription: "Requeue failing Greptile reviews.",
        issueIdentifier: "PET-17",
        issueTitle: "Greptile review loop",
        pullRequestUrl: "https://github.com/peterje/orca/pull/17",
        reviewFeedback: "# Greptile review\n\nConfidence: 4/5",
        verify: ["bun run check", "bun run test"],
      })

      expect(result.prompt).toContain("pull request review feedback")
      expect(result.promptFileContents).toContain("## Pull request review feedback")
      expect(result.promptFileContents).toContain("- Address the requested pull request feedback. When both human and Greptile feedback are present, follow the human direction first when they disagree.")
      expect(result.promptFileContents).not.toContain("Address the requested human and Greptile feedback together")
      expect(result.promptFileContents).toContain("- Have the existing branch ready for another review pass.")
      expect(result.promptFileContents).toContain("- Use a conventional commit message every time you create a commit.")
      expect(result.promptFileContents).toContain("- If you update the PR description, keep the same lowercase narrative format with `**closes**`, `**summary**`, and `**verification**`.")
    }).pipe(Effect.provide(makePromptGenLayer())))

  it.effect("guides merge conflict follow-up after a merge leaves conflicts behind", () =>
    Effect.gen(function* () {
      const promptGen = yield* PromptGen
      const result = yield* promptGen.buildMergeConflictPrompt({
        baseBranch: "main",
        branch: "orca/pet-23-use-weave",
        conflictFiles: ["apps/cli/src/runner.ts", "README.md"],
        issueDescription: "Use weave before asking the agent to fix merge conflicts.",
        issueIdentifier: "PET-23",
        issueTitle: "Use weave for merge-conflict handling",
        pullRequestUrl: "https://github.com/peterje/orca/pull/23",
        verify: ["bun run check", "bun run test"],
      })

      expect(result.prompt).toContain("merge conflicts")
      expect(result.promptFileContents).toContain("## Merge conflict context")
      expect(result.promptFileContents).toContain("attempted a merge")
      expect(result.promptFileContents).toContain("- Have the existing branch ready for another review pass.")
      expect(result.promptFileContents).toContain("apps/cli/src/runner.ts")
      expect(result.promptFileContents).toContain("- Resolve all remaining merge conflicts before finishing.")
      expect(result.promptFileContents).toContain("- Use a conventional commit message every time you create a commit.")
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
