import { defineConfig } from "wxt";
export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Focus Lock",
    description: "Um Pomodoro simples para proteger o seu foco.",
    permissions: ["storage", "alarms", "webRequest", "webRequestBlocking"],
    host_permissions: ["http://*/*", "https://*/*"],
    browser_specific_settings: {
      gecko: {
        id: "focus-lock@example.invalid",
        data_collection_permissions: {
          required: ["none"]
        }
      }
    }
  }
});
