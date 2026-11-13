import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { formatGoogleChatMediaText, formatGoogleChatTextChunks } from "./format.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const OUTBOUND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const;
const STRUCTURED_ATTACHMENT_MEDIA_KEYS = [...OUTBOUND_MEDIA_KEYS, "url"] as const;

function readGoogleChatMediaUrls(params: Record<string, unknown>): string[] {
  return [
    ...OUTBOUND_MEDIA_KEYS.map((key) => readStringParam(params, key)),
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
    ...(Array.isArray(params.attachments) ? params.attachments : []).flatMap((attachment) =>
      isRecord(attachment)
        ? STRUCTURED_ATTACHMENT_MEDIA_KEYS.map((key) => readStringParam(attachment, key))
        : [],
    ),
  ].filter((value): value is string => value !== undefined);
}

export async function handleGoogleChatAction({
  action,
  params,
  cfg,
  accountId,
  assertDirectAdapterHandoff,
  onPlatformSendDispatch,
}: ChannelMessageActionContext) {
  if (action === "upload-file") {
    throw new Error(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
    );
  }

  const mediaUrls = action === "send" ? readGoogleChatMediaUrls(params) : [];
  const content =
    action === "send"
      ? formatGoogleChatMediaText(
          readStringParam(params, "message", {
            required: mediaUrls.length === 0,
            allowEmpty: true,
          }),
          mediaUrls,
        )
      : "";

  const account = resolveGoogleChatAccount({
    cfg,
    accountId,
  });
  if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
    throw new Error("Google Chat credentials are missing.");
  }

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
    const space = await resolveGoogleChatOutboundSpace({
      account,
      target: to,
      assertDirectAdapterHandoff,
    });

    // Render CommonMark into Chat markup and keep every chunk in the first chunk's thread.
    const chunks = formatGoogleChatTextChunks(content);
    let thread = threadId ?? undefined;
    let sent: Awaited<ReturnType<typeof sendGoogleChatMessage>> = null;
    const acceptedText: Array<{ id?: string; text: string }> = [];
    let deliveredThread: string | undefined;
    for (const text of chunks.length > 0 ? chunks : [""]) {
      try {
        sent = await sendGoogleChatMessage({
          account,
          space,
          text,
          thread,
          assertDirectAdapterHandoff,
          onPlatformSendDispatch,
        });
      } catch (error) {
        if (acceptedText.length === 0) {
          throw error;
        }
        // Report accepted chunks so a retry cannot silently duplicate them.
        throw createChannelPartialDeliveryError(error, {
          messageIds: acceptedText.flatMap(({ id }) => (id ? [id] : [])),
          content: acceptedText.map(({ text: delivered }) => delivered).join("\n"),
          visibleReplySent: true,
        });
      }
      if (sent) {
        acceptedText.push({ id: sent.messageName, text });
      }
      thread = sent?.threadName ?? thread;
      deliveredThread = sent?.threadName ?? deliveredThread;
    }
    const messageNames = acceptedText.flatMap(({ id }) => (id ? [id] : []));
    if (messageNames.length === 0) {
      return jsonResult({ ok: true, to: space, ...sent });
    }
    // Only Chat's confirmed thread proves a source reply when the send inherited it.
    const receipt = createMessageReceiptFromOutboundResults({
      results: messageNames.map((messageId) => ({
        channel: "googlechat",
        messageId,
        chatId: space,
        conversationId: space,
      })),
      threadId: deliveredThread,
      kind: "text",
    });
    return jsonResult({ ok: true, to: space, ...sent, receipt });
  }

  throw new Error(`Action ${action} is not supported for provider googlechat.`);
}
