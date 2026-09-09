import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../../../src/agents/internal-runtime-context.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  cacheRequestsComplete,
  collectCacheFailureEvidence,
  decodeCacheExchanges,
  decodeCacheResponse,
  readCacheCaptureRows,
  reconcileCacheUsage,
  verifyCacheConversation,
  verifyDependentReadHistory,
  waitForCacheExchanges,
  type CacheExchange,
} from "./gateway-prompt-cache-capture.js";
import {
  GATEWAY_PROMPT_CACHE_SCENARIOS,
  gatewayPromptCacheCaseId,
  gatewayPromptCacheModels,
  validateGatewayPromptCacheAssertions,
} from "./gateway-prompt-cache-contract.js";
import {
  assertGatewayPromptCacheStopped,
  stopGatewayPromptCacheFixture,
} from "./gateway-prompt-cache-fixture.js";

const sonnet = gatewayPromptCacheModels()[1]!;
const fable = gatewayPromptCacheModels()[2]!;
const openai = gatewayPromptCacheModels()[0]!;
const sse = (event: string, data: unknown) =>
  `${event ? `event: ${event}\r\n` : ""}data: ${JSON.stringify(data)}\r\n\r\n`;
const initialUsage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 200,
};
function anthropicStream(stop = "end_turn") {
  return (
    sse("message_start", { message: { id: "msg_test", model: sonnet.id, usage: initialUsage } }) +
    sse("message_delta", { delta: {}, usage: { output_tokens: 4 } }) +
    sse("message_delta", {
      delta: { stop_reason: stop },
      usage: { output_tokens: 6, cache_read_input_tokens: null },
    }) +
    sse("message_stop", {})
  );
}
function openaiStream(usage: unknown, status = "completed") {
  // Responses also supports data-only SSE frames; the SDK owns framing.
  return sse("", {
    type: `response.${status}`,
    response: { id: "resp_test", model: openai.id, status, usage },
  });
}
const openaiUsage = {
  input_tokens: 500,
  output_tokens: 9,
  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
};
const reader = { getSessionEvents: () => [], readBlob: () => null };

function carrier(text: string, cached = false) {
  return {
    type: "text",
    text: `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${text}\n${INTERNAL_RUNTIME_CONTEXT_END}`,
    ...(cached ? { cache_control: { type: "ephemeral" } } : {}),
  };
}
function message(role: string, content: unknown[]) {
  return { role, content };
}
function exchange(messages: unknown[], cacheRead = 0): CacheExchange {
  return {
    flowId: "test-flow",
    requestHash: "request-hash",
    responseHash: "response-hash",
    responseId: "response-test",
    model: sonnet.id,
    api: "anthropic-messages",
    request: { system: [{ type: "text", text: "system" }], tools: [], messages },
    usage: { input: 50, output: 8, cacheRead, cacheWrite: 7950 - cacheRead, totalInput: 8000 },
  };
}
function conversation(retained = false): CacheExchange[] {
  const seed = message("user", [{ type: "text", text: "unique long user seed" }]);
  const context = message("user", [carrier("turn one", retained)]);
  const reply = message("assistant", [{ type: "text", text: "ready" }]);
  const followup = message("user", [{ type: "text", text: "repeat" }]);
  return [
    exchange([seed, context]),
    exchange(
      structuredClone([
        seed,
        ...(retained ? [context] : []),
        reply,
        followup,
        message("user", [carrier("turn two")]),
      ]),
      7950,
    ),
  ];
}
function readHistory() {
  return [
    message("assistant", [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a.txt" } },
    ]),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "a",
      content: [{ type: "text", text: "next: b-random.txt" }],
    },
    message("assistant", [
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b-random.txt" } },
    ]),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "b",
      content: [{ type: "text", text: "opaque-answer" }],
    },
  ];
}

