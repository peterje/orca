import { ChildProcess } from "effect/unstable/process"

type OutputMode = "pipe" | "inherit" | "ignore"
type InputMode = "pipe" | "inherit" | "ignore"

export const bashPath = "/bin/bash"

export const makeShellCommand = (options: {
  readonly command: string
  readonly cwd: string
  readonly env?: Record<string, string> | undefined
  readonly stderr?: OutputMode | undefined
  readonly stdout?: OutputMode | undefined
  readonly stdin?: InputMode | undefined
}) =>
  ChildProcess.make(bashPath, ["-lc", options.command], {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
    stderr: options.stderr ?? "pipe",
    stdout: options.stdout ?? "pipe",
    stdin: options.stdin ?? "inherit",
  })
