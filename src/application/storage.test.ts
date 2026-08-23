import { describe, expect, it } from "vitest";
import { StateStore, type StorageArea } from "./storage";

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea & { values: Record<string, unknown> } {
  const values = { ...initial };
  return {
    values,
    async get() {
      return { ...values };
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }
  };
}

describe("StateStore", () => {
  it("initializes and persists the Foco profile when storage is empty", async () => {
    const storage = memoryStorage();
    const store = new StateStore(storage, () => 1000);

    const state = await store.read();

    expect(state).toEqual({
      configuration: {
        schemaVersion: 1,
        profile: { id: "focus", name: "Foco", hostname: null }
      }
    });
    expect(storage.values.configuration).toEqual(state.configuration);
  });
});
