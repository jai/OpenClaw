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
  /** Thread Chat placed the activity message in. */
  deliveredThreadName?: string;
  /** Thread names that identify the activity's placement; empty for top level. */
  threadNames: readonly string[];
  /** Returns false when the activity message can no longer be edited. */
  update: (text: string) => Promise<boolean>;
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
}): GoogleChatProgressActivity | undefined {
  const threadName = params.threadName?.trim();
  let match: GoogleChatProgressActivity | undefined;
  for (const activity of liveActivities) {
    if (activity.accountId !== params.accountId || activity.spaceId !== params.spaceId) {
      continue;
    }
    const placed = threadName
      ? activity.threadNames.includes(threadName)
      : activity.threadNames.length === 0;
    if (placed) {
      // The most recently registered turn owns the visible activity message.
      match = activity;
    }
  }
  return match;
}
