import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

export type SettingsService = {
  get: <S extends Schema.Top>(
    setting: Setting<string, S>,
  ) => Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]>
  set: <S extends Schema.Top>(
    setting: Setting<string, S>,
    value: Option.Option<S["Type"]>,
  ) => Effect.Effect<void, never, S["EncodingServices"]>
}

export const Settings = ServiceMap.Service<SettingsService>("orca/Settings")

export const SettingsLive = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const kvs = yield* KeyValueStore.KeyValueStore
    const store = KeyValueStore.prefix(kvs, "settings.")

    const get = <S extends Schema.Top>(setting: Setting<string, S>) =>
      Effect.orDie(KeyValueStore.toSchemaStore(store, setting.schema).get(setting.name))

    const set = <S extends Schema.Top>(
      setting: Setting<string, S>,
      value: Option.Option<S["Type"]>,
    ) => {
      const schemaStore = KeyValueStore.toSchemaStore(store, setting.schema)
      return Option.match(value, {
        onNone: () => Effect.ignore(schemaStore.remove(setting.name)),
        onSome: (stored: S["Type"]) => Effect.orDie(schemaStore.set(setting.name, stored)),
      })
    }

    return Settings.of({ get, set })
  }),
)

export class Setting<const Name extends string, S extends Schema.Top> {
  readonly name: Name
  readonly schema: S

  constructor(name: Name, schema: S) {
    this.name = name
    this.schema = schema
  }
}
