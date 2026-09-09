import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import { bindsClaudeThinkingPrefix } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
import type { DebugProxyCaptureReader } from "../../../../src/proxy-capture/store-readonly.js";
import type { PromptCacheModel, PromptCacheScenario } from "./gateway-prompt-cache-contract.js";

export const CACHE_CAPTURE_EVENT_LIMIT = 512;
export const CACHE_CAPTURE_BODY_LIMIT = 2 * 1024 * 1024;
export const CACHE_SCENARIO_REQUEST_LIMIT = 8;
export const CACHE_SCENARIO_INPUT_TOKEN_LIMIT = 240_000;

type JsonRecord = Record<string, unknown>;
type CacheUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
  totalInput: number;
};
export type CacheExchange = {
  flowId: string;
  request: JsonRecord;
  requestHash: string;
  responseHash: string;
  responseId: string;
  model: string;
  api: "anthropic-messages" | "openai-responses";
  usage: CacheUsage;
};

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} is missing or is not an object.`);
  }
  return value;
}

function parseRecord(text: string, label: string) {
  try {
    return requireRecord(JSON.parse(text), label);
  } catch {
    // Captured bodies can include credentials or private paths. Never attach the raw parse error.
    throw new Error(`${label} is not a complete JSON object.`);
  }
}

function counter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Missing or invalid provider usage: ${label}.`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

export function captureHash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

/** Use the SDK's framing decoder, but independently validate terminal state and raw usage. */
export async function decodeCacheResponse(
  api: CacheExchange["api"],
  body: string,
): Promise<Pick<CacheExchange, "model" | "responseId" | "usage">> {
  let started = false;
  let stopped = false;
  let responseId = "";
  let model = "";
  let stopReason: unknown;
  let usage: JsonRecord = {};
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  for await (const frame of Stream.rawEvents(response)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    const event = frame.event ?? "";
    const known =
      event === "error" ||
      event.startsWith("response.") ||
      ["message_start", "message_delta", "message_stop"].includes(event);
    if (event && !known) {
      continue;
    }
    const data = parseRecord(frame.data, "Provider SSE event");
    const kind = event || data.type;
    if (kind === "error" || kind === "response.failed" || kind === "response.incomplete") {
      throw new Error("Provider stream failed or ended incomplete.");
    }
    if (api === "anthropic-messages") {
      if (kind === "message_start") {
        if (started || stopped) {
          throw new Error("Duplicate Anthropic message_start.");
        }
        started = true;
        const message = requireRecord(data.message, "Anthropic message_start");
        responseId = nonemptyString(message.id, "Anthropic response identity");
        model = nonemptyString(message.model, "Anthropic response model");
        usage = { ...requireRecord(message.usage, "Anthropic initial usage") };
      } else if (kind === "message_delta") {
        if (!started || stopped) {
          throw new Error("Anthropic message_delta outside its message.");
        }
        const delta = requireRecord(data.delta, "Anthropic delta");
        stopReason = delta.stop_reason ?? stopReason;
        // Delta counters are cumulative, and nullable fields do not erase earlier observations.
        for (const [key, value] of Object.entries(
          requireRecord(data.usage, "Anthropic delta usage"),
        )) {
          if (value !== null && value !== undefined) {
            usage[key] = value;
          }
        }
      } else if (kind === "message_stop") {
        if (
          !started ||
          stopped ||
          !["end_turn", "tool_use", "stop_sequence"].includes(String(stopReason))
        ) {
          throw new Error("Anthropic message did not complete successfully.");
        }
        stopped = true;
      }
    } else if (kind === "response.completed") {
      if (stopped) {
        throw new Error("Duplicate OpenAI response terminal.");
      }
      const terminal = requireRecord(data.response, "OpenAI terminal response");
      if (terminal.status !== "completed" || terminal.error || terminal.incomplete_details) {
        throw new Error("OpenAI terminal response is not complete.");
      }
      responseId = nonemptyString(terminal.id, "OpenAI response identity");
      model = nonemptyString(terminal.model, "OpenAI response model");
      usage = requireRecord(terminal.usage, "OpenAI terminal usage");
      stopped = true;
    }
  }
  if (!stopped) {
    throw new Error("Captured SSE is missing its successful terminal event.");
  }
  const input = counter(usage.input_tokens, "input_tokens");
  const output = counter(usage.output_tokens, "output_tokens");
  const details =
    api === "openai-responses"
      ? requireRecord(usage.input_tokens_details, "OpenAI input token details")
      : usage;
  const cacheRead = counter(
    api === "openai-responses" ? details.cached_tokens : usage.cache_read_input_tokens,
    "cache read",
  );
  const rawWrite =
    api === "openai-responses" ? details.cache_write_tokens : usage.cache_creation_input_tokens;
  const cacheWrite =
    rawWrite === undefined || rawWrite === null ? null : counter(rawWrite, "cache write");
  if (api === "anthropic-messages" && cacheWrite === null) {
    throw new Error("Anthropic cache creation usage was not observed.");
  }
  const totalInput = api === "anthropic-messages" ? input + cacheRead + (cacheWrite ?? 0) : input;
  if (cacheRead + (cacheWrite ?? 0) > totalInput) {
    throw new Error("Provider cache counters exceed total input.");
  }
  return { model, responseId, usage: { input, output, cacheRead, cacheWrite, totalInput } };
}

