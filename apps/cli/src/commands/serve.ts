import { Console, Duration, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { planIssues } from "../issue-planner.ts"
import { Linear } from "../linear.ts"

const noWorkHeartbeatEvery = 10

export const commandServe = Command.make(
  "serve",
  {
    intervalSeconds: Flag.integer("interval-seconds").pipe(
      Flag.withDescription("Polling interval in seconds."),
      Flag.withDefault(30),
    ),
  },
  Effect.fn("commandServe")(function* ({ intervalSeconds }) {
    const linear = yield* Linear
    let previousTopIssueId: string | null = null
    let emptyPolls = 0

    while (true) {
      const issues = yield* linear.issues
      const plan = planIssues(issues)
      const topIssue = plan.actionable[0]

      if (topIssue) {
        emptyPolls = 0
        if (topIssue.id !== previousTopIssueId) {
          yield* Console.log(`Would implement: ${topIssue.identifier} ${topIssue.title}`)
          previousTopIssueId = topIssue.id
        }
      } else {
        emptyPolls += 1
        if (previousTopIssueId !== null || emptyPolls === 1 || emptyPolls % noWorkHeartbeatEvery === 0) {
          yield* Console.log("No actionable Orca work is currently available.")
          previousTopIssueId = null
        }
      }

      yield* Effect.sleep(Duration.seconds(intervalSeconds))
    }
  }),
).pipe(Command.withDescription("Poll Linear and print the next Orca issue."))
