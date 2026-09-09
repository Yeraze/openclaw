import type { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { PromptCacheModel } from "./gateway-prompt-cache-contract.js";

export const CACHE_SCENARIO_TIMEOUT_MS = 180_000;

/** Shared by live cases and the zero-inference built-Gateway startup smoke. */
export function gatewayPromptCacheOptions(
  model: PromptCacheModel,
  taskRoot: string,
  captureSession: string,
): Parameters<ReturnType<typeof createQaGatewayChild>["start"]>[0] {
  const modelRef = `${model.provider}/${model.id}`;
  return {
    repoRoot: process.cwd(),
    command: {
      executablePath: process.execPath,
      argsPrefix: ["dist/index.js"],
      cwd: process.cwd(),
      tempParentDir: taskRoot,
      usePackagedPlugins: true,
    },
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    providerMode: "live-frontier",
    primaryModel: modelRef,
    alternateModel: modelRef,
    fastMode: false,
    thinkingDefault: model.thinking,
    runtimeEnvPatch: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      OPENCLAW_DEBUG_PROXY_SESSION_ID: captureSession,
      OPENCLAW_DEBUG_PROXY_URL: undefined,
    },
    mutateConfig: (cfg) => ({
      ...cfg,
      models: undefined,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          timeoutSeconds: CACHE_SCENARIO_TIMEOUT_MS / 1_000,
          mediaModels: undefined,
          models: {
            [modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: {
                transport: "sse",
                openaiWsWarmup: false,
                maxTokens: model.maxOutputTokens,
              },
            },
          },
        },
        entries: {
          qa: {
            ...cfg.agents?.entries?.qa,
            model: { primary: modelRef, fallbacks: [] },
            tools: { profile: "full", allow: ["read"] },
          },
        },
      },
      tools: { profile: "full", allow: ["read"], toolSearch: false, codeMode: false },
      memory: { search: { enabled: false } },
      plugins: {
        ...cfg.plugins,
        slots: { ...cfg.plugins?.slots, memory: "none" },
        entries: { ...cfg.plugins?.entries, "memory-core": { enabled: false } },
      },
    }),
  };
}
