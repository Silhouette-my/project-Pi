/**
 * Session-lifetime store behind `window.openai.widgetState` for
 * visualization cards (Phase 1).
 *
 * Deliberate limits, restated in the skill and the card bridge:
 * - The snapshot lives only in renderer memory, keyed by card identity. It
 *   survives iframe remounts inside one app run (scrolling a card out and
 *   back, transcript re-renders) but NOT an app restart or a reload.
 * - Nothing is persisted: no schema change, no host round-trip, and the
 *   state is never sent to the model.
 * A later phase that wants durability needs a host-side store and a schema
 * migration; this module is the seam for it.
 */

const states = new Map<string, unknown>();

export function readWidgetState(cardId: string): unknown {
  return states.get(cardId) ?? null;
}

export function writeWidgetState(cardId: string, state: unknown): void {
  states.set(cardId, state ?? null);
}

/** Drop every snapshot; used by tests and on full transcript teardown. */
export function clearWidgetStates(): void {
  states.clear();
}
