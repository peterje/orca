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
  buildReviewPrompt: (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
    readonly reviewFeedback: string
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
- If you open a PR, use a lowercase conventional commit title.
- Create the PR with \`gh pr create\` and a HEREDOC body so the formatting is preserved.
- Write the PR body in lowercase narrative prose, use only \`###\` and \`####\` headings, include the verification commands you ran under \`### verification\`, and end with \`closes ${options.issue.identifier}\`.
`

      return { prompt, promptFileContents }
    })

  const buildReviewPrompt = (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
    readonly reviewFeedback: string
    readonly verify: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const repoInstructions = yield* readAgentsInstructions(fs)
      const prompt = `Address the attached pull request review feedback in the current repository without asking for permission.`
      const promptFileContents = `# Pull request review

Identifier: ${options.issueIdentifier}
Title: ${options.issueTitle}

## Original issue description

${options.issueDescription.trim().length > 0 ? options.issueDescription : "No description provided."}

## Existing pull request

- URL: ${options.pullRequestUrl}
- Branch: ${options.branch}

## Review feedback

${options.reviewFeedback}

## Repo instructions

${repoInstructions}

## Orca execution constraints

- Work only in the current worktree on branch \`${options.branch}\`.
- Base branch is \`${options.baseBranch}\`.
- Address the requested review feedback and keep the existing pull request moving.
- Do not ask for permission; pick reasonable defaults and keep going.
- Do not mutate unrelated git state.
- Do not commit secrets or any files under \`.orca/\`.
- Prefer a conventional commit if you create a commit.
- Keep using the existing branch and pull request.

## Verification commands

${options.verify.length > 0 ? options.verify.map((command) => `- \`${command}\``).join("\n") : "- No repo-specific verification commands configured."}

## Required git outcome

- Have the existing branch ready for another human review pass.
- If you commit, use a conventional commit message.
- Update the existing pull request instead of creating a new branch or pull request.
- Keep the pull request title unchanged.
- Mention the verification commands you ran in any pull request update you make.
`

      return { prompt, promptFileContents }
    })

  return PromptGen.of({ buildImplementationPrompt, buildReviewPrompt })
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
