import { beforeEach, describe, expect, it, vi } from "vitest";

const updateGoogleChatMessage = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./api.js", () => ({ updateGoogleChatMessage }));

const { createGoogleChatStatusMessage } = await import("./monitor-status-message.js");

const account = { accountId: "default" } as never;

function texts(): string[] {
  return updateGoogleChatMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
}

describe("Google Chat activity message", () => {
  beforeEach(() => {
    updateGoogleChatMessage.mockClear();
  });

  it("keeps progress text visible when the status label changes", async () => {
    const activity = await createGoogleChatStatusMessage({
      account,
      messageName: "spaces/A/messages/activity",
      onError: () => {},
    });
    await activity.updateText("All 12 removals are verified.");
    await activity.controller.setTool("exec");
    await activity.stop();

    const last = texts().at(-1) ?? "";
    expect(last.startsWith("All 12 removals are verified.\n\n")).toBe(true);
    expect(last).not.toBe("All 12 removals are verified.");
    expect(texts().every((text) => text.length > 0)).toBe(true);
  });

  it("shows only the status label before any progress", async () => {
    const activity = await createGoogleChatStatusMessage({
      account,
      messageName: "spaces/A/messages/activity",
      onError: () => {},
    });
    await activity.controller.setTool("exec");
    await activity.stop();

    expect(texts().some((text) => text.includes("\n\n"))).toBe(false);
  });

  it("reports a skipped write after the activity closes", async () => {
    const activity = await createGoogleChatStatusMessage({
      account,
      messageName: "spaces/A/messages/activity",
      onError: () => {},
    });
    await activity.stop();
    expect(await activity.updateText("late")).toBe(false);
  });
});
