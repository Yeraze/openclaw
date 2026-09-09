import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createDebugProxyCaptureReader } from "../../../../src/proxy-capture/store-readonly.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  CACHE_SCENARIO_REQUEST_LIMIT,
  readCacheCaptureRows,
  reconcileCacheUsage,
  verifyCacheConversation,
  verifyDependentReadHistory,
  waitForCacheExchanges,
} from "./gateway-prompt-cache-capture.js";
import {
  GATEWAY_PROMPT_CACHE_SCENARIOS,
  gatewayPromptCacheCaseId,
  gatewayPromptCacheModels,
} from "./gateway-prompt-cache-contract.js";
import {
  CACHE_SCENARIO_TIMEOUT_MS as SCENARIO_TIMEOUT_MS,
  gatewayPromptCacheOptions,
} from "./gateway-prompt-cache-fixture.js";

const ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CACHE_RUNTIME === "1";
const MODELS = gatewayPromptCacheModels(process.env.OPENCLAW_LIVE_CACHE_RUNTIME_PROFILE);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} was not returned.`);
  }
  return value;
}

function assistantText(message: Record<string, unknown>) {
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("")
    : "";
}

// A bounded, unique manifest makes the conversation exceed provider cache minima
// without relying on the Gateway's (possibly already warm) system/tool prefix.
function manifest(label: string) {
  return Array.from(
    { length: 256 },
    (_, index) => `record ${index}: ${label}; revision ${randomUUID()}; status verified.`,
  ).join("\n");
}

async function sendTurn(gateway: QaGatewayChild, sessionKey: string, message: string) {
  const started = requireObject(
    await gateway.call(
      "chat.send",
      { sessionKey, message, deliver: false, idempotencyKey: randomUUID() },
      { timeoutMs: 30_000 },
    ),
    "chat.send",
  );
  if (started.status !== "started" || typeof started.runId !== "string") {
    throw new Error("chat.send did not start a new run.");
  }
  const terminal = requireObject(
    await gateway.call(
      "agent.wait",
      { runId: started.runId, timeoutMs: SCENARIO_TIMEOUT_MS },
      { timeoutMs: SCENARIO_TIMEOUT_MS + 5_000 },
    ),
    "agent.wait",
  );
  if (terminal.status !== "ok") {
    throw new Error("Gateway run failed or did not reach its successful terminal state.");
  }
  const history = requireObject(
    await gateway.call("chat.history", { sessionKey, limit: 100 }),
    "chat.history",
  );
  if (!Array.isArray(history.messages) || !history.messages.every(isRecord)) {
    throw new Error("Gateway omitted the persisted conversation.");
  }
  const messages = history.messages;
  const final = messages.findLast((entry) => entry.role === "assistant");
  if (!final || !assistantText(final).trim()) {
    throw new Error("Gateway did not persist a visible assistant reply.");
  }
  return { messages, reply: assistantText(final).trim() };
}

describe("Gateway HTTP prompt cache", () => {
  if (!ENABLED) {
    it("disabled runtime cache opt-in", () => {});
    return;
  }

  for (const model of MODELS) {
    for (const scenario of GATEWAY_PROMPT_CACHE_SCENARIOS) {
      it(
        gatewayPromptCacheCaseId(model, scenario),
        { timeout: SCENARIO_TIMEOUT_MS + 90_000 },
        async () => {
          const apiKeyName = model.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
          if (!process.env[apiKeyName]?.trim()) {
            throw new Error(
              `Runtime cache proof requires ${apiKeyName}; missing auth is not a pass.`,
            );
          }
          const taskRoot = tempDirs.make("openclaw-prompt-cache-");
          // Setup reads the parent environment before applying runtimeEnvPatch. Never
          // import an operator's endpoint overrides or subscription credentials.
          vi.stubEnv(
            "OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH",
            path.join(taskRoot, "no-host-config.json"),
          );
          for (const name of [
            "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN",
            "OPENCLAW_LIVE_SETUP_TOKEN_VALUE",
            "ANTHROPIC_OAUTH_TOKEN",
            "OPENAI_BASE_URL",
            "ANTHROPIC_BASE_URL",
            "CODEX_API_KEY",
            "OPENCLAW_LIVE_CODEX_API_KEY",
            "OPENCLAW_DEBUG_PROXY_URL",
          ]) {
            vi.stubEnv(name, undefined);
          }
          const owner = createQaGatewayChild();
          const captureSession = `prompt-cache-${randomUUID()}`;
          let gateway: QaGatewayChild | undefined;
          let monitor: Promise<void> | undefined;
          const stopMonitor = new AbortController();
          let budgetFailure: Error | undefined;
          let proofFailure: unknown;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            gateway = await owner.start(gatewayPromptCacheOptions(model, taskRoot, captureSession));
            if (gateway.runtimeEnv.OPENCLAW_DEBUG_PROXY_URL) {
              throw new Error("Cache proof must not route through a debug proxy.");
            }
            const reader = createDebugProxyCaptureReader({ env: gateway.runtimeEnv });
            const rows = () => readCacheCaptureRows(reader, captureSession);
            // Capture is asynchronous and observes requests after response headers.
            // Stop at the observed ceiling; any overrun remains a failed, fully counted run.
            const stopForBudget = (reason: string) => {
              budgetFailure ??= new Error(reason);
              void gateway?.stop();
            };
            deadline = setTimeout(
              () => stopForBudget("Runtime cache scenario time budget exceeded."),
              SCENARIO_TIMEOUT_MS,
            );
            monitor = (async () => {
              while (!stopMonitor.signal.aborted) {
                try {
                  if (
                    rows().filter((row) => row.kind === "request").length >=
                    CACHE_SCENARIO_REQUEST_LIMIT
                  ) {
                    stopForBudget("Runtime cache scenario request budget reached.");
                    return;
                  }
                  await delay(50, undefined, { signal: stopMonitor.signal });
                } catch {
                  if (!stopMonitor.signal.aborted) {
                    stopForBudget("Runtime cache capture monitor failed.");
                  }
                  return;
                }
              }
            })();
            const catalog = requireObject(await gateway.call("models.list", {}), "models.list");
            if (
              !Array.isArray(catalog.models) ||
              !catalog.models.some(
                (entry) =>
                  isRecord(entry) && entry.provider === model.provider && entry.id === model.id,
              )
            ) {
              throw new Error(
                "The exact runtime cache model is absent from the canonical catalog.",
              );
            }
            const sessionKey = `agent:qa:cache-${randomUUID()}`;
            const firstPath = "manifest-a.txt";
            const secondPath = `manifest-${randomUUID()}.txt`;
            const answer = `CACHE_ANSWER_${randomUUID().replaceAll("-", "")}`;
            const acknowledgement = `CACHE_READY_${randomUUID().replaceAll("-", "")}`;
            let prompt = `${manifest("user seed")}\n`;
            if (scenario === "dependent-reads") {
              await fs.writeFile(
                path.join(gateway.workspaceDir, firstPath),
                `${manifest("tool result")}\nRead the next file at ${secondPath} to find the answer.\n`,
                { mode: 0o600 },
              );
              await fs.writeFile(
                path.join(gateway.workspaceDir, secondPath),
                `The answer is ${answer}.\n`,
                { mode: 0o600 },
              );
              prompt += `Read ${firstPath} in full. It names the only next file to read. Read that file, then reply with only its answer. Do not list files or use other tools.`;
            } else {
              prompt += `Remember this manifest. Do not use tools. Reply with exactly ${acknowledgement}.`;
            }
            const first = await sendTurn(gateway, sessionKey, prompt);
            const firstExchanges = await waitForCacheExchanges(
              rows,
              reader,
              model,
              scenario === "dependent-reads" ? 3 : 1,
            );
            reconcileCacheUsage(firstExchanges, first.messages);
            if (first.reply !== (scenario === "dependent-reads" ? answer : acknowledgement)) {
              throw new Error("The first turn did not return the expected visible answer.");
            }
            if (scenario === "dependent-reads") {
              verifyDependentReadHistory(
                first.messages,
                firstPath,
                secondPath,
                answer,
                gateway.workspaceDir,
              );
            }
            const beforeFollowup = firstExchanges.length;
            const second = await sendTurn(
              gateway,
              sessionKey,
              "Without calling tools, repeat your previous final answer exactly.",
            );
            const exchanges = await waitForCacheExchanges(rows, reader, model, beforeFollowup + 1);
            const persistedUsage = reconcileCacheUsage(exchanges, second.messages);
            if (second.reply !== first.reply) {
              throw new Error("The warm followup did not use the same persisted conversation.");
            }
            const sessions = requireObject(
              await gateway.call("sessions.list", {}),
              "sessions.list",
            );
            const session = Array.isArray(sessions.sessions)
              ? sessions.sessions.find((entry) => isRecord(entry) && entry.key === sessionKey)
              : undefined;
            if (
              !isRecord(session) ||
              !isRecord(session.agentRuntime) ||
              session.agentRuntime.id !== "openclaw" ||
              session.model !== model.id ||
              session.modelProvider !== model.provider
            ) {
              throw new Error("Persisted session used an unexpected runtime or model.");
            }
            if (budgetFailure) {
              throw budgetFailure;
            }
            const proof = verifyCacheConversation(exchanges, model, scenario, beforeFollowup);
            if (scenario === "dependent-reads") {
              if (
                JSON.stringify(exchanges[0]!.request).includes(secondPath) ||
                !JSON.stringify(exchanges[1]!.request).includes(secondPath) ||
                !JSON.stringify(exchanges[2]!.request).includes(answer)
              ) {
                throw new Error(
                  "Provider requests did not contain the ordered, dependent tool results.",
                );
              }
            } else if (first.messages.some((entry) => entry.role === "toolResult")) {
              throw new Error("Text-only cache scenario unexpectedly used a tool.");
            }
            // Raw prompts, file paths, API response ids and the capture database stay private.
            console.log(
              JSON.stringify({
                proof: "gateway-prompt-cache",
                case: gatewayPromptCacheCaseId(model, scenario),
                runtime: session.agentRuntime.id,
                transport: "http-sse",
                persistedUsage,
                ...proof,
              }),
            );
          } catch (error) {
            proofFailure = error;
          } finally {
            clearTimeout(deadline);
            stopMonitor.abort();
            await monitor;
            await stopQaGatewayFixture(owner);
          }
          if (proofFailure) {
            throw proofFailure;
          }
        },
      );
    }
  }
});
