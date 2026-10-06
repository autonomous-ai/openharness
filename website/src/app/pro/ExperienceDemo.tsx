"use client";
import Image from "next/image";
import {
  useEffect,
  useReducer,
  useRef,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  CornerUpLeft,
  Grid2X2,
  Layers,
  Mic,
  MoreHorizontal,
  Plus,
  Repeat2,
  RotateCcw,
  Search,
  Settings2,
  Target,
  WifiOff,
  X,
} from "lucide-react";
import {
  capability,
  createState,
  draftPage,
  elapsed,
  pendingQuestions,
  readyAgents,
  reducer,
  resolveGesture,
  selectedAgent,
  sampleWords,
  type Sheet,
} from "./experience";
import AppPreview, { tileStyle } from "./AppPreview";
import s from "./experience.module.css";
export type PreviewScenario =
  | "home"
  | "map"
  | "attention"
  | "carry"
  | "return"
  | "goal"
  | "loop"
  | "usage";
const previewNames: Record<PreviewScenario, string> = {
  home: "Voice",
  map: "Navigation",
  attention: "Decisions",
  carry: "Carry",
  return: "Return",
  goal: "Goal",
  loop: "Loop",
  usage: "Today",
};
type Contact = { x: number; y: number };
function CarriedSource({
  name,
  text,
  expired = false,
}: {
  name?: string;
  text: string;
  expired?: boolean;
}) {
  const passage = [...text.replace(/\s+/g, " ").trim()];
  const preview =
    passage.slice(0, 120).join("") + (passage.length > 120 ? "…" : "");
  return (
    <details className={`${s.carriedSource} ${expired ? s.expired : ""}`}>
      <summary aria-label={`Show passage preview from ${name}`}>
        <Copy />
        <span>From {name}</span>
        <ChevronDown />
      </summary>
      <p>
        <small>Passage preview</small>
        {preview}
      </p>
    </details>
  );
}
export default function ExperienceDemo({
  scenario = "home",
  presentation = "paired",
  product = false,
}: {
  scenario?: PreviewScenario;
  presentation?: "paired" | "device";
  product?: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, scenario, (initial) =>
    reducer(createState(), { type: "RESET", scenario: initial }),
  );
  const container = useRef<HTMLDivElement>(null);
  const contacts = useRef(new Map<number, Contact>());
  const gesture = useRef({
    count: 0,
    startX: 0,
    startY: 0,
    dx: 0,
    dy: 0,
    moved: false,
  });
  const suppressClick = useRef(false);
  const started = useRef(0);
  const active = selectedAgent(state);
  const workspace = state.workspaces.find((w) => w.id === state.app.workspace)!;
  const map = state.workspaces.find((w) => w.id === state.mapWorkspace)!;
  const questions = pendingQuestions(state);
  const results = readyAgents(state);
  const question = state.questions.find(
    (q) => q.id === state.questionId && !q.resolved,
  );
  const questionAgent = state.agents.find((a) => a.id === question?.agentId);
  const reading = state.agents.find((a) => a.id === state.readingId)!;
  const composition = state.composition;
  const page = composition ? draftPage(composition) : null;
  const carryExpired =
    !!composition?.passage &&
    !composition.passageAttached &&
    composition.passage.expiresAt <= state.now;
  useEffect(() => {
    started.current = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const tick = () =>
      dispatch({ type: "TICK", now: Date.now() - started.current });
    const run = () => {
      if (!timer) {
        tick();
        timer = setInterval(tick, 1000);
      }
    };
    // Every chapter is rendered and discoverable. Offscreen examples do not
    // run clocks; returning to one still advances expiry from actual elapsed time.
    if (!product || typeof IntersectionObserver === "undefined") {
      run();
      return stop;
    }
    const observer = new IntersectionObserver(([entry]) =>
      entry.isIntersecting ? run() : stop(),
    );
    if (container.current) observer.observe(container.current);
    return () => {
      stop();
      observer.disconnect();
    };
  }, [product]);
  const pendingId = state.pending?.id;
  useEffect(() => {
    if (!pendingId || !state.autoReceipt) return;
    const timer = setTimeout(
      () => dispatch({ type: "HOST_ACK", id: pendingId }),
      950,
    );
    return () => clearTimeout(timer);
  }, [pendingId, state.autoReceipt]);
  useEffect(() => {
    if (!state.notice || state.composition || state.pending || !state.connected)
      return;
    const timer = setTimeout(() => dispatch({ type: "CLEAR_NOTICE" }), 3500);
    return () => clearTimeout(timer);
  }, [state.notice, state.composition, state.pending, state.connected]);
  function center() {
    const points = [...contacts.current.values()];
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    if (!contacts.current.size) suppressClick.current = false;
    if (
      state.sheet !== "home" ||
      state.composition ||
      (e.target as HTMLElement).closest("[data-control]") ||
      (e.pointerType === "mouse" && e.button !== 0)
    )
      return;
    contacts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = center();
    gesture.current = {
      count: Math.max(gesture.current.count, contacts.current.size),
      startX: p.x,
      startY: p.y,
      dx: 0,
      dy: 0,
      moved: false,
    };
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (
      !contacts.current.has(e.pointerId) ||
      contacts.current.size !== gesture.current.count
    )
      return;
    contacts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = center(),
      g = gesture.current,
      old = g.dy;
    g.dx = p.x - g.startX;
    g.dy = p.y - g.startY;
    if (Math.hypot(g.dx, g.dy) > 12) {
      g.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    // Touch visitors can scroll the product story right over the example.
    // Mouse drags and the dedicated study retain the device's vertical gesture.
    if (
      g.count === 1 &&
      Math.abs(g.dy) > Math.abs(g.dx) &&
      !(product && e.pointerType === "touch")
    )
      dispatch({ type: "SCROLL", delta: -(g.dy - old) * 0.14 });
  }
  function up(e: PointerEvent<HTMLDivElement>) {
    if (!contacts.current.has(e.pointerId)) return;
    contacts.current.delete(e.pointerId);
    if (contacts.current.size) return;
    const g = gesture.current;
    suppressClick.current = g.moved;
    const action = resolveGesture(g.count, g.dx, g.dy);
    if (action) dispatch({ type: "SWIPE", ...action });
    gesture.current = {
      count: 0,
      startX: 0,
      startY: 0,
      dx: 0,
      dy: 0,
      moved: false,
    };
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || state.sheet !== "home") return;
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      dispatch({
        type: "SWIPE",
        level: e.shiftKey ? 2 : 1,
        direction: e.key === "ArrowRight" ? 1 : -1,
      });
    }
    if (["ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      dispatch({ type: "SCROLL", delta: e.key === "ArrowUp" ? -5 : 5 });
    }
  }
  function open(sheet: Sheet) {
    dispatch({ type: "SHEET", sheet });
  }
  const sheetTitle =
    state.sheet === "delivery"
      ? "Your answer"
      : state.sheet === "map"
        ? state.carry
          ? "Pass it on"
          : "Your workspace"
        : state.sheet === "attention"
          ? "For you"
          : state.sheet === "question"
            ? "Your decision"
            : state.sheet === "result"
              ? "The useful part"
              : state.sheet === "compose"
                ? composition?.recovery
                  ? "Your message"
                  : composition?.intent === "goal"
                    ? "Set a goal"
                    : composition?.intent === "loop"
                      ? "Set a loop"
                      : composition?.passage
                        ? "Add direction"
                        : "Speak naturally"
                : state.sheet === "actions"
                  ? "What’s next?"
                  : state.sheet === "find"
                    ? "Find your work"
                    : state.sheet === "new"
                      ? "A new direction"
                      : state.sheet === "usage"
                        ? "Today"
                        : "Make it yours";
  function back() {
    if (composition?.recovery || (state.pending && state.deliveryUncertain))
      open("home");
    else if (composition) dispatch({ type: "DISCARD" });
    else if (state.carry) dispatch({ type: "DISCARD" });
    else open("home");
  }
  return (
    <div
      ref={container}
      className={`${s.experience} ${product ? s.product : ""} ${presentation === "device" ? s.deviceOnly : ""}`}
    >
      <div className={s.stage}>
        <div className={s.deviceColumn}>
          <div className={s.hardware}>
            <div
              className={s.screen}
              data-testid="pro-screen"
              tabIndex={0}
              role="group"
              aria-label={
                product
                  ? `${previewNames[scenario]} preview`
                  : "Interactive Harness Pro device"
              }
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onKeyDown={key}
              onPointerCancel={() => {
                contacts.current.clear();
                gesture.current.count = 0;
                suppressClick.current = true;
              }}
              onClickCapture={(e) => {
                if (suppressClick.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  suppressClick.current = false;
                }
              }}
            >
              {state.sheet === "home" ? (
                <>
                  <header className={s.homeHeader} data-control>
                    <button
                      className={s.workspaceButton}
                      onClick={() => open("map")}
                      aria-label="Open workspace map"
                    >
                      {workspace.name}
                      <ChevronDown />
                    </button>
                    <button
                      className={s.iconButton}
                      onClick={() => open("actions")}
                      aria-label="More actions"
                    >
                      <MoreHorizontal />
                    </button>
                  </header>
                  {(state.pending || composition?.recovery) && (
                    <button
                      data-control
                      className={s.returnChip}
                      onClick={() => dispatch({ type: "CHECK_DELIVERY" })}
                    >
                      {composition?.recovery
                        ? "Your message"
                        : "Check delivery"}
                      <ChevronRight />
                    </button>
                  )}
                  {state.visit && (
                    <button
                      data-control
                      className={s.returnChip}
                      aria-label={`Return to ${state.agents.find((a) => a.id === state.visit!.agentId)?.title} line ${Math.round(state.visit!.line)}`}
                      onClick={() => dispatch({ type: "RETURN" })}
                      disabled={!state.connected}
                    >
                      <CornerUpLeft />
                      Return to{" "}
                      {
                        state.agents.find((a) => a.id === state.visit!.agentId)
                          ?.title
                      }
                    </button>
                  )}
                  <div className={s.agentIdentity}>
                    <i data-activity={active.activity} />
                    {active.name}
                    <span>·</span>
                    {active.machine}
                  </div>
                  <button
                    className={`${s.homeVoice} ${state.visit || state.pending ? s.homeCompact : ""}`}
                    onClick={() => dispatch({ type: "VOICE" })}
                    disabled={!state.connected || !!state.pending}
                    aria-label={`Speak to ${active.name}`}
                  >
                    <Image
                      unoptimized
                      src={`/pro/tim_adult_${!state.connected ? "nap" : state.notice === "Sent" ? "done" : active.activity === "needs-you" ? "need" : active.activity === "ready" ? "done" : "idle"}_0.png`}
                      alt="Tim, your companion"
                      width={280}
                      height={280}
                      draggable={false}
                    />
                    <h3>{active.title}</h3>
                    <span className={s.workState}>
                      {!state.connected ? (
                        <>
                          <WifiOff />
                          Reconnect to speak
                        </>
                      ) : active.activity === "ready" ? (
                        "Ready to read"
                      ) : active.activity === "needs-you" ? (
                        "Needs your direction"
                      ) : active.activity === "idle" ? (
                        "Ready when you are"
                      ) : active.activity === "instructed" ? (
                        "Instruction sent"
                      ) : (
                        <>
                          {state.quiet ? (
                            <span className={s.stillDot} />
                          ) : (
                            <span className={s.workingPulse} />
                          )}
                          Working{" "}
                          {active.observedSeconds !== null && (
                            <span>
                              ·{" "}
                              {elapsed(
                                active.observedSeconds +
                                  Math.floor(state.now / 1000),
                              )}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <span className={s.speakHint}>
                      <Mic />
                      Tap to speak
                    </span>
                  </button>
                  <footer className={s.homeFooter} data-control>
                    <div className={s.updateButtons}>
                      {active.result && (
                        <button
                          data-control
                          className={s.readyButton}
                          onClick={() =>
                            dispatch({ type: "READ", id: active.id })
                          }
                        >
                          Read result
                          <ArrowUpRight />
                        </button>
                      )}

                      {questions.length > 0 && (
                        <button
                          className={s.needsButton}
                          aria-label={`${questions.length} need you`}
                          onClick={() =>
                            dispatch({ type: "QUESTION", id: questions[0].id })
                          }
                        >
                          <span>{questions.length}</span>need you
                        </button>
                      )}
                      {!active.result && results.length > 0 && (
                        <button
                          className={s.readyButton}
                          aria-label={`${results.length} ready`}
                          onClick={() =>
                            dispatch({ type: "READ", id: results[0].id })
                          }
                        >
                          <span>{results.length}</span>ready
                        </button>
                      )}
                      {!active.result &&
                        !questions.length &&
                        !results.length && (
                          <span className={s.caughtUp}>
                            <Check />
                            All caught up
                          </span>
                        )}
                    </div>
                    <button
                      className={s.spendButton}
                      onClick={() => open("usage")}
                      aria-label="View today's local spending"
                    >
                      <span>Today · {state.usage.machine}</span>
                      <strong>
                        {state.usage.amount === null
                          ? "Unavailable"
                          : `~$${state.usage.amount.toFixed(2)}`}
                        {state.usage.coverage === "partial" && <span>+</span>}
                      </strong>
                    </button>
                  </footer>
                </>
              ) : (
                <>
                  <header className={s.sheetHeader} data-control>
                    <button
                      className={s.iconButton}
                      onClick={back}
                      disabled={!!state.pending && !state.deliveryUncertain}
                      aria-label={
                        state.pending || composition?.recovery
                          ? "Back to work"
                          : composition
                            ? "Discard instruction"
                            : "Back to work"
                      }
                    >
                      {composition &&
                      !composition.recovery &&
                      !state.pending ? (
                        <X />
                      ) : (
                        <ArrowLeft />
                      )}
                    </button>
                    <span>{sheetTitle}</span>
                    <span className={s.sheetIndicator} />
                  </header>
                  <div className={s.sheetBody} data-control>
                    {state.sheet === "map" && (
                      <>
                        {state.carry && (
                          <div className={s.carryRibbon}>
                            <Copy />
                            <span>
                              From {state.carry.sourceName}
                              <small>{state.carry.text}</small>
                            </span>
                          </div>
                        )}
                        <div className={s.workspacePicker}>
                          <button
                            aria-label="Previous workspace"
                            onClick={() => {
                              const i = state.workspaces.findIndex(
                                (w) => w.id === state.mapWorkspace,
                              );
                              dispatch({
                                type: "WORKSPACE",
                                id: state.workspaces[
                                  (i + state.workspaces.length - 1) %
                                    state.workspaces.length
                                ].id,
                              });
                            }}
                          >
                            <ChevronLeft />
                          </button>
                          <span>
                            <strong>{map.name}</strong>
                            <small>{map.machine}</small>
                          </span>
                          <button
                            aria-label="Next workspace"
                            onClick={() => {
                              const i = state.workspaces.findIndex(
                                (w) => w.id === state.mapWorkspace,
                              );
                              dispatch({
                                type: "WORKSPACE",
                                id: state.workspaces[
                                  (i + 1) % state.workspaces.length
                                ].id,
                              });
                            }}
                          >
                            <ChevronRight />
                          </button>
                        </div>
                        <div
                          className={s.workspaceMap}
                          data-testid="device-workspace-map"
                        >
                          {map.tiles.map((tile, index) => {
                            const agent = state.agents.find(
                              (a) => a.id === tile.agentId,
                            );
                            return agent ? (
                              <button
                                key={agent.id}
                                style={tileStyle(tile)}
                                className={`${s.workTile} ${state.activeId === agent.id ? s.currentTile : ""}`}
                                disabled={
                                  !state.connected ||
                                  state.carry?.agentId === agent.id
                                }
                                onClick={() =>
                                  dispatch({ type: "FOCUS", id: agent.id })
                                }
                                aria-label={`${state.carry ? "Carry to" : "Open"} ${agent.title} on ${agent.machine}`}
                              >
                                <strong>{agent.title}</strong>
                                <span>{agent.name}</span>
                                <i data-activity={agent.activity} />
                              </button>
                            ) : (
                              <div
                                key={`viewer-${index}`}
                                className={s.viewerTile}
                                style={tileStyle(tile)}
                              >
                                <Grid2X2 />
                                <span>App preview</span>
                                <small>On your monitor</small>
                              </div>
                            );
                          })}
                        </div>
                        <div className={s.mapFooter}>
                          <div className={s.workspaceDots}>
                            {state.workspaces.map((w) => (
                              <button
                                key={w.id}
                                aria-label={`Browse ${w.name} workspace`}
                                aria-pressed={w.id === state.mapWorkspace}
                                onClick={() =>
                                  dispatch({ type: "WORKSPACE", id: w.id })
                                }
                              />
                            ))}
                          </div>
                          <button
                            className={s.textAction}
                            onClick={() => open("find")}
                            disabled={!!state.carry}
                          >
                            <Search />
                            Find across machines
                          </button>
                        </div>
                      </>
                    )}
                    {state.sheet === "attention" && (
                      <div className={s.attentionList}>
                        {!active.result &&
                          !questions.length &&
                          !results.length && (
                            <div className={s.emptyState}>
                              <Check />
                              <h3>All caught up.</h3>
                              <p>Your agents can keep going.</p>
                            </div>
                          )}
                        {questions.map((q) => {
                          const agent = state.agents.find(
                            (a) => a.id === q.agentId,
                          )!;
                          return (
                            <button
                              key={q.id}
                              onClick={() =>
                                dispatch({ type: "QUESTION", id: q.id })
                              }
                            >
                              <span className={s.attentionDot} />
                              <span>
                                <strong>{agent.title}</strong>
                                <small>{agent.name} · Your decision</small>
                              </span>
                              <ChevronRight />
                            </button>
                          );
                        })}
                        {results.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => dispatch({ type: "READ", id: a.id })}
                          >
                            <Check />
                            <span>
                              <strong>{a.title}</strong>
                              <small>{a.name} · Ready to read</small>
                            </span>
                            <ChevronRight />
                          </button>
                        ))}
                      </div>
                    )}
                    {state.sheet === "question" && question && (
                      <div className={s.questionSheet}>
                        <div className={s.contextLine}>
                          {questionAgent?.title}
                          <span>
                            {questionAgent?.name} · {questionAgent?.machine}
                          </span>
                        </div>
                        <div className={s.questionContent}>
                          <h3>{question.text}</h3>
                          <div className={s.questionChoices}>
                            {question.options.map((option, i) => (
                              <button
                                key={option}
                                aria-pressed={state.choice === i}
                                onClick={() =>
                                  dispatch({ type: "CHOOSE", choice: i })
                                }
                                disabled={!!state.pending}
                              >
                                <span>{option}</span>
                                {state.choice === i ? (
                                  <Check />
                                ) : (
                                  <span className={s.radioCircle} />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className={s.sheetActions}>
                          <button
                            className={s.textAction}
                            onClick={() => open("attention")}
                            disabled={!!state.pending}
                          >
                            All updates
                          </button>
                          <button
                            className={s.primary}
                            disabled={
                              state.choice === null ||
                              !state.connected ||
                              !!state.pending
                            }
                            onClick={() =>
                              dispatch({
                                type: "ANSWER",
                                id: question.id,
                                revision: state.questionRevision,
                              })
                            }
                          >
                            {state.pending ? "Sending…" : "Send answer"}
                            <ArrowUpRight />
                          </button>
                        </div>
                      </div>
                    )}
                    {state.sheet === "result" && reading?.result && (
                      <div className={s.resultSheet}>
                        <div className={s.contextLine}>
                          {reading.title}
                          <span>
                            {reading.name} · {reading.machine}
                          </span>
                        </div>
                        <div className={s.resultText}>
                          {reading.result.map((text, i) => (
                            <button
                              key={text}
                              aria-pressed={state.selection === i}
                              aria-label={`Select passage ${i + 1}`}
                              onClick={() =>
                                dispatch({ type: "SELECT", index: i })
                              }
                            >
                              {text}
                              {state.selection === i && <Check />}
                            </button>
                          ))}
                        </div>
                        <div className={s.sheetActions}>
                          <button
                            className={s.secondary}
                            disabled={
                              !state.connected || !!state.savedComposition
                            }
                            onClick={() => dispatch({ type: "VISIT" })}
                          >
                            Open in app
                            <ArrowUpRight />
                          </button>
                          <button
                            className={s.primary}
                            disabled={
                              state.selection === null || !state.connected
                            }
                            onClick={() => dispatch({ type: "CARRY" })}
                          >
                            <Copy />
                            {state.savedComposition ? "Use passage" : "Carry"}
                          </button>
                        </div>
                        <span className={s.smallContext}>
                          {state.selection === null
                            ? "Tap the part you want to carry"
                            : state.savedComposition
                              ? "Your instruction is still saved"
                              : "This exact passage travels with you"}
                        </span>
                      </div>
                    )}
                    {state.sheet === "compose" && composition && (
                      <div className={s.composeSheet}>
                        <div className={s.contextLine}>
                          {composition.recipientTitle ||
                            composition.recipientName}
                          {(composition.recipientTitle ||
                            composition.recipientMachine) && (
                            <span>
                              {composition.recipientTitle &&
                                composition.recipientName}
                              {composition.recipientTitle &&
                                composition.recipientMachine &&
                                " · "}
                              {composition.recipientMachine}
                            </span>
                          )}
                        </div>
                        {composition.phase === "ready" ? (
                          <>
                            {composition.passage && (
                              <CarriedSource
                                name={composition.passage.sourceName}
                                text={composition.passage.text}
                              />
                            )}
                            {carryExpired ? (
                              <div className={s.recovery}>
                                <p>The carried passage expired.</p>
                                <button
                                  onClick={() => dispatch({ type: "RESELECT" })}
                                >
                                  Choose again
                                </button>
                              </div>
                            ) : (
                              <button
                                className={s.listeningSurface}
                                onClick={() => dispatch({ type: "RECORD" })}
                                aria-label="Add a voice instruction"
                                disabled={!state.connected}
                              >
                                <Image
                                  unoptimized
                                  src="/pro/tim_adult_idle_0.png"
                                  width={220}
                                  height={220}
                                  alt="Tim"
                                />
                                <h3>Add a little direction.</h3>
                                <span>
                                  <Mic />
                                  Tap to speak
                                </span>
                              </button>
                            )}
                          </>
                        ) : composition.phase === "listening" ? (
                          <>
                            <button
                              className={s.listeningSurface}
                              onClick={() => dispatch({ type: "FINISH_VOICE" })}
                              aria-label={
                                composition.review
                                  ? "Finish and review"
                                  : "Finish and send"
                              }
                            >
                              <Image
                                unoptimized
                                src="/pro/tim_adult_idle_0.png"
                                width={220}
                                height={220}
                                alt="Tim is listening"
                              />
                              <div className={s.waveform} aria-hidden>
                                {[12, 24, 16, 32, 20, 28, 14].map((h, i) => (
                                  <i
                                    key={i}
                                    style={{
                                      height: `${h / 4}cqw`,
                                      animationDelay: `${i * -0.13}s`,
                                    }}
                                  />
                                ))}
                              </div>
                              <h3>
                                {composition.append
                                  ? "Add another thought"
                                  : "I’m listening"}
                              </h3>
                              <span>
                                {composition.review
                                  ? "Tap to review"
                                  : "Tap to send"}
                              </span>
                            </button>
                            <button
                              className={s.textAction}
                              disabled={composition.review}
                              onClick={() => dispatch({ type: "REVIEW_FIRST" })}
                            >
                              {composition.review ? (
                                <>
                                  <Check />
                                  Review before sending
                                </>
                              ) : (
                                <>
                                  Review first
                                  <ChevronRight />
                                </>
                              )}
                            </button>
                          </>
                        ) : (
                          <>
                            <div
                              className={s.reviewContent}
                              role="region"
                              aria-label="Instruction and context"
                              tabIndex={0}
                            >
                              {composition.intent === "loop" &&
                                composition.text === sampleWords("loop") && (
                                  <div className={s.schedule}>
                                    <Repeat2 />
                                    <span>
                                      Weekdays · 09:00
                                      <small>
                                        Requested ·{" "}
                                        <span>Asia/Ho_Chi_Minh</span>
                                      </small>
                                    </span>
                                  </div>
                                )}
                              {composition.recovery && (
                                <div className={s.retainedStatus} role="status">
                                  <strong>
                                    {composition.recovery.state === "offline"
                                      ? composition.text
                                        ? "Offline copy"
                                        : "Recover your message"
                                      : composition.recovery.state ===
                                          "recovered"
                                        ? "Recovered · read only"
                                        : "Full message unavailable"}
                                  </strong>
                                  <span>
                                    {composition.recovery.delivery === "sent"
                                      ? composition.intent === "task"
                                        ? "Passed to Harness"
                                        : "Request sent"
                                      : composition.recovery.delivery ===
                                          "not-sent"
                                        ? "Not sent"
                                        : composition.recovery.delivery ===
                                            "rejected"
                                          ? "Instruction rejected"
                                          : "Delivery unconfirmed"}
                                  </span>
                                </div>
                              )}
                              <p className={s.draftText}>
                                {page?.text ||
                                  (composition.recovery
                                    ? "No words saved on device."
                                    : "Recording stopped. Your next attempt can start here.")}
                              </p>
                              {composition.passage && (
                                <CarriedSource
                                  name={composition.passage.sourceName}
                                  text={composition.passage.text}
                                  expired={carryExpired}
                                />
                              )}
                              {composition.recovery?.bookmark?.carried && (
                                <span className={s.smallContext}>
                                  Passage preview unavailable.
                                </span>
                              )}
                            </div>
                            {page && page.total > 1 && (
                              <div className={s.draftPager}>
                                <button
                                  aria-label="Earlier message part"
                                  disabled={
                                    page.part === 0 ||
                                    (!!composition.recovery &&
                                      (!state.connected ||
                                        composition.recovery.state !==
                                          "recovered"))
                                  }
                                  onClick={() =>
                                    dispatch({
                                      type: "DRAFT_PART",
                                      id: composition.id,
                                      delta: -1,
                                    })
                                  }
                                >
                                  <ChevronLeft />
                                </button>
                                <span>
                                  Part {page.part + 1} of {page.total}
                                </span>
                                <button
                                  aria-label="Next message part"
                                  disabled={
                                    page.part + 1 >= page.total ||
                                    (!!composition.recovery &&
                                      (!state.connected ||
                                        composition.recovery.state !==
                                          "recovered"))
                                  }
                                  onClick={() =>
                                    dispatch({
                                      type: "DRAFT_PART",
                                      id: composition.id,
                                      delta: 1,
                                    })
                                  }
                                >
                                  <ChevronRight />
                                </button>
                              </div>
                            )}
                            {composition.recovery ? (
                              <div className={s.retainedActions}>
                                {composition.recovery.state !== "recovered" && (
                                  <button
                                    className={s.primary}
                                    disabled={!state.connected}
                                    onClick={() =>
                                      dispatch({
                                        type: "RECOVER_DRAFT",
                                        id: composition.id,
                                      })
                                    }
                                  >
                                    Recover message
                                  </button>
                                )}
                                <button
                                  onClick={() =>
                                    dispatch({
                                      type: "CLOSE_DRAFT",
                                      id: composition.id,
                                    })
                                  }
                                >
                                  Close
                                </button>
                                <small>Close removes this copy.</small>
                              </div>
                            ) : composition.phase === "review" ? (
                              <>
                                {carryExpired ? (
                                  <div className={s.recovery}>
                                    <p>
                                      Choose the passage again. Your words are
                                      saved.
                                    </p>
                                    <button
                                      onClick={() =>
                                        dispatch({ type: "RESELECT" })
                                      }
                                    >
                                      Choose again
                                    </button>
                                    <button
                                      onClick={() =>
                                        dispatch({ type: "DROP_CARRY" })
                                      }
                                    >
                                      Use words only
                                    </button>
                                  </div>
                                ) : (
                                  <div className={s.draftTools}>
                                    <button
                                      onClick={() =>
                                        dispatch({
                                          type: composition.text
                                            ? "APPEND"
                                            : "RECORD_AGAIN",
                                        })
                                      }
                                      disabled={!state.connected}
                                    >
                                      <Mic />
                                      {composition.text
                                        ? "Add a thought"
                                        : "Try again"}
                                    </button>
                                    {composition.priorText !== undefined && (
                                      <button
                                        onClick={() =>
                                          dispatch({ type: "UNDO" })
                                        }
                                      >
                                        Undo
                                      </button>
                                    )}
                                  </div>
                                )}
                                <button
                                  className={`${s.primary} ${s.wide}`}
                                  disabled={
                                    !composition.text.trim() ||
                                    !state.connected ||
                                    carryExpired
                                  }
                                  onClick={() => dispatch({ type: "SEND" })}
                                >
                                  {composition.intent === "goal"
                                    ? "Send goal"
                                    : composition.intent === "loop"
                                      ? "Send loop"
                                      : "Send"}
                                  <ArrowUpRight />
                                </button>
                              </>
                            ) : (
                              <div className={s.deliveryState}>
                                {composition.phase === "sending" ? (
                                  <>
                                    <span className={s.workingPulse} />
                                    Sending
                                  </>
                                ) : (
                                  <>
                                    <WifiOff />
                                    <strong>Delivery unconfirmed</strong>
                                    <span>Your words are kept.</span>
                                    <button
                                      onClick={() =>
                                        dispatch({ type: "RECONCILE" })
                                      }
                                      disabled={!state.connected}
                                    >
                                      Check status
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {state.sheet === "actions" && (
                      <div className={s.actionsSheet}>
                        <div className={s.contextLine}>
                          {active.title}
                          <span>
                            {active.name} · {active.machine}
                          </span>
                        </div>
                        <div className={s.actionGrid}>
                          <button
                            onClick={() =>
                              dispatch({ type: "VOICE", intent: "goal" })
                            }
                            disabled={
                              !state.connected || !capability(active, "goal")
                            }
                          >
                            <Target />
                            <span>Set a goal</span>
                            <small>
                              {capability(active, "goal")
                                ? "Describe an outcome"
                                : "Claude or Codex"}
                            </small>
                          </button>
                          <button
                            onClick={() =>
                              dispatch({ type: "VOICE", intent: "loop" })
                            }
                            disabled={
                              !state.connected || !capability(active, "loop")
                            }
                          >
                            <Repeat2 />
                            <span>Set a loop</span>
                            <small>
                              {capability(active, "loop")
                                ? "Request a routine"
                                : "Claude only"}
                            </small>
                          </button>
                          <button
                            onClick={() => open("find")}
                            disabled={!state.connected}
                          >
                            <Search />
                            <span>Find work</span>
                          </button>
                          <button
                            onClick={() => open("new")}
                            disabled={!state.connected}
                          >
                            <Plus />
                            <span>New Harness</span>
                          </button>
                          <button onClick={() => open("attention")}>
                            <Layers />
                            <span>Updates</span>
                            <small>
                              {questions.length + results.length} waiting
                            </small>
                          </button>
                          <button onClick={() => open("settings")}>
                            <Settings2 />
                            <span>Preferences</span>
                          </button>
                        </div>
                      </div>
                    )}
                    {state.sheet === "find" && (
                      <div className={s.findSheet}>
                        <button
                          className={s.voiceSearch}
                          onClick={() =>
                            dispatch({
                              type: "QUERY",
                              text: state.query ? "" : "checkout",
                            })
                          }
                        >
                          <Mic />
                          <span>{state.query || "Say a name or a task"}</span>
                          {state.query && <X />}
                        </button>
                        <div className={s.findResults}>
                          {state.agents
                            .filter((a) =>
                              `${a.title} ${a.name} ${a.machine}`
                                .toLowerCase()
                                .includes(state.query.toLowerCase()),
                            )
                            .map((a) => (
                              <button
                                key={a.id}
                                onClick={() =>
                                  dispatch({ type: "FOCUS", id: a.id })
                                }
                                disabled={!state.connected}
                              >
                                <span>
                                  <strong>{a.title}</strong>
                                  <small>
                                    {a.name} · {a.machine}
                                  </small>
                                </span>
                                <ArrowUpRight />
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                    {state.sheet === "new" && (
                      <div className={s.newSheet}>
                        <div className={s.contextLine}>
                          {workspace.name}
                          <span>{active.machine}</span>
                        </div>
                        <h3>Explore another direction.</h3>
                        <div className={s.questionChoices}>
                          {(["claude", "codex"] as const).map((engine) => (
                            <button
                              key={engine}
                              aria-pressed={state.newEngine === engine}
                              onClick={() =>
                                dispatch({ type: "NEW_ENGINE", engine })
                              }
                            >
                              <span>
                                {engine === "claude" ? "Claude Code" : "Codex"}
                              </span>
                              {state.newEngine === engine ? (
                                <Check />
                              ) : (
                                <span className={s.radioCircle} />
                              )}
                            </button>
                          ))}
                        </div>
                        <button
                          className={`${s.primary} ${s.wide}`}
                          disabled={!state.connected}
                          onClick={() => dispatch({ type: "CREATE" })}
                        >
                          Create in app
                          <Plus />
                        </button>
                        <span className={s.smallContext}>
                          Same project. A new agent.
                        </span>
                      </div>
                    )}
                    {state.sheet === "usage" && (
                      <div className={s.usageSheet}>
                        <div className={s.contextLine}>
                          {state.usage.machine}
                          <span>
                            Local transcripts · {state.usage.currency} estimate
                          </span>
                        </div>
                        <div className={s.costHero}>
                          {state.usage.amount === null
                            ? "—"
                            : `$${state.usage.amount.toFixed(2)}`}
                          {state.usage.coverage === "partial" && <span>+</span>}
                        </div>
                        <p>
                          {state.usage.coverage === "partial"
                            ? "Some usage isn’t included."
                            : state.usage.coverage === "unavailable"
                              ? "No estimate available."
                              : "Estimated from local transcripts."}
                        </p>
                        <div className={s.costRows}>
                          {state.usage.providers.map((p) => (
                            <span key={p.name}>
                              {p.name}
                              <strong>
                                {p.amount === null
                                  ? "Not enabled"
                                  : `$${p.amount.toFixed(2)}`}
                              </strong>
                            </span>
                          ))}
                          <span>
                            Other machines<strong>Not included</strong>
                          </span>
                        </div>
                        <span className={s.smallContext}>
                          Sample estimate · Updated{" "}
                          {Math.floor((state.now - state.usage.asOf) / 60000)}{" "}
                          minutes ago
                        </span>
                      </div>
                    )}
                    {state.sheet === "delivery" && state.pending && (
                      <div className={s.composeSheet}>
                        <div className={s.contextLine}>
                          {
                            state.agents.find(
                              (a) => a.id === state.pending!.agentId,
                            )?.title
                          }
                          <span>
                            {
                              state.agents.find(
                                (a) => a.id === state.pending!.agentId,
                              )?.name
                            }
                          </span>
                        </div>
                        <p className={s.draftText}>{state.pending.text}</p>
                        <div className={s.deliveryState}>
                          <WifiOff />
                          <strong>Delivery unconfirmed</strong>
                          <span>Check the answer in Harness.</span>
                          <div className={s.deliveryActions}>
                            <button
                              onClick={() => dispatch({ type: "RECONCILE" })}
                              disabled={!state.connected}
                            >
                              Check status
                            </button>
                            {state.deliveryUncertain && (
                              <button
                                onClick={() =>
                                  dispatch({
                                    type: "CLOSE_DELIVERY",
                                    id: state.pending!.id,
                                  })
                                }
                              >
                                Close
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                    {state.sheet === "settings" && (
                      <div className={s.settingsSheet}>
                        <Image
                          unoptimized
                          src="/pro/tim_adult_idle_0.png"
                          width={160}
                          height={160}
                          alt="Tim"
                        />
                        <h3>A quiet companion.</h3>
                        <button
                          className={s.settingRow}
                          aria-pressed={state.quiet}
                          onClick={() => dispatch({ type: "QUIET" })}
                        >
                          <span>Quiet motion</span>
                          <span className={s.toggle}>
                            <i />
                          </span>
                        </button>
                        <div className={s.settingRow}>
                          <span>Voice</span>
                          <span>English</span>
                        </div>
                        <span className={s.smallContext}>
                          No always-on microphone. Tap when you need it.
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
              {state.notice && (
                <div
                  className={`${s.deviceNotice} ${state.pending || !state.connected ? s.noticePersistent : ""}`}
                  role="status"
                >
                  {state.notice}
                </div>
              )}
            </div>
          </div>
          <div className={s.deviceControls}>
            <button
              onClick={() =>
                dispatch({ type: "SWIPE", level: 1, direction: -1 })
              }
              aria-label="Previous agent"
              disabled={state.sheet !== "home" || !state.connected}
            >
              <ChevronLeft />
            </button>
            <span>
              {product
                ? "Swipe sideways to move."
                : "Swipe to move. Slide to scroll."}
            </span>
            <button
              onClick={() =>
                dispatch({ type: "SWIPE", level: 1, direction: 1 })
              }
              aria-label="Next agent"
              disabled={state.sheet !== "home" || !state.connected}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
        {presentation === "paired" && (
          <AppPreview state={state} dispatch={dispatch} />
        )}
      </div>
      {product ? (
        <div className={s.productFooter}>
          <span>Try it · Sample voice and app data</span>
          <button
            onClick={() => {
              dispatch({ type: "RESET", scenario });
            }}
            aria-label={`Reset ${previewNames[scenario]} preview`}
          >
            <RotateCcw size={13} /> Reset
          </button>
        </div>
      ) : (
        <>
          <div className={s.studyFooter}>
            <span>Give a little direction. Let the work continue.</span>
            <small>Interactive study · Sample voice and app data</small>
          </div>
          <details className={s.labControls}>
            <summary>
              <CircleHelp size={14} />
              Try the edges
            </summary>
            <div>
              <button
                onClick={() =>
                  dispatch({ type: "CONNECTION", connected: !state.connected })
                }
              >
                {state.connected ? "Interrupt app link" : "Reconnect app link"}
              </button>
              <button
                onClick={() =>
                  dispatch({
                    type: "AUTO_RECEIPT",
                    enabled: !state.autoReceipt,
                  })
                }
              >
                {state.autoReceipt
                  ? "Hold host receipts"
                  : "Resume host receipts"}
              </button>
              <button
                disabled={!state.pending}
                onClick={() => dispatch({ type: "RECONCILE" })}
              >
                Check missing receipt
              </button>
              <button onClick={() => dispatch({ type: "SOURCE_CHANGED" })}>
                Update research result
              </button>
              <button
                disabled={!questions.length}
                onClick={() => dispatch({ type: "ANSWER_ELSEWHERE" })}
              >
                Answer elsewhere
              </button>
              <button
                disabled={!state.visit}
                onClick={() => dispatch({ type: "PRUNE" })}
              >
                Prune earlier output
              </button>
              <button
                disabled={!state.visit}
                onClick={() => dispatch({ type: "CLOSE_ORIGIN" })}
              >
                Close return pane
              </button>
              <button
                disabled={!composition?.passage}
                onClick={() =>
                  dispatch({ type: "TICK", now: state.now + 300_001 })
                }
              >
                Expire carried text
              </button>
              <button
                disabled={!state.pending}
                onClick={() =>
                  dispatch({ type: "HOST_REJECT", id: state.pending!.id })
                }
              >
                Host rejects instruction
              </button>
              <button
                disabled={
                  !composition?.recovery &&
                  (!composition?.review || !composition.text.trim())
                }
                onClick={() => dispatch({ type: "RESTART_DEVICE" })}
              >
                Restart device
              </button>
              <button
                disabled={!state.archive}
                onClick={() => dispatch({ type: "ARCHIVE_LOST" })}
              >
                Forget host draft
              </button>
              <button
                disabled={!state.archive}
                onClick={() =>
                  dispatch({ type: "TICK", now: state.now + 1_800_000 })
                }
              >
                Expire host draft
              </button>
            </div>
            <p>
              A link interruption keeps one part while the device stays powered.
              The restart experiment keeps only message identity, never words or
              a passage preview. Recovery needs the same host’s retained
              archive; host restart or expiry makes it unavailable. These are
              sample states, not hardware verification. Two-finger sideways
              swipes reveal workspaces. Arrow keys navigate; Shift + arrows
              changes workspace. Hardware touch, comfort and acoustics need a
              device trial.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