function providerApi(event: JsonRecord): CacheExchange["api"] | undefined {
  if (typeof event.path !== "string") {
    return undefined;
  }
  const endpoint = event.path.split("?")[0];
  if (endpoint === "/v1/messages") {
    return "anthropic-messages";
  }
  if (endpoint === "/v1/responses") {
    return "openai-responses";
  }
  return undefined;
}

function captureBody(event: JsonRecord, reader: DebugProxyCaptureReader): string {
  const meta =
    typeof event.metaJson === "string" ? parseRecord(event.metaJson, "Capture metadata") : {};
  if (meta.bodyCapture !== undefined) {
    throw new Error("Provider capture body was unavailable, oversized, or stalled.");
  }
  const body =
    typeof event.dataText === "string"
      ? event.dataText
      : typeof event.dataBlobId === "string"
        ? reader.readBlob(event.dataBlobId)
        : null;
  if (!body || Buffer.byteLength(body) > CACHE_CAPTURE_BODY_LIMIT) {
    throw new Error("Provider capture body is missing or exceeds the proof bound.");
  }
  return body;
}

export function readCacheCaptureRows(reader: DebugProxyCaptureReader, sessionId: string) {
  const rows = reader.getSessionEvents(sessionId, CACHE_CAPTURE_EVENT_LIMIT);
  if (rows.length >= CACHE_CAPTURE_EVENT_LIMIT) {
    throw new Error("Capture event limit reached; complete request accounting is unavailable.");
  }
  const providerRows = rows.filter((row) => providerApi(row) !== undefined);
  if (providerRows.some((row) => row.kind === "error" || row.kind === "retry-link")) {
    throw new Error("Provider transport error or retry was captured.");
  }
  return providerRows.toSorted(
    (left, right) => Number(left.ts) - Number(right.ts) || Number(left.id) - Number(right.id),
  );
}

export function cacheRequestsComplete(rows: JsonRecord[]): boolean {
  const requests = rows.filter((row) => row.kind === "request");
  return (
    requests.length > 0 &&
    requests.every(
      (request) =>
        rows.filter((row) => row.kind === "response" && row.flowId === request.flowId).length === 1,
    )
  );
}

export async function decodeCacheExchanges(
  rows: JsonRecord[],
  reader: DebugProxyCaptureReader,
  expected: PromptCacheModel,
): Promise<CacheExchange[]> {
  const requests = rows.filter((row) => row.kind === "request");
  if (!cacheRequestsComplete(rows) || requests.length > CACHE_SCENARIO_REQUEST_LIMIT) {
    throw new Error("Missing provider exchanges or request budget exceeded.");
  }
  if (rows.filter((row) => row.kind === "response").length !== requests.length) {
    throw new Error("Unmatched provider response.");
  }
  const expectedApi = expected.provider === "anthropic" ? "anthropic-messages" : "openai-responses";
  const result: CacheExchange[] = [];
  const flows = new Set<string>();
  for (const request of requests) {
    const flowId = nonemptyString(request.flowId, "Capture flow identity");
    if (flows.has(flowId)) {
      throw new Error("Duplicate provider request flow.");
    }
    flows.add(flowId);
    const response = rows.find((row) => row.kind === "response" && row.flowId === flowId)!;
    if (
      providerApi(request) !== expectedApi ||
      request.host !==
        (expected.provider === "anthropic" ? "api.anthropic.com" : "api.openai.com") ||
      request.method !== "POST" ||
      response.status !== 200 ||
      typeof response.contentType !== "string" ||
      !response.contentType.toLowerCase().startsWith("text/event-stream")
    ) {
      throw new Error("Unexpected provider endpoint, status, or streaming transport.");
    }
    const requestText = captureBody(request, reader);
    const body = parseRecord(requestText, "Provider request");
    if (body.model !== expected.id || body.stream !== true) {
      throw new Error("Provider request used an unexpected model or non-streaming API.");
    }
    const responseText = captureBody(response, reader);
    const terminal = await decodeCacheResponse(expectedApi, responseText);
    if (terminal.model !== expected.id) {
      throw new Error("Provider response used an unexpected model; fallback is not cache proof.");
    }
    result.push({
      flowId,
      request: body,
      requestHash: captureHash(requestText),
      responseHash: captureHash(responseText),
      api: expectedApi,
      ...terminal,
    });
  }
  if (
    result.reduce((total, exchange) => total + exchange.usage.totalInput, 0) >
    CACHE_SCENARIO_INPUT_TOKEN_LIMIT
  ) {
    throw new Error("Scenario input token budget exceeded.");
  }
  return result;
}

