import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Fiber, Layer, Path, Ref, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import { TestClock, TestConsole } from "effect/testing"
import { commandIssues } from "./commands/issues.ts"
import { commandRoot } from "./commands/root.ts"
import { commandServe } from "./commands/serve.ts"
import { Linear, type LinearIssue } from "./linear.ts"

describe("CLI commands", () => {
  it.effect("renders the issues list with actionable and blocked sections", () =>
    Effect.gen(function* () {
      const run = makeCliRunner(commandIssues)

      yield* run(["issues", "list"])

      expect(yield* TestConsole.logLines).toEqual([
        "Actionable",
        "- ENG-1 Fix blocker [priority: Urgent, included to unblock ENG-2]",
        "",
        "Blocked",
        "- ENG-2 Ship feature [blocked by: ENG-1; priority: Urgent, direct Orca issue]",
        "",
        "Dependency graph",
        "- ENG-2 Ship feature [blocked, priority: Urgent, direct]",
        "   \\- dependency: ENG-1 Fix blocker [actionable, priority: Urgent, inherits ENG-2]",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedLinearLayer([
            issue({ id: "blocker-1", identifier: "ENG-1", title: "Fix blocker" }),
            issue({
              blockedBy: ["blocker-1"],
              id: "tagged-1",
              identifier: "ENG-2",
              isOrcaTagged: true,
              priority: 1,
              title: "Ship feature",
            }),
          ]),
        ),
      ),
    ))

  it.effect("renders inherited subissues as actionable work before the tagged parent", () =>
    Effect.gen(function* () {
      const run = makeCliRunner(commandIssues)

      yield* run(["issues", "list"])

      expect(yield* TestConsole.logLines).toEqual([
        "Actionable",
        "- ENG-11 Subissue [priority: High, included to unblock ENG-10]",
        "",
        "Blocked",
        "- ENG-10 Parent [blocked by: ENG-11; priority: High, direct Orca issue]",
        "",
        "Dependency graph",
        "- ENG-10 Parent [blocked, priority: High, direct]",
        "   \\- subissue: ENG-11 Subissue [actionable, priority: High, inherits ENG-10]",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedLinearLayer([
            issue({
              childIds: ["child-1"],
              id: "parent-1",
              identifier: "ENG-10",
              isOrcaTagged: true,
              priority: 2,
              title: "Parent",
            }),
            issue({
              id: "child-1",
              identifier: "ENG-11",
              parentId: "parent-1",
              title: "Subissue",
            }),
          ]),
        ),
      ),
    ))

  it.effect("renders the dependency graph even when nothing is blocked", () =>
    Effect.gen(function* () {
      const run = makeCliRunner(commandIssues)

      yield* run(["issues", "list"])

      expect(yield* TestConsole.logLines).toEqual([
        "Actionable",
        "- ENG-1 Ready issue [priority: High, direct Orca issue]",
        "",
        "Blocked",
        "- None",
        "",
        "Dependency graph",
        "- ENG-1 Ready issue [actionable, priority: High, direct]",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedLinearLayer([
            issue({
              id: "ready-1",
              identifier: "ENG-1",
              isOrcaTagged: true,
              priority: 2,
              title: "Ready issue",
            }),
          ]),
        ),
      ),
    ))

  it.effect("renders nested dependency chains in the graph", () =>
    Effect.gen(function* () {
      const run = makeCliRunner(commandIssues)

      yield* run(["issues", "list"])

      expect(yield* TestConsole.logLines).toEqual([
        "Actionable",
        "- ENG-3 Dependency [priority: Urgent, included to unblock ENG-1]",
        "",
        "Blocked",
        "- ENG-1 Parent [blocked by: ENG-2; priority: Urgent, direct Orca issue]",
        "- ENG-2 Child [blocked by: ENG-3; priority: Urgent, included to unblock ENG-1]",
        "",
        "Dependency graph",
        "- ENG-1 Parent [blocked, priority: Urgent, direct]",
        "   \\- subissue: ENG-2 Child [blocked, priority: Urgent, inherits ENG-1]",
        "      \\- dependency: ENG-3 Dependency [actionable, priority: Urgent, inherits ENG-1]",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedLinearLayer([
            issue({
              childIds: ["child-1"],
              id: "parent-1",
              identifier: "ENG-1",
              isOrcaTagged: true,
              priority: 1,
              title: "Parent",
            }),
            issue({
              blockedBy: ["dep-1"],
              id: "child-1",
              identifier: "ENG-2",
              parentId: "parent-1",
              title: "Child",
            }),
            issue({
              id: "dep-1",
              identifier: "ENG-3",
              title: "Dependency",
            }),
          ]),
        ),
      ),
    ))

  it.effect("serve only logs when the selected issue changes or work disappears", () =>
    Effect.gen(function* () {
      const run = makeCliRunner(commandServe)
      const fiber = yield* Effect.forkChild(run(["serve", "--interval-seconds", "1"]))

      yield* Effect.yieldNow
      yield* TestClock.adjust(4_000)
      yield* Fiber.interrupt(fiber)

      expect(yield* TestConsole.logLines).toEqual([
        "Would implement: ENG-1 First issue",
        "Would implement: ENG-2 Second issue",
        "No actionable Orca work is currently available.",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          sequencingLinearLayer([
            [issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, priority: 1, title: "First issue" })],
            [issue({ id: "issue-1", identifier: "ENG-1", isOrcaTagged: true, priority: 1, title: "First issue" })],
            [issue({ id: "issue-2", identifier: "ENG-2", isOrcaTagged: true, priority: 1, title: "Second issue" })],
            [],
            [],
          ]),
        ),
      ),
    ))
})

const makeCliRunner = (...subcommands: Array<typeof commandIssues | typeof commandServe>) =>
  Command.runWith(commandRoot.pipe(Command.withSubcommands(subcommands)), { version: "0.0.0" })

const cliEnvironmentLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("not used in this test"),
      readLine: Effect.succeed(""),
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("not used in this test")),
  ),
  Stdio.layerTest({}),
)

const fixedLinearLayer = (issues: ReadonlyArray<LinearIssue>) =>
  Layer.succeed(
    Linear,
    Linear.of({
      authenticate: Effect.die("not used in this test"),
      issues: Effect.succeed(issues),
      viewer: Effect.die("not used in this test"),
    }),
  )

const sequencingLinearLayer = (snapshots: ReadonlyArray<ReadonlyArray<LinearIssue>>) =>
  Layer.effect(
    Linear,
    Effect.gen(function* () {
      const index = yield* Ref.make(0)

      return Linear.of({
        authenticate: Effect.die("not used in this test"),
        issues: Ref.modify(index, (current) => [snapshots[Math.min(current, snapshots.length - 1)] ?? [], current + 1]),
        viewer: Effect.die("not used in this test"),
      })
    }),
  )

const issue = (overrides: Partial<LinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title">): LinearIssue => ({
  blockedBy: overrides.blockedBy ?? [],
  childIds: overrides.childIds ?? [],
  createdAtMs: overrides.createdAtMs ?? Date.parse("2026-01-01T00:00:00.000Z"),
  id: overrides.id,
  identifier: overrides.identifier,
  isOrcaTagged: overrides.isOrcaTagged ?? false,
  labels: overrides.labels ?? [],
  parentId: overrides.parentId ?? null,
  priority: overrides.priority ?? 0,
  state: overrides.state ?? "unstarted",
  title: overrides.title,
})
