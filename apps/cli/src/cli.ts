#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import PackageJson from "../package.json" with { type: "json" }
import { commandIssues } from "./commands/issues.ts"
import { commandLinear } from "./commands/linear.ts"
import { commandRoot } from "./commands/root.ts"
import { commandServe } from "./commands/serve.ts"
import { LinearApiError } from "./linear.ts"
import { LinearLayer } from "./linear-layer.ts"
import {
  LinearAuthRequiredError,
  LinearOAuthError,
} from "./linear/token-manager.ts"
import { PlatformServices } from "./shared/platform.ts"

commandRoot.pipe(
  Command.withSubcommands([commandLinear, commandIssues, commandServe]),
  Command.run({
    version: PackageJson.version,
  }),
  Effect.provide(Layer.mergeAll(PlatformServices, LinearLayer)),
  Effect.catchTags({
    LinearAuthRequiredError: renderAndExit,
    LinearOAuthError: renderAndExit,
    LinearApiError: renderAndExit,
  }),
  BunRuntime.runMain,
)

function renderAndExit(
  error: LinearAuthRequiredError | LinearOAuthError | LinearApiError,
) {
  return Effect.andThen(Console.error(getErrorMessage(error)), Effect.sync(() => process.exit(1)))
}

function getErrorMessage(error: LinearAuthRequiredError | LinearOAuthError | LinearApiError) {
  if ("message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
