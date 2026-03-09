import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { RepoConfig } from "../repo-config.ts"

export const commandInit = Command.make(
  "init",
  {
    agent: Flag.choice("agent", ["opencode", "codex"]).pipe(
      Flag.withDescription("Execution agent to use for self-writing runs."),
      Flag.withDefault("opencode"),
    ),
    baseBranch: Flag.string("base-branch").pipe(
      Flag.withDescription("Base branch for Orca worktrees and pull requests."),
      Flag.withDefault("main"),
    ),
    branchPrefix: Flag.string("branch-prefix").pipe(
      Flag.withDescription("Prefix for generated Orca branches."),
      Flag.withDefault("orca"),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Overwrite the existing repo config if present."),
    ),
    linearLabel: Flag.string("linear-label").pipe(
      Flag.withDescription("Linear label used to select executable issues."),
      Flag.withDefault("Orca"),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("GitHub repo in owner/name format."),
      Flag.withDefault("owner/name"),
    ),
  },
  Effect.fn("commandInit")(function* ({ agent, baseBranch, branchPrefix, force, linearLabel, repo }) {
    const repoConfig = yield* RepoConfig
    const config = yield* repoConfig.bootstrap({
      agent,
      baseBranch,
      branchPrefix,
      force,
      linearLabel,
      repo: repo === "owner/name" ? undefined : repo,
    })
    const path = yield* repoConfig.configPath

    yield* Console.log(`Initialized Orca repo config at ${path}.`)
    yield* Console.log(`Repo: ${config.repo}`)
    yield* Console.log(`Base branch: ${config.baseBranch}`)
    yield* Console.log(`Agent: ${config.agent}`)
    yield* Console.log(`Verification: ${config.verify.length > 0 ? config.verify.join(", ") : "none configured"}`)
  }),
).pipe(Command.withDescription("Bootstrap repo-local Orca config under ./.orca/."))
