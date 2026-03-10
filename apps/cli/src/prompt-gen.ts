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
  buildMergeConflictPrompt: (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly conflictFiles: ReadonlyArray<string>
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
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
      const linearIssueReference = makeLinearIssueReference(options.issue.identifier, options.issue.workspaceSlug)
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
- Use a conventional commit message if you create a commit.
- Prefer a draft pull request unless there is already an open PR for this branch.

## Verification commands

${options.verify.length > 0 ? options.verify.map((command) => `- \`${command}\``).join("\n") : "- No repo-specific verification commands configured."}

## Required git outcome

- Have the branch ready for review.
- Use a conventional commit message every time you create a commit.
- If you open a PR, use a lowercase conventional commit title.
- Create the PR with \`gh pr create\` and a HEREDOC body so the formatting is preserved.
- Write the PR body with bold section labels instead of markdown headings: \`**closes**\`, \`**summary**\`, and \`**verification**\`.
- Under \`**closes**\`, link the Linear ticket as \`${linearIssueReference}\`.
- Keep the prose lowercase unless code or ticket identifiers require otherwise.
- Make the \`**summary**\` section a readable narrative that explains what changed and why it matters, and avoid file-by-file implementation details.
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

## Pull request review feedback

${options.reviewFeedback}

## Repo instructions

${repoInstructions}

## Orca execution constraints

- Work only in the current worktree on branch \`${options.branch}\`.
- Base branch is \`${options.baseBranch}\`.
- Address the requested human and Greptile feedback together, and follow the human direction first when they disagree.
- Do not ask for permission; pick reasonable defaults and keep going.
- Do not mutate unrelated git state.
- Do not commit secrets or any files under \`.orca/\`.
- Use a conventional commit message if you create a commit.
- Keep using the existing branch and pull request.

## Verification commands

${options.verify.length > 0 ? options.verify.map((command) => `- \`${command}\``).join("\n") : "- No repo-specific verification commands configured."}

## Required git outcome

- Have the existing branch ready for another review pass.
- Use a conventional commit message every time you create a commit.
- Update the existing pull request instead of creating a new branch or pull request.
- Keep the pull request title unchanged.
- If you update the PR description, keep the same lowercase narrative format with \`**closes**\`, \`**summary**\`, and \`**verification**\`.
- Mention the verification commands you ran in any pull request update you make.
`

      return { prompt, promptFileContents }
    })

  const buildMergeConflictPrompt = (options: {
    readonly baseBranch: string
    readonly branch: string
    readonly conflictFiles: ReadonlyArray<string>
    readonly issueDescription: string
    readonly issueIdentifier: string
    readonly issueTitle: string
    readonly pullRequestUrl: string
    readonly verify: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const repoInstructions = yield* readAgentsInstructions(fs)
      const prompt = `Resolve the attached merge conflicts in the current repository without asking for permission.`
      const promptFileContents = `# Pull request merge conflict

Identifier: ${options.issueIdentifier}
Title: ${options.issueTitle}

## Original issue description

${options.issueDescription.trim().length > 0 ? options.issueDescription : "No description provided."}

## Existing pull request

- URL: ${options.pullRequestUrl}
- Branch: ${options.branch}
- Base branch: ${options.baseBranch}

## Merge conflict context

- Orca already fetched \`origin/${options.baseBranch}\` and attempted a merge with \`git merge --no-commit --no-ff origin/${options.baseBranch}\`.
- Resolve the remaining conflicts, keep the merge intact, and leave the existing pull request ready for verification.

${options.conflictFiles.length > 0 ? `## Unresolved conflict files

${options.conflictFiles.map((file) => `- \`${file}\``).join("\n")}

` : ""}## Repo instructions

${repoInstructions}

## Orca execution constraints

- Work only in the current worktree on branch \`${options.branch}\`.
- Base branch is \`${options.baseBranch}\`.
- Finish resolving the tracked pull request merge conflicts and keep the existing pull request moving.
- Do not ask for permission; pick reasonable defaults and keep going.
- Do not mutate unrelated git state.
- Do not commit secrets or any files under \`.orca/\`.
- Use a conventional commit message if you create a commit.
- Keep using the existing branch and pull request.

## Verification commands

${options.verify.length > 0 ? options.verify.map((command) => `- \`${command}\``).join("\n") : "- No repo-specific verification commands configured."}

## Required git outcome

- Have the existing branch ready for another review pass.
- Resolve all remaining merge conflicts before finishing.
- Use a conventional commit message every time you create a commit.
- Update the existing pull request instead of creating a new branch or pull request.
- Keep the pull request title unchanged.
- If you update the PR description, keep the same lowercase narrative format with \`**closes**\`, \`**summary**\`, and \`**verification**\`.
- Mention the verification commands you ran in any pull request update you make.
`

      return { prompt, promptFileContents }
    })

  return PromptGen.of({ buildImplementationPrompt, buildMergeConflictPrompt, buildReviewPrompt })
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

const makeLinearIssueReference = (issueIdentifier: string, workspaceSlug: string | undefined) => {
  const normalizedWorkspaceSlug = workspaceSlug?.trim().toLowerCase()
  return normalizedWorkspaceSlug && normalizedWorkspaceSlug.length > 0
    ? `[${issueIdentifier}](https://linear.app/${normalizedWorkspaceSlug}/issue/${issueIdentifier})`
    : issueIdentifier
}
