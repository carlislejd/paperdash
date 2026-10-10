import type { StreamMessage } from "../../../../packages/shared/src/types";

type Listener = (message: StreamMessage) => void;
const listeners = new Set<Listener>();

// Panels share the dashboard's single EventSource; mounting a chart never
// opens another stream or reconnects the existing one.
export function publishLiveEvent(message: StreamMessage) {
  for (const listener of listeners) listener(message);
}

export function subscribeLiveEvents(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
