import type {
  NumberRange,
  ParameterValue,
  SetResult,
  SettingsRegistry,
} from "foss-earth/settings";

/**
 * The typed machinery of a parameter catalogue, generic over its spec list:
 * each owner instantiates it over its own parameters, and the host over the
 * composed catalogue. Values live in the settings registry; these only type
 * the reads and writes and hold the defaults in memory for code that runs
 * without a registry.
 */

type ValueOf<Spec> = Spec extends { kind: "boolean" } ? boolean
  : Spec extends { kind: "range" } ? NumberRange
  : Spec extends { kind: "choice"; choices: readonly { id: infer Choice }[] } ? Choice
  : Spec extends { kind: "number"; named: readonly { id: infer Named }[] } ? number | Named
  : Spec extends { kind: "number" } ? number
  : string;

/** The effective value of each parameter of a spec list, by id. */
export type CatalogueValues<Specs extends readonly { id: string }[]> = {
  [Spec in Specs[number] as Spec["id"]]: ValueOf<Spec>;
};

/** What code reads parameters through: the registry, or its defaults in a test. */
export interface CatalogueParameters<Values> {
  get<Id extends keyof Values & string>(id: Id): Values[Id];
}

/** Reads, writes and watches parameters, typed by id. */
export interface CatalogueStore<Values> extends CatalogueParameters<Values> {
  set<Id extends keyof Values & string>(id: Id, value: Values[Id]): SetResult;
  /** Several values at once: all are applied, or none. */
  setMany(values: Partial<Values>): SetResult;
  reset(id: keyof Values & string): void;
  /** Called with the effective value whenever it changes. */
  watch<Id extends keyof Values & string>(id: Id, listener: (value: Values[Id]) => void): () => void;
  /** Why values will not survive a reload, or null when they are being saved. */
  storageError(): string | null;
}

/** The part of the settings registry a catalogue store reads and writes through. */
export type CatalogueRegistry = Pick<SettingsRegistry, "get" | "set" | "setMany" | "reset" | "watch" | "getStorageError">;

/** The registry, typed for one catalogue's parameters. */
export function catalogueStore<Values>(registry: CatalogueRegistry): CatalogueStore<Values> {
  return {
    get: id => registry.get(id) as never,
    set: (id, value) => registry.set(id, value as ParameterValue),
    setMany: values => registry.setMany(values as Record<string, ParameterValue>),
    reset: id => registry.reset(id),
    watch: (id, listener) => registry.watch(id, value => listener(value as never)),
    storageError: () => registry.getStorageError(),
  };
}

/** The spec of one parameter of a spec list, by id. */
export function catalogueSpec<Spec extends { id: string }>(
  specs: readonly Spec[],
): <Id extends Spec["id"]>(id: Id) => Extract<Spec, { id: Id }> {
  const byId = new Map<string, Spec>(specs.map(spec => [spec.id, spec]));
  return <Id extends Spec["id"]>(id: Id): Extract<Spec, { id: Id }> => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`Unknown flight parameter ${id}`);
    return spec as Extract<Spec, { id: Id }>;
  };
}

/**
 * A catalogue's defaults in memory, for code that runs without a registry,
 * such as a unit test. Overrides stand in for values the test sets. Writes are
 * not validated and not saved.
 */
export function catalogueDefaults<Values>(
  specOf: (id: never) => { default: unknown },
  overrides: Partial<Values> = {},
): CatalogueStore<Values> {
  const catalogueDefault = (id: string): unknown => {
    const value = specOf(id as never).default;
    return typeof value === "object" ? { ...value } : value;
  };
  const values = new Map<string, unknown>(Object.entries(overrides));
  const listeners = new Map<string, Set<(value: never) => void>>();
  const notify = (id: string): void => {
    for (const listener of [...listeners.get(id) ?? []]) listener(store.get(id as keyof Values & string) as never);
  };
  const store: CatalogueStore<Values> = {
    get(id) {
      return (values.has(id) ? values.get(id) : catalogueDefault(id)) as never;
    },
    set(id, value) {
      values.set(id, value);
      notify(id);
      return { ok: true };
    },
    setMany(next) {
      for (const [id, value] of Object.entries(next)) values.set(id, value);
      for (const id of Object.keys(next)) notify(id);
      return { ok: true };
    },
    reset(id) {
      values.delete(id);
      notify(id);
    },
    watch(id, listener) {
      const set = listeners.get(id) ?? new Set();
      set.add(listener as (value: never) => void);
      listeners.set(id, set);
      return () => { set.delete(listener as (value: never) => void); };
    },
    storageError: () => null,
  };
  return store;
}
