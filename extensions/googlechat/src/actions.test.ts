import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

// mock-isolation: Action fixtures provide account selection without loading real credentials.
vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount: vi.fn(),
  listGoogleChatAccountIds: vi.fn(),
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;
const remoteMedia = "https://example.invalid/image.png";
const link = `Attachment: ${remoteMedia}`;

beforeAll(async () => {
  ({ googlechatMessageActions } = await import("./message-tool-api.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccount.mockReturnValue({ credentialSource: "service-account" });
  resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./api.js");
  vi.doUnmock("./targets.js");
  vi.resetModules();
});

function send(params: Record<string, unknown>, action = "send") {
  return googlechatMessageActions.handleAction({
    action,
    params,
    cfg: {},
    accountId: "default",
  } as never);
}

it("supports only send actions", () => {
  expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
  expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
});

it.each([
  ["caption", undefined, "thread-1", "caption"],
  [undefined, remoteMedia, undefined, link],
  ["caption", remoteMedia, undefined, `caption\n\n${link}`],
])("sends %s through the resolved space", async (message, media, thread, text) => {
  sendGoogleChatMessage.mockResolvedValue({
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "spaces/AAA/threads/thread-1",
  });

  const result = await send({ to: "spaces/AAA", message, media, threadId: thread });
  expect(sendGoogleChatMessage.mock.lastCall?.[0]).toMatchObject({
    space: "spaces/AAA",
    text,
    thread,
  });
  expect(result.details).toMatchObject({
    ok: true,
    to: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "spaces/AAA/threads/thread-1",
    receipt: {
      platformMessageIds: ["spaces/AAA/messages/msg-1"],
      threadId: "spaces/AAA/threads/thread-1",
    },
  });
});

it("renders message-tool Markdown for Google Chat before sending", async () => {
  sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

  await send({
    to: "spaces/AAA",
    message: "**Completed ✅**\n\nThe [tracker item](https://example.com/item) is updated.",
    threadId: "spaces/AAA/threads/source",
  });

  expect(sendGoogleChatMessage.mock.lastCall?.[0]).toMatchObject({
    space: "spaces/AAA",
    text: "*Completed ✅*\n\nThe <https://example.com/item|tracker item> is updated.",
    thread: "spaces/AAA/threads/source",
  });
});

it("keeps long sends in the first thread and reports the delivered thread", async () => {
  sendGoogleChatMessage
    .mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/new-thread",
    })
    .mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/msg-2",
      threadName: "spaces/AAA/threads/new-thread",
    });

  const result = await send({ to: "spaces/AAA", message: "x".repeat(33_000) });

  expect(sendGoogleChatMessage).toHaveBeenCalledTimes(2);
  expect(sendGoogleChatMessage.mock.calls[0]?.[0].thread).toBeUndefined();
  expect(sendGoogleChatMessage.mock.calls[1]?.[0].thread).toBe("spaces/AAA/threads/new-thread");
  // Source-reply completion needs the delivered thread. Without it, the runner
  // cannot tell this answer from a send to another thread and answers twice.
  expect(result.details).toMatchObject({
    receipt: {
      platformMessageIds: ["spaces/AAA/messages/msg-1", "spaces/AAA/messages/msg-2"],
      threadId: "spaces/AAA/threads/new-thread",
    },
  });
});

it("reports the accepted prefix when a later message chunk fails", async () => {
  sendGoogleChatMessage
    .mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/new-thread",
    })
    .mockRejectedValueOnce(new Error("second chunk failed"));

  const error = await send({ to: "spaces/AAA", message: "x".repeat(33_000) }).catch(
    (caught: unknown) => caught,
  );

  expect(error).toMatchObject({
    code: "CHANNEL_PARTIAL_DELIVERY",
    message: "second chunk failed",
    deliveryResult: {
      messageIds: ["spaces/AAA/messages/msg-1"],
      content: sendGoogleChatMessage.mock.calls[0]?.[0].text,
      visibleReplySent: true,
    },
  });
});

it("reports no receipt when Google Chat suppresses the send", async () => {
  sendGoogleChatMessage.mockResolvedValue(null);

  const result = await send({ to: "spaces/AAA", message: "answer" });

  expect(result.details).toEqual({ ok: true, to: "spaces/AAA" });
});

it.each([
  { media: "remote.png" },
  { mediaUrls: ["remote.png"] },
  { attachments: [{ url: "remote.png" }] },
])("rejects local attachments %j before provider access", async (media) => {
  await expect(send({ to: "spaces/AAA", message: "caption", ...media })).rejects.toThrow(
    "Google Chat outbound attachments require remote HTTP(S) URLs.",
  );

  expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
  expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
  expect(sendGoogleChatMessage).not.toHaveBeenCalled();
});

it("rejects unsupported actions without provider access", async () => {
  await expect(send({}, "react")).rejects.toThrow(
    "Action react is not supported for provider googlechat.",
  );

  expect(sendGoogleChatMessage).not.toHaveBeenCalled();
});
