import { createHash } from "node:crypto";
import {
  formatInboundMediaUnavailableText,
  recordChannelBotPairLoopAndCheckSuppression,
  createChannelInboundEnvelopeBuilderAsync,
  toInboundMediaFactsWithMetadata,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { parseDateStringTimestampMs as resolveGoogleChatTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  deleteGoogleChatMessage,
  downloadGoogleChatMedia,
  GoogleChatApiError,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
} from "./api.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import { formatGoogleChatTextChunks } from "./format.js";
import { applyGoogleChatInboundAccessPolicy } from "./monitor-access.js";
import {
  createGoogleChatIngressMonitor,
  type GoogleChatIngressLifecycle,
} from "./monitor-ingress.js";
import {
  createGoogleChatTypingMessage,
  deliverGoogleChatReply,
  resolveBotDisplayName,
  type GoogleChatTypingMessage,
} from "./monitor-reply-delivery.js";
import { resolveGoogleChatReplyThread } from "./monitor-reply-target.js";
import {
  registerGoogleChatWebhookTarget,
  setGoogleChatWebhookEventProcessor,
} from "./monitor-routing.js";
import { createGoogleChatStatusMessage } from "./monitor-status-message.js";
import type {
  GoogleChatCoreRuntime,
  GoogleChatMonitorOptions,
  GoogleChatRuntimeEnv,
  WebhookTarget,
} from "./monitor-types.js";
import { warnAppPrincipalMisconfiguration } from "./monitor-webhook.js";
import { hasGoogleChatMedia, registerGoogleChatActivityProgress } from "./progress-activity.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatInboundIsGroup, resolveGoogleChatMemberLabel } from "./space-members.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";

setGoogleChatWebhookEventProcessor(processGoogleChatEvent);

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

async function processGoogleChatEvent(
  event: GoogleChatEvent,
  target: WebhookTarget,
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
  config: OpenClawConfig = target.config,
): Promise<void> {
  const eventType = event.type ?? event.eventType;
  if (eventType === "CARD_CLICKED") {
    await maybeHandleGoogleChatApprovalCardClick({ event, target });
    return;
  }
  if (eventType !== "MESSAGE") {
    return;
  }
  const { account, runtime, core, statusSink, mediaMaxMb } = target;
  const space = event.space;
  const message = event.message;
  if (!space || !message) {
    return;
  }

  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email;
  const isBotSender = sender?.type?.toUpperCase() === "BOT";
  const appUserId = account.config.botUser?.trim() || "users/app";

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (isBotSender) {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId === "users/app") {
      logVerbose(core, runtime, "skip app-authored message");
      return;
    }
  }

  const messageText = (message.argumentText ?? message.text ?? "").trim();
  const attachments = message.attachment ?? [];
  let rawBody = messageText;
  if (!rawBody && attachments.length === 0) {
    return;
  }

  const isGroup = await resolveGoogleChatInboundIsGroup({
    account,
    space,
    logVerbose: (messageLocal) => logVerbose(core, runtime, messageLocal),
  });

  const route = resolveAgentRoute({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: spaceId,
    },
  });
  const replyThreadName = message.thread?.name;
  // Session storage canonicalizes keys to lowercase. Hash the case-sensitive
  // resource name and use the routeless :subsession: suffix instead of the
  // generic :thread: suffix, which is interpreted as a physical reply target.
  const dispatchSessionKey =
    isGroup && account.config.sessionThread === true && replyThreadName?.trim()
      ? `${route.sessionKey}:subsession:${createHash("sha256").update(replyThreadName.trim()).digest("hex").slice(0, 16)}`
      : route.sessionKey;

  const access = await applyGoogleChatInboundAccessPolicy({
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    contextBinding: {
      agentId: route.agentId,
      sessionKey: dispatchSessionKey,
      ...(message.name ? { messageId: message.name } : {}),
      inboundEventKind: "user_request",
    },
    statusSink,
    logVerbose: (messageLocal) => logVerbose(core, runtime, messageLocal),
  });
  if (!access.ok) {
    return;
  }
  const { commandAuthorized, effectiveWasMentioned, groupBotLoopProtection, groupSystemPrompt } =
    access;
  if (allowBots && isBotSender && senderId && senderId !== appUserId) {
    const botLoopResult = recordChannelBotPairLoopAndCheckSuppression({
      scopeId: account.accountId,
      conversationId: spaceId,
      senderId,
      receiverId: appUserId,
      config: mergePairLoopGuardConfig(account.config.botLoopProtection, groupBotLoopProtection),
      defaultsConfig: config.channels?.defaults?.botLoopProtection,
      defaultEnabled: true,
      nowMs: resolveGoogleChatTimestampMs(event.eventTime),
    });
    if (botLoopResult.suppressed) {
      logVerbose(core, runtime, `skip bot-to-bot loop in ${spaceId}`);
      return;
    }
  }

  const mediaInputs: ChannelInboundMediaInput[] = attachments.map((attachment) => ({
    contentType: attachment.contentType,
  }));
  const attachmentNotices = new Set<string>();
  const reportAttachmentUnavailable = (notice: string, hint = "") => {
    if (attachmentNotices.has(notice)) {
      return;
    }
    attachmentNotices.add(notice);
    rawBody = formatInboundMediaUnavailableText({ body: rawBody, notice });
    runtime.error?.(`[${account.accountId}] ${notice}${hint}`);
  };
  for (const [index, attachment] of attachments.entries()) {
    try {
      const attachmentData = await downloadAttachment(attachment, account, mediaMaxMb, core);
      if (attachmentData) {
        mediaInputs[index] = {
          path: attachmentData.path,
          url: attachmentData.path,
          contentType: attachmentData.contentType ?? attachment.contentType,
        };
      } else {
        const reason = attachment.driveDataRef
          ? "Google Drive files are not downloadable"
          : "unsupported attachment source";
        const notice = `[Google Chat attachment unavailable: ${reason}; upload the file directly]`;
        reportAttachmentUnavailable(notice);
      }
    } catch (error) {
      const missing = error instanceof GoogleChatApiError && error.status === 404;
      if (!missing && (!(error instanceof MediaFetchError) || error.code !== "max_bytes")) {
        throw error;
      }
      // Adopt permanent attachment failures after authorizing the original text; retrying
      // them would block every later durable message in the same conversation.
      const notice = missing
        ? "[Google Chat attachment unavailable: file not found; upload the file directly]"
        : `[Google Chat attachment too large; maximum ${mediaMaxMb} MB]`;
      reportAttachmentUnavailable(
        notice,
        missing ? "" : " Increase channels.googlechat.mediaMaxMb to process larger attachments.",
      );
    }
  }
  const media = mediaInputs.length === 0 ? [] : await toInboundMediaFactsWithMetadata(mediaInputs);

  const fromLabel = isGroup
    ? space.displayName ||
      (await resolveGoogleChatMemberLabel({
        account,
        space,
        logVerbose: (messageLocal) => logVerbose(core, runtime, messageLocal),
      })) ||
      `space:${spaceId}`
    : senderName || `user:${senderId}`;
  const timestampMs = resolveGoogleChatTimestampMs(event.eventTime);
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
    cfg: config,
    route: { ...route, sessionKey: dispatchSessionKey },
  });
  const body = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: timestampMs,
    body: rawBody,
  });

  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress: access.channelIngress,
    channel: "googlechat",
    accountId: route.accountId,
    messageId: message.name,
    messageIdFull: message.name,
    timestamp: timestampMs,
    from: `googlechat:${senderId}`,
    sender: {
      id: senderId,
      name: senderName || undefined,
      username: senderEmail,
      isBot: isBotSender || undefined,
    },
    conversation: {
      kind: isGroup ? "channel" : "direct",
      id: spaceId,
      label: fromLabel,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey,
    },
    reply: {
      to: `googlechat:${spaceId}`,
      originatingTo: `googlechat:${spaceId}`,
      replyToId: replyThreadName,
      replyToIdFull: replyThreadName,
      messageThreadId: dispatchSessionKey === route.sessionKey ? undefined : replyThreadName,
    },
    message: {
      body,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    },
    media: media.length > 0 ? media : undefined,
    supplemental: {
      groupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    },
    extra: {
      ChatType: isGroup ? "channel" : "direct",
      TransportThreadId: account.config.replyToMode === "all" ? replyThreadName : undefined,
      WasMentioned: isGroup ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      GroupSubject: undefined,
      GroupSpace: isGroup ? space.displayName : undefined,
    },
  });

  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`,
    );
    typingIndicator = "message";
  }
  let typingMessage: GoogleChatTypingMessage | undefined;
  let hasThreadedReply = false;
  const progressMessageNames = new Set<string>();
  let hasVisibleAnswer = false;
  const isProgressReply = (payload: ReplyPayload, kind?: string) =>
    !payload.isError &&
    !payload.isCompactionNotice &&
    !payload.isFallbackNotice &&
    (kind === "tool" || payload.isCommentary === true || payload.isStatusNotice === true);
  const cleanupProgress = async () => {
    for (const messageName of progressMessageNames) {
      try {
        await deleteGoogleChatMessage({ account, messageName });
        progressMessageNames.delete(messageName);
      } catch (err) {
        if (err instanceof GoogleChatApiError && err.status === 404) {
          progressMessageNames.delete(messageName);
        } else {
          runtime.error?.(`Google Chat progress cleanup failed: ${String(err)}`);
        }
      }
    }
  };
  const resolveReplyThreadName = (payload: ReplyPayload): string | undefined => {
    const thread = resolveGoogleChatReplyThread({
      payload,
      sourceMessageName: message.name,
      replyThreadName,
      replyToMode: account.config.replyToMode,
      hasThreadedReply,
    });
    return typingMessage?.placement === "thread" && typingMessage.requestedThreadName === thread
      ? typingMessage.deliveredThreadName
      : thread;
  };
  const effectiveReplyThreadName = resolveReplyThreadName({ text: "" });

  if (typingIndicator === "message") {
    try {
      const botName = resolveBotDisplayName({
        accountName: account.config.name,
        agentId: route.agentId,
        config,
      });
      const result = await sendGoogleChatMessage({
        account,
        space: spaceId,
        text: `_${botName} is typing..._`,
        thread: effectiveReplyThreadName,
      });
      if (result?.messageName) {
        typingMessage = createGoogleChatTypingMessage({
          messageName: result.messageName,
          requestedThreadName: effectiveReplyThreadName,
          deliveredThreadName: result.threadName,
        });
      }
    } catch (err) {
      runtime.error?.(`Failed sending typing message: ${String(err)}`);
    }
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const activity = typingMessage
    ? await createGoogleChatStatusMessage({
        enabled: config.messages?.statusReactions?.enabled === true,
        account,
        messageName: typingMessage.name,
        onError: (error) => runtime.error?.(`Google Chat status update failed: ${String(error)}`),
      })
    : undefined;
  // Progress folded into the activity message stays visible when the turn ends
  // without a separately posted answer, e.g. after handing work to a subagent.
  let foldedProgressText: string | undefined;
  let answerPosted = false;
  const unregisterProgressActivity =
    activity && typingMessage
      ? registerGoogleChatActivityProgress({
          accountId: account.accountId,
          spaceId,
          sessionKey: dispatchSessionKey,
          messageName: typingMessage.name,
          threadName: typingMessage.deliveredThreadName,
          chunkLimit,
          activity,
          onFolded: (text) => (foldedProgressText = text),
          onSeparatePost: () => (answerPosted = true),
        })
      : undefined;
  const stopActivity = async () => {
    unregisterProgressActivity?.();
    await activity?.stop();
  };
  let deferred = false;
  let lifecycleSettled = false;
  let deliveryFailed = false;
  let settlement: Promise<void> | undefined;
  const settleStatus = () =>
    (settlement ??= (async () => {
      await stopActivity();
      if (hasVisibleAnswer) {
        await cleanupProgress();
      }
      const placeholder = typingMessage;
      typingMessage = undefined;
      if (placeholder && foldedProgressText && !answerPosted) {
        try {
          await updateGoogleChatMessage({
            account,
            messageName: placeholder.name,
            text: foldedProgressText,
          });
          return;
        } catch (error) {
          runtime.error?.(`Google Chat folded progress restore failed: ${String(error)}`);
        }
      }
      if (placeholder) {
        try {
          await deleteGoogleChatMessage({ account, messageName: placeholder.name });
        } catch (error) {
          if (!(error instanceof GoogleChatApiError && error.status === 404)) {
            runtime.error?.(`Google Chat typing cleanup failed: ${String(error)}`);
          }
        }
      }
    })());
  const settleDeferred = async () => {
    await stopActivity();
    // A queued turn settles after its own delivery; remove the activity even
    // when it ended silently, but keep feedback after a failed send.
    if (!deliveryFailed) {
      await settleStatus();
    }
  };
  const lifecycle: Parameters<
    GoogleChatCoreRuntime["channel"]["inbound"]["run"]
  >[0]["turnAdoptionLifecycle"] = typingMessage
    ? {
        ...turnAdoptionLifecycle,
        onAdopted: () => turnAdoptionLifecycle?.onAdopted(),
        onDeferred: () => {
          turnAdoptionLifecycle?.onDeferred();
          deferred = true;
        },
        onSettled: () => {
          lifecycleSettled = true;
          return deferred
            ? settleDeferred().catch((error: unknown) =>
                runtime.error?.(`Google Chat deferred status cleanup failed: ${String(error)}`),
              )
            : undefined;
        },
      }
    : turnAdoptionLifecycle;
  try {
    const turnResult = await core.channel.inbound.run({
      channel: "googlechat",
      accountId: route.accountId,
      raw: message,
      ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
      adapter: {
        ingest: () => ({
          id: message.name ?? spaceId,
          timestamp: timestampMs,
          rawText: rawBody,
          textForAgent: rawBody,
          textForCommands: rawBody,
          raw: message,
        }),
        resolveTurn: () => ({
          cfg: config,
          channel: "googlechat",
          accountId: route.accountId,
          route: { agentId: route.agentId, sessionKey: dispatchSessionKey },
          ctxPayload,
          delivery: {
            durable: async (payload, info) => {
              if (
                isProgressReply(payload, info.kind) ||
                payload.isCompactionNotice ||
                payload.isFallbackNotice
              ) {
                return false;
              }
              if (info.kind !== "final") {
                return false;
              }
              await stopActivity();
              const threadId = resolveReplyThreadName(payload);
              return threadId
                ? { to: spaceId, replyToId: threadId, threadId }
                : { to: spaceId, replyToId: null };
            },
            deliver: async (payload, info) => {
              const replyToId = resolveReplyThreadName(payload);
              const progress = isProgressReply(payload, info?.kind);
              const folds = progress && !hasGoogleChatMedia(payload);
              if (folds && activity && replyToId === resolveReplyThreadName({ text: "" })) {
                const [text] = formatGoogleChatTextChunks(payload.text ?? "", chunkLimit);
                if (text) {
                  try {
                    const updated = await activity.updateText(text);
                    if (
                      updated &&
                      (payload.isCommentary === true || payload.isStatusNotice === true)
                    ) {
                      foldedProgressText = text;
                    }
                  } catch (error) {
                    runtime.error?.(`Google Chat progress update failed: ${String(error)}`);
                  }
                }
                return;
              }
              if (!progress && !payload.isCompactionNotice && !payload.isFallbackNotice) {
                await stopActivity();
              }
              try {
                await deliverGoogleChatReply({
                  payload: { ...payload, replyToId },
                  account,
                  spaceId,
                  runtime,
                  core,
                  config,
                  statusSink,
                  typingMessage,
                  onTextDelivered: (name) => {
                    if (progress) {
                      progressMessageNames.add(name);
                    }
                  },
                });
              } catch (error) {
                deliveryFailed = true;
                throw error;
              }
            },
            onDelivered: async (payload, info, result) => {
              if (
                result?.visibleReplySent !== false &&
                !result?.suppression &&
                !payload.isCompactionNotice &&
                !payload.isFallbackNotice &&
                !isProgressReply(payload, info?.kind)
              ) {
                hasVisibleAnswer = true;
                answerPosted = true;
                if (resolveReplyThreadName(payload)) {
                  hasThreadedReply = true;
                }
                if (
                  info?.kind === "final" &&
                  resolveReplyThreadName(payload) === resolveReplyThreadName({ text: "" })
                ) {
                  await settleStatus();
                }
              }
              statusSink?.({ lastOutboundAt: Date.now() });
            },
            onError: (err, info) => {
              deliveryFailed = true;
              runtime.error?.(
                `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
              );
            },
          },
          replyPipeline: {},
          replyOptions: {
            commentaryPayloadsEnabled: false,
            onObservedReplyDelivery: async () => {
              hasVisibleAnswer = answerPosted = true;
              await settleStatus();
            },
            ...(activity
              ? {
                  allowToolLifecycleWhenProgressHidden: true,
                  onReplyStart: async () => {
                    await activity.controller.setThinking();
                  },
                  onToolStart: async (payload) => {
                    await activity.controller.setTool(payload.name);
                    return false;
                  },
                  onCompactionStart: async () => {
                    await activity.controller.setCompacting();
                    return false;
                  },
                  onCompactionEnd: async () => {
                    await activity.controller.setThinking();
                    return false;
                  },
                }
              : {}),
          },
          record: {
            onRecordError: (err) => {
              runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
            },
          },
        }),
      },
    });
    if (turnResult?.dispatched && turnResult.dispatchResult.observedReplyDelivery) {
      hasVisibleAnswer = true;
    }
    if (turnResult?.dispatched && turnResult.dispatchResult.deferredToActiveRun) {
      deferred = true;
    }
  } finally {
    if (!deferred || lifecycleSettled) {
      await stopActivity();
      if (!deliveryFailed && (!deferred || hasVisibleAnswer)) {
        await settleStatus();
      }
    }
  }
}

