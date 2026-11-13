import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { formatGoogleChatMediaText, formatGoogleChatTextChunks } from "./format.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export type GoogleChatTypingMessage = ReturnType<typeof createGoogleChatTypingMessage>;

export function createGoogleChatTypingMessage(params: {
  messageName: string;
  requestedThreadName?: string;
  deliveredThreadName?: string;
}) {
  const name = params.messageName.trim();
  const requestedThreadName = params.requestedThreadName?.trim();
  if (!requestedThreadName) {
    return { placement: "top-level" as const, name };
  }
  return {
    placement: "thread" as const,
    name,
    requestedThreadName,
    deliveredThreadName: params.deliveredThreadName?.trim() || requestedThreadName,
  };
}

/**
 * Posts a reply as new messages after the turn's activity message. The activity
 * message never becomes the answer, so it can be cleaned up independently.
 */
export async function deliverGoogleChatReply(params: {
  payload: ReplyPayload;
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessage?: GoogleChatTypingMessage;
  onTextDelivered?: (messageName: string) => void;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink } = params;
  const typingMessage = params.typingMessage;
  const replyThreadName = payload.replyToId?.trim() || undefined;
  const reply = resolveSendableOutboundReplyParts(payload);
  let deliveryThreadName = replyThreadName;
  const acceptedText: Array<{ id?: string; text: string }> = [];
  const runTextOperation = async <T>(operation: Promise<T>): Promise<T> =>
    await operation.catch((error: unknown) => {
      if (acceptedText.length === 0) {
        throw error;
      }
      throw createChannelPartialDeliveryError(error, {
        messageIds: acceptedText.flatMap(({ id }) => (id ? [id] : [])),
        content: acceptedText.map(({ text }) => text).join("\n"),
        visibleReplySent: true,
      });
    });

  // The requested thread decides whether the activity message shares this reply's
  // thread; the provider-returned thread owns every later physical send after fallback.
  if (
    typingMessage?.placement === "thread" &&
    typingMessage.requestedThreadName === replyThreadName
  ) {
    deliveryThreadName = typingMessage.deliveredThreadName;
  }

  let text: string;
  try {
    text = formatGoogleChatMediaText(reply.text, reply.mediaUrls);
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : String(cause),
      { cause, retryable: false },
    );
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
  const chunks = formatGoogleChatTextChunks(text, chunkLimit).flatMap((chunk) =>
    core.channel.text.chunkMarkdownTextWithMode(chunk, chunkLimit, chunkMode),
  );
  if (text && !chunks.some((chunk) => chunk)) {
    // Permanent policy rejection before any recipient-visible send; the typed
    // contract keeps delivery custody from recording a false ambiguous attempt.
    throw new PlatformMessageNotDispatchedError(
      "Google Chat reply has no visible text after formatting.",
      { cause: undefined, retryable: false },
    );
  }

  const recordOutboundStatus = () => {
    try {
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Google Chat outbound status update failed: ${String(err)}`);
    }
  };
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    const sent = await runTextOperation(
      sendGoogleChatMessage({
        account,
        space: spaceId,
        text: chunk,
        thread: deliveryThreadName,
      }),
    );
    if (sent) {
      const id = sent.messageName?.trim() || undefined;
      acceptedText.push({ id, text: chunk });
      if (id) {
        params.onTextDelivered?.(id);
      }
    }
    if (replyThreadName) {
      deliveryThreadName = sent?.threadName?.trim() || deliveryThreadName;
    }
    recordOutboundStatus();
  }
}
