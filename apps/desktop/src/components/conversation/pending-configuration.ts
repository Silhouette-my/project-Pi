import { useAppStore } from "../../stores/app-store";
import type { SessionConfigurationInput } from "../../stores/app-state";

/**
 * Apply a model/effort chosen in a detached composer before its conversation
 * existed. The created session keeps its own mode: picking a model never
 * changes what kind of conversation it is.
 */
export async function applyPendingConfiguration(
  sessionId: string,
  configuration: SessionConfigurationInput | undefined,
): Promise<void> {
  if (!configuration) return;
  const store = useAppStore.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  await store.configureSession(sessionId, { ...configuration, mode: session?.mode ?? configuration.mode });
}