/** Agent completion and capture persistence are separate observable boundaries. */
export async function waitForCacheExchanges(
  readRows: () => JsonRecord[],
  reader: DebugProxyCaptureReader,
  model: PromptCacheModel,
  expectedCount: number,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const rows = readRows();
    const requests = rows.filter((row) => row.kind === "request").length;
    const responses = rows.filter((row) => row.kind === "response").length;
    if (requests > expectedCount || responses > expectedCount) {
      throw new Error("Unexpected provider exchanges in the completed turn.");
    }
    if (requests === expectedCount && responses === expectedCount && cacheRequestsComplete(rows)) {
      return decodeCacheExchanges(rows, reader, model);
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Completed turn is missing its full terminal capture.");
}

function withoutCacheMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheMetadata);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheMetadata(item)]),
  );
}

function messageAtoms(exchange: CacheExchange, retained: boolean): unknown[] {
  const messages =
    exchange.api === "anthropic-messages" ? exchange.request.messages : exchange.request.input;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Provider conversation payload is missing.");
  }
  return messages.flatMap((value) => {
    const message = requireRecord(value, "Provider message");
    if (Array.isArray(message.content)) {
      return message.content.flatMap((block) => {
        const content = requireRecord(block, "Provider content block");
        const carrier = typeof content.text === "string" && hasInternalRuntimeContext(content.text);
        if (carrier && !retained) {
          if (content.cache_control !== undefined) {
            throw new Error("Transient runtime context owns a cache breakpoint.");
          }
          return [];
        }
        return [{ role: message.role, content: withoutCacheMetadata(content) }];
      });
    }
    return [withoutCacheMetadata(message)];
  });
}

/** Compare the meaningful conversation, not a best-of hit rate or a system-only cache hit. */
export function verifyCacheConversation(
  exchanges: CacheExchange[],
  model: PromptCacheModel,
  scenario: PromptCacheScenario,
  turnBoundary: number,
) {
  const expectedCount = scenario === "dependent-reads" ? 4 : 2;
  if (exchanges.length !== expectedCount || turnBoundary !== expectedCount - 1) {
    throw new Error("Unexpected request count; retries or extra model turns are not cache proof.");
  }
  const retained = model.provider === "anthropic" && bindsClaudeThinkingPrefix({ id: model.id });
  const first = exchanges[0]!;
  const staticPrefix = captureHash(
    withoutCacheMetadata({
      system: first.request.system,
      instructions: first.request.instructions,
      tools: first.request.tools,
    }),
  );
  const projections = exchanges.map((exchange) => {
    if (
      captureHash(
        withoutCacheMetadata({
          system: exchange.request.system,
          instructions: exchange.request.instructions,
          tools: exchange.request.tools,
        }),
      ) !== staticPrefix
    ) {
      throw new Error("System or tool definitions changed within the cache scenario.");
    }
    return messageAtoms(exchange, retained);
  });
  for (let index = 1; index < projections.length; index += 1) {
    const previous = projections[index - 1]!;
    const current = projections[index]!;
    if (
      current.length < previous.length ||
      captureHash(current.slice(0, previous.length)) !== captureHash(previous)
    ) {
      throw new Error("Eligible historical conversation content changed before the next request.");
    }
  }
  if (model.provider === "anthropic") {
    const carriers = exchanges.map((exchange) =>
      (exchange.request.messages as JsonRecord[]).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter(
              (block) =>
                isRecord(block) &&
                typeof block.text === "string" &&
                hasInternalRuntimeContext(block.text),
            )
          : [],
      ),
    );
    if (carriers[0]!.length === 0) {
      throw new Error("Runtime carrier was not exercised.");
    }
    const original = captureHash(withoutCacheMetadata(carriers[0]![0]));
    const next = carriers[turnBoundary]!.some(
      (carrier) => captureHash(withoutCacheMetadata(carrier)) === original,
    );
    if (next !== retained) {
      throw new Error("Runtime carrier did not follow the model's replay lifecycle.");
    }
  }
  for (let index = 1; index < exchanges.length; index += 1) {
    const previous = exchanges[index - 1]!;
    const current = exchanges[index]!;
    const messages = previous.request.messages ?? previous.request.input;
    const transientBytes =
      retained || !Array.isArray(messages)
        ? 0
        : messages.reduce(
            (total, message) =>
              total +
              (isRecord(message) && Array.isArray(message.content)
                ? message.content.reduce(
                    (bytes, block) =>
                      bytes +
                      (isRecord(block) &&
                      typeof block.text === "string" &&
                      hasInternalRuntimeContext(block.text)
                        ? Buffer.byteLength(block.text)
                        : 0),
                    0,
                  )
                : 0),
            0,
          );
    // A removed carrier cannot be cached on the next request. Its UTF-8 byte
    // length is a conservative token upper bound; retained history has no such
    // deduction. Allow 128 tokens for provider cache-block rounding, not a ratio.
    const requiredPrefix = previous.usage.totalInput - transientBytes - 128;
    if (
      current.usage.cacheRead < requiredPrefix ||
      current.usage.cacheRead - first.usage.cacheRead < 1024
    ) {
      throw new Error(
        `Request ${index + 1} did not reuse the preceding conversation beyond the cold cache baseline.`,
      );
    }
  }
  if (
    scenario === "dependent-reads" &&
    exchanges[2]!.usage.cacheRead - exchanges[1]!.usage.cacheRead < 1024
  ) {
    throw new Error("The second tool continuation did not cache the large first read result.");
  }
  return {
    lifecycle: retained ? "retained" : "transient",
    prefixHash: captureHash(projections[0]),
    requestCount: exchanges.length,
    requests: exchanges.map(
      ({ request: _request, flowId: _flowId, responseId: _responseId, ...proof }) => proof,
    ),
  };
}

