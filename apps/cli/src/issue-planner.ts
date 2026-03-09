import type { LinearIssue } from "./linear.ts"

export type BlockingRelation = {
  readonly issue: LinearIssue
  readonly kind: "dependency" | "subissue"
}

export type PlannedIssue = LinearIssue & {
  readonly blocking: ReadonlyArray<BlockingRelation>
  readonly blockingIssues: ReadonlyArray<LinearIssue>
  readonly effectivePriority: number
  readonly includedBecause: "direct" | "inherited"
  readonly inheritedFrom: ReadonlyArray<string>
}

export type IssuePlan = {
  readonly actionable: ReadonlyArray<PlannedIssue>
  readonly blocked: ReadonlyArray<PlannedIssue>
  readonly work: ReadonlyArray<PlannedIssue>
}

export const planIssues = (
  issues: ReadonlyArray<LinearIssue>,
  options?: { readonly linearLabel?: string | undefined },
): IssuePlan => {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))
  const directIssues = issues.filter((issue) => isTaggedIssue(issue, options?.linearLabel))
  const workIds = new Set<string>()
  const inheritedFrom = new Map<string, Set<string>>()

  const visit = (issueId: string, rootId: string) => {
    const issue = issuesById.get(issueId)
    if (!issue) {
      return
    }

    workIds.add(issueId)
    if (issueId !== rootId) {
      let roots = inheritedFrom.get(issueId)
      if (!roots) {
        roots = new Set<string>()
        inheritedFrom.set(issueId, roots)
      }
      roots.add(rootId)
    }

    for (const blockerId of issue.blockedBy) {
      visit(blockerId, rootId)
    }

    for (const childId of issue.childIds) {
      visit(childId, rootId)
    }
  }

  for (const issue of directIssues) {
    visit(issue.id, issue.id)
  }

  const work = Array.from(workIds)
    .map((issueId) => issuesById.get(issueId)!)
    .map((issue): PlannedIssue => {
      const rootIssues = Array.from(inheritedFrom.get(issue.id) ?? [])
        .map((rootId) => issuesById.get(rootId))
        .filter((rootIssue): rootIssue is LinearIssue => rootIssue !== undefined)
        .sort(compareIssueIdentifiers)

      return {
        ...issue,
        blocking: [
          ...issue.blockedBy.map((blockerId) => ({ blockerId, kind: "dependency" as const })),
          ...issue.childIds.map((blockerId) => ({ blockerId, kind: "subissue" as const })),
        ]
          .map((relation) => ({
            issue: issuesById.get(relation.blockerId),
            kind: relation.kind,
          }))
          .filter(
            (relation): relation is BlockingRelation =>
              relation.issue !== undefined && workIds.has(relation.issue.id),
          )
          .sort(compareBlockingRelations),
        effectivePriority: issue.isOrcaTagged
          || isTaggedIssue(issue, options?.linearLabel)
          ? issue.priority
          : deriveInheritedPriority(rootIssues),
        includedBecause: issue.isOrcaTagged || isTaggedIssue(issue, options?.linearLabel) ? "direct" : "inherited",
        inheritedFrom: rootIssues.map((rootIssue) => rootIssue.identifier),
        get blockingIssues() {
          return this.blocking.map((relation) => relation.issue)
        },
      }
    })
    .sort(comparePlannedIssues)

  return {
    actionable: work.filter((issue) => issue.blockingIssues.length === 0),
    blocked: work.filter((issue) => issue.blockingIssues.length > 0),
    work,
  }
}

const deriveInheritedPriority = (issues: ReadonlyArray<LinearIssue>) => {
  if (issues.length === 0) {
    return 0
  }

  return issues.reduce((best, issue) =>
    priorityRank(issue.priority) < priorityRank(best) ? issue.priority : best, issues[0]!.priority)
}

const comparePlannedIssues = (left: PlannedIssue, right: PlannedIssue) =>
  priorityRank(left.effectivePriority) - priorityRank(right.effectivePriority) ||
  right.createdAtMs - left.createdAtMs ||
  left.identifier.localeCompare(right.identifier)

const compareLinearIssues = (left: LinearIssue, right: LinearIssue) =>
  priorityRank(left.priority) - priorityRank(right.priority) ||
  right.createdAtMs - left.createdAtMs ||
  left.identifier.localeCompare(right.identifier)

const compareBlockingRelations = (left: BlockingRelation, right: BlockingRelation) =>
  compareLinearIssues(left.issue, right.issue)

const compareIssueIdentifiers = (left: LinearIssue, right: LinearIssue) =>
  left.identifier.localeCompare(right.identifier)

const priorityRank = (priority: number) => (priority <= 0 ? Number.POSITIVE_INFINITY : priority)

export const formatPriority = (priority: number) => {
  switch (priority) {
    case 1:
      return "Urgent"
    case 2:
      return "High"
    case 3:
      return "Medium"
    case 4:
      return "Low"
    default:
      return "None"
  }
}

export const renderDependencyGraph = (work: ReadonlyArray<PlannedIssue>): Array<string> => {
  const workById = new Map(work.map((issue) => [issue.id, issue]))
  const order = new Map(work.map((issue, index) => [issue.id, index]))
  const roots = work.filter((issue) => issue.includedBecause === "direct")

  return roots.flatMap((issue, index) => {
    const lines = renderIssueTree(issue, workById, order, "", true, new Set())
    return index === 0 ? lines : ["", ...lines]
  })
}

const isTaggedIssue = (issue: LinearIssue, linearLabel = "Orca") =>
  issue.labels.some((label) => label.toLowerCase() === linearLabel.toLowerCase()) ||
  (linearLabel.toLowerCase() === "orca" && issue.isOrcaTagged)

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
