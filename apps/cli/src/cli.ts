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
import { commandStatus } from "./commands/status.ts"
import { LinearApiError } from "./linear.ts"
import {
  LinearAuthRequiredError,
  LinearOAuthError,
} from "./linear/token-manager.ts"
import { MissionControlError } from "./mission-control.ts"
import { OrcaClientError, OrcaClientLayer } from "./orca-client.ts"
import { RepoConfigError, RepoConfigLayer } from "./repo-config.ts"
import { RunnerFailure, RunnerNoWorkError } from "./runner.ts"
import { RunStateBusyError } from "./run-state.ts"
import { PlatformServices } from "./shared/platform.ts"

const program = Command.run(
  commandRoot.pipe(Command.withSubcommands([commandLinear, commandInit, commandIssues, commandRun, commandServe, commandStatus])),
  {
    version: PackageJson.version,
  },
)

const appLayer = Layer.mergeAll(PlatformServices, RepoConfigLayer, OrcaClientLayer.pipe(Layer.provide(RepoConfigLayer)))

const provided = Effect.provide(program, appLayer)

const handled = Effect.catchTags(provided, {
  LinearAuthRequiredError: renderAndExit,
  LinearOAuthError: renderAndExit,
  LinearApiError: renderAndExit,
  MissionControlError: renderAndExit,
  OrcaClientError: renderAndExit,
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
