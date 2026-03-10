import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect"
import type { OrcaServerEvent } from "./orca-server-protocol.ts"

export type OrcaEventsService = {
  readonly publish: (event: OrcaServerEvent) => Effect.Effect<void>
  readonly stream: Stream.Stream<OrcaServerEvent>
}

export const OrcaEvents = ServiceMap.Service<OrcaEventsService>("orca/OrcaEvents")

export const OrcaEventsLayer = Layer.effect(
  OrcaEvents,
  Effect.gen(function* () {
    // No replay: new SSE clients only receive events published after they subscribe.
    const pubsub = yield* PubSub.unbounded<OrcaServerEvent>()

    return OrcaEvents.of({
      publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
      stream: Stream.fromPubSub(pubsub),
    })
  }),
)
