import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { type PlannedIssue, formatPriority, planIssues } from "../issue-planner.ts"
import { Linear } from "../linear.ts"

const commandIssuesList = Command.make(
  "list",
  {},
  Effect.fn("commandIssuesList")(function* () {
    const linear = yield* Linear
    const issues = yield* linear.issues
    const plan = planIssues(issues)

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

const renderDependencyGraph = (work: ReadonlyArray<PlannedIssue>): Array<string> => {
  const workById = new Map(work.map((issue) => [issue.id, issue]))
  const order = new Map(work.map((issue, index) => [issue.id, index]))
  const roots = work.filter((issue) => issue.isOrcaTagged)

  return roots.flatMap((issue, index) => {
    const lines = renderIssueTree(issue, workById, order, "", true, new Set())
    return index === 0 ? lines : ["", ...lines]
  })
}

const renderIssueTree = (
  issue: PlannedIssue,
  workById: Map<string, PlannedIssue>,
  order: Map<string, number>,
  prefix: string,
  isRoot: boolean,
  path: Set<string>,
): Array<string> => {
  const lines = [`${isRoot ? "- " : prefix}${formatGraphIssue(issue)}`]
  const nextPath = new Set(path).add(issue.id)
  const blocking = issue.blocking
    .map((relation) => ({
      issue: workById.get(relation.issue.id),
      kind: relation.kind,
    }))
    .filter(
      (relation): relation is { issue: PlannedIssue; kind: "dependency" | "subissue" } =>
        relation.issue !== undefined,
    )
    .sort((left, right) => (order.get(left.issue.id) ?? 0) - (order.get(right.issue.id) ?? 0))

  for (let index = 0; index < blocking.length; index += 1) {
    const relation = blocking[index]!
    const isLast = index === blocking.length - 1
    const connector = isLast ? "\\- " : "|- "
    const basePrefix = isRoot ? "   " : prefix
    const childPrefix = `${basePrefix}${isLast ? "   " : "|  "}`

    lines.push(`${basePrefix}${connector}${relation.kind}: ${formatGraphIssue(relation.issue)}`)

    if (!nextPath.has(relation.issue.id) && relation.issue.blocking.length > 0) {
      const nestedLines = renderIssueTree(
        relation.issue,
        workById,
        order,
        childPrefix,
        false,
        nextPath,
      )
      lines.push(...nestedLines.slice(1))
    }
  }

  return lines
}

const formatGraphIssue = (issue: PlannedIssue) => {
  const status = issue.blocking.length === 0 ? "actionable" : "blocked"
  const source =
    issue.includedBecause === "direct"
      ? "direct"
      : `inherits ${issue.inheritedFrom.join(", ")}`
  return `${issue.identifier} ${issue.title} [${status}, priority: ${formatPriority(issue.effectivePriority)}, ${source}]`
}