describe("raw cache stream evidence", () => {
  it("merges cumulative Anthropic deltas without adding or erasing counters", async () => {
    expect(await decodeCacheResponse("anthropic-messages", anthropicStream())).toEqual({
      model: sonnet.id,
      responseId: "msg_test",
      usage: { input: 10, output: 6, cacheRead: 100, cacheWrite: 200, totalInput: 310 },
    });
  });
  it("reads raw OpenAI cached and cache-write input without double counting", async () => {
    const decoded = await decodeCacheResponse("openai-responses", openaiStream(openaiUsage));
    expect(decoded.usage).toEqual({
      input: 500,
      output: 9,
      cacheRead: 300,
      cacheWrite: 100,
      totalInput: 500,
    });
    const absent = await decodeCacheResponse(
      "openai-responses",
      openaiStream({
        ...openaiUsage,
        input_tokens_details: { cached_tokens: 0 },
      }),
    );
    expect(absent.usage.cacheWrite).toBeNull();
    expect(absent.usage.cacheRead).toBe(0);
  });
  it.each(["failed", "incomplete"])("rejects OpenAI %s terminals", async (status) => {
    await expect(
      decodeCacheResponse("openai-responses", openaiStream(openaiUsage, status)),
    ).rejects.toThrow("incomplete");
  });
  it.each(["max_tokens", "refusal"])("rejects Anthropic %s termination", async (reason) => {
    await expect(
      decodeCacheResponse("anthropic-messages", anthropicStream(reason)),
    ).rejects.toThrow("complete");
  });
  it("rejects missing terminal, malformed data, duplicate terminal and provider error", async () => {
    for (const body of [
      anthropicStream().replace(sse("message_stop", {}), ""),
      "event: message_start\ndata: {broken\n\n",
      anthropicStream() + sse("message_stop", {}),
      anthropicStream() + sse("error", { error: { message: "private provider detail" } }),
    ]) {
      await expect(decodeCacheResponse("anthropic-messages", body)).rejects.toThrow();
    }
  });
  it("allows nonblocking unknown events and SDK multiline/comment framing", async () => {
    const body =
      ": heartbeat\r\n\r\n" +
      sse("future_event", { anything: true }) +
      anthropicStream().replace('data: {"message":', 'data: {\r\ndata: "message":');
    expect((await decodeCacheResponse("anthropic-messages", body)).usage.output).toBe(6);
  });
  it("does not turn missing usage into zero", async () => {
    await expect(
      decodeCacheResponse(
        "openai-responses",
        openaiStream({
          ...openaiUsage,
          input_tokens_details: {},
        }),
      ),
    ).rejects.toThrow("cache read");
  });
  it("requires one paired complete official HTTP/SSE exchange for the selected model", async () => {
    const rows = [
      {
        kind: "request",
        flowId: "flow",
        host: "api.openai.com",
        path: "/v1/responses",
        method: "POST",
        dataText: JSON.stringify({ model: openai.id, stream: true }),
      },
      {
        kind: "response",
        flowId: "flow",
        path: "/v1/responses",
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        dataText: openaiStream(openaiUsage),
      },
    ];
    expect(cacheRequestsComplete(rows)).toBe(true);
    expect(await decodeCacheExchanges(rows, reader, openai)).toHaveLength(1);
    expect(cacheRequestsComplete(rows.slice(0, 1))).toBe(false);
    for (const invalid of [
      [rows[0]!, { ...rows[1], flowId: "unmatched" }],
      [rows[0]!, { ...rows[1], status: 429 }],
      [{ ...rows[0], host: "proxy.example" }, rows[1]!],
      [{ ...rows[0], dataText: "{}" }, rows[1]!],
      [rows[0]!, { ...rows[1], metaJson: '{"bodyCapture":"stalled"}' }],
      [rows[0]!, { ...rows[1], dataText: undefined }],
      [
        rows[0]!,
        { ...rows[1], dataText: openaiStream(openaiUsage).replace(openai.id, "other-model") },
      ],
    ]) {
      await expect(decodeCacheExchanges(invalid, reader, openai)).rejects.toThrow();
    }
  });
  it("fails capture overflow and transport retry records", () => {
    expect(() =>
      readCacheCaptureRows({ ...reader, getSessionEvents: () => Array(512).fill({}) }, "capture"),
    ).toThrow("limit");
    expect(() =>
      readCacheCaptureRows(
        {
          ...reader,
          getSessionEvents: () => [{ kind: "retry-link", path: "/v1/messages" }],
        },
        "capture",
      ),
    ).toThrow("retry");
  });
  it("waits for the complete expected phase, not an earlier complete prefix", async () => {
    const pair = (flowId: string) => [
      {
        kind: "request",
        flowId,
        host: "api.openai.com",
        path: "/v1/responses",
        method: "POST",
        dataText: JSON.stringify({ model: openai.id, stream: true }),
      },
      {
        kind: "response",
        flowId,
        path: "/v1/responses",
        status: 200,
        contentType: "text/event-stream",
        dataText: openaiStream(openaiUsage),
      },
    ];
    const first = pair("first");
    const second = pair("second");
    const snapshots = [[], first, [...first, second[0]!], [...first, ...second]];
    let reads = 0;
    const result = await waitForCacheExchanges(
      () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
      reader,
      openai,
      2,
    );
    expect(result).toHaveLength(2);
    expect(reads).toBe(4);
    await expect(waitForCacheExchanges(() => first, reader, openai, 2, 1)).rejects.toThrow(
      "full terminal capture",
    );
    await expect(
      waitForCacheExchanges(() => [...first, ...second], reader, openai, 1),
    ).rejects.toThrow("Unexpected");
  });
});

