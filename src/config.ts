import { PodConfig } from "./types.js";

export function loadPodConfig(env?: Record<string, any>): PodConfig {
  const get = (key: string, fallback: string): string => {
    if (env && env[key]) return String(env[key]);
    if (typeof process !== "undefined" && process.env && process.env[key]) {
      return String(process.env[key]);
    }
    return fallback;
  };

  const id = get("POD_ID", "underwriting-audit-pod");
  const name = get("POD_NAME", "Underwriting Audit Pod");
  const role = get("POD_ROLE", "auditor");
  const lob = get("POD_DOMAIN", get("POD_LOB", "insurance"));
  const hubUrl = get("HUB_URL", get("FACTORY_HUB_URL", "http://localhost:5000"));
  const apiKey = get("API_KEY", "");
  const port = parseInt(get("PORT", "5100"), 10);

  let capabilities: string[] = ["task_execution", "event_messaging", "health_reporting"];
  const rawCaps = get("POD_CAPABILITIES", "");
  if (rawCaps) {
    try {
      capabilities = JSON.parse(rawCaps);
    } catch {
      capabilities = rawCaps.split(",").map((c) => c.trim()).filter(Boolean);
    }
  }

  return {
    id,
    name,
    role,
    lob,
    capabilities,
    hubUrl,
    apiKey,
    port,
  };
}
