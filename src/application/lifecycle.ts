export type BackgroundLifecycleEvents = {
  onStartup: { addListener(listener: () => void): void };
  onInstalled: { addListener(listener: () => void): void };
};

/** Connect browser lifecycle events to the service's single reconciliation entrypoint. */
export function registerBackgroundLifecycle(
  runtime: BackgroundLifecycleEvents,
  reconcile: () => Promise<void>
): void {
  const enqueueReconciliation = (): void => {
    void reconcile();
  };

  enqueueReconciliation();
  runtime.onStartup.addListener(enqueueReconciliation);
  runtime.onInstalled.addListener(enqueueReconciliation);
}