describe("cache history and lifecycle proof", () => {
  it("uses actual model contracts for transient and retained carriers", () => {
    expect(verifyCacheConversation(conversation(), sonnet, "text-followup", 1).lifecycle).toBe(
      "transient",
    );
    expect(verifyCacheConversation(conversation(true), fable, "text-followup", 1).lifecycle).toBe(
      "retained",
    );
    expect(() => verifyCacheConversation(conversation(true), sonnet, "text-followup", 1)).toThrow(
      "breakpoint",
    );
    expect(() => verifyCacheConversation(conversation(), fable, "text-followup", 1)).toThrow();
  });
  it("allows cache metadata movement but not historical content or system mutation", () => {
    const stable = conversation();
    const messages = stable[1]!.request.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    messages[0]!.content[0]!.cache_control = { type: "ephemeral" };
    expect(() => verifyCacheConversation(stable, sonnet, "text-followup", 1)).not.toThrow();
    messages[0]!.content[0]!.text = "rewritten history";
    expect(() => verifyCacheConversation(stable, sonnet, "text-followup", 1)).toThrow("historical");
    const changed = conversation();
    changed[1]!.request.system = [{ type: "text", text: "new system" }];
    expect(() => verifyCacheConversation(changed, sonnet, "text-followup", 1)).toThrow("System");
  });
  it("rejects system-only cache hits and retries instead of choosing the best request", () => {
    const noGrowth = conversation();
    noGrowth[1]!.usage.cacheRead = 512;
    expect(() => verifyCacheConversation(noGrowth, sonnet, "text-followup", 1)).toThrow("baseline");
    expect(() =>
      verifyCacheConversation([...conversation(), conversation()[1]!], sonnet, "text-followup", 1),
    ).toThrow("count");
  });
  it("requires both tool continuations and marginal reuse of the first large read result", () => {
    const seed = message("user", [{ type: "text", text: "unique seed" }]);
    const a = message("assistant", [
      { type: "tool_use", id: "a", name: "read", input: { path: "a.txt" } },
    ]);
    const resultA = message("user", [
      { type: "tool_result", tool_use_id: "a", content: "large first tool result" },
    ]);
    const b = message("assistant", [
      { type: "tool_use", id: "b", name: "read", input: { path: "b.txt" } },
    ]);
    const resultB = message("user", [
      { type: "tool_result", tool_use_id: "b", content: "opaque answer" },
    ]);
    const history = [
      [seed],
      [seed, a, resultA],
      [seed, a, resultA, b, resultB],
      [
        seed,
        a,
        resultA,
        b,
        resultB,
        message("assistant", [{ type: "text", text: "opaque answer" }]),
        message("user", [{ type: "text", text: "repeat" }]),
      ],
    ];
    const valid = history.map((messages, index) => ({
      ...exchange([
        ...structuredClone(messages),
        message("user", [carrier(index === 3 ? "new turn" : "first turn")]),
      ]),
      usage: {
        input: 50,
        output: 8,
        cacheRead: [0, 7950, 15950, 16000][index]!,
        cacheWrite: [7950, 8000, 100, 150][index]!,
        totalInput: [8000, 16000, 16100, 16200][index]!,
      },
    }));
    expect(() => verifyCacheConversation(valid, sonnet, "dependent-reads", 3)).not.toThrow();
    const continuationsMiss = structuredClone(valid);
    continuationsMiss[1]!.usage.cacheRead = 0;
    continuationsMiss[2]!.usage.cacheRead = 0;
    continuationsMiss[3]!.usage.cacheRead = 7950;
    expect(() => verifyCacheConversation(continuationsMiss, sonnet, "dependent-reads", 3)).toThrow(
      "Request 2",
    );
    const missingToolCache = structuredClone(valid);
    missingToolCache[2]!.usage.cacheRead = 7950;
    expect(() => verifyCacheConversation(missingToolCache, sonnet, "dependent-reads", 3)).toThrow(
      "Request 3",
    );
  });
  it("requires real read A result before read B and both successful results", () => {
    expect(() =>
      verifyDependentReadHistory(readHistory(), "a.txt", "b-random.txt", "opaque-answer"),
    ).not.toThrow();
    const parallel = readHistory();
    [parallel[1], parallel[2]] = [parallel[2]!, parallel[1]!];
    expect(() =>
      verifyDependentReadHistory(parallel, "a.txt", "b-random.txt", "opaque-answer"),
    ).toThrow("dependent");
    const failed = readHistory();
    Object.assign(failed[3]!, { isError: true });
    expect(() =>
      verifyDependentReadHistory(failed, "a.txt", "b-random.txt", "opaque-answer"),
    ).toThrow("successfully");
    expect(() =>
      verifyDependentReadHistory(
        readHistory().slice(0, 3),
        "a.txt",
        "b-random.txt",
        "opaque-answer",
      ),
    ).toThrow("order");
  });
});

