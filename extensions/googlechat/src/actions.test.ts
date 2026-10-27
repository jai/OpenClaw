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
  normalizeGoogleChatTarget: (raw: string) => raw.replace(/^googlechat:/, ""),
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;
const remoteMedia = "https://example.invalid/image.png";
const link = `Attachment: ${remoteMedia}`;
const originThread = "spaces/AAA/threads/origin";
const trustedDmContext = {
  requesterAccountId: "default",
  toolContext: {
    currentChannelProvider: "googlechat",
    currentChannelId: "googlechat:spaces/AAA",
    currentChatType: "direct",
    currentThreadTs: originThread,
    replyToMode: "all",
  },
};

beforeAll(async () => {
  ({ googlechatMessageActions } = await import("./message-tool-api.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccount.mockReturnValue({
    accountId: "default",
    credentialSource: "service-account",
  });
  resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./api.js");
  vi.doUnmock("./targets.js");
  vi.resetModules();
});

function send(
  params: Record<string, unknown>,
  action = "send",
  context: Record<string, unknown> = {},
) {
  return googlechatMessageActions.handleAction({
    action,
    params,
    cfg: {},
    accountId: "default",
    ...context,
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
  expect(result.details).toEqual({
    ok: true,
    to: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "spaces/AAA/threads/thread-1",
  });
});

it("keeps an explicit send in its originating DM thread when the model omits threadId", async () => {
  await send({ to: "spaces/AAA", message: "Following up" }, "send", trustedDmContext);

  expect(sendGoogleChatMessage.mock.lastCall?.[0]).toMatchObject({
    space: "spaces/AAA",
    thread: originThread,
  });
});

it("renders bold text and links in an explicit message send", async () => {
  await send({
    to: "spaces/AAA",
    message: "**Completed ✅**\n\nThe [GitHub UAM item](https://example.com/uam) is updated.",
    threadId: originThread,
  });

  expect(sendGoogleChatMessage.mock.lastCall?.[0]).toMatchObject({
    text: "*Completed ✅*\n\nThe <https://example.com/uam|GitHub UAM item> is updated.",
    thread: originThread,
  });
});

it("keeps every chunk of a long explicit send in the first message's thread", async () => {
  sendGoogleChatMessage
    .mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/first",
      threadName: "spaces/AAA/threads/new",
    })
    .mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/second",
      threadName: "spaces/AAA/threads/new",
    });

  await send({ to: "spaces/AAA", message: "x".repeat(33_000) });

  expect(sendGoogleChatMessage).toHaveBeenCalledTimes(2);
  expect(sendGoogleChatMessage.mock.calls[0]?.[0].thread).toBeUndefined();
  expect(sendGoogleChatMessage.mock.calls[1]?.[0].thread).toBe("spaces/AAA/threads/new");
});

it("honors an explicit thread even when the current DM has a different thread", async () => {
  await send(
    { to: "spaces/AAA", message: "New thread", threadId: "spaces/AAA/threads/explicit" },
    "send",
    trustedDmContext,
  );

  expect(sendGoogleChatMessage.mock.lastCall?.[0].thread).toBe("spaces/AAA/threads/explicit");
});

it.each([
  [
    "another provider",
    { toolContext: { ...trustedDmContext.toolContext, currentChannelProvider: "slack" } },
  ],
  ["another account", { requesterAccountId: "other" }],
  [
    "another space",
    { toolContext: { ...trustedDmContext.toolContext, currentChannelId: "spaces/BBB" } },
  ],
  [
    "another space's thread",
    {
      toolContext: {
        ...trustedDmContext.toolContext,
        currentThreadTs: "spaces/BBB/threads/origin",
      },
    },
  ],
  ["a group", { toolContext: { ...trustedDmContext.toolContext, currentChatType: "group" } }],
  ["reply mode off", { toolContext: { ...trustedDmContext.toolContext, replyToMode: "off" } }],
])("does not infer a DM thread for %s", async (_reason, override) => {
  await send({ to: "spaces/AAA", message: "Standalone" }, "send", {
    ...trustedDmContext,
    ...override,
  });

  expect(sendGoogleChatMessage.mock.lastCall?.[0].thread).toBeUndefined();
});

it("lets an explicit top-level send leave the originating DM thread", async () => {
  await send({ to: "spaces/AAA", message: "Standalone", topLevel: true }, "send", trustedDmContext);

  expect(sendGoogleChatMessage.mock.lastCall?.[0].thread).toBeUndefined();
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