/** Reconcile each provider response with its persisted assistant, not a session sum. */
export function reconcileCacheUsage(exchanges: CacheExchange[], messages: JsonRecord[]) {
  const assistants = messages.filter((message) => message.role === "assistant");
  if (assistants.length !== exchanges.length) {
    throw new Error("Persisted assistant count differs from the provider exchange count.");
  }
  return exchanges.map((exchange, index) => {
    const assistant = assistants[index]!;
    const usage = requireRecord(assistant.usage, "Persisted assistant usage");
    if (
      assistant.responseId !== exchange.responseId ||
      assistant.model !== exchange.model ||
      assistant.api !== exchange.api
    ) {
      throw new Error("Persisted assistant identity differs from its provider response.");
    }
    const raw = exchange.usage;
    // OpenAI input includes both cache buckets; Anthropic input excludes them.
    // The runtime's numeric write default is checked, but never upgrades an
    // absent raw counter into observed zero-write evidence.
    const expected = {
      input:
        exchange.api === "openai-responses"
          ? raw.input - raw.cacheRead - (raw.cacheWrite ?? 0)
          : raw.input,
      output: raw.output,
      cacheRead: raw.cacheRead,
      cacheWrite: raw.cacheWrite ?? 0,
      totalTokens: raw.totalInput + raw.output,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (counter(usage[key], `persisted ${key}`) !== value) {
        throw new Error(`Persisted assistant ${index + 1} ${key} differs from raw provider usage.`);
      }
    }
    return { ...expected, rawCacheWriteObserved: raw.cacheWrite !== null };
  });
}

export function verifyDependentReadHistory(
  messages: JsonRecord[],
  firstPath: string,
  secondPath: string,
  answer: string,
  workspace = ".",
) {
  const calls: Array<{ id: unknown; path: unknown }> = [];
  const results: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall") {
          if (block.name !== "read" || !isRecord(block.arguments)) {
            throw new Error("Dependent-read scenario called an unexpected tool.");
          }
          calls.push({ id: block.id, path: block.arguments.path ?? block.arguments.file_path });
        }
      }
    } else if (message.role === "toolResult") {
      if (message.toolName !== "read" || message.isError === true) {
        throw new Error("Dependent-read scenario did not complete a read successfully.");
      }
      results.push(message);
    }
  }
  if (
    calls.length !== 2 ||
    results.length !== 2 ||
    typeof calls[0]!.path !== "string" ||
    typeof calls[1]!.path !== "string" ||
    path.resolve(workspace, calls[0]!.path) !== path.resolve(workspace, firstPath) ||
    path.resolve(workspace, calls[1]!.path) !== path.resolve(workspace, secondPath) ||
    results[0]!.toolCallId !== calls[0]!.id ||
    results[1]!.toolCallId !== calls[1]!.id ||
    !JSON.stringify(results[0]!.content).includes(secondPath) ||
    !JSON.stringify(results[1]!.content).includes(answer)
  ) {
    throw new Error("Dependent reads did not preserve the required tool/result order.");
  }
  const firstResultIndex = messages.indexOf(results[0]!);
  const secondCallIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && block.type === "toolCall" && block.id === calls[1]!.id,
      ),
  );
  if (secondCallIndex <= firstResultIndex) {
    throw new Error("Second read was not dependent on the first completed result.");
  }
}
