// Googlechat tests cover the monitor's live typing status lifecycle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import type { setGoogleChatWebhookEventProcessor } from "./monitor-routing.js";
import type { GoogleChatCoreRuntime, WebhookTarget } from "./monitor-types.js";
import "./monitor.js";

type EventProcessor = Parameters<typeof setGoogleChatWebhookEventProcessor>[0];

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const routing = vi.hoisted<{ processEvent?: EventProcessor }>(() => ({}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync:
    async () =>
    ({ body }: { body: string }) =>
      body,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: ({ accountId }: { accountId: string }) => ({
    agentId: "agent-1",
    accountId,
    sessionKey: "session-1",
  }),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  ...apiMocks,
}));

vi.mock("./monitor-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-access.js")>()),
  applyGoogleChatInboundAccessPolicy: async () => ({ ok: true }),
}));

// mock-isolation: capture the real processor without registering shared webhook state.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: (processEvent: EventProcessor) => {
    routing.processEvent = processEvent;
  },
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
});

type LiveTurn = {
  delivery: {
    deliver: (
      payload: { text: string; replyToId?: string },
      info?: { kind: string },
    ) => Promise<void>;
  };
  replyOptions?: {
    onToolStart?: (payload: {
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
    }) => unknown;
    onQueuedFollowupAdmitted?: () => Promise<void>;
    onQueuedFollowupSettled?: () => Promise<void>;
  };
};

type RunParams = {
  adapter: { resolveTurn: () => LiveTurn };
  turnAdoptionLifecycle?: { onDeferred?: () => unknown };
};

const placeholder = "spaces/LIVE/messages/typing";
const typingText = "_OpenClaw is typing..._";
const doneStatus = "_OpenClaw is done — reply below._";

async function runLiveTurn(params: {
  drive?: (turn: LiveTurn, runParams: RunParams) => Promise<void>;
  thread?: string;
}) {
  if (!routing.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  let retained: LiveTurn | undefined;
  const runTurn = vi.fn(async (runParams: RunParams) => {
    retained = runParams.adapter.resolveTurn();
    await params.drive?.(retained, runParams);
  });
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: vi.fn((payload: unknown) => payload), run: runTurn },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
  const account = {
    accountId: "work",
    config: { typingIndicator: "live", ...(params.thread ? { replyToMode: "all" } : {}) },
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;

  await routing.processEvent(
    {
      type: "MESSAGE",
      space: { name: "spaces/LIVE", spaceType: "SPACE" },
      message: {
        name: "spaces/LIVE/messages/1",
        text: "hello",
        ...(params.thread ? { thread: { name: params.thread } } : {}),
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    },
    {
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
      path: "/googlechat",
      ingress: { receive: vi.fn<WebhookTarget["ingress"]["receive"]>() },
    } as unknown as WebhookTarget,
  );
  if (!retained) {
    throw new Error("Expected the live turn to run");
  }
  return { account, turn: retained };
}

describe("googlechat monitor live typing mode", () => {
  it.each([
    {
      name: "core routes the queued answer",
      deliverThroughMonitor: false,
      expectedSent: [typingText],
      expectedDone: [],
      expectedDeleted: [placeholder],
    },
    {
      name: "the monitor delivers the queued answer",
      deliverThroughMonitor: true,
      expectedSent: [typingText, "queued answer"],
      expectedDone: [placeholder],
      expectedDeleted: [],
    },
  ])(
    "reuses and retires the queued message's placeholder when $name",
    async ({ deliverThroughMonitor, expectedSent, expectedDone, expectedDeleted }) => {
      apiMocks.sendGoogleChatMessage.mockResolvedValue({ messageName: placeholder });
      // The run is queued behind an active one, so it returns without delivering;
      // core later drains the queued turn through the retained callbacks.
      const { turn } = await runLiveTurn({
        drive: async (_turn, runParams) => {
          runParams.turnAdoptionLifecycle?.onDeferred?.();
        },
      });

      await turn.replyOptions?.onQueuedFollowupAdmitted?.();
      if (deliverThroughMonitor) {
        await turn.delivery.deliver({ text: "queued answer" }, { kind: "final" });
      }
      await turn.replyOptions?.onQueuedFollowupSettled?.();

      expect(apiMocks.sendGoogleChatMessage.mock.calls.map(([call]) => call.text)).toEqual(
        expectedSent,
      );
      const doneEdits = apiMocks.updateGoogleChatMessage.mock.calls
        .filter(([call]) => call.text === doneStatus)
        .map(([call]) => call.messageName);
      expect(doneEdits).toEqual(expectedDone);
      expect(apiMocks.deleteGoogleChatMessage.mock.calls.map(([call]) => call.messageName)).toEqual(
        expectedDeleted,
      );
    },
  );

  it.each([
    { name: "succeeds", updateError: undefined },
    {
      name: "finds the message gone",
      updateError: new GoogleChatApiError(404, "Google Chat API 404: message not found"),
    },
    {
      name: "is throttled",
      updateError: new GoogleChatApiError(429, "Google Chat API 429: quota exceeded"),
    },
  ])(
    "posts the live answer as a new message when the done-status edit $name",
    async ({ updateError }) => {
      const thread = "spaces/LIVE/threads/root";
      apiMocks.sendGoogleChatMessage.mockResolvedValue({
        messageName: placeholder,
        threadName: thread,
      });
      if (updateError) {
        apiMocks.updateGoogleChatMessage.mockRejectedValueOnce(updateError);
      }

      const { account } = await runLiveTurn({
        thread,
        drive: async (turn) => {
          await turn.delivery.deliver({ text: "the answer", replyToId: thread }, { kind: "final" });
        },
      });

      // A new message notifies the user; an in-place edit of the placeholder would not.
      expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
        account,
        messageName: placeholder,
        text: doneStatus,
      });
      expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith({
        account,
        space: "spaces/LIVE",
        text: "the answer",
        thread,
      });
      expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it("follows a re-sent live placeholder into its new thread for the done status and answer", async () => {
    const requestedThread = "spaces/LIVE/threads/root";
    const replacement = "spaces/LIVE/messages/replacement";
    const replacementThread = "spaces/LIVE/threads/replacement";
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: placeholder, threadName: requestedThread })
      .mockResolvedValueOnce({ messageName: replacement, threadName: replacementThread })
      .mockResolvedValueOnce({ messageName: "spaces/LIVE/messages/answer" });
    apiMocks.updateGoogleChatMessage.mockRejectedValueOnce(
      new GoogleChatApiError(404, "Google Chat API 404: message not found"),
    );
    vi.useFakeTimers();
    try {
      const { account } = await runLiveTurn({
        thread: requestedThread,
        drive: async (turn) => {
          await turn.replyOptions?.onToolStart?.({
            toolCallId: "call-1",
            name: "exec",
            phase: "start",
            args: { command: "ls" },
          });
          // Let the progress draft pass its startup delay so the first edit lands.
          await vi.advanceTimersByTimeAsync(2_000);
          await turn.delivery.deliver(
            { text: "the answer", replyToId: requestedThread },
            { kind: "final" },
          );
        },
      });

      expect(apiMocks.updateGoogleChatMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ account, messageName: placeholder }),
      );
      expect(apiMocks.updateGoogleChatMessage).toHaveBeenLastCalledWith({
        account,
        messageName: replacement,
        text: doneStatus,
      });
      expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith({
        account,
        space: "spaces/LIVE",
        text: "the answer",
        thread: replacementThread,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
