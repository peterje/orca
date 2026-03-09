#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import PackageJson from "../package.json" with { type: "json" }
import { commandInit } from "./commands/init.ts"
import { commandIssues } from "./commands/issues.ts"
import { commandLinear } from "./commands/linear.ts"
import { commandRun } from "./commands/run.ts"
import { commandRoot } from "./commands/root.ts"
import { commandServe } from "./commands/serve.ts"
import { AgentRunnerLayer } from "./agent-runner.ts"
import { GitHubLayer } from "./github.ts"
import { LinearApiError } from "./linear.ts"
import { LinearLayer } from "./linear-layer.ts"
import {
  LinearAuthRequiredError,
  LinearOAuthError,
} from "./linear/token-manager.ts"
import { PromptGenLayer } from "./prompt-gen.ts"
import { RepoConfigError, RepoConfigLayer } from "./repo-config.ts"
import { RunnerFailure, RunnerLayer, RunnerNoWorkError } from "./runner.ts"
import { RunStateBusyError, RunStateLayer } from "./run-state.ts"
import { PlatformServices } from "./shared/platform.ts"
import { VerifierLayer } from "./verifier.ts"
import { WorktreeLayer } from "./worktree.ts"

const program = Command.run(
  commandRoot.pipe(Command.withSubcommands([commandLinear, commandInit, commandIssues, commandRun, commandServe])),
  {
    version: PackageJson.version,
  },
)

const supportLayer = Layer.mergeAll(
  RepoConfigLayer,
  RunStateLayer,
  WorktreeLayer,
  AgentRunnerLayer,
  PromptGenLayer,
  VerifierLayer,
  GitHubLayer,
).pipe(Layer.provide(PlatformServices))

const executionLayer = RunnerLayer.pipe(Layer.provide([LinearLayer, supportLayer]))

const appLayer = Layer.mergeAll(PlatformServices, LinearLayer, supportLayer, executionLayer)

const provided = Effect.provide(program, appLayer)

const handled = Effect.catchTags(provided, {
  LinearAuthRequiredError: renderAndExit,
  LinearOAuthError: renderAndExit,
  LinearApiError: renderAndExit,
  RepoConfigError: renderAndExit,
  RunnerFailure: renderAndExit,
  RunnerNoWorkError: renderAndExit,
  RunStateBusyError: renderAndExit,
})

BunRuntime.runMain(Effect.provide(handled, PlatformServices))

function renderAndExit(error: unknown) {
  return Effect.andThen(Console.error(getErrorMessage(error)), Effect.sync(() => process.exit(1)))
}

function getErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
