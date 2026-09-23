import type { Params, Rig, RigRegistry } from './types';

/**
 * Build a registry from a list of rigs. Throws on a duplicate id, and on a
 * variant ("base.variant") that could not stand in for its base in an
 * override: its base must be registered, and it must keep every base param
 * with the same type and every base part. It may add params and parts.
 */
export function createRegistry(rigs: readonly Rig[]): RigRegistry {
  const map = new Map<string, Rig>();
  for (const rig of rigs) {
    if (map.has(rig.id)) throw new Error(`duplicate rig id "${rig.id}" in registry`);
    map.set(rig.id, rig);
  }
  const problems: string[] = [];
  for (const rig of map.values()) {
    const baseId = baseRigId(rig.id);
    if (baseId !== rig.id) problems.push(...variantProblems(rig, baseId, map));
  }
  if (problems.length > 0) {
    throw new Error(`invalid rig variants:\n- ${problems.join('\n- ')}`);
  }
  return map;
}

/** Why a variant cannot swap in for its base, one message per problem. */
function variantProblems(rig: Rig, baseId: string, map: ReadonlyMap<string, Rig>): string[] {
  const who = `variant rig "${rig.id}"`;
  const base = map.get(baseId);
  if (!base) {
    return [`${who} needs its base rig "${baseId}", which is not registered; register "${baseId}" too, or rename the rig without a "."`];
  }
  const out: string[] = [];
  for (const [name, spec] of Object.entries(base.params)) {
    const own = Object.hasOwn(rig.params, name) ? rig.params[name] : undefined;
    if (!own) {
      out.push(`${who} lacks param "${name}" of its base rig "${baseId}"; a variant must accept every base param so an override can swap it in`);
    } else if (own.type !== spec.type) {
      out.push(`${who} declares param "${name}" as ${own.type}, but its base rig "${baseId}" declares it as ${spec.type}; use the same type`);
    }
  }
  const parts = new Set(rig.parts ?? []);
  for (const part of base.parts ?? []) {
    if (!parts.has(part)) {
      out.push(`${who} drops part "${part}" of its base rig "${baseId}"; a variant keeps every base part (it may add more) so part selections survive the swap`);
    }
  }
  return out;
}

/** A fresh Params object holding every schema default. */
export function defaultParams(rig: Rig): Params {
  const out: Params = {};
  for (const [name, spec] of Object.entries(rig.params)) out[name] = spec.default;
  return out;
}

/** The base rig id of a variant: "fly.wingTorn" -> "fly". A base rig id maps to itself. */
export function baseRigId(id: string): string {
  const dot = id.indexOf('.');
  return dot < 0 ? id : id.slice(0, dot);
}

/** Every registered variant of a base rig ("base.x"), in registry order. */
export function variantsOf(registry: RigRegistry, baseId: string): Rig[] {
  return [...registry.values()].filter((rig) => rig.id !== baseId && baseRigId(rig.id) === baseId);
}