async function downloadAttachment(
  attachment: GoogleChatAttachment,
  account: ResolvedGoogleChatAccount,
  mediaMaxMb: number,
  core: GoogleChatCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = mediaMaxMb * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, resourceName, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName,
  );
  return { path: saved.path, contentType: saved.contentType };
}

export async function startGoogleChatMonitor(
  options: GoogleChatMonitorOptions,
): Promise<() => Promise<void>> {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveGoogleChatWebhookPath(options);
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return async () => {};
  }

  const audienceType = options.account.config.audienceType;
  const audience = options.account.config.audience?.trim();
  if ((audienceType !== "app-url" && audienceType !== "project-number") || !audience) {
    const error =
      "Google Chat webhook authentication requires channels.googlechat.audienceType and channels.googlechat.audience.";
    options.runtime.error?.(`[${options.account.accountId}] ${error}`);
    options.statusSink?.(
      channelBlockedPatch(error, {
        running: true,
        connected: false,
        webhookPath: undefined,
      }),
    );
    return async () => {};
  }
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  warnAppPrincipalMisconfiguration({
    accountId: options.account.accountId,
    audienceType,
    appPrincipal: options.account.config.appPrincipal,
    log: options.runtime.log,
  });

  const readConfig = createRuntimeConfigReader(options.config);
  const ingress = createGoogleChatIngressMonitor({
    accountId: options.account.accountId,
    runtime: options.runtime,
    abortSignal: options.abortSignal,
    dispatch: async (event, lifecycle) => {
      await processGoogleChatEvent(event, target, lifecycle, readConfig());
    },
  });
  const target: WebhookTarget = {
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb,
    ingress,
  };
  ingress.start();
  let unregisterTarget: (() => void) | undefined;
  try {
    unregisterTarget = registerGoogleChatWebhookTarget(target);
    options.statusSink?.(channelReadyPatch());
  } catch (error) {
    await ingress.stop();
    throw error;
  }

  return async () => {
    unregisterTarget?.();
    await ingress.stop();
  };
}

// Invalid webhook URLs stay null so status never advertises an unbound default route.
export function resolveGoogleChatWebhookPath({
  webhookPath,
  webhookUrl,
}: Pick<GoogleChatMonitorOptions, "webhookPath" | "webhookUrl">): string | null {
  return resolveWebhookPath({
    webhookPath,
    webhookUrl,
    defaultPath: "/googlechat",
  });
}
