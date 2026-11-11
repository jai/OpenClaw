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
  const inThread: GoogleChatProgressActivity[] = [];
  for (const activity of liveActivities) {
    if (
      activity.accountId === params.accountId &&
      activity.spaceId === params.spaceId &&
      activity.threadName === threadName
    ) {
      inThread.push(activity);
    }
  }
  const sameSession = sessionKey
    ? inThread.filter((activity) => activity.sessionKey.toLowerCase() === sessionKey).at(-1)
    : undefined;
  // Session keys can differ in shape for one turn; fall back to the thread
  // only when a single turn owns it, so concurrent turns never edit each other.
  return sameSession ?? (inThread.length === 1 ? inThread[0] : undefined);
}

export function describeGoogleChatProgressActivities(accountId: string, spaceId: string): string {
  return [...liveActivities]
    .filter((activity) => activity.accountId === accountId && activity.spaceId === spaceId)
    .map((activity) => `${activity.sessionKey}@${activity.threadName ?? "top"}`)
    .join(",");
}
