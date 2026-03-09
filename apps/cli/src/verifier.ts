import { Data, Effect, Fiber, Layer, ServiceMap, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { makeShellCommand } from "./shared/shell.ts"

export type VerificationStepResult = {
  readonly command: string
  readonly exitCode: number
  readonly output: string
}

export type VerifierService = {
  run: (options: {
    readonly commands: ReadonlyArray<string>
    readonly cwd: string
  }) => Effect.Effect<ReadonlyArray<VerificationStepResult>, VerificationError>
}

export const Verifier = ServiceMap.Service<VerifierService>("orca/Verifier")

export const VerifierLive = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const run = (options: {
    readonly commands: ReadonlyArray<string>
    readonly cwd: string
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const results: Array<VerificationStepResult> = []
        for (const command of options.commands) {
          const handle = yield* spawner.spawn(
            makeShellCommand({
              command,
              cwd: options.cwd,
            }),
          ).pipe(
            Effect.mapError((cause) => new VerificationError({ message: `Failed to start verification command: ${command}`, cause, results })),
          )

          let output = ""
          const outputFiber = yield* handle.all.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                output += chunk
                process.stdout.write(chunk)
              })),
            Effect.forkScoped,
          )

          const exitCode = yield* handle.exitCode.pipe(
            Effect.ensuring(Fiber.interrupt(outputFiber)),
            Effect.mapError((cause) => new VerificationError({ message: `Verification command failed to exit cleanly: ${command}`, cause, results })),
          )

          const result = { command, exitCode, output } satisfies VerificationStepResult
          results.push(result)
          if (exitCode !== 0) {
            return yield* Effect.fail(
              new VerificationError({
                message: `Verification failed for command: ${command}`,
                results,
              }),
            )
          }
        }

        return results
      }),
    )

  return Verifier.of({ run })
})

export const VerifierLayer = Layer.effect(Verifier, VerifierLive)

export class VerificationError extends Data.TaggedError("VerificationError")<{
  readonly message: string
  readonly results: ReadonlyArray<VerificationStepResult>
  readonly cause?: unknown
}> {}