describe("persisted cache usage reconciliation", () => {
  const raw: CacheExchange = {
    ...exchange([]),
    api: "openai-responses",
    model: openai.id,
    usage: { input: 500, output: 9, cacheRead: 300, cacheWrite: 100, totalInput: 500 },
  };
  function persisted(exchange: CacheExchange) {
    const usage = exchange.usage;
    return {
      role: "assistant",
      model: exchange.model,
      api: exchange.api,
      responseId: exchange.responseId,
      usage: {
        input:
          exchange.api === "openai-responses"
            ? usage.input - usage.cacheRead - (usage.cacheWrite ?? 0)
            : usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: usage.totalInput + usage.output,
      },
    };
  }
  it("reconciles independently parsed raw buckets for each response", () => {
    const second: CacheExchange = {
      ...raw,
      api: "anthropic-messages",
      model: sonnet.id,
      responseId: "second",
      usage: { input: 10, output: 6, cacheRead: 100, cacheWrite: 200, totalInput: 310 },
    };
    expect(reconcileCacheUsage([raw, second], [persisted(raw), persisted(second)])).toHaveLength(2);
    expect(() => reconcileCacheUsage([raw, second], [persisted(second), persisted(raw)])).toThrow(
      "identity",
    );
  });
  it.each(["cacheRead", "cacheWrite"])(
    "rejects zeroed persisted %s despite positive raw usage",
    (field) => {
      const message = persisted(raw);
      Object.assign(message.usage, { [field]: 0 });
      expect(() => reconcileCacheUsage([raw], [message])).toThrow(field);
    },
  );
  it("keeps absent raw writes distinct from the runtime's numeric zero default", () => {
    const absent = structuredClone(raw);
    absent.usage.cacheWrite = null;
    const result = reconcileCacheUsage([absent], [persisted(absent)]);
    expect(result[0]).toMatchObject({ cacheWrite: 0, rawCacheWriteObserved: false });
    expect(absent.usage.cacheWrite).toBeNull();
    expect(() => reconcileCacheUsage([raw], [])).toThrow("count");
  });
});

