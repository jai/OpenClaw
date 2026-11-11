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
import { formatGoogleChatTextChunks } from "./format.js";
import { findGoogleChatProgressActivity } from "./progress-activity.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const OUTBOUND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const;
const STRUCTURED_ATTACHMENT_MEDIA_KEYS = [...OUTBOUND_MEDIA_KEYS, "url"] as const;

function hasGoogleChatOutboundAttachment(params: Record<string, unknown>): boolean {
  if (OUTBOUND_MEDIA_KEYS.some((key) => readStringParam(params, key) !== undefined)) {
    return true;
  }
  if (readStringArrayParam(params, "mediaUrls") !== undefined) {
    return true;
  }
  if (!Array.isArray(params.attachments)) {
    return false;
  }
  return params.attachments.some(
    (attachment) =>
      isRecord(attachment) &&
      STRUCTURED_ATTACHMENT_MEDIA_KEYS.some(
        (key) => readStringParam(attachment, key) !== undefined,
      ),
  );
}

export async function handleGoogleChatAction({
  action,
  params,
  cfg,
  accountId,
  assertDirectAdapterHandoff,
  onPlatformSendDispatch,
  sourceReplyFinal,
  sessionKey,
}: ChannelMessageActionContext) {
  if (action === "upload-file" || (action === "send" && hasGoogleChatOutboundAttachment(params))) {
    throw new Error(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
    );
  }

  const account = resolveGoogleChatAccount({
    cfg,
    accountId,
  });
  if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
    throw new Error("Google Chat credentials are missing.");
  }

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const content = readStringParam(params, "message", {
      required: true,
      allowEmpty: true,
    });
    const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
    const space = await resolveGoogleChatOutboundSpace({
      account,
      target: to,
      assertDirectAdapterHandoff,
    });

    // A progress send folds into the turn's live activity message, which the
    // monitor removes when the turn settles, instead of posting a standalone
    // message that is never cleaned up.
    if (sourceReplyFinal === false && content.trim()) {
      const activity = findGoogleChatProgressActivity({
        accountId: account.accountId,
        spaceId: space,
        // Chat drops thread names outside this space, so the send would not land there.
        threadName:
          threadId &&
          /^spaces\/[^/]+\/threads\/[^/]+$/.test(threadId) &&
          threadId.startsWith(`${space}/threads/`)
            ? threadId
            : undefined,
        sessionKey,
      });
      if (
        activity &&
        (await activity.update(content, { assertDirectAdapterHandoff, onPlatformSendDispatch }))
      ) {
        const receipt = createMessageReceiptFromOutboundResults({
          results: [
            {
              channel: "googlechat",
              messageId: activity.messageName,
              chatId: space,
              conversationId: space,
            },
          ],
          threadId: activity.threadName,
          kind: "text",
        });
        return jsonResult({
          ok: true,
          to: space,
          messageName: activity.messageName,
          threadName: activity.threadName,
          foldedIntoActivity: true,
          receipt,
        });
      }
    }

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
