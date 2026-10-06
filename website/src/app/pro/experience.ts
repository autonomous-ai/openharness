// Local interaction study. These fixtures model the existing app/device identities;
// they never record audio, run agents, or send commands to a real host.
export type Intent = "task" | "goal" | "loop";
export type Activity =
  | "working"
  | "needs-you"
  | "ready"
  | "idle"
  | "instructed";
export type Agent = {
  id: string;
  engine: "claude" | "codex" | "hermes" | "pi";
  name: string;
  title: string;
  machine: string;
  workspace: string;
  activity: Activity;
  observedSeconds: number | null;
  detail: string;
  result?: string[];
  resultId?: string;
  resultRevision?: number;
};
export type Tile = {
  agentId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
export type Workspace = {
  id: string;
  name: string;
  machine: string;
  tiles: Tile[];
};
export type Question = {
  id: string;
  revision: number;
  agentId: string;
  text: string;
  options: string[];
  resolved: boolean;
};
export type Sheet =
  | "home"
  | "map"
  | "attention"
  | "question"
  | "result"
  | "compose"
  | "actions"
  | "find"
  | "new"
  | "usage"
  | "delivery"
  | "settings";
export type Bookmark = { agentId: string; workspace: string; line: number };
export type Passage = {
  id: string;
  agentId: string;
  sourceName: string;
  resultId: string;
  text: string;
  revision: number;
  expiresAt: number;
};
export type Composition = {
  id: string;
  hostId: string;
  recipient: string;
  recipientName: string;
  recipientTitle: string;
  recipientMachine: string;
  intent: Intent;
  phase: "ready" | "listening" | "review" | "sending" | "uncertain";
  text: string;
  part: number;
  priorText?: string;
  review: boolean;
  append: boolean;
  passage?: Passage;
  /** Starting the instruction attaches an immutable snapshot; only the unused tray expires. */
  passageAttached?: boolean;
  recovery?: {
    state: "offline" | "recovered" | "unavailable";
    total: number;
    delivery: "not-sent" | "unconfirmed" | "sent" | "rejected";
    /** A restart keeps identity only, including whether Carry was attached. */
    bookmark?: { carried: boolean };
  };
};
/** One volatile sample-host archive, separate from the one-part device copy. */
export type DraftArchive = {
  id: string;
  hostId: string;
  recipient: string;
  intent: Intent;
  passageId?: string;
  text: string;
  expiresAt: number;
  operationId?: string;
  delivery: NonNullable<Composition["recovery"]>["delivery"];
};
export type Operation = {
  id: string;
  kind: "voice" | "answer";
  agentId: string;
  intent: Intent;
  text: string;
  passage?: Passage;
  questionId?: string;
  questionRevision?: number;
};
export type Receipt = {
  id: string;
  agentId: string;
  text: string;
  intent: Intent;
  source?: string;
  kind: "voice" | "answer";
};
export type State = {
  agents: Agent[];
  workspaces: Workspace[];
  questions: Question[];
  activeId: string;
  app: Bookmark;
  sheet: Sheet;
  mapWorkspace: string;
  readingId: string;
  questionId: string;
  questionRevision: number;
  choice: number | null;
  visit: Bookmark | null;
  selection: number | null;
  selectionRevision: number | null;
  carry: Passage | null;
  composition: Composition | null;
  savedComposition: Composition | null;
  archive: DraftArchive | null;
  draftSequence: number;
  hostId: string;
  pending: Operation | null;
  receipts: Receipt[];
  connected: boolean;
  sequence: number;
  now: number;
  notice: string;
  query: string;
  newEngine: "claude" | "codex";
  quiet: boolean;
  resultRead: string[];
  readingLines: Record<string, number>;
  liveLine: number;
  oldestLine: number;
  commandLog: string[];
  deliveryUncertain: boolean;
  autoReceipt: boolean;
  usage: {
    amount: number | null;
    currency: "USD";
    machine: string;
    coverage: "partial" | "complete" | "unavailable";
    asOf: number;
    source: "local transcripts";
    providers: { name: string; amount: number | null }[];
  };
};
export const agents: Agent[] = [
  {
    id: "claude",
    engine: "claude",
    name: "Claude Code",
    title: "Build the launch",
    machine: "MacBook",
    workspace: "launch",
    activity: "working",
    observedSeconds: 252,
    detail: "Refining the mobile layout. The desktop layout is unchanged.",
  },
  {
    id: "codex",
    engine: "codex",
    name: "Codex",
    title: "Checkout tests",
    machine: "MacBook",
    workspace: "launch",
    activity: "needs-you",
    observedSeconds: 137,
    detail: "The test suite is ready. One decision before I continue.",
  },
  {
    id: "hermes",
    engine: "hermes",
    name: "Hermes",
    title: "Customer research",
    machine: "Server",
    workspace: "launch",
    activity: "ready",
    observedSeconds: null,
    detail: "Three customer groups. One clear place to start.",
    resultId: "research-1",
    resultRevision: 1,
    result: [
      "Small teams lose time moving context between their tools.",
      "Start with independent studios: they already run several agents, but want one place to direct the work.",
      "The strongest test is a complete handoff: research to design to implementation, without re-explaining the task.",
    ],
  },
  {
    id: "pi",
    engine: "pi",
    name: "Pi",
    title: "Refine the CLI",
    machine: "MacBook",
    workspace: "launch",
    activity: "needs-you",
    observedSeconds: 86,
    detail: "Two command names are ready for your choice.",
  },
  {
    id: "claude-ops",
    engine: "claude",
    name: "Claude Code",
    title: "Watch staging",
    machine: "Server",
    workspace: "operations",
    activity: "idle",
    observedSeconds: null,
    detail: "Ready for the next instruction.",
  },
  {
    id: "codex-mobile",
    engine: "codex",
    name: "Codex",
    title: "Mobile checkout",
    machine: "Home Mac",
    workspace: "mobile",
    activity: "working",
    observedSeconds: null,
    detail: "Checking the empty-cart and payment-retry paths.",
  },
];
export const workspaces: Workspace[] = [
  {
    id: "launch",
    name: "Launch",
    machine: "MacBook + Server",
    tiles: [
      { agentId: "claude", x1: 0, y1: 0, x2: 560, y2: 530 },
      { agentId: "codex", x1: 560, y1: 0, x2: 1000, y2: 530 },
      { agentId: "hermes", x1: 0, y1: 530, x2: 440, y2: 1000 },
      { agentId: "pi", x1: 440, y1: 530, x2: 1000, y2: 1000 },
    ],
  },
  {
    id: "operations",
    name: "Operations",
    machine: "Server",
    tiles: [{ agentId: "claude-ops", x1: 0, y1: 0, x2: 1000, y2: 1000 }],
  },
  {
    id: "mobile",
    name: "Mobile",
    machine: "Home Mac",
    tiles: [
      { agentId: "", x1: 0, y1: 0, x2: 700, y2: 1000 },
      { agentId: "codex-mobile", x1: 700, y1: 0, x2: 1000, y2: 1000 },
    ],
  },
];
const initialQuestions: Question[] = [
  {
    id: "checkout-environment",
    revision: 1,
    agentId: "codex",
    text: "Where should I run the checkout tests?",
    options: ["Staging", "Local"],
    resolved: false,
  },
  {
    id: "command-name",
    revision: 3,
    agentId: "pi",
    text: "Which name should the new command use?",
    options: ["The short name", "The descriptive name"],
    resolved: false,
  },
];
export function createState(now = 0): State {
  return {
    agents: agents.map((a) => ({ ...a })),
    workspaces: workspaces.map((w) => ({
      ...w,
      tiles: w.tiles.map((t) => ({ ...t })),
    })),
    questions: initialQuestions.map((q) => ({ ...q, options: [...q.options] })),
    activeId: "claude",
    app: { agentId: "claude", workspace: "launch", line: 42 },
    sheet: "home",
    mapWorkspace: "launch",
    readingId: "hermes",
    questionId: "",
    questionRevision: 0,
    choice: null,
    visit: null,
    selection: null,
    selectionRevision: null,
    carry: null,
    composition: null,
    savedComposition: null,
    archive: null,
    draftSequence: 0,
    hostId: "sample-cable-host",
    pending: null,
    receipts: [],
    connected: true,
    sequence: 0,
    now,
    notice: "",
    query: "",
    newEngine: "claude",
    quiet: true,
    resultRead: [],
    readingLines: { claude: 42 },
    liveLine: 84,
    oldestLine: 1,
    commandLog: [],
    deliveryUncertain: false,
    autoReceipt: true,
    usage: {
      amount: 3.42,
      currency: "USD",
      machine: "MacBook",
      coverage: "partial",
      asOf: now - 120_000,
      source: "local transcripts",
      providers: [
        { name: "Claude Code", amount: 2.18 },
        { name: "Codex", amount: 1.24 },
        { name: "OpenCode", amount: null },
      ],
    },
  };
}
export function capability(agent: Agent, intent: Intent): boolean {
  return (
    intent === "task" ||
    (intent === "goal" && ["claude", "codex"].includes(agent.engine)) ||
    (intent === "loop" && agent.engine === "claude")
  );
}
export const sampleWords = (intent: Intent, carried = false) =>
  carried
    ? "Check this against the checkout work. Tell me what we should test first."
    : intent === "goal"
      ? "Keep working until the checkout accessibility tests pass."
      : intent === "loop"
        ? "Every weekday at 09:00 Asia/Ho_Chi_Minh, check staging and report only failures."
        : "Check the mobile layout too. Keep the current desktop behavior.";
export const DRAFT_BYTES = 16_000;
export const DRAFT_PART_BYTES = 480;
export const ARCHIVE_LIFETIME = 30 * 60_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** Slice at UTF-8 codepoint boundaries; no trim, normalization or whitespace loss. */
export function draftParts(text: string): string[] {
  const parts: string[] = [];
  let part = "",
    size = 0;
  for (const character of text) {
    const length = bytes(character);
    if (size + length > DRAFT_PART_BYTES) {
      parts.push(part);
      part = "";
      size = 0;
    }
    part += character;
    size += length;
  }
  if (part) parts.push(part);
  return parts;
}
export function draftPage(c: Composition): {
  text: string;
  part: number;
  total: number;
} {
  if (c.recovery)
    return { text: c.text, part: c.part, total: c.recovery.total };
  const parts = draftParts(c.text);
  const part = Math.min(c.part, Math.max(0, parts.length - 1));
  return { text: parts[part] ?? "", part, total: Math.max(1, parts.length) };
}
function recipientDetails(agent: Agent) {
  return {
    recipientName: agent.name,
    recipientTitle: agent.title,
    recipientMachine: agent.machine,
  };
}
function retained(
  s: State,
  c: Composition,
  delivery: DraftArchive["delivery"],
): State {
  if (c.recovery)
    return {
      ...s,
      composition: { ...c, recovery: { ...c.recovery, state: "offline" } },
      savedComposition: null,
    };
  const page = draftPage(c);
  return {
    ...s,
    archive:
      bytes(c.text) <= DRAFT_BYTES
        ? {
            id: c.id,
            hostId: c.hostId,
            recipient: c.recipient,
            intent: c.intent,
            passageId: c.passage?.id,
            text: c.text,
            expiresAt: s.now + ARCHIVE_LIFETIME,
            operationId: s.pending?.id,
            delivery,
          }
        : null,
    composition: {
      ...c,
      text: page.text,
      part: page.part,
      priorText: undefined,
      append: false,
      phase: "review",
      recovery: {
        state: "offline",
        total: page.total,
        delivery: delivery === "sent" ? "unconfirmed" : delivery,
      },
    },
    savedComposition: null,
    sheet: "compose",
  };
}
function matchingArchive(s: State, c: Composition): DraftArchive | null {
  const a = s.archive;
  return a &&
    a.expiresAt > s.now &&
    a.id === c.id &&
    a.hostId === c.hostId &&
    a.hostId === s.hostId &&
    a.recipient === c.recipient &&
    a.intent === c.intent &&
    (c.recovery?.bookmark
      ? !!a.passageId === c.recovery.bookmark.carried
      : a.passageId === c.passage?.id) &&
    a.text.trim().length > 0 &&
    bytes(a.text) <= DRAFT_BYTES
    ? a
    : null;
}
export function selectedAgent(s: State): Agent {
  return s.agents.find((a) => a.id === s.activeId)!;
}
export function pendingQuestions(s: State): Question[] {
  return s.questions.filter((q) => !q.resolved);
}
export function readyAgents(s: State): Agent[] {
  return s.agents.filter(
    (a) => a.result && !s.resultRead.includes(a.resultId ?? a.id),
  );
}
export function elapsed(seconds: number | null): string {
  return seconds === null
    ? ""
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function cycle<T>(items: T[], current: T, delta: number): T {
  return items[
    (Math.max(0, items.indexOf(current)) + delta + items.length) % items.length
  ];
}
export type Gesture = { level: 1 | 2; direction: -1 | 1 };
export function resolveGesture(
  contacts: number,
  dx: number,
  dy: number,
): Gesture | null {
  return (contacts === 1 || contacts === 2) &&
    Math.abs(dx) >= 42 &&
    Math.abs(dx) > Math.abs(dy) * 1.3
    ? { level: contacts, direction: dx < 0 ? 1 : -1 }
    : null;
}
function logged(s: State, message: string): State {
  return { ...s, commandLog: [...s.commandLog.slice(-7), message] };
}
function focus(s: State, id: string, deliberate = false): State {
  const a = s.agents.find((a) => a.id === id);
  if (!a) return s;
  const readingLines = { ...s.readingLines, [s.app.agentId]: s.app.line };
  return logged(
    {
      ...s,
      activeId: id,
      app: {
        agentId: id,
        workspace: a.workspace,
        line: readingLines[id] ?? s.liveLine,
      },
      readingLines,
      mapWorkspace: a.workspace,
      visit: deliberate ? null : s.visit,
    },
    `Focus · ${a.title} · ${a.machine}`,
  );
}
function settle(s: State, op: Operation): State {
  if (op.kind === "answer") {
    const q = s.questions.find((q) => q.id === op.questionId);
    if (!q || q.resolved || q.revision !== op.questionRevision)
      return {
        ...s,
        pending: null,
        deliveryUncertain: false,
        composition: null,
        sheet: "attention",
        notice: "This question was handled in the app.",
      };
  }
  const receipt: Receipt = {
    id: op.id,
    agentId: op.agentId,
    text: op.text,
    intent: op.intent,
    source: op.passage?.text,
    kind: op.kind,
  };
  const a = s.agents.find((a) => a.id === op.agentId);
  if (!a && !s.composition?.recovery)
    return {
      ...s,
      pending: null,
      deliveryUncertain: false,
      composition: null,
      sheet: "home",
      notice: "That work was closed. Nothing was sent.",
    };
  const questions =
    op.kind === "answer"
      ? s.questions.map((q) =>
          q.id === op.questionId
            ? { ...q, resolved: true, revision: q.revision + 1 }
            : q,
        )
      : s.questions;
  return logged(
    {
      ...s,
      receipts: [...s.receipts, receipt],
      questions,
      agents: s.agents.map((a) =>
        a.id === op.agentId
          ? {
              ...a,
              activity: "instructed",
              observedSeconds: null,
              detail: op.text,
            }
          : a,
      ),
    },
    `${op.kind === "answer" ? "Answer accepted" : op.intent === "task" ? "Instruction accepted" : `${op.intent === "goal" ? "Goal" : "Loop"} request accepted`} · ${a?.name ?? s.composition?.recipientName}`,
  );
}
function acknowledge(s: State): State {
  const op = s.pending;
  if (!op) return s;
  const receipt = s.receipts.find((r) => r.id === op.id);
  if (s.composition?.recovery) {
    const c = s.composition;
    return {
      ...s,
      pending: receipt ? null : op,
      deliveryUncertain: !receipt,
      composition: {
        ...c,
        recovery: {
          ...c.recovery!,
          delivery: receipt ? "sent" : "unconfirmed",
        },
      },
      notice: receipt
        ? `${c.intent === "task" ? "Passed to Harness" : "Request sent"}. Your copy remains read only.`
        : "Delivery is still unconfirmed.",
    };
  }
  if (!receipt)
    return {
      ...s,
      deliveryUncertain: true,
      composition: s.composition
        ? { ...s.composition, phase: "uncertain" }
        : null,
      notice: "Delivery is still unconfirmed. Your instruction is kept.",
    };
  const next = pendingQuestions(s)[0];
  return {
    ...s,
    pending: null,
    deliveryUncertain: false,
    composition: null,
    carry: null,
    choice: null,
    sheet: op.kind === "answer" && next ? "question" : "home",
    questionId: next?.id ?? "",
    questionRevision: next?.revision ?? 0,
    notice:
      op.kind === "answer"
        ? "Answer accepted"
        : op.intent === "task"
          ? "Sent"
          : `${op.intent === "goal" ? "Goal" : "Loop"} request sent`,
  };
}
export type Action =
  | {
      type: "RESET";
      scenario?:
        | "home"
        | "map"
        | "attention"
        | "carry"
        | "return"
        | "goal"
        | "loop"
        | "usage"
        | "autonomy";
    }
  | { type: "SHEET"; sheet: Sheet }
  | { type: "FOCUS"; id: string; fromApp?: boolean }
  | { type: "WORKSPACE"; id: string }
  | { type: "SWIPE"; level: 1 | 2; direction: number }
  | { type: "SCROLL"; delta: number }
  | { type: "VOICE"; intent?: Intent }
  | { type: "RECORD" }
  | { type: "FINISH_VOICE" }
  | { type: "REVIEW_FIRST" }
  | { type: "EDIT_DRAFT"; text: string }
  | { type: "APPEND" }
  | { type: "RECORD_AGAIN" }
  | { type: "RESELECT" }
  | { type: "DROP_CARRY" }
  | { type: "UNDO" }
  | { type: "DISCARD" }
  | { type: "SEND" }
  | { type: "HOST_ACK"; id: string }
  | { type: "HOST_REJECT"; id: string }
  | { type: "CONNECTION"; connected: boolean }
  | { type: "RECONCILE" }
  | { type: "CLOSE_DELIVERY"; id: string }
  | { type: "RECOVER_DRAFT"; id: string }
  | { type: "CLOSE_DRAFT"; id: string }
  | { type: "DRAFT_PART"; id: string; delta: -1 | 1 }
  | { type: "ARCHIVE_LOST" }
  | { type: "RESTART_DEVICE" }
  | { type: "QUESTION"; id: string }
  | { type: "CHOOSE"; choice: number }
  | { type: "ANSWER"; id: string; revision: number }
  | { type: "ANSWER_ELSEWHERE" }
  | { type: "READ"; id: string }
  | { type: "SELECT"; index: number }
  | { type: "CARRY" }
  | { type: "VISIT" }
  | { type: "RETURN" }
  | { type: "PRUNE" }
  | { type: "CLOSE_ORIGIN" }
  | { type: "TICK"; now: number }
  | { type: "QUERY"; text: string }
  | { type: "NEW_ENGINE"; engine: "claude" | "codex" }
  | { type: "CREATE" }
  | { type: "QUIET" }
  | { type: "CLEAR_NOTICE" }
  | { type: "AUTO_RECEIPT"; enabled: boolean }
  | { type: "CHECK_DELIVERY" }
  | { type: "SOURCE_CHANGED" };
export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "RESET": {
      const n = {
        ...createState(s.now),
        draftSequence: s.draftSequence,
        sequence: s.sequence,
      };
      if (a.scenario === "map") return { ...n, sheet: "map" };
      if (a.scenario === "usage") return { ...n, sheet: "usage" };
      if (a.scenario === "attention") return { ...n, sheet: "attention" };
      if (a.scenario === "return")
        return reducer({ ...n, sheet: "result" }, { type: "VISIT" });
      if (a.scenario === "carry")
        return { ...n, sheet: "result", resultRead: ["research-1"] };
      if (a.scenario === "goal" || a.scenario === "loop")
        return reducer(reducer(n, { type: "VOICE", intent: a.scenario }), {
          type: "FINISH_VOICE",
        });
      if (a.scenario === "autonomy") return { ...n, sheet: "actions" };
      return n;
    }
    case "SHEET":
      if (s.savedComposition)
        return {
          ...s,
          composition: s.savedComposition,
          savedComposition: null,
          sheet: "compose",
        };
      if (
        ((s.pending && s.deliveryUncertain) || s.composition?.recovery) &&
        ["home", "attention", "usage", "settings"].includes(a.sheet)
      )
        return { ...s, sheet: a.sheet, notice: "" };
      if (s.composition || s.pending)
        return { ...s, notice: "Finish or discard this instruction first." };
      return {
        ...s,
        sheet: a.sheet,
        mapWorkspace: s.app.workspace,
        notice: "",
        query: "",
      };
    case "FOCUS": {
      if (a.fromApp) return focus(s, a.id, true);
      if (
        s.pending ||
        s.composition ||
        s.savedComposition ||
        !s.connected ||
        !s.agents.some((x) => x.id === a.id)
      )
        return s;
      if (s.carry) {
        const n = focus(s, a.id, true);
        return {
          ...n,
          draftSequence: s.draftSequence + 1,
          sheet: "compose",
          composition: {
            id: `draft-${s.draftSequence + 1}`,
            hostId: s.hostId,
            recipient: a.id,
            ...recipientDetails(s.agents.find((agent) => agent.id === a.id)!),
            intent: "task",
            phase: "ready",
            text: "",
            part: 0,
            review: true,
            append: false,
            passage: s.carry,
          },
        };
      }
      return { ...focus(s, a.id, true), sheet: "home", notice: "" };
    }
    case "WORKSPACE":
      return s.workspaces.some((w) => w.id === a.id)
        ? { ...s, mapWorkspace: a.id }
        : s;
    case "SWIPE": {
      if (s.sheet !== "home" || s.composition || s.pending || !s.connected)
        return s;
      if (a.level === 2)
        return {
          ...s,
          sheet: "map",
          mapWorkspace: cycle(
            s.workspaces.map((w) => w.id),
            s.app.workspace,
            a.direction,
          ),
        };
      const ids = s.agents
        .filter((x) => x.workspace === s.app.workspace)
        .map((x) => x.id);
      return focus(s, cycle(ids, s.activeId, a.direction), true);
    }
    case "SCROLL":
      return s.sheet === "home" && s.connected && !s.composition
        ? {
            ...s,
            app: {
              ...s.app,
              line: Math.round(
                Math.min(
                  s.liveLine,
                  Math.max(s.oldestLine, s.app.line + a.delta),
                ),
              ),
            },
          }
        : s;
    case "VOICE": {
      if (
        !s.connected ||
        s.pending ||
        s.composition ||
        s.savedComposition ||
        !["home", "actions"].includes(s.sheet)
      )
        return s;
      const intent = a.intent ?? "task",
        agent = selectedAgent(s);
      if (!capability(agent, intent))
        return {
          ...s,
          notice: `${intent === "goal" ? "Goals" : "Loops"} are unavailable for ${agent.name}.`,
        };
      return {
        ...s,
        draftSequence: s.draftSequence + 1,
        sheet: "compose",
        notice: "",
        composition: {
          id: `draft-${s.draftSequence + 1}`,
          hostId: s.hostId,
          recipient: agent.id,
          ...recipientDetails(agent),
          intent,
          phase: "listening",
          text: "",
          part: 0,
          review: intent !== "task",
          append: false,
        },
      };
    }
    case "RECORD": {
      const c = s.composition;
      const recipient = s.agents.find((agent) => agent.id === c?.recipient);
      if (c?.phase !== "ready" || c.recovery || !s.connected || !recipient)
        return s;
      if (c.passage && c.passage.expiresAt <= s.now)
        return { ...s, notice: "Choose the passage again before speaking." };
      return {
        ...s,
        composition: {
          ...c,
          ...recipientDetails(recipient),
          phase: "listening",
          passageAttached: !!c.passage,
        },
      };
    }
    case "REVIEW_FIRST":
      return s.composition?.phase === "listening" &&
        !s.composition.recovery &&
        !s.pending
        ? { ...s, composition: { ...s.composition, review: true } }
        : s;
    case "FINISH_VOICE": {
      const c = s.composition;
      if (!c || c.recovery || c.phase !== "listening") return s;
      if (!s.connected)
        return {
          ...s,
          composition: { ...c, phase: "review" },
          notice: "Connection lost. Nothing sent.",
        };
      const words = sampleWords(c.intent, !!c.passage);
      const text = c.append
        ? `${c.text}\nAlso check the empty-cart state.`
        : words;
      if (bytes(text) > DRAFT_BYTES)
        return {
          ...s,
          composition: { ...c, phase: "review", append: false },
          notice:
            "This message is full. Keep the existing words or start another.",
        };
      const n: State = {
        ...s,
        composition: {
          ...c,
          text,
          part: c.append ? draftParts(text).length - 1 : 0,
          priorText: c.append ? c.text : c.priorText,
          phase: "review",
          append: false,
        },
      };
      return c.review ? n : reducer(n, { type: "SEND" });
    }
    case "EDIT_DRAFT":
      return s.composition?.phase === "review" &&
        !s.composition.recovery &&
        bytes(a.text) <= DRAFT_BYTES
        ? { ...s, composition: { ...s.composition, text: a.text, part: 0 } }
        : s;
    case "APPEND":
      return s.composition?.phase === "review" &&
        !s.composition.recovery &&
        s.connected
        ? {
            ...s,
            composition: {
              ...s.composition,
              phase: "listening",
              append: true,
              review: true,
            },
          }
        : s;
    case "RECORD_AGAIN":
      return s.composition?.phase === "review" &&
        !s.composition.recovery &&
        s.connected
        ? {
            ...s,
            composition: {
              ...s.composition,
              phase: "listening",
              append: false,
              review: true,
            },
          }
        : s;
    case "RESELECT":
      return s.composition &&
        !s.composition.recovery &&
        ["ready", "review"].includes(s.composition.phase) &&
        s.composition.passage
        ? {
            ...s,
            savedComposition: s.composition,
            composition: null,
            readingId: s.composition.passage.agentId,
            selection: null,
            sheet: "result",
            notice: s.composition.text
              ? "Choose the passage. Your instruction is saved."
              : "Choose the passage again.",
          }
        : s;
    case "DROP_CARRY":
      return s.composition?.phase === "review" && !s.composition.recovery
        ? {
            ...s,
            carry: null,
            composition: { ...s.composition, passage: undefined },
            notice: "Context removed. Your words are kept.",
          }
        : s;
    case "UNDO":
      return s.composition?.priorText !== undefined &&
        !s.composition.recovery &&
        s.composition.phase === "review"
        ? {
            ...s,
            composition: {
              ...s.composition,
              text: s.composition.priorText,
              part: 0,
              priorText: undefined,
            },
          }
        : s;
    case "DISCARD":
      if (s.composition?.recovery) return s;
      if (s.pending)
        return { ...s, notice: "Delivery is in progress. Check its status." };
      return {
        ...s,
        sheet: "home",
        composition: null,
        savedComposition: null,
        carry: null,
        selection: null,
        notice: "Discarded",
      };
    case "SEND": {
      const c = s.composition;
      if (
        !c ||
        c.recovery ||
        c.phase !== "review" ||
        !c.text.trim() ||
        s.pending
      )
        return s;
      if (!s.connected)
        return {
          ...s,
          notice: "Reconnect to send. Your words are still here.",
        };
      const recipient = s.agents.find((a) => a.id === c.recipient);
      if (!recipient || !capability(recipient, c.intent))
        return {
          ...s,
          notice: "This agent no longer supports that instruction.",
        };
      if (c.passage && !c.passageAttached)
        return {
          ...s,
          notice: "Choose the passage again before speaking.",
        };
      const id = `op-${s.sequence + 1}`;
      return {
        ...s,
        sequence: s.sequence + 1,
        deliveryUncertain: false,
        composition: { ...c, phase: "sending" },
        pending: {
          id,
          kind: "voice",
          agentId: c.recipient,
          intent: c.intent,
          text: c.text,
          passage: c.passage,
        },
        notice: "",
      };
    }
    case "HOST_ACK": {
      if (s.pending?.id !== a.id || s.receipts.some((r) => r.id === a.id))
        return s;
      const accepted = settle(s, s.pending);
      const n = {
        ...accepted,
        archive:
          accepted.archive?.operationId === a.id
            ? { ...accepted.archive, delivery: "sent" as const }
            : accepted.archive,
      };
      if (!n.pending) return n;
      if (n.composition?.recovery) return n.connected ? acknowledge(n) : n;
      return n.connected
        ? acknowledge(n)
        : {
            ...n,
            deliveryUncertain: true,
            composition: n.composition
              ? { ...n.composition, phase: "uncertain" }
              : null,
            notice: "Delivery unconfirmed. Reconnect to check.",
          };
    }
    case "HOST_REJECT": {
      if (s.pending?.id !== a.id || s.receipts.some((r) => r.id === a.id))
        return s;
      if (s.composition?.review || s.composition?.recovery) {
        const n = s.composition.recovery
          ? s
          : retained(s, s.composition, "rejected");
        const archive = matchingArchive(n, n.composition!);
        return {
          ...n,
          pending: s.connected ? null : s.pending,
          deliveryUncertain: !s.connected,
          archive: archive ? { ...archive, delivery: "rejected" } : n.archive,
          composition: {
            ...n.composition!,
            recovery: {
              ...n.composition!.recovery!,
              state: s.connected
                ? archive
                  ? "recovered"
                  : "unavailable"
                : "offline",
              delivery: s.connected ? "rejected" : "unconfirmed",
            },
          },
          notice: s.connected
            ? "The instruction was rejected. This copy is read only."
            : "Delivery unconfirmed.",
        };
      }
      return {
        ...s,
        pending: null,
        deliveryUncertain: false,
        sheet: s.composition ? "compose" : "question",
        composition: s.composition
          ? { ...s.composition, phase: "review" }
          : null,
        notice: "The host rejected this instruction. Nothing was sent.",
      };
    }
    case "CONNECTION": {
      const n: State = {
        ...s,
        connected: a.connected,
        deliveryUncertain: (!a.connected && !!s.pending) || s.deliveryUncertain,
        notice: a.connected ? "Connected" : "Connection lost",
      };
      if (
        a.connected &&
        !n.composition?.recovery &&
        n.pending &&
        n.receipts.some((r) => r.id === n.pending!.id)
      )
        return acknowledge(n);
      const c = n.composition ?? n.savedComposition;
      if (!a.connected && c && (c.recovery || (c.review && c.text.trim()))) {
        return {
          ...retained(n, c, n.pending ? "unconfirmed" : "not-sent"),
          notice: c.text
            ? "Connection lost. Only this part is available offline."
            : "Reconnect to recover your message.",
        };
      }
      if (!a.connected && n.composition)
        return {
          ...n,
          composition: {
            ...n.composition,
            phase: n.pending
              ? "uncertain"
              : n.composition.phase === "ready"
                ? "ready"
                : "review",
          },
          notice: n.pending
            ? "Delivery unconfirmed. Your instruction is preserved."
            : "Connection lost. Nothing sent.",
        };
      return n;
    }
    case "RECOVER_DRAFT": {
      const c = s.composition;
      if (!s.connected || !c?.recovery || c.id !== a.id) return s;
      const archive = matchingArchive(s, c);
      if (!archive)
        return {
          ...s,
          composition: {
            ...c,
            recovery: { ...c.recovery, state: "unavailable" },
          },
          notice: c.text
            ? "Full message unavailable. This part is still here."
            : "Full message unavailable. No words are saved on this device.",
        };
      const parts = draftParts(archive.text),
        part = Math.min(c.part, parts.length - 1);
      return {
        ...s,
        pending:
          archive.delivery === "sent" || archive.delivery === "rejected"
            ? null
            : s.pending,
        deliveryUncertain: archive.delivery === "unconfirmed",
        composition: {
          ...c,
          text: parts[part],
          part,
          recovery: {
            ...c.recovery,
            state: "recovered",
            total: parts.length,
            delivery: archive.delivery,
          },
        },
        notice: "",
      };
    }
    case "DRAFT_PART": {
      const c = s.composition;
      if (!c || c.id !== a.id || c.phase === "listening" || c.phase === "ready")
        return s;
      if (c.recovery) {
        if (!s.connected || c.recovery.state !== "recovered") return s;
        const archive = matchingArchive(s, c);
        if (!archive)
          return {
            ...s,
            composition: {
              ...c,
              recovery: { ...c.recovery, state: "unavailable" },
            },
          };
        const parts = draftParts(archive.text),
          part = c.part + a.delta;
        if (part < 0 || part >= parts.length) return s;
        return { ...s, composition: { ...c, text: parts[part], part } };
      }
      const part = c.part + a.delta;
      return part >= 0 && part < draftParts(c.text).length
        ? { ...s, composition: { ...c, part } }
        : s;
    }
    case "CLOSE_DRAFT":
      if (s.composition?.id !== a.id || !s.composition.recovery) return s;
      return {
        ...s,
        composition: null,
        savedComposition: null,
        pending: null,
        deliveryUncertain: false,
        carry: null,
        sheet: "home",
        notice: "Local copy closed.",
      };
    case "ARCHIVE_LOST":
      return { ...s, archive: null };
    case "RESTART_DEVICE": {
      const c = s.composition ?? s.savedComposition;
      if (!c || (!c.recovery && (!c.review || !c.text.trim()))) return s;
      const n = c.recovery
        ? s
        : retained(s, c, s.pending ? "unconfirmed" : "not-sent");
      // This lab edge models the proposed metadata-only native bookmark.
      // The sample host archive survives; no words, page or source preview do.
      return {
        ...n,
        connected: false,
        carry: null,
        pending: null,
        savedComposition: null,
        deliveryUncertain: false,
        composition: {
          id: c.id,
          hostId: c.hostId,
          recipient: c.recipient,
          recipientName: c.recipientName,
          recipientTitle: "",
          recipientMachine: "",
          intent: c.intent,
          phase: "review",
          text: "",
          part: 0,
          review: true,
          append: false,
          recovery: {
            state: "offline",
            total: 0,
            delivery: "unconfirmed",
            bookmark: { carried: c.recovery?.bookmark?.carried ?? !!c.passage },
          },
        },
        sheet: "compose",
        notice: "Reconnect to recover your message.",
      };
    }
    case "RECONCILE":
      return s.connected ? acknowledge(s) : s;
    case "CLOSE_DELIVERY":
      if (
        !s.deliveryUncertain ||
        s.pending?.kind !== "answer" ||
        s.pending.id !== a.id
      )
        return s;
      // Explicitly close only this local record. This is neither a host receipt
      // nor a notification dismissal; the current questions remain unchanged.
      return {
        ...s,
        pending: null,
        deliveryUncertain: false,
        questionId: "",
        questionRevision: 0,
        choice: null,
        sheet: "attention",
        notice: "Check the answer in Harness.",
      };
    case "QUESTION": {
      const q = s.questions.find((q) => q.id === a.id && !q.resolved);
      return q && !s.pending && !s.composition && !s.savedComposition
        ? {
            ...s,
            sheet: "question",
            questionId: q.id,
            questionRevision: q.revision,
            choice: null,
            notice: "",
          }
        : s;
    }
    case "CHOOSE": {
      const q = s.questions.find((q) => q.id === s.questionId);
      return q &&
        !q.resolved &&
        !s.pending &&
        a.choice >= 0 &&
        a.choice < q.options.length
        ? { ...s, choice: a.choice }
        : s;
    }
    case "ANSWER": {
      const q = s.questions.find((q) => q.id === a.id);
      if (
        s.sheet !== "question" ||
        a.id !== s.questionId ||
        a.revision !== s.questionRevision ||
        !q ||
        q.resolved ||
        q.revision !== a.revision ||
        s.choice === null ||
        !q.options[s.choice] ||
        !s.connected ||
        s.pending
      )
        return {
          ...s,
          notice: "This answer is no longer available. Check the question.",
        };
      const id = `op-${s.sequence + 1}`;
      return {
        ...s,
        sequence: s.sequence + 1,
        pending: {
          id,
          kind: "answer",
          agentId: q.agentId,
          intent: "task",
          text: q.options[s.choice],
          questionId: q.id,
          questionRevision: q.revision,
        },
      };
    }
    case "ANSWER_ELSEWHERE": {
      const id = s.questionId || pendingQuestions(s)[0]?.id;
      const answered = s.questions.find((q) => q.id === id);
      return {
        ...s,
        agents: s.agents.map((a) =>
          a.id === answered?.agentId
            ? { ...a, activity: "instructed", observedSeconds: null }
            : a,
        ),
        questions: s.questions.map((q) =>
          q.id === id ? { ...q, resolved: true, revision: q.revision + 1 } : q,
        ),
        choice: null,
        sheet: s.sheet === "question" ? "attention" : s.sheet,
        notice: "Answered in the app.",
      };
    }
    case "READ": {
      const agent = s.agents.find((x) => x.id === a.id);
      if (
        !agent?.result ||
        s.savedComposition ||
        ((s.composition || s.pending) &&
          !s.deliveryUncertain &&
          !s.composition?.recovery)
      )
        return s;
      return {
        ...s,
        sheet: "result",
        readingId: a.id,
        selection: null,
        selectionRevision: null,
        resultRead: [...new Set([...s.resultRead, agent.resultId ?? a.id])],
        notice: "",
      };
    }
    case "SELECT": {
      const source = s.agents.find((a) => a.id === s.readingId);
      return s.sheet === "result" &&
        source?.result &&
        a.index >= 0 &&
        a.index < source.result.length
        ? {
            ...s,
            selection: a.index,
            selectionRevision: source.resultRevision ?? 1,
          }
        : s;
    }
    case "CARRY": {
      const source = s.agents.find((a) => a.id === s.readingId);
      if (
        s.sheet !== "result" ||
        s.pending ||
        s.composition ||
        s.savedComposition?.recovery ||
        s.selection === null ||
        !source?.result ||
        !s.connected
      )
        return s;
      if (s.selectionRevision !== (source.resultRevision ?? 1))
        return {
          ...s,
          selection: null,
          notice: "The source changed. Choose the passage again.",
        };
      const text = source.result[s.selection];
      const passage: Passage = {
        id: `passage-${s.sequence + 1}`,
        agentId: source.id,
        sourceName: source.name,
        resultId: source.resultId ?? source.id,
        text,
        revision: source.resultRevision ?? 1,
        expiresAt: s.now + 300_000,
      };
      if (s.savedComposition)
        return {
          ...s,
          sequence: s.sequence + 1,
          carry: passage,
          composition: {
            ...s.savedComposition,
            passage,
            passageAttached: s.savedComposition.phase === "review",
          },
          savedComposition: null,
          sheet: "compose",
          notice: "Passage updated. Review before sending.",
        };
      return {
        ...s,
        sequence: s.sequence + 1,
        carry: passage,
        sheet: "map",
        mapWorkspace: s.app.workspace,
        notice: "",
      };
    }
    case "VISIT": {
      if (
        s.sheet !== "result" ||
        s.composition ||
        s.savedComposition ||
        s.pending ||
        !s.connected
      )
        return s;
      if (s.readingId === s.app.agentId)
        return { ...s, sheet: "home", notice: "Already open in the app" };
      const origin = s.visit ?? { ...s.app };
      return {
        ...focus(s, s.readingId),
        visit: origin,
        sheet: "home",
        notice: "Opened on your monitor",
      };
    }
    case "RETURN": {
      if (
        s.composition ||
        s.savedComposition ||
        s.pending ||
        !s.visit ||
        !s.connected
      )
        return s;
      const origin = s.visit;
      if (!s.agents.some((a) => a.id === origin.agentId))
        return {
          ...s,
          visit: null,
          notice: "That work was closed in the app.",
        };
      const line = Math.max(s.oldestLine, origin.line);
      return logged(
        {
          ...s,
          activeId: origin.agentId,
          app: { ...origin, line },
          visit: null,
          sheet: "home",
          notice:
            line === origin.line
              ? `Back where you left off · line ${line}`
              : "Back to your work. The earlier text is no longer available.",
        },
        `Return · ${origin.agentId} · line ${line}`,
      );
    }
    case "CLOSE_ORIGIN": {
      if (!s.visit) return s;
      const id = s.visit.agentId;
      const agents = s.agents.filter((a) => a.id !== id);
      const workspaces = s.workspaces.map((w) => ({
        ...w,
        tiles: w.tiles.filter((t) => t.agentId !== id),
      }));
      const fallback = agents.find((a) => a.id === s.activeId) ?? agents[0];
      const readingId =
        s.readingId === id
          ? (agents.find((a) => a.result)?.id ?? "")
          : s.readingId;
      const n = {
        ...s,
        agents,
        workspaces,
        questions: s.questions.filter((q) => q.agentId !== id),
        readingId,
        visit: null,
        notice: "The original pane was closed. Return is unavailable.",
      };
      return fallback && s.app.agentId === id ? focus(n, fallback.id, true) : n;
    }
    case "PRUNE":
      return { ...s, oldestLine: 60 };
    case "TICK": {
      const now = Math.max(s.now, a.now);
      const expired = s.archive && s.archive.expiresAt <= now;
      return {
        ...s,
        now,
        archive: expired ? null : s.archive,
        composition:
          expired &&
          s.archive?.id === s.composition?.id &&
          s.composition?.recovery?.state === "recovered"
            ? {
                ...s.composition,
                recovery: { ...s.composition.recovery, state: "unavailable" },
              }
            : s.composition,
      };
    }
    case "QUERY":
      return { ...s, query: a.text };
    case "NEW_ENGINE":
      return { ...s, newEngine: a.engine };
    case "CREATE": {
      if (
        !s.connected ||
        s.pending ||
        s.composition ||
        s.savedComposition ||
        s.sheet !== "new"
      )
        return s;
      const id = `new-${s.sequence + 1}`,
        workspace = s.workspaces.find((w) => w.id === s.app.workspace)!;
      const agent: Agent = {
        id,
        engine: s.newEngine,
        name: s.newEngine === "claude" ? "Claude Code" : "Codex",
        title: "Explore another direction",
        machine: selectedAgent(s).machine,
        workspace: workspace.id,
        activity: "idle",
        observedSeconds: null,
        detail: "Ready for your first instruction.",
      };
      const ids = [...workspace.tiles.map((t) => t.agentId), id];
      const tiles = ids.map((agentId, i) => ({
        agentId,
        x1: (i % 2) * 500,
        x2: ((i % 2) + 1) * 500,
        y1: (Math.floor(i / 2) * 1000) / Math.ceil(ids.length / 2),
        y2: ((Math.floor(i / 2) + 1) * 1000) / Math.ceil(ids.length / 2),
      }));
      return {
        ...focus(
          {
            ...s,
            sequence: s.sequence + 1,
            agents: [...s.agents, agent],
            workspaces: s.workspaces.map((w) =>
              w.id === workspace.id ? { ...w, tiles } : w,
            ),
          },
          id,
        ),
        sheet: "home",
        notice: "New Harness opened in the app",
      };
    }
    case "QUIET":
      return { ...s, quiet: !s.quiet };
    case "CLEAR_NOTICE":
      return { ...s, notice: "" };
    case "AUTO_RECEIPT":
      return { ...s, autoReceipt: a.enabled };
    case "CHECK_DELIVERY":
      return s.composition?.recovery
        ? { ...s, sheet: "compose", notice: "" }
        : s.pending
          ? {
              ...s,
              sheet: s.composition ? "compose" : "delivery",
              notice: s.deliveryUncertain
                ? "Delivery is unconfirmed. Check its status."
                : "Waiting for the host receipt.",
            }
          : s;
    case "SOURCE_CHANGED":
      return {
        ...s,
        agents: s.agents.map((a) =>
          a.id === s.readingId && a.result
            ? {
                ...a,
                resultId: `${a.id}-result-${(a.resultRevision ?? 1) + 1}`,
                resultRevision: (a.resultRevision ?? 1) + 1,
                result: [
                  "New research is available. Review the latest findings before selecting a passage.",
                  ...a.result.slice(1),
                ],
              }
            : a,
        ),
        notice:
          "New output arrived. Any carried copy stays exactly as selected.",
      };
  }
}