describe("runtime cache matrix contract", () => {
  it.each(["daily", "expanded"])("requires every unique completed %s scenario", (profile) => {
    const models = gatewayPromptCacheModels(profile);
    const assertions = models.flatMap((model) =>
      GATEWAY_PROMPT_CACHE_SCENARIOS.map((scenario) => ({
        title: gatewayPromptCacheCaseId(model, scenario),
        status: "passed",
      })),
    );
    expect(assertions).toHaveLength(profile === "daily" ? 6 : 10);
    expect(validateGatewayPromptCacheAssertions(assertions, profile)).toEqual({ ok: true });
    for (const invalid of [
      assertions.slice(1),
      [...assertions, assertions[0]!],
      ...["skipped", "failed", "pending", "unavailable"].map((status) => [
        { ...assertions[0], status },
        ...assertions.slice(1),
      ]),
      [{ ...assertions[0], title: "wrong model/runtime" }, ...assertions.slice(1)],
    ]) {
      expect(validateGatewayPromptCacheAssertions(invalid, profile).ok).toBe(false);
    }
  });
  it("keeps expanded reasoning models runnable without a none override", () => {
    expect(gatewayPromptCacheModels("expanded").map((model) => model.id)).toContain("gpt-6-astra");
    expect(gatewayPromptCacheModels("expanded").map((model) => model.id)).toContain(
      "claude-opus-5",
    );
    expect(gatewayPromptCacheModels("expanded").every((model) => model.thinking === "low")).toBe(
      true,
    );
    expect(() => gatewayPromptCacheModels("first-available")).toThrow("profile");
  });
});

