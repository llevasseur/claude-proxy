import { useSyncExternalStore } from 'react';

let models: readonly string[] = [];
const listeners = new Set<() => void>();

export function recordObservedModels(observed: Iterable<string>): void {
  const next = new Set(models);
  let changed = false;
  for (const model of observed) {
    if (!next.has(model)) {
      next.add(model);
      changed = true;
    }
  }
  if (!changed) return;
  models = [...next].sort((left, right) => left.localeCompare(right));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly string[] {
  return models;
}

export function useObservedModels(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
