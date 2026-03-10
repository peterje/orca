import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Fiber, Layer, Option, Path, Ref, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import { TestClock, TestConsole } from "effect/testing"
import { commandIssues } from "./commands/issues.ts"
import { commandRoot } from "./commands/root.ts"
import { commandServe } from "./commands/serve.ts"
import { commandStatus } from "./commands/status.ts"
import { Linear, type LinearIssue } from "./linear.ts"
import { MissionControl, type MissionControlSnapshot } from "./mission-control.ts"
import { RepoConfig, RepoConfigData } from "./repo-config.ts"
import { RunState, type ActiveRun } from "./run-state.ts"
import { Runner, RunnerFailure } from "./runner.ts"

describe("CLI commands", () => {
  it.effect("renders the issues list with actionable and blocked sections", () =>
    Effect.gen(function* () {
      const run = makeIssuesCliRunner()

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
      const run = makeIssuesCliRunner()

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
      const run = makeIssuesCliRunner()

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

  it.effect("uses repo-local label and workspace filters for issues list", () =>
    Effect.gen(function* () {
      const run = makeIssuesCliRunner()

      yield* run(["issues", "list"])

      expect(yield* TestConsole.logLines).toEqual([
        "Actionable",
        "- ENG-2 Workspace match [priority: None, direct Orca issue]",
        "",
        "Blocked",
        "- None",
        "",
        "Dependency graph",
        "- ENG-2 Workspace match [actionable, priority: None, direct]",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedRepoConfigLayer({ linearLabel: "Autowrite", linearWorkspace: "coteachai" }),
          fixedLinearLayer([
            issue({ id: "default-1", identifier: "ENG-1", isOrcaTagged: true, title: "Default workspace" }),
            issue({ id: "custom-1", identifier: "ENG-2", labels: ["Autowrite"], title: "Workspace match", workspaceSlug: "coteachai" }),
          ]),
        ),
      ),
    ))

  it.effect("renders nested dependency chains in the graph", () =>
    Effect.gen(function* () {
      const run = makeIssuesCliRunner()

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
      const run = makeServeCliRunner()
      const fiber = yield* Effect.forkChild(run(["serve", "--interval-seconds", "1"]))

      yield* Effect.yieldNow
      yield* TestClock.adjust(4_000)
      yield* Fiber.interrupt(fiber)

      expect(yield* TestConsole.logLines).toEqual([
        "Mission control",
        "- current: idle",
        "- next: ENG-1 First issue - ready to pick up",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
        "Mission control",
        "- current: idle",
        "- next: ENG-2 Second issue - ready to pick up",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
        "Mission control",
        "- current: idle",
        "- next: nothing ready right now",
        "- issue queue: 0 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          sequencingMissionControlLayer([
            snapshot({ next: { issueIdentifier: "ENG-1", issueTitle: "First issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({ next: { issueIdentifier: "ENG-1", issueTitle: "First issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({ next: { issueIdentifier: "ENG-2", issueTitle: "Second issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({}),
            snapshot({}),
          ]),
          sequencingRunnerLayer([Option.none(), Option.none(), Option.none()]),
        ),
      ),
    ))

  it.effect("serve previews review work before implementation work", () =>
    Effect.gen(function* () {
      const run = makeServeCliRunner()
      const fiber = yield* Effect.forkChild(run(["serve", "--interval-seconds", "1"]))

      yield* Effect.yieldNow
      yield* TestClock.adjust(2_000)
      yield* Fiber.interrupt(fiber)

      expect(yield* TestConsole.logLines).toEqual([
        "Mission control",
        "- current: idle",
        "- next: ENG-9 Existing PR - review feedback ready",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 1 ready for follow-up",
        "Mission control",
        "- current: idle",
        "- next: ENG-10 New issue - ready to pick up",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          sequencingMissionControlLayer([
            snapshot({
              issues: { blockedCount: 0, readyToPickUpCount: 1 },
              next: { issueIdentifier: "ENG-9", issueTitle: "Existing PR", stage: "review-feedback-ready" },
              reviews: { readyForFollowUpCount: 1, waitingForReviewCount: 0 },
            }),
            snapshot({ next: { issueIdentifier: "ENG-10", issueTitle: "New issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({ next: { issueIdentifier: "ENG-10", issueTitle: "New issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
          ]),
          sequencingRunnerLayer([Option.none(), Option.none(), Option.none()]),
        ),
      ),
    ))

  it.effect("serve keeps polling when waiting pull request polling fails", () =>
    Effect.gen(function* () {
      const run = makeServeCliRunner()
      const fiber = yield* Effect.forkChild(run(["serve", "--interval-seconds", "1"]))

      yield* Effect.yieldNow
      yield* TestClock.adjust(2_000)
      yield* Fiber.interrupt(fiber)

      expect(yield* TestConsole.logLines).toEqual([
        "Mission control",
        "- current: idle",
        "- next: ENG-1 First issue - ready to pick up",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
        "Mission control",
        "- current: idle",
        "- next: ENG-2 Second issue - ready to pick up",
        "- issue queue: 1 ready to pick up, 0 blocked",
        "- review queue: 0 waiting for review, 0 ready for follow-up",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          sequencingMissionControlLayer([
            snapshot({ next: { issueIdentifier: "ENG-1", issueTitle: "First issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({ next: { issueIdentifier: "ENG-2", issueTitle: "Second issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
            snapshot({ next: { issueIdentifier: "ENG-2", issueTitle: "Second issue", stage: "ready-to-pick-up" }, issues: { blockedCount: 0, readyToPickUpCount: 1 } }),
          ]),
          sequencingRunnerLayer(
            [Option.none(), Option.none(), Option.none()],
            { pollWaitingPullRequests: Effect.fail(new RunnerFailure({ message: "boom" })) },
          ),
        ),
      ),
    ))

  it.effect("status renders the current mission control snapshot", () =>
    Effect.gen(function* () {
      const run = makeStatusCliRunner()

      yield* run(["status"])

      expect(yield* TestConsole.logLines).toEqual([
        "Mission control",
        "- current: ENG-11 Active issue - running verification",
        "- next: ENG-12 Next issue - ready to pick up",
        "- issue queue: 2 ready to pick up, 1 blocked",
        "- review queue: 1 waiting for review, 1 ready for follow-up",
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliEnvironmentLayer,
          TestConsole.layer,
          fixedMissionControlLayer(snapshot({
            current: { issueIdentifier: "ENG-11", issueTitle: "Active issue", stage: "verifying" },
            issues: { blockedCount: 1, readyToPickUpCount: 2 },
            next: { issueIdentifier: "ENG-12", issueTitle: "Next issue", stage: "ready-to-pick-up" },
            reviews: { readyForFollowUpCount: 1, waitingForReviewCount: 1 },
          })),
        ),
      ),
    ))
})

const makeIssuesCliRunner = () =>
  Command.runWith(commandRoot.pipe(Command.withSubcommands([commandIssues])), { version: "0.0.0" })

const makeServeCliRunner = () =>
  Command.runWith(commandRoot.pipe(Command.withSubcommands([commandServe])), { version: "0.0.0" })

const makeStatusCliRunner = () =>
  Command.runWith(commandRoot.pipe(Command.withSubcommands([commandStatus])), { version: "0.0.0" })

const cliEnvironmentLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Layer.succeed(
    RunState,
    RunState.of({
      acquire: () => Effect.die("not used in this test"),
      clear: Effect.void,
      current: Effect.succeed(null as ActiveRun | null),
      update: () => Effect.succeed(null as ActiveRun | null),
    }),
  ),
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
  Layer.succeed(
    RepoConfig,
    RepoConfig.of({
      bootstrap: () => Effect.die("not used in this test"),
      configPath: Effect.die("not used in this test"),
      document: Effect.die("not used in this test"),
      exists: Effect.die("not used in this test"),
      read: Effect.succeed(makeRepoConfigData({})),
      readOption: Effect.succeed(makeRepoConfigData({})),
      write: () => Effect.die("not used in this test"),
    }),
  ),
  Stdio.layerTest({}),
)

type TestLinearIssue = LinearIssue & {
  readonly workspaceSlug?: string | undefined
}

const fixedLinearLayer = (issues: ReadonlyArray<TestLinearIssue>) =>
  Layer.succeed(
    Linear,
    Linear.of({
      authenticate: Effect.die("not used in this test"),
      commentOnIssue: () => Effect.die("not used in this test"),
      issues: (options) => Effect.succeed(filterIssuesByWorkspace(issues, options?.workspaceSlug)),
      markIssueInProgress: () => Effect.die("not used in this test"),
      viewer: Effect.die("not used in this test"),
    }),
  )

const sequencingLinearLayer = (snapshots: ReadonlyArray<ReadonlyArray<TestLinearIssue>>) =>
  Layer.effect(
    Linear,
    Effect.gen(function* () {
      const index = yield* Ref.make(0)

      return Linear.of({
        authenticate: Effect.die("not used in this test"),
        commentOnIssue: () => Effect.die("not used in this test"),
        issues: (options) =>
          Ref.modify(index, (current) => {
            const issues = snapshots[Math.min(current, snapshots.length - 1)] ?? []
            return [filterIssuesByWorkspace(issues, options?.workspaceSlug), current + 1]
          }),
        markIssueInProgress: () => Effect.die("not used in this test"),
        viewer: Effect.die("not used in this test"),
      })
    }),
  )

const fixedRepoConfigLayer = (config: { readonly linearLabel?: string | undefined; readonly linearWorkspace?: string | undefined }) =>
  Layer.succeed(
    RepoConfig,
    RepoConfig.of({
      bootstrap: () => Effect.die("not used in this test"),
      configPath: Effect.die("not used in this test"),
      document: Effect.die("not used in this test"),
      exists: Effect.die("not used in this test"),
      read: Effect.succeed(makeRepoConfigData(config)),
      readOption: Effect.succeed(makeRepoConfigData(config)),
      write: () => Effect.die("not used in this test"),
    }),
  )

const sequencingRunnerLayer = (
  snapshots: ReadonlyArray<Option.Option<{ readonly id: string; readonly issueIdentifier: string; readonly kind: "implementation"; readonly title: string } | { readonly id: string; readonly issueIdentifier: string; readonly kind: "review"; readonly pullRequestNumber: number; readonly pullRequestUrl: string; readonly title: string }>>,
  options?: {
    readonly pollWaitingPullRequests?: Effect.Effect<void, RunnerFailure>
  },
) =>
  Layer.effect(
    Runner,
    Effect.gen(function* () {
      const index = yield* Ref.make(0)

      return Runner.of({
        peekNext: Ref.modify(index, (current) => [snapshots[Math.min(current, snapshots.length - 1)] ?? Option.none(), current + 1]),
        pollWaitingPullRequests: options?.pollWaitingPullRequests ?? Effect.void,
        runNext: Effect.die("not used in this test"),
      })
    }),
  )

const fixedMissionControlLayer = (mission: MissionControlSnapshot) =>
  Layer.succeed(
    MissionControl,
    MissionControl.of({
      snapshot: Effect.succeed(mission),
    }),
  )

const sequencingMissionControlLayer = (snapshots: ReadonlyArray<MissionControlSnapshot>) =>
  Layer.effect(
    MissionControl,
    Effect.gen(function* () {
      const index = yield* Ref.make(0)

      return MissionControl.of({
        snapshot: Ref.modify(index, (current) => [snapshots[Math.min(current, snapshots.length - 1)] ?? snapshot({}), current + 1]),
      })
    }),
  )

const snapshot = (overrides?: Partial<MissionControlSnapshot>): MissionControlSnapshot => ({
  current: overrides?.current ?? null,
  issues: {
    blockedCount: overrides?.issues?.blockedCount ?? 0,
    readyToPickUpCount: overrides?.issues?.readyToPickUpCount ?? 0,
  },
  next: overrides?.next ?? null,
  reviews: {
    readyForFollowUpCount: overrides?.reviews?.readyForFollowUpCount ?? 0,
    waitingForReviewCount: overrides?.reviews?.waitingForReviewCount ?? 0,
  },
})

const issue = (overrides: Partial<TestLinearIssue> & Pick<LinearIssue, "id" | "identifier" | "title">): TestLinearIssue => ({
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
  workspaceSlug: overrides.workspaceSlug,
})

const filterIssuesByWorkspace = (issues: ReadonlyArray<TestLinearIssue>, workspaceSlug: string | undefined) => {
  const normalizedWorkspaceSlug = workspaceSlug?.trim().toLowerCase()

  return normalizedWorkspaceSlug === undefined || normalizedWorkspaceSlug.length === 0
    ? issues
    : issues.filter((issue) => issue.workspaceSlug?.toLowerCase() === normalizedWorkspaceSlug)
}

function makeRepoConfigData(overrides: { readonly linearLabel?: string | undefined; readonly linearWorkspace?: string | undefined }) {
  return new RepoConfigData({
    agent: "opencode",
    agentArgs: [],
    agentTimeoutMinutes: 45,
    baseBranch: "main",
    branchPrefix: "orca",
    cleanupWorktreeOnSuccess: true,
    draftPr: true,
    greptilePollIntervalSeconds: 30,
    linearLabel: overrides.linearLabel ?? "Orca",
    ...(overrides.linearWorkspace === undefined ? {} : { linearWorkspace: overrides.linearWorkspace }),
    maxWaitingPullRequests: 4,
    repo: "peterje/orca",
    setup: ["bun install"],
    stallTimeoutMinutes: 10,
    verify: ["bun run check"],
  })
}