describe("cache failure evidence and cleanup", () => {
  function captured(exchanges: CacheExchange[]) {
    return exchanges.flatMap((exchange, index) => [
      {
        id: index * 2,
        kind: "request",
        flowId: `private-flow-${index}`,
        path: "/v1/messages",
        host: "api.anthropic.com",
        method: "POST",
        dataText: JSON.stringify({ model: sonnet.id, stream: true, ...exchange.request }),
      },
      {
        id: index * 2 + 1,
        kind: "response",
        flowId: `private-flow-${index}`,
        path: "/v1/messages",
        status: 200,
        contentType: "text/event-stream",
        dataText:
          sse("message_start", {
            message: {
              id: `private-response-${index}`,
              model: sonnet.id,
              usage: {
                input_tokens: exchange.usage.input,
                output_tokens: 0,
                cache_read_input_tokens: exchange.usage.cacheRead,
                cache_creation_input_tokens: exchange.usage.cacheWrite,
              },
            },
          }) +
          sse("message_delta", {
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: exchange.usage.output },
          }) +
          sse("message_stop", {}),
      },
    ]);
  }

  it("retains raw and normalized evidence for a real cache assertion failure without private text", async () => {
    const exchanges = conversation(true);
    expect(() => verifyCacheConversation(exchanges, sonnet, "text-followup", 1)).toThrow(
      "breakpoint",
    );
    const rows = captured(exchanges);
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "private-session",
      sonnet,
      [{ role: "assistant", usage: { cacheRead: 0, cacheWrite: 0, secret: "private-usage" } }],
      "text-followup",
    );
    expect(evidence).toMatchObject({
      captureComplete: true,
      requestCount: 2,
      lifecycle: "transient",
      requests: [
        {
          rawUsage: { cacheWrite: 7950 },
          normalizedUsage: { cacheWrite: 0, input: null },
          carriers: [
            {
              contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              markerHash: expect.any(String),
            },
          ],
        },
        {
          rawUsage: { cacheRead: 7950 },
        },
      ],
      reuse: [{ request: 2, actualPrefix: 7950, minimumColdGrowth: 1024 }],
    });
    expect(evidence.reuse[0]!.minimumPrefix).toBeGreaterThan(7000);
    const output = JSON.stringify(evidence);
    for (const privateValue of [
      "private-session",
      "private-flow",
      "private-response",
      "private-usage",
      "unique long user seed",
      "turn one",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("reports failed continuations and the first read growth instead of only the final cache hit", async () => {
    const exchanges = [
      conversation()[0]!,
      conversation()[0]!,
      conversation()[0]!,
      conversation()[1]!,
    ];
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => captured(exchanges) },
      "session",
      sonnet,
      [],
      "dependent-reads",
    );
    expect(evidence.reuse.map((entry) => entry.actualPrefix)).toEqual([0, 0, 7950]);
    expect(evidence.firstReadReuse).toEqual({ minimum: 1024, actual: 0 });
  });

  it("reports incomplete and unreadable capture as unavailable, never complete zero-usage proof", async () => {
    const rows = captured(conversation()).slice(0, 3);
    const partial = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(partial).toMatchObject({
      captureComplete: false,
      requestCount: 2,
      responseCount: 1,
      requests: [{ terminalComplete: true }, { terminalComplete: false, rawUsage: null }],
      reuse: [],
    });
    const failed = await collectCacheFailureEvidence(
      {
        ...reader,
        getSessionEvents: () => {
          throw new Error("private database path");
        },
      },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(failed).toMatchObject({ captureReadFailed: true, captureComplete: false });
    expect(JSON.stringify(failed)).not.toContain("private database path");
  });

  it("marks request and capture truncation explicitly", async () => {
    const rows = captured(Array.from({ length: 9 }, () => conversation()[0]!));
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(evidence).toMatchObject({
      requestCount: 9,
      omittedRequestCount: 1,
      captureComplete: false,
    });
    const overflow = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => Array(512).fill({ kind: "unknown" }) },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(overflow).toMatchObject({ captureLimitReached: true, captureComplete: false });
  });

  it.each(["never-spawned", "confirmed-stopped"] as const)(
    "removes an empty parent after %s",
    async (process) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      await stopGatewayPromptCacheFixture({ stop: async () => ({ process, errors: [] }) }, root);
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["unconfirmed", "confirmed-stopped"] as const)(
    "retains the parent and original assertion when %s cleanup fails",
    async (process) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      const original = new Error("cache invariant failed");
      const cleanup = new Error("stop failed");
      try {
        const failure = await runQaGatewayFixture(
          async () => {
            throw original;
          },
          () =>
            stopGatewayPromptCacheFixture(
              { stop: async () => ({ process, errors: [cleanup] }) },
              root,
            ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toBe(original);
        expect((failure as AggregateError).errors[1].errors).toContain(cleanup);
        expect((await fs.stat(root)).isDirectory()).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it("preserves owner-retained child artifacts even after a confirmed stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    try {
      await fs.mkdir(path.join(root, "retained-child"));
      await stopGatewayPromptCacheFixture(
        { stop: async () => ({ process: "confirmed-stopped", errors: [] }) },
        root,
      );
      expect(await fs.readdir(root)).toEqual(["retained-child"]);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.each([
    { process: "unconfirmed", diagnostic: false },
    { process: "unconfirmed", diagnostic: true },
    { process: "confirmed-stopped", diagnostic: true },
  ] as const)(
    "preserves early budget-stop failure after final cleanup succeeds: $process/$diagnostic",
    async ({ process, diagnostic }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      const original = new Error("request budget reached");
      const cleanup = new Error("early stop failed");
      const budgetStop = Promise.resolve({
        process,
        errors: diagnostic ? [cleanup] : [],
      });
      let reported = false;
      try {
        const failure = await runQaGatewayFixture(
          async () => {
            throw original;
          },
          async () => assertGatewayPromptCacheStopped(await budgetStop),
          () => {
            reported = true;
          },
          () =>
            stopGatewayPromptCacheFixture(
              { stop: async () => ({ process: "confirmed-stopped", errors: [] }) },
              root,
            ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toBe(original);
        expect((failure as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[1].errors).toEqual(diagnostic ? [cleanup] : []);
        expect(reported).toBe(true);
        await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains state when stop is unconfirmed even without diagnostic errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    try {
      await expect(
        stopGatewayPromptCacheFixture(
          { stop: async () => ({ process: "unconfirmed", errors: [] }) },
          root,
        ),
      ).rejects.toThrow("retained");
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("preserves the original assertion and state when stop itself rejects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    const original = new Error("cache assertion");
    const cleanup = new Error("stop rejected");
    try {
      const failure = await runQaGatewayFixture(
        async () => {
          throw original;
        },
        () =>
          stopGatewayPromptCacheFixture(
            {
              stop: async () => {
                throw cleanup;
              },
            },
            root,
          ),
      ).catch((error: unknown) => error);
      expect((failure as AggregateError).errors).toEqual([original, cleanup]);
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
