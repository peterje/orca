import { Data, Effect, FileSystem, Layer, ServiceMap } from "effect"
import { renderDependencyGraph, type IssuePlan, type PlannedIssue } from "./issue-planner.ts"

export type PromptGenService = {
  buildImplementationPrompt: (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly issue: PlannedIssue
    readonly plan: IssuePlan
    readonly verify: ReadonlyArray<string>
  }) => Effect.Effect<{
    readonly prompt: string
    readonly promptFileContents: string
  }, PromptGenError>
}

export const PromptGen = ServiceMap.Service<PromptGenService>("orca/PromptGen")

export const PromptGenLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const buildImplementationPrompt = (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly issue: PlannedIssue
    readonly plan: IssuePlan
    readonly verify: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const repoInstructions = yield* readAgentsInstructions(fs)
      const dependencyGraph = renderDependencyGraph(options.plan.work).join("\n")
      const prompt = `Implement the attached Linear issue in the current repository without asking for permission.`
      const promptFileContents = `# Linear issue

Identifier: ${options.issue.identifier}
Title: ${options.issue.title}

## Description

${options.issue.description.trim().length > 0 ? options.issue.description : "No description provided."}

## Dependency graph

${dependencyGraph.length > 0 ? dependencyGraph : "- No tracked blockers"}

## Repo instructions

${repoInstructions}

## Orca execution constraints

- Work only in the current worktree on branch \`${options.branch}\`.
- Base branch is \`${options.baseBranch}\`.
- Implement the selected issue end-to-end in this repository.
- Do not ask for permission; pick reasonable defaults and keep going.
- Do not mutate unrelated git state.
- Do not commit secrets or any files under \`.orca/\`.
- Prefer a conventional commit if you create a commit.
- Prefer a draft pull request unless there is already an open PR for this branch.

## Verification commands

${options.verify.length > 0 ? options.verify.map((command) => `- \`${command}\``).join("\n") : "- No repo-specific verification commands configured."}

## Required git outcome

- Have the branch ready for review.
- If you commit, use a conventional commit message.
- If you open a PR, use the title \`${options.issue.identifier}: ${options.issue.title}\`.
- Include a brief summary, the verification commands you ran, and \`Refs ${options.issue.identifier}\` in the PR body.
`

      return { prompt, promptFileContents }
    })

  return PromptGen.of({ buildImplementationPrompt })
})

export const PromptGenLayer = Layer.effect(PromptGen, PromptGenLive)

export class PromptGenError extends Data.TaggedError("PromptGenError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const readAgentsInstructions = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists("AGENTS.md").pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return "No AGENTS.md file found."
    }
    return yield* fs.readFileString("AGENTS.md").pipe(
      Effect.mapError((cause) => new PromptGenError({ message: "Failed to read AGENTS.md.", cause })),
    )
  })
