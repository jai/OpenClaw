/**
 * Live activity messages that a message-tool progress send can fold into.
 *
 * The monitor registers a turn's activity message while it is open. A
 * `message(action=send, final=false)` to the same space and thread edits that
 * message instead of posting a standalone progress message that nothing cleans up.
 */
export type GoogleChatProgressActivity = {
  accountId: string;
  spaceId: string;
  /** The activity message's resource name. */
  messageName: string;
  /** Thread Chat placed the activity message in; absent for top level. */
  threadName?: string;
  /** Session that owns the turn, so concurrent turns never edit each other's activity. */
  sessionKey: string;
  /** Returns false when the activity message was not edited. */
  update: (
    text: string,
    hooks: {
      assertDirectAdapterHandoff?: () => void;
      onPlatformSendDispatch?: () => Promise<void> | void;
    },
  ) => Promise<boolean>;
};

const liveActivities = new Set<GoogleChatProgressActivity>();

export function registerGoogleChatProgressActivity(
  activity: GoogleChatProgressActivity,
): () => void {
  liveActivities.add(activity);
  return () => {
    liveActivities.delete(activity);
  };
}

export function findGoogleChatProgressActivity(params: {
  accountId: string;
  spaceId: string;
  threadName?: string;
  sessionKey?: string | null;
}): GoogleChatProgressActivity | undefined {
  const threadName = params.threadName?.trim() || undefined;
  const sessionKey = params.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return undefined;
  }
  let match: GoogleChatProgressActivity | undefined;
  for (const activity of liveActivities) {
    if (activity.accountId !== params.accountId || activity.spaceId !== params.spaceId) {
      continue;
    }
    if (activity.threadName === threadName && activity.sessionKey.toLowerCase() === sessionKey) {
      // The most recently registered turn owns the visible activity message.
      match = activity;
    }
  }
  return match;
}
