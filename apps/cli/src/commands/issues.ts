import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { formatPriority, renderDependencyGraph } from "../issue-planner.ts"
import { OrcaClient } from "../orca-client.ts"

const commandIssuesList = Command.make(
  "list",
  {},
  Effect.fn("commandIssuesList")(function* () {
    const client = yield* OrcaClient
    const plan = yield* client.issuePlan

    if (plan.work.length === 0) {
      yield* Console.log("No Orca work found.")
      return
    }

    yield* Console.log("Actionable")
    if (plan.actionable.length === 0) {
      yield* Console.log("- None")
    } else {
      for (const issue of plan.actionable) {
        const source =
          issue.includedBecause === "direct"
            ? "direct Orca issue"
            : `included to unblock ${issue.inheritedFrom.join(", ")}`
        yield* Console.log(
          `- ${issue.identifier} ${issue.title} [priority: ${formatPriority(issue.effectivePriority)}, ${source}]`,
        )
      }
    }

    yield* Console.log("")
    yield* Console.log("Blocked")
    if (plan.blocked.length === 0) {
      yield* Console.log("- None")
    } else {
      for (const issue of plan.blocked) {
        const blockers = issue.blockingIssues.map((blocker) => blocker.identifier).join(", ")
        const reason =
          issue.includedBecause === "direct"
            ? "direct Orca issue"
            : `included to unblock ${issue.inheritedFrom.join(", ")}`
        yield* Console.log(
          `- ${issue.identifier} ${issue.title} [blocked by: ${blockers}; priority: ${formatPriority(issue.effectivePriority)}, ${reason}]`,
        )
      }
    }

    yield* Console.log("")
    yield* Console.log("Dependency graph")
    for (const line of renderDependencyGraph(plan.work)) {
      yield* Console.log(line)
    }
  }),
).pipe(Command.withDescription("List the current Orca issue queue."))

export const commandIssues = Command.make("issues").pipe(
  Command.withDescription("Inspect planned Orca issues."),
  Command.withSubcommands([commandIssuesList]),
)
