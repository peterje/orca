import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatPriority, planIssues } from "./issue-planner.ts"
import type { LinearIssue } from "./linear.ts"

describe("planIssues", () => {
  it.effect("promotes inherited blockers ahead of blocked tagged work", () =>
    Effect.gen(function* () {
      const plan = planIssues([
        issue({
          blockedBy: ["blocker-1"],
          id: "tagged-1",
          identifier: "ENG-10",
          isOrcaTagged: true,
          priority: 1,
          title: "Ship the feature",
        }),
        issue({
          id: "blocker-1",
          identifier: "ENG-5",
          priority: 3,
          title: "Fix the blocker",
        }),
      ])

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-5"])
      expect(plan.blocked.map((issue) => issue.identifier)).toEqual(["ENG-10"])
      expect(plan.actionable[0]?.effectivePriority).toBe(1)
      expect(plan.actionable[0]?.includedBecause).toBe("inherited")
      expect(plan.actionable[0]?.inheritedFrom).toEqual(["ENG-10"])
    }))

  it.effect("sorts actionable work by effective priority and recency", () =>
    Effect.gen(function* () {
      const plan = planIssues([
        issue({
          createdAtMs: Date.parse("2026-03-01T00:00:00.000Z"),
          id: "tagged-1",
          identifier: "ENG-1",
          isOrcaTagged: true,
          priority: 2,
          title: "High priority task",
        }),
        issue({
          createdAtMs: Date.parse("2026-03-02T00:00:00.000Z"),
          id: "tagged-2",
          identifier: "ENG-2",
          isOrcaTagged: true,
          priority: 2,
          title: "More recent task",
        }),
        issue({
          createdAtMs: Date.parse("2026-03-03T00:00:00.000Z"),
          id: "tagged-3",
          identifier: "ENG-3",
          isOrcaTagged: true,
          priority: 4,
          title: "Lower priority task",
        }),
      ])

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual([
        "ENG-2",
        "ENG-1",
        "ENG-3",
      ])
    }))

  it.effect("formats priority names", () =>
    Effect.sync(() => {
      expect(formatPriority(1)).toBe("Urgent")
      expect(formatPriority(2)).toBe("High")
      expect(formatPriority(3)).toBe("Medium")
      expect(formatPriority(4)).toBe("Low")
      expect(formatPriority(0)).toBe("None")
    }))

  it.effect("inherits the most urgent priority across multiple unblocked roots", () =>
    Effect.sync(() => {
      const plan = planIssues([
        issue({
          blockedBy: ["shared-blocker"],
          id: "tagged-1",
          identifier: "ENG-20",
          isOrcaTagged: true,
          priority: 3,
          title: "Medium priority work",
        }),
        issue({
          blockedBy: ["shared-blocker"],
          id: "tagged-2",
          identifier: "ENG-21",
          isOrcaTagged: true,
          priority: 1,
          title: "Urgent work",
        }),
        issue({
          id: "shared-blocker",
          identifier: "ENG-5",
          priority: 4,
          title: "Shared blocker",
        }),
      ])

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-5"])
      expect(plan.actionable[0]?.effectivePriority).toBe(1)
      expect(plan.actionable[0]?.inheritedFrom).toEqual(["ENG-20", "ENG-21"])
    }))

  it.effect("ignores missing blockers and non-Orca work", () =>
    Effect.sync(() => {
      const plan = planIssues([
        issue({
          blockedBy: ["missing-blocker"],
          id: "tagged-1",
          identifier: "ENG-30",
          isOrcaTagged: true,
          priority: 2,
          title: "Tagged work with stale blocker reference",
        }),
        issue({
          id: "unrelated-1",
          identifier: "ENG-99",
          priority: 1,
          title: "Unrelated non-Orca work",
        }),
      ])

      expect(plan.work.map((issue) => issue.identifier)).toEqual(["ENG-30"])
      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-30"])
      expect(plan.blocked).toEqual([])
    }))

  it.effect("treats incomplete subissues as inherited work and blocks the parent", () =>
    Effect.sync(() => {
      const plan = planIssues([
        issue({
          childIds: ["child-1"],
          id: "parent-1",
          identifier: "ENG-40",
          isOrcaTagged: true,
          priority: 2,
          title: "Parent issue",
        }),
        issue({
          id: "child-1",
          identifier: "ENG-41",
          priority: 4,
          title: "Subissue",
        }),
      ])

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-41"])
      expect(plan.blocked.map((issue) => issue.identifier)).toEqual(["ENG-40"])
      expect(plan.actionable[0]?.effectivePriority).toBe(2)
      expect(plan.actionable[0]?.inheritedFrom).toEqual(["ENG-40"])
      expect(plan.blocked[0]?.blockingIssues.map((issue) => issue.identifier)).toEqual(["ENG-41"])
    }))

  it.effect("supports a configurable label for direct Orca work", () =>
    Effect.sync(() => {
      const plan = planIssues(
        [
          issue({
            id: "custom-1",
            identifier: "ENG-60",
            labels: ["Autowrite"],
            title: "Custom labeled work",
          }),
        ],
        { linearLabel: "Autowrite" },
      )

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-60"])
      expect(plan.actionable[0]?.includedBecause).toBe("direct")
    }))

  it.effect("recursively expands blockers of inherited subissues", () =>
    Effect.sync(() => {
      const plan = planIssues([
        issue({
          childIds: ["child-1"],
          id: "parent-1",
          identifier: "ENG-50",
          isOrcaTagged: true,
          priority: 1,
          title: "Parent issue",
        }),
        issue({
          blockedBy: ["dep-1"],
          id: "child-1",
          identifier: "ENG-51",
          priority: 4,
          title: "Subissue",
        }),
        issue({
          id: "dep-1",
          identifier: "ENG-52",
          priority: 4,
          title: "Dependency",
        }),
      ])

      expect(plan.actionable.map((issue) => issue.identifier)).toEqual(["ENG-52"])
      expect(plan.blocked.map((issue) => issue.identifier)).toEqual(["ENG-50", "ENG-51"])
    }))
})

const issue = (
  overrides: Partial<LinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title">,
): LinearIssue => ({
  blockedBy: overrides.blockedBy ?? [],
  childIds: overrides.childIds ?? [],
  createdAtMs: overrides.createdAtMs ?? Date.parse("2026-01-01T00:00:00.000Z"),
  description: overrides.description ?? "",
  id: overrides.id,
  identifier: overrides.identifier,
  isOrcaTagged: overrides.isOrcaTagged ?? false,
  labels: overrides.labels ?? [],
  parentId: overrides.parentId ?? null,
  priority: overrides.priority ?? 0,
  stateId: overrides.stateId ?? `${overrides.id}-state`,
  stateName: overrides.stateName ?? "Unstarted",
  state: overrides.state ?? "unstarted",
  teamStates: overrides.teamStates ?? [],
  title: overrides.title,
})
