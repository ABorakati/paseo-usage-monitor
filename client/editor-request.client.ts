/**
 * A pending request to open one provider's editor. The composer pill's card
 * and the settings screen never share a React tree — the card lives inside the
 * host's pill on the composer rail, and the settings screen is a surface the
 * host mounts elsewhere — so the request travels through module state rather
 * than props or context.
 *
 * It survives until the settings screen consumes it, because a press opens the
 * surface and the editor cannot open until that surface has mounted and its
 * config has loaded.
 */

let requestedProviderId: string | null = null;
const listeners = new Set<() => void>();

export function requestProviderEditor(providerId: string): void {
  requestedProviderId = providerId;
  for (const listener of listeners) listener();
}

export function clearProviderEditorRequest(): void {
  if (requestedProviderId === null) {
    return;
  }
  requestedProviderId = null;
  for (const listener of listeners) listener();
}

export function subscribeProviderEditorRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readProviderEditorRequest(): string | null {
  return requestedProviderId;
}
