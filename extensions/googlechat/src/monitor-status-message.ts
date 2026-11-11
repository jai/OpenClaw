import { createStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { updateGoogleChatMessage } from "./api.js";

const LABELS: Record<string, string> = {
  "👀": "Received",
  "🧠": "Thinking…",
  "🛠️": "Running a tool…",
  "💻": "Working on code…",
  "🌐": "Accessing the web…",
  "🛫": "Deploying…",
  "🏗️": "Building…",
  "💁": "Using the browser…",
  "🗜️": "Organizing context…",
  "⏳": "Still working…",
  "🗺️": "Updating the plan…",
  "📖": "Reading a file…",
  "✍️": "Writing a file…",
  "📝": "Editing a file…",
  "🩹": "Applying code changes…",
  "🔎": "Searching…",
  "📄": "Fetching a web page…",
  "🧰": "Managing tools…",
  "⌨️": "Using the terminal…",
  "🖱️": "Using the computer…",
  "📱": "Using a device…",
  "🖥️": "Working with the screen…",
  "🖼️": "Working with images…",
  "📋": "Updating the dashboard…",
  "📎": "Attaching a file…",
  "⏰": "Managing scheduled tasks…",
  "🎯": "Updating the goal…",
  "❓": "Preparing a question…",
  "🔑": "Accessing credentials…",
  "✨": "Suggesting a task…",
  "🗑️": "Dismissing a task…",
  "🦀": "Managing OpenClaw…",
  "🔌": "Managing the gateway…",
  "🧩": "Using a tool…",
  "📊": "Checking session status…",
  "🔀": "Publishing to GitHub…",
  "🔐": "Checking GitHub access…",
  "🗂️": "Managing sessions…",
  "💬": "Checking conversations…",
  "📨": "Sending a message…",
  "↔️": "Working with another conversation…",
  "🧾": "Processing results…",
  "🎙️": "Working with transcripts…",
  "🧑‍🔧": "Delegating work…",
  "🤖": "Coordinating agents…",
  "🧭": "Finding agents…",
  "📓": "Reading memory…",
  "🧮": "Running code…",
  "✉️": "Working with messages…",
  "🎨": "Generating images…",
  "🎵": "Generating music…",
  "🎬": "Generating video…",
  "📑": "Reading a PDF…",
  "⏸️": "Waiting…",
  "🔊": "Generating speech…",
};

/** Updates an existing typing placeholder; final-answer delivery owns its lifetime. */
export async function createGoogleChatStatusMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  onError: (error: unknown) => void;
  enabled?: boolean;
}) {
  let closed = false;
  let pendingWrite = Promise.resolve();
  // Progress text stays visible; the latest status label is shown under it.
  let progressText: string | undefined;
  let statusLine: string | undefined;
  const compose = () =>
    [statusLine ? progressText?.slice(0, 3800) : progressText, statusLine]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  const write = (): Promise<boolean> => {
    const text = compose();
    const next = pendingWrite.then(async () => {
      if (closed || !text) {
        return false;
      }
      await updateGoogleChatMessage({
        account: params.account,
        messageName: params.messageName,
        text,
      });
      return true;
    });
    pendingWrite = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const updateText = (text: string): Promise<boolean> => {
    progressText = text;
    return write();
  };
  const controller = createStatusReactionController({
    enabled: params.enabled !== false,
    initialEmoji: "👀",
    presentation: "activity",
    // Silence between lifecycle events does not mean the run has failed.
    emojis: { stallSoft: "⏳", stallHard: "⏳" },
    adapter: {
      setReaction: async (emoji) => {
        statusLine = `${emoji} ${LABELS[emoji] ?? "Working…"}`;
        await write();
      },
    },
    onError: params.onError,
  });
  await controller.setQueued();
  return {
    controller,
    updateText,
    isClosed: () => closed,
    // Drain activity and commentary writes before final delivery or cleanup.
    stop: async () => {
      closed = true;
      await controller.clear();
      await pendingWrite;
    },
  };
}
