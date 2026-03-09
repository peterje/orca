import { Data, Duration, Effect, Fiber, Layer, Option, Ref, ServiceMap, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type AgentRunnerService = {
  run: (options: {
    readonly agent: "opencode" | "codex"
    readonly agentArgs: ReadonlyArray<string>
    readonly cwd: string
    readonly prompt: string
    readonly promptFilePath: string
    readonly stallTimeoutMinutes: number
    readonly timeoutMinutes: number
  }) => Effect.Effect<void, AgentRunnerError | AgentRunnerStalledError | AgentRunnerTimeoutError>
}

export const AgentRunner = ServiceMap.Service<AgentRunnerService>("orca/AgentRunner")

export const AgentRunnerLive = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const run = (options: {
    readonly agent: "opencode" | "codex"
    readonly agentArgs: ReadonlyArray<string>
    readonly cwd: string
    readonly prompt: string
    readonly promptFilePath: string
    readonly stallTimeoutMinutes: number
    readonly timeoutMinutes: number
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* buildCommand(options).pipe(
          spawner.spawn,
          Effect.mapError((cause) => new AgentRunnerError({ message: `Failed to launch ${options.agent}.`, cause })),
        )
        const lastOutputAt = yield* Ref.make(Date.now())

        const outputFiber = yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* Ref.set(lastOutputAt, Date.now())
              yield* Effect.sync(() => process.stdout.write(chunk))
            })),
          Effect.forkScoped,
        )

        const stallWatcher = watchForStall({
          handle,
          lastOutputAt,
          stallTimeout: Duration.minutes(options.stallTimeoutMinutes),
        })

        const timedExitCode = yield* handle.exitCode.pipe(
          Effect.raceFirst(stallWatcher),
          Effect.timeoutOption(Duration.minutes(options.timeoutMinutes)),
          Effect.tapError(() => handle.kill().pipe(Effect.catch(() => Effect.void))),
          Effect.ensuring(Fiber.interrupt(outputFiber)),
          Effect.mapError((cause) =>
            cause instanceof AgentRunnerStalledError || cause instanceof AgentRunnerTimeoutError
              ? cause
              : new AgentRunnerError({ message: `Failed while running ${options.agent}.`, cause }),
          ),
        )

        const exitCode = yield* Option.match(timedExitCode, {
          onNone: () =>
            Effect.fail(
              new AgentRunnerTimeoutError({
                message: `${options.agent} timed out after ${options.timeoutMinutes} minutes.`,
              }),
            ),
          onSome: (exitCode) => Effect.succeed(exitCode),
        })

        if (exitCode !== 0) {
          return yield* Effect.fail(
            new AgentRunnerError({ message: `${options.agent} exited with status ${exitCode}.` }),
          )
        }
      }),
    )

  return AgentRunner.of({ run })
})

export const AgentRunnerLayer = Layer.effect(AgentRunner, AgentRunnerLive)

export class AgentRunnerError extends Data.TaggedError("AgentRunnerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AgentRunnerStalledError extends Data.TaggedError("AgentRunnerStalledError")<{
  readonly message: string
}> {}

export class AgentRunnerTimeoutError extends Data.TaggedError("AgentRunnerTimeoutError")<{
  readonly message: string
}> {}

const buildCommand = (options: {
  readonly agent: "opencode" | "codex"
  readonly agentArgs: ReadonlyArray<string>
  readonly cwd: string
  readonly prompt: string
  readonly promptFilePath: string
}) => {
  if (options.agent === "codex") {
    return ChildProcess.make(
      "codex",
      [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        ...options.agentArgs,
        `@${options.promptFilePath}\n\n${options.prompt}`,
      ],
      {
        cwd: options.cwd,
        stderr: "pipe",
        stdout: "pipe",
        stdin: "inherit",
      },
    )
  }

  return ChildProcess.make(
    "opencode",
    ["run", options.prompt, "--thinking", ...options.agentArgs, "-f", options.promptFilePath],
    {
      cwd: options.cwd,
      env: {
        OPENCODE_PERMISSION: '{"*":"allow", "question":"deny"}',
      },
      extendEnv: true,
      stderr: "pipe",
      stdout: "pipe",
      stdin: "inherit",
    },
  )
}

const watchForStall = (options: {
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly lastOutputAt: Ref.Ref<number>
  readonly stallTimeout: Duration.Duration
}) =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.seconds(5))
      const running = yield* options.handle.isRunning.pipe(Effect.orElseSucceed(() => false))
      if (!running) {
        return
      }
      const lastOutput = yield* Ref.get(options.lastOutputAt)
      const elapsed = Date.now() - lastOutput
      if (elapsed > Duration.toMillis(options.stallTimeout)) {
        yield* options.handle.kill().pipe(Effect.catch(() => Effect.void))
        return yield* Effect.fail(
          new AgentRunnerStalledError({
            message: `Agent stalled for more than ${Math.max(1, Math.round(Duration.toMinutes(options.stallTimeout)))} minutes.`,
          }),
        )
      }
    }),
  )
