import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

import { registerGoogleChatProgressActivity } from "./progress-activity.js";

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./message-tool-api.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function buildAccount() {
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      config: { groupPolicy: "open", dmPolicy: "open" },
    };
  }

  function expectJsonResult(result: unknown, details: Record<string, unknown>) {
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(details, null, 2),
        },
      ],
      details,
    });
  }

  it("describes only send actions when enabled accounts exist", () => {
    listGoogleChatAccountIds.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "inline",
      tokenStatus: "available",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("does not expose actions for configured-unavailable file credentials", () => {
    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "file",
      tokenStatus: "configured_unavailable",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();
  });

  it("keeps account-scoped discovery send-only", () => {
    inspectGoogleChatAccount.mockImplementation(
      ({ accountId: _accountId }: { accountId?: string | null }) => ({
        enabled: true,
        credentialSource: "inline",
        tokenStatus: "available",
        config: {},
      }),
    );

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({
        actions: ["send"],
      });
    }
  });

  it("folds a progress send into the live activity message in the same thread", async () => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    const update = vi.fn(async () => true);
    const unregister = registerGoogleChatProgressActivity({
      accountId: "default",
      spaceId: "spaces/AAA",
      messageName: "spaces/AAA/messages/activity",
      threadName: "spaces/AAA/threads/t1",
      sessionKey: "agent:main:main",
      update,
    });
    try {
      const result = await googlechatMessageActions.handleAction({
        action: "send",
        params: {
          to: "spaces/AAA",
          message: "Checking Linear next.",
          threadId: "spaces/AAA/threads/t1",
        },
        cfg: {},
        accountId: "default",
        sessionKey: "agent:main:main",
        sourceReplyFinal: false,
      } as never);
      expect(update).toHaveBeenCalledWith("Checking Linear next.", expect.any(Object));
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
      expect((result as { details: unknown }).details).toMatchObject({
        ok: true,
        foldedIntoActivity: true,
        messageName: "spaces/AAA/messages/activity",
      });
    } finally {
      unregister();
    }
  });

  it.each([
    { name: "a final send", sourceReplyFinal: true, updated: true, sessionKey: "agent:main:main" },
    {
      name: "a progress send after the activity closed",
      sourceReplyFinal: false,
      updated: false,
      sessionKey: "agent:main:main",
    },
    {
      name: "a progress send from another session",
      sourceReplyFinal: false,
      updated: true,
      sessionKey: "agent:other",
    },
  ])("posts $name as a separate message", async ({ sourceReplyFinal, updated, sessionKey }) => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });
    const unregister = registerGoogleChatProgressActivity({
      accountId: "default",
      spaceId: "spaces/AAA",
      messageName: "spaces/AAA/messages/activity",
      threadName: "spaces/AAA/threads/t1",
      sessionKey: "agent:main:main",
      update: vi.fn(async () => updated),
    });
    try {
      await googlechatMessageActions.handleAction({
        action: "send",
        params: { to: "spaces/AAA", message: "Update", threadId: "spaces/AAA/threads/t1" },
        cfg: {},
        accountId: "default",
        sessionKey,
        sourceReplyFinal,
      } as never);
      expect(sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("sends text through the resolved space", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });

    const result = await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        replyTo: "spaces/AAA/threads/requested",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "spaces/AAA/threads/requested",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
    const send = googlechatMessageActions.extractToolSend({
      args: { action: "send", to: "spaces/AAA", replyTo: "spaces/AAA/threads/requested" },
    });
    if (!send) {
      throw new Error("Expected Google Chat send evidence");
    }
    expect(send.threadId).toBe("spaces/AAA/threads/requested");
    expect(googlechatMessageActions.extractToolSendResult({ result, send })).toMatchObject({
      to: "spaces/AAA",
      threadId: "spaces/AAA/threads/thread-1",
    });
  });

  it.each([
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrls: ["remote.png"] },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ url: "remote.png" }],
      },
    },
    {
      action: "upload-file",
      params: { to: "spaces/AAA", message: "caption", path: "local.png" },
    },
  ])(
    "rejects outbound attachment action $action before provider access",
    async ({ action, params }) => {
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params,
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow(
        "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
      );

      expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
      expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported actions without provider access", async () => {
    const action = "react";
    resolveGoogleChatAccount.mockReturnValue(buildAccount());

    await expect(
      googlechatMessageActions.handleAction({
        action,
        params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
