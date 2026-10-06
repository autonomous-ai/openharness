import { describe, expect, it } from "vitest";
import {
  createState,
  ARCHIVE_LIFETIME,
  DRAFT_BYTES,
  draftPage,
  draftParts,
  pendingQuestions,
  readyAgents,
  reducer,
  resolveGesture,
  sampleWords,
  selectedAgent,
  type Action,
  type Intent,
  type State,
} from "./experience";

const run = (state: State, ...actions: Action[]) =>
  actions.reduce(reducer, state);
const review = (intent: Intent = "task") =>
  run(
    createState(),
    { type: "VOICE", intent },
    { type: "REVIEW_FIRST" },
    { type: "FINISH_VOICE" },
  );
const carrying = () =>
  run(
    createState(),
    { type: "READ", id: "hermes" },
    { type: "SELECT", index: 1 },
    { type: "CARRY" },
    { type: "FOCUS", id: "codex" },
  );
const carryReview = () =>
  run(carrying(), { type: "RECORD" }, { type: "FINISH_VOICE" });
const pendingTask = () =>
  run(createState(), { type: "VOICE" }, { type: "FINISH_VOICE" });
const visit = (initial = createState()) =>
  run(initial, { type: "READ", id: "hermes" }, { type: "VISIT" });

describe("Pro voice and delivery", () => {
  it("sends a quick task to the captured recipient despite a later app focus change", () => {
    let state = run(
      createState(),
      { type: "VOICE" },
      { type: "FOCUS", id: "codex", fromApp: true },
      { type: "FINISH_VOICE" },
    );
    expect(state.activeId).toBe("codex");
    expect(state.pending).toMatchObject({ agentId: "claude", intent: "task" });
    expect(state.receipts).toHaveLength(0);
    const id = state.pending!.id;
    state = reducer(state, { type: "HOST_ACK", id });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({ id, agentId: "claude" });
    expect(state.pending).toBeNull();
    expect(state.app.agentId).toBe("codex");
    expect(reducer(state, { type: "HOST_ACK", id }).receipts).toHaveLength(1);
  });

  it.each<Intent>(["goal", "loop"])(
    "requires a nonempty reviewed %s request without claiming a completed outcome",
    (intent) => {
      let state = review(intent);
      expect(state.composition).toMatchObject({ phase: "review", intent });
      expect(state.pending).toBeNull();
      const words = state.composition!.text;
      state = run(state, { type: "EDIT_DRAFT", text: "  " }, { type: "SEND" });
      expect(state.pending).toBeNull();
      state = run(state, { type: "EDIT_DRAFT", text: words }, { type: "SEND" });
      expect(state.receipts).toHaveLength(0);
      state = reducer(state, { type: "HOST_ACK", id: state.pending!.id });
      expect(state.receipts[0]).toMatchObject({ intent, text: words });
      expect(state.notice).toMatch(/request sent/i);
      expect(state.notice).not.toMatch(/complete|scheduled|running/i);
    },
  );

  it.each<Intent>(["goal", "loop"])(
    "does not manufacture unsupported %s capability for a selected agent",
    (intent) => {
      const state = run(
        createState(),
        { type: "FOCUS", id: "hermes" },
        { type: "VOICE", intent },
      );
      expect(state.composition).toBeNull();
      expect(state.pending).toBeNull();
      expect(state.receipts).toHaveLength(0);
      expect(state.notice).toMatch(/unavailable|not supported/i);
    },
  );

  it("keeps reviewed words through append and undo before any link loss", () => {
    let state = review();
    const original = state.composition!.text;
    state = run(state, { type: "APPEND" }, { type: "FINISH_VOICE" });
    expect(state.composition!.text).toContain(original);
    expect(state.composition!.text).not.toBe(original);
    state = reducer(state, { type: "UNDO" });
    expect(state.composition!.text).toBe(original);
    state = reducer(state, { type: "SEND" });
    expect(state.pending!.text).toBe(original);
    state = reducer(state, { type: "HOST_ACK", id: state.pending!.id });
    expect(state.receipts).toHaveLength(1);
  });

  it("offers a fresh recording after capture is interrupted without sending an empty instruction", () => {
    let state = run(
      createState(),
      { type: "VOICE" },
      { type: "CONNECTION", connected: false },
      { type: "FINISH_VOICE" },
      { type: "CONNECTION", connected: true },
      { type: "SEND" },
    );
    expect(state.pending).toBeNull();
    expect(state.composition).toMatchObject({ phase: "review", text: "" });
    state = run(state, { type: "RECORD_AGAIN" }, { type: "FINISH_VOICE" });
    expect(state.composition!.text.trim()).not.toBe("");
    expect(state.composition!.phase).toBe("review");
    expect(state.pending).toBeNull();
  });

  it("reconciles an accepted instruction after losing its receipt without resending", () => {
    let state = run(review(), { type: "SEND" });
    const operation = state.pending!;
    state = run(
      state,
      { type: "CONNECTION", connected: false },
      { type: "HOST_ACK", id: operation.id },
      { type: "SEND" },
      { type: "DISCARD" },
      { type: "RECONCILE" },
    );
    expect(state.pending).toEqual(operation);
    expect(state.receipts).toHaveLength(1);
    expect(state.composition!.recovery?.state).toBe("offline");
    expect(state.sequence).toBe(1);
    state = run(
      state,
      { type: "CONNECTION", connected: true },
      { type: "HOST_ACK", id: operation.id },
      { type: "RECOVER_DRAFT", id: state.composition!.id },
    );
    expect(state.pending).toBeNull();
    expect(state.composition).toMatchObject({
      text: operation.text,
      recovery: { state: "recovered", delivery: "sent" },
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.sequence).toBe(1);
  });

  it("keeps an absent receipt unresolved and rejects stale or unrelated acknowledgements", () => {
    let state = run(review(), { type: "SEND" });
    const operation = state.pending!;
    state = run(
      state,
      { type: "CONNECTION", connected: false },
      { type: "CONNECTION", connected: true },
      { type: "RECONCILE" },
      { type: "HOST_ACK", id: "some-other-operation" },
      { type: "SEND" },
    );
    expect(state.pending).toEqual(operation);
    expect(state.receipts).toHaveLength(0);
    expect(state.composition!.recovery?.delivery).toBe("unconfirmed");
    expect(state.notice).toMatch(/unconfirmed/i);
    expect(state.sequence).toBe(1);
  });

  it("never manufactures a reviewed archive or restart bookmark for an ordinary quick task", () => {
    let state = pendingTask();
    const operation = state.pending!;
    state = run(
      state,
      { type: "REVIEW_FIRST" },
      { type: "CONNECTION", connected: false },
      { type: "RESTART_DEVICE" },
      { type: "RECOVER_DRAFT", id: state.composition!.id },
    );
    expect(state.composition).toMatchObject({
      phase: "uncertain",
      review: false,
    });
    expect(state.composition!.recovery).toBeUndefined();
    expect(state.archive).toBeNull();
    expect(state.pending).toEqual(operation);
    state = run(
      state,
      { type: "HOST_ACK", id: operation.id },
      { type: "CONNECTION", connected: true },
    );
    expect(state.receipts).toHaveLength(1);
    expect(state.archive).toBeNull();
    expect(state.composition).toBeNull();
    expect(state.pending).toBeNull();
  });

  it("allows local controls and reading during uncertain delivery without abandoning its operation", () => {
    let state = reducer(pendingTask(), { type: "RECONCILE" });
    const operation = state.pending;
    state = run(
      state,
      { type: "SHEET", sheet: "home" },
      { type: "SHEET", sheet: "settings" },
      { type: "QUIET" },
    );
    expect(state.sheet).toBe("settings");
    expect(state.quiet).toBe(false);
    state = reducer(state, { type: "READ", id: "hermes" });
    expect(state.sheet).toBe("result");
    expect(state.pending).toEqual(operation);
    state = reducer(state, { type: "CHECK_DELIVERY" });
    expect(state.sheet).toBe("compose");
    expect(state.composition!.phase).toBe("uncertain");
    expect(state.receipts).toHaveLength(0);
    state = reducer(state, { type: "HOST_ACK", id: operation!.id });
    expect(state.receipts).toHaveLength(1);
    expect(state.pending).toBeNull();
  });
});

describe("Pro sample-host message recovery", () => {
  const words =
    "  Keep  the spacing.\n\nGiữ nguyên bản gốc — đừng đổi. \t e\u0301 👩🏽‍💻\n".repeat(
      25,
    ) + "  End.  ";
  const loss = (initial: State) =>
    run(
      initial,
      { type: "EDIT_DRAFT", text: words },
      { type: "CONNECTION", connected: false },
    );
  const mutations: Action[] = [
    { type: "SEND" },
    { type: "EDIT_DRAFT", text: "Changed" },
    { type: "APPEND" },
    { type: "RECORD_AGAIN" },
    { type: "RECORD" },
    { type: "FINISH_VOICE" },
    { type: "UNDO" },
    { type: "RESELECT" },
    { type: "DROP_CARRY" },
    { type: "REVIEW_FIRST" },
    { type: "DISCARD" },
  ];

  it.each(["task", "goal", "loop", "carry"] as const)(
    "recovers %s words for reading, never re-enables composition",
    (kind) => {
      let state = loss(kind === "carry" ? carryReview() : review(kind));
      const id = state.composition!.id,
        original = state.composition!,
        archive = state.archive!;
      expect(archive.text).toBe(words);
      expect(
        new TextEncoder().encode(original.text).length,
      ).toBeLessThanOrEqual(480);
      expect(original.text).not.toBe(words);
      expect(original.priorText).toBeUndefined();
      state = run(
        state,
        ...mutations,
        { type: "CONNECTION", connected: true },
        ...mutations,
      );
      expect(state.composition).toEqual(original);
      expect(state.archive).toEqual(archive);
      expect(state.pending).toBeNull();
      state = reducer(state, { type: "RECOVER_DRAFT", id });
      expect(state.composition!.recovery?.state).toBe("recovered");
      const pages: string[] = [];
      for (let n = 0; n < state.composition!.recovery!.total; n++) {
        pages.push(state.composition!.text);
        state = reducer(state, { type: "DRAFT_PART", id, delta: 1 });
      }
      expect(pages.length).toBeGreaterThan(4);
      expect(pages.join("")).toBe(words);
      expect(
        pages.every((part) => new TextEncoder().encode(part).length <= 480),
      ).toBe(true);
      const recovered = state.composition;
      state = run(state, ...mutations);
      expect(state.composition).toBe(recovered);
      expect(state.pending).toBeNull();
      expect(state.receipts).toHaveLength(0);
      expect(state.archive!.expiresAt).toBe(archive.expiresAt);
      expect(state.composition!.passage).toEqual(original.passage);
    },
  );

  it("retains the visible part during interrupted append and freezes recipient/source display", () => {
    let state = run(carryReview(), { type: "EDIT_DRAFT", text: words });
    const id = state.composition!.id;
    state = run(
      state,
      { type: "DRAFT_PART", id, delta: 1 },
      { type: "APPEND" },
    );
    const pinned = state.composition!;
    state = {
      ...state,
      agents: state.agents.map((agent) => ({
        ...agent,
        name: "Renamed",
        title: "Other work",
        machine: "Another machine",
      })),
    };
    state = run(
      state,
      { type: "FOCUS", id: "pi", fromApp: true },
      { type: "CONNECTION", connected: false },
      { type: "FINISH_VOICE" },
    );
    expect(state.composition).toMatchObject({
      id,
      recipient: pinned.recipient,
      recipientName: pinned.recipientName,
      recipientTitle: pinned.recipientTitle,
      recipientMachine: pinned.recipientMachine,
      part: 1,
      text: draftParts(words)[1],
      passage: pinned.passage,
    });
    expect(state.archive!.text).toBe(words);
    state = run(
      state,
      { type: "CONNECTION", connected: true },
      { type: "RECOVER_DRAFT", id },
    );
    expect(state.composition!.part).toBe(1);
    expect(state.composition!.passage!.sourceName).toBe("Hermes");
  });

  it.each(["task", "goal", "loop", "carry"] as const)(
    "restarts %s with identity only and explicitly recovers words from the exact archive",
    (kind) => {
      let state = run(kind === "carry" ? carryReview() : review(kind), {
        type: "EDIT_DRAFT",
        text: words,
      });
      const original = state.composition!;
      state = run(
        state,
        { type: "DRAFT_PART", id: original.id, delta: 1 },
        { type: "RESTART_DEVICE" },
      );
      const bookmark = state.composition!;
      expect(bookmark).toMatchObject({
        id: original.id,
        hostId: original.hostId,
        recipient: original.recipient,
        recipientName: original.recipientName,
        recipientTitle: "",
        recipientMachine: "",
        intent: original.intent,
        text: "",
        part: 0,
        recovery: {
          state: "offline",
          total: 0,
          delivery: "unconfirmed",
          bookmark: { carried: kind === "carry" },
        },
      });
      expect(bookmark.passage).toBeUndefined();
      expect(bookmark.priorText).toBeUndefined();
      expect(state.carry).toBeNull();
      expect(state.pending).toBeNull();
      expect(state.archive!.text).toBe(words);
      const deadline = state.archive!.expiresAt;
      state = run(
        state,
        { type: "CONNECTION", connected: true },
        { type: "CLOSE_DRAFT", id: "stale-draft" },
        { type: "RECOVER_DRAFT", id: "stale-draft" },
        ...mutations,
      );
      expect(state.composition).toBe(bookmark);
      state = reducer(state, { type: "RECOVER_DRAFT", id: bookmark.id });
      const pages: string[] = [];
      for (let n = 0; n < state.composition!.recovery!.total; n++) {
        pages.push(state.composition!.text);
        state = reducer(state, {
          type: "DRAFT_PART",
          id: bookmark.id,
          delta: 1,
        });
      }
      expect(pages.join("")).toBe(words);
      expect(state.composition!.passage).toBeUndefined();
      expect(state.composition!.recipientName).toBe(original.recipientName);
      expect(state.composition!.recovery!.delivery).toBe("not-sent");
      const recovered = state.composition;
      state = run(state, ...mutations);
      expect(state.composition).toBe(recovered);
      expect(state.archive!.expiresAt).toBe(deadline);
      expect(state.receipts).toHaveLength(0);
    },
  );

  it.each(["missing", "other-host", "expired"] as const)(
    "keeps a restart bookmark empty and read-only when its archive is %s",
    (reason) => {
      let state = run(carryReview(), { type: "RESTART_DEVICE" });
      const id = state.composition!.id;
      state =
        reason === "missing"
          ? reducer(state, { type: "ARCHIVE_LOST" })
          : reason === "expired"
            ? reducer(state, { type: "TICK", now: state.archive!.expiresAt })
            : { ...state, hostId: "other-host" };
      state = run(
        state,
        { type: "CONNECTION", connected: true },
        { type: "RECOVER_DRAFT", id },
        { type: "DRAFT_PART", id, delta: 1 },
        ...mutations,
      );
      expect(state.composition).toMatchObject({
        id,
        text: "",
        part: 0,
        recovery: { state: "unavailable", total: 0 },
      });
      expect(state.composition!.passage).toBeUndefined();
      expect(state.notice).not.toContain("This part is still here");
      expect(state.receipts).toHaveLength(0);
      expect(state.pending).toBeNull();
    },
  );

  it("does not persist a delivery claim across restart and keeps recovered words after a historical receipt", () => {
    let state = run(
      review("goal"),
      { type: "SEND" },
      { type: "CONNECTION", connected: false },
    );
    const id = state.composition!.id,
      operation = state.pending!.id;
    state = run(
      state,
      { type: "HOST_ACK", id: operation },
      { type: "RESTART_DEVICE" },
      { type: "CONNECTION", connected: true },
    );
    expect(state.composition!.text).toBe("");
    expect(state.composition!.recovery!.delivery).toBe("unconfirmed");
    expect(state.receipts).toHaveLength(1);
    state = run(state, { type: "RECOVER_DRAFT", id }, ...mutations, {
      type: "HOST_ACK",
      id: operation,
    });
    expect(state.composition).toMatchObject({
      id,
      text: sampleWords("goal"),
      recovery: { state: "recovered", delivery: "sent" },
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.pending).toBeNull();
  });

  it("does not extend archive lifetime by reading, repeated recovery or another disconnect", () => {
    let state = loss(review());
    const id = state.composition!.id,
      deadline = state.archive!.expiresAt;
    state = run(
      state,
      { type: "CONNECTION", connected: true },
      { type: "TICK", now: deadline - 1 },
      { type: "RECOVER_DRAFT", id },
      { type: "DRAFT_PART", id, delta: 1 },
    );
    const cached = state.composition!.text;
    state = run(
      state,
      { type: "CONNECTION", connected: false },
      { type: "CONNECTION", connected: true },
      { type: "RECOVER_DRAFT", id },
    );
    expect(state.archive!.expiresAt).toBe(deadline);
    state = run(
      state,
      { type: "TICK", now: deadline },
      { type: "TICK", now: 0 },
      { type: "RECOVER_DRAFT", id },
      { type: "DRAFT_PART", id, delta: 1 },
    );
    expect(state.archive).toBeNull();
    expect(state.now).toBe(deadline);
    expect(state.composition).toMatchObject({
      text: cached,
      recovery: { state: "unavailable" },
    });
    expect(state.pending).toBeNull();
  });

  it.each([
    "missing",
    "other-host",
    "other-recipient",
    "other-intent",
    "other-source",
  ])("keeps the local page when recovery is %s", (reason) => {
    let state = loss(carryReview());
    const id = state.composition!.id,
      cached = state.composition!.text;
    const archive = state.archive!;
    state = {
      ...state,
      connected: true,
      archive:
        reason === "missing"
          ? null
          : {
              ...archive,
              ...(reason === "other-host" ? { hostId: "different-host" } : {}),
              ...(reason === "other-recipient" ? { recipient: "pi" } : {}),
              ...(reason === "other-intent" ? { intent: "loop" as const } : {}),
              ...(reason === "other-source" ? { passageId: "new-tray" } : {}),
            },
    };
    state = reducer(state, { type: "RECOVER_DRAFT", id });
    expect(state.composition).toMatchObject({
      text: cached,
      recovery: { state: "unavailable" },
    });
    expect(state.pending).toBeNull();
    expect(state.receipts).toHaveLength(0);
  });

  it("closes only this device copy and rejects old Close/recovery/receipt against a new draft", () => {
    let state = run(
      review("goal"),
      { type: "SEND" },
      { type: "CONNECTION", connected: false },
    );
    const id = state.composition!.id,
      operation = state.pending!.id,
      archive = state.archive;
    state = reducer(state, { type: "CLOSE_DRAFT", id });
    expect(state.composition).toBeNull();
    expect(state.archive).toBe(archive);
    expect(state.receipts).toHaveLength(0);
    state = run(
      state,
      { type: "CONNECTION", connected: true },
      { type: "VOICE", intent: "goal" },
      { type: "FINISH_VOICE" },
      { type: "CONNECTION", connected: false },
    );
    const newer = state.composition;
    expect(newer!.id).not.toBe(id);
    state = run(
      state,
      { type: "CLOSE_DRAFT", id },
      { type: "RECOVER_DRAFT", id },
      { type: "HOST_ACK", id: operation },
    );
    expect(state.composition).toBe(newer);
    expect(state.archive!.id).toBe(newer!.id);
    expect(state.receipts).toHaveLength(0);
    expect(state.sequence).toBe(1); // Draft identities do not consume send IDs.
    expect(state.draftSequence).toBe(2);
  });

  it("keeps strict rejection read-only until Close, then allows a deliberately new message", () => {
    let state = run(review("goal"), { type: "SEND" });
    const operation = state.pending!.id,
      id = state.composition!.id;
    state = run(state, { type: "HOST_REJECT", id: operation }, ...mutations);
    expect(state.composition!.recovery?.delivery).toBe("rejected");
    expect(state.pending).toBeNull();
    state = run(
      state,
      { type: "CLOSE_DRAFT", id },
      { type: "VOICE", intent: "goal" },
      { type: "FINISH_VOICE" },
      { type: "SEND" },
    );
    expect(state.pending!.id).not.toBe(operation);
    expect(state.composition!.id).not.toBe(id);
    expect(state.archive!.id).toBe(id);
  });

  it("bounds the archive by UTF-8 bytes and preserves whitespace in the sent sample", () => {
    const exact = "é".repeat(DRAFT_BYTES / 2);
    let state = run(review(), { type: "EDIT_DRAFT", text: exact });
    state = reducer(state, { type: "EDIT_DRAFT", text: exact + "é" });
    expect(state.composition!.text).toBe(exact);
    state = reducer(state, { type: "CONNECTION", connected: false });
    expect(new TextEncoder().encode(state.archive!.text).length).toBe(
      DRAFT_BYTES,
    );
    expect(state.archive!.expiresAt).toBe(ARCHIVE_LIFETIME);
    expect(draftParts(exact).join("")).toBe(exact);
    state = run(
      review(),
      { type: "EDIT_DRAFT", text: words },
      { type: "SEND" },
    );
    expect(state.pending!.text).toBe(words);
    expect(draftPage(state.composition!).text).toBe(draftParts(words)[0]);
  });
});

describe("Pro decisions", () => {
  it("keeps choosing separate from answering and advances only after acknowledgement", () => {
    let state = createState();
    const desktop = { ...state.app };
    state = run(
      state,
      { type: "QUESTION", id: "checkout-environment" },
      { type: "CHOOSE", choice: 0 },
    );
    expect(pendingQuestions(state)).toHaveLength(2);
    expect(state.pending).toBeNull();
    expect(state.app).toEqual(desktop);
    state = reducer(state, {
      type: "ANSWER",
      id: state.questionId,
      revision: state.questionRevision,
    });
    expect(state.pending).toMatchObject({
      kind: "answer",
      agentId: "codex",
      text: "Staging",
    });
    expect(pendingQuestions(state)).toHaveLength(2);
    state = reducer(state, { type: "HOST_ACK", id: state.pending!.id });
    expect(pendingQuestions(state)).toHaveLength(1);
    expect(state.questionId).toBe("command-name");
    expect(state.choice).toBeNull();
    expect(state.app).toEqual(desktop);
  });

  it.each([
    { id: "command-name", revision: 3 },
    { id: "checkout-environment", revision: 2 },
  ])(
    "rejects a choice replayed against another question or revision (%j)",
    (answer) => {
      const state = run(
        createState(),
        { type: "QUESTION", id: "checkout-environment" },
        { type: "CHOOSE", choice: 1 },
        { type: "ANSWER", ...answer },
      );
      expect(state.pending).toBeNull();
      expect(state.receipts).toHaveLength(0);
      expect(pendingQuestions(state)).toHaveLength(2);
    },
  );

  it("does not accept a stale selection after the app has answered the question", () => {
    const state = run(
      createState(),
      { type: "QUESTION", id: "checkout-environment" },
      { type: "CHOOSE", choice: 0 },
      { type: "ANSWER_ELSEWHERE" },
      { type: "ANSWER", id: "checkout-environment", revision: 1 },
    );
    expect(state.pending).toBeNull();
    expect(state.choice).toBeNull();
    expect(pendingQuestions(state).map((q) => q.id)).toEqual(["command-name"]);
    expect(state.receipts).toHaveLength(0);
  });

  it("rejects an in-flight answer whose question closed before the host accepted it", () => {
    let state = run(
      createState(),
      { type: "QUESTION", id: "checkout-environment" },
      { type: "CHOOSE", choice: 0 },
      { type: "ANSWER", id: "checkout-environment", revision: 1 },
    );
    const id = state.pending!.id;
    state = run(state, { type: "ANSWER_ELSEWHERE" }, { type: "HOST_ACK", id });
    expect(state.receipts).toHaveLength(0);
    expect(state.pending).toBeNull();
    expect(state.choice).toBeNull();
  });

  it("never routes a generic voice action on a question to the unrelated home agent", () => {
    const state = run(
      createState(),
      { type: "QUESTION", id: "command-name" },
      { type: "VOICE" },
    );
    expect(state.composition).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.questionId).toBe("command-name");
  });

  it("retains an unconfirmed answer after its question closes elsewhere and reconciles the same operation", () => {
    let state = run(
      createState(),
      { type: "QUESTION", id: "checkout-environment" },
      { type: "CHOOSE", choice: 0 },
      { type: "ANSWER", id: "checkout-environment", revision: 1 },
      { type: "RECONCILE" },
    );
    const operation = state.pending!;
    state = run(
      state,
      { type: "SHEET", sheet: "home" },
      { type: "ANSWER_ELSEWHERE" },
      { type: "CHECK_DELIVERY" },
      { type: "RECONCILE" },
    );
    expect(state.sheet).toBe("delivery");
    expect(state.pending).toEqual(operation);
    expect(state.pending!.text).toBe("Staging");
    expect(state.deliveryUncertain).toBe(true);
    expect(state.sequence).toBe(1);
    state = reducer(state, { type: "HOST_ACK", id: operation.id });
    expect(state.pending).toBeNull();
    expect(state.receipts).toHaveLength(0);
    expect(state.deliveryUncertain).toBe(false);
  });

  it("locally closes an unknown answer without a receipt or resend, then opens the next question", () => {
    let state = run(
      createState(),
      { type: "QUESTION", id: "checkout-environment" },
      { type: "CHOOSE", choice: 0 },
      { type: "ANSWER", id: "checkout-environment", revision: 1 },
    );
    const oldId = state.pending!.id;
    expect(reducer(state, { type: "CLOSE_DELIVERY", id: oldId })).toBe(state);
    state = run(
      state,
      { type: "CONNECTION", connected: false },
      { type: "ANSWER_ELSEWHERE" },
      { type: "CONNECTION", connected: true },
    );
    const questions = state.questions;
    state = reducer(state, { type: "CLOSE_DELIVERY", id: oldId });
    expect(state.sheet).toBe("attention");
    expect(state.pending).toBeNull();
    expect(state.questions).toBe(questions);
    expect(state.receipts).toHaveLength(0);
    expect(state.sequence).toBe(1);
    state = run(
      state,
      { type: "QUESTION", id: "command-name" },
      { type: "CHOOSE", choice: 0 },
      { type: "ANSWER", id: "command-name", revision: 3 },
      { type: "RECONCILE" },
    );
    const newer = state.pending;
    expect(newer!.id).not.toBe(oldId);
    state = run(
      state,
      { type: "CLOSE_DELIVERY", id: oldId },
      { type: "HOST_ACK", id: oldId },
    );
    expect(state.pending).toBe(newer);
    expect(state.receipts).toHaveLength(0);
  });
});

describe("Pro context handoff", () => {
  it("rejects a selection from an older result revision and marks replacement output unread", () => {
    let state = run(
      createState(),
      { type: "READ", id: "hermes" },
      { type: "SELECT", index: 0 },
    );
    expect(readyAgents(state)).toHaveLength(0);
    state = run(state, { type: "SOURCE_CHANGED" }, { type: "CARRY" });
    expect(state.carry).toBeNull();
    expect(state.notice).toMatch(/changed|select/i);
    expect(readyAgents(state).map((agent) => agent.id)).toEqual(["hermes"]);
    state = run(state, { type: "SELECT", index: 0 }, { type: "CARRY" });
    const source = state.agents.find((agent) => agent.id === "hermes")!;
    expect(state.carry).toMatchObject({
      resultId: source.resultId,
      revision: source.resultRevision,
      text: source.result![0],
    });
  });

  it("chooses a recipient without opening the microphone and freezes the exact selected passage", () => {
    let state = carrying();
    const excerpt = state.carry!.text;
    expect(state.composition).toMatchObject({
      recipient: "codex",
      phase: "ready",
      passage: { text: excerpt, agentId: "hermes" },
    });
    expect(state.pending).toBeNull();
    state = {
      ...state,
      agents: state.agents.map((agent) =>
        agent.id === "hermes"
          ? { ...agent, result: ["New output arrived after capture."] }
          : agent,
      ),
    };
    state = run(
      state,
      { type: "RECORD" },
      { type: "FINISH_VOICE" },
      { type: "FOCUS", id: "pi", fromApp: true },
      { type: "SEND" },
    );
    expect(state.pending).toMatchObject({
      agentId: "codex",
      passage: { text: excerpt, agentId: "hermes" },
    });
    state = reducer(state, { type: "HOST_ACK", id: state.pending!.id });
    expect(state.receipts[0]).toMatchObject({
      agentId: "codex",
      source: excerpt,
    });
  });

  it("keeps attached context and words while reviewing after the unused tray lifetime", () => {
    let state = carryReview();
    const passage = state.composition!.passage;
    const words = state.composition!.text;
    state = run(
      state,
      { type: "TICK", now: 300_001 },
      { type: "TICK", now: 1000 },
      { type: "SOURCE_CHANGED" },
      { type: "SEND" },
    );
    expect(state.now).toBe(300_001);
    expect(state.pending).toMatchObject({
      agentId: "codex",
      text: words,
      passage,
    });
    expect(state.composition!.passage).toEqual(passage);
  });

  it("requires a fresh passage before opening the microphone when the unused tray expires", () => {
    let state = run(
      carrying(),
      { type: "TICK", now: 300_001 },
      { type: "RECORD" },
    );
    expect(state.composition).toMatchObject({
      phase: "ready",
      recipient: "codex",
      text: "",
    });
    expect(state.composition!.passageAttached).not.toBe(true);
    expect(state.pending).toBeNull();
    state = run(
      state,
      { type: "RESELECT" },
      { type: "VOICE" },
      { type: "FOCUS", id: "pi" },
      { type: "CREATE" },
    );
    expect(state.savedComposition).toMatchObject({
      phase: "ready",
      recipient: "codex",
      text: "",
    });
    expect(state.agents).toHaveLength(6);
    state = run(state, { type: "SELECT", index: 2 }, { type: "CARRY" });
    expect(state.composition).toMatchObject({
      phase: "ready",
      recipient: "codex",
      passageAttached: false,
    });
    expect(state.savedComposition).toBeNull();
    state = run(state, { type: "RECORD" }, { type: "FINISH_VOICE" });
    expect(state.composition).toMatchObject({
      phase: "review",
      passageAttached: true,
    });
    expect(state.pending).toBeNull();
    state = reducer(state, { type: "SEND" });
    expect(state.pending).toMatchObject({ agentId: "codex" });
  });

  it("can remove attached context while preserving the reviewed instruction", () => {
    let state = carryReview();
    const words = state.composition!.text;
    state = run(
      state,
      { type: "TICK", now: 300_001 },
      { type: "DROP_CARRY" },
      { type: "SEND" },
    );
    expect(state.pending).toMatchObject({ agentId: "codex", text: words });
    expect(state.pending!.passage).toBeUndefined();
  });
});

describe("Pro navigation and continuity", () => {
  it("browses workspaces without moving the app until an agent is chosen", () => {
    let state = createState();
    const desktop = { ...state.app };
    state = run(
      state,
      { type: "SHEET", sheet: "map" },
      { type: "WORKSPACE", id: "mobile" },
    );
    expect(state.app).toEqual(desktop);
    state = reducer(state, { type: "FOCUS", id: "codex-mobile" });
    expect(state.app).toMatchObject({
      agentId: "codex-mobile",
      workspace: "mobile",
    });
    expect(selectedAgent(state).machine).toBe("Home Mac");
  });

  it("preserves each pane’s reading position through ordinary selection", () => {
    let state = run(createState(), { type: "SCROLL", delta: -7 });
    expect(state.app.line).toBe(35);
    state = reducer(state, { type: "FOCUS", id: "claude" });
    expect(state.app.line).toBe(35);
    state = run(
      state,
      { type: "FOCUS", id: "codex" },
      { type: "SCROLL", delta: -10 },
    );
    const codexLine = state.app.line;
    state = reducer(state, { type: "FOCUS", id: "claude" });
    expect(state.app.line).toBe(35);
    state = reducer(state, { type: "FOCUS", id: "codex" });
    expect(state.app.line).toBe(codexLine);
  });

  it("reads locally, visits the exact result, and restores the original reading anchor", () => {
    let state = createState();
    const desktop = { ...state.app };
    state = reducer(state, { type: "READ", id: "hermes" });
    expect(state.app).toEqual(desktop);
    expect(state.visit).toBeNull();
    state = reducer(state, { type: "VISIT" });
    expect(state.app.agentId).toBe("hermes");
    expect(state.visit).toMatchObject(desktop);
    state = reducer(state, { type: "RETURN" });
    expect(state.app).toEqual(desktop);
    expect(state.visit).toBeNull();
  });

  it.each([true, false])(
    "invalidates Return after an intentional focus change (fromApp=%s)",
    (fromApp) => {
      let state = visit();
      state = reducer(state, { type: "FOCUS", id: "pi", fromApp });
      const desktop = { ...state.app };
      expect(state.visit).toBeNull();
      state = reducer(state, { type: "RETURN" });
      expect(state.app).toEqual(desktop);
    },
  );

  it("discloses a pruned anchor instead of claiming an exact restoration", () => {
    const state = run(visit(), { type: "PRUNE" }, { type: "RETURN" });
    expect(state.app.agentId).toBe("claude");
    expect(state.app.line).toBeGreaterThan(42);
    expect(state.notice).toMatch(/earlier text is no longer available/i);
    expect(state.visit).toBeNull();
  });

  it("removes a closed origin from the map and decisions without leaving an invalid selection", () => {
    const state = reducer(
      visit(reducer(createState(), { type: "FOCUS", id: "codex" })),
      { type: "CLOSE_ORIGIN" },
    );
    expect(state.visit).toBeNull();
    expect(selectedAgent(state)).toBeDefined();
    expect(state.agents.some((agent) => agent.id === "codex")).toBe(false);
    expect(
      state.workspaces
        .flatMap((w) => w.tiles)
        .some((tile) => tile.agentId === "codex"),
    ).toBe(false);
    expect(state.questions.some((q) => q.agentId === "codex")).toBe(false);
    expect(reducer(state, { type: "RETURN" }).app).toEqual(state.app);
  });

  it("does not create a Return detour when opening the already focused result", () => {
    const state = visit(
      reducer(createState(), { type: "FOCUS", id: "hermes" }),
    );
    expect(state.visit).toBeNull();
    expect(
      selectedAgent(reducer(state, { type: "CLOSE_ORIGIN" })),
    ).toBeDefined();
  });

  it("recognizes only deliberate one- and two-contact horizontal navigation", () => {
    expect(resolveGesture(1, -75, 8)).toEqual({ level: 1, direction: 1 });
    expect(resolveGesture(2, 75, -8)).toEqual({ level: 2, direction: -1 });
    for (const [count, dx, dy] of [
      [1, 20, 0],
      [1, 0, 80],
      [2, 42, 43],
      [0, 90, 0],
      [3, 90, 0],
    ]) {
      expect(resolveGesture(count, dx, dy)).toBeNull();
    }
  });
});
