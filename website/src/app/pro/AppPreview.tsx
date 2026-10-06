'use client';
import { Check, Circle, Plus, Terminal, X } from 'lucide-react';
import { type State, type Action, type Tile } from './experience';
import s from './experience.module.css';
import type { CSSProperties, Dispatch } from 'react';
export function tileStyle(t: Tile): CSSProperties {
  return {
    left: `${t.x1 / 10}%`,
    top: `${t.y1 / 10}%`,
    width: `${(t.x2 - t.x1) / 10}%`,
    height: `${(t.y2 - t.y1) / 10}%`,
  };
}
export default function AppPreview({
  state,
  dispatch,
}: {
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const workspace = state.workspaces.find((w) => w.id === state.app.workspace)!;
  const composition = state.composition;
  const recipient = state.agents.find((a) => a.id === composition?.recipient);
  const question = state.questions.find(
    (q) => q.id === state.questionId && !q.resolved,
  );
  return (
    <div className={s.appColumn}>
      <div className={s.appCaption}>
        <span>HARNESS APP</span>
        <span>{state.connected ? 'Connected preview' : 'Connection lost'}</span>
      </div>
      <div className={s.appWindow} aria-label="Paired Harness app preview">
        <div className={s.appTitlebar}>
          <span className={s.windowDots}>
            <i />
            <i />
            <i />
          </span>
          <span>Harness</span>
          <Plus size={15} />
        </div>
        <div className={s.appTabs}>
          {state.workspaces.map((w) => (
            <button
              key={w.id}
              className={state.app.workspace === w.id ? s.activeAppTab : ''}
              onClick={() => {
                const id = w.tiles.find((t) => t.agentId)?.agentId;
                if (id) dispatch({ type: 'FOCUS', id, fromApp: true });
              }}
              aria-label={`Open ${w.name} in app`}
            >
              {w.name}
              <span>{w.tiles.length}</span>
            </button>
          ))}
        </div>
        <div className={s.appGrid} data-testid="app-workspace">
          {workspace.tiles.map((tile, index) => {
            const agent = state.agents.find((a) => a.id === tile.agentId);
            if (!agent)
              return (
                <div
                  key={`viewer-${index}`}
                  style={tileStyle(tile)}
                  className={`${s.appPane} ${s.viewerPane}`}
                >
                  <div className={s.viewerArt}>
                    <span />
                    <span />
                    <span />
                  </div>
                  <span>App preview</span>
                  <small>Viewer · no agent input</small>
                </div>
              );
            const isFocused = state.app.agentId === agent.id;
            const receipt = [...state.receipts]
              .reverse()
              .find((r) => r.agentId === agent.id);
            const pendingQuestion = state.questions.find(
              (q) => q.agentId === agent.id && !q.resolved,
            );
            return (
              <section
                key={agent.id}
                style={tileStyle(tile)}
                className={`${s.appPane} ${isFocused ? s.focusedPane : ''}`}
                data-agent-id={agent.id}
                aria-label={`${agent.title} app pane`}
              >
                <button
                  className={s.paneHeader}
                  onClick={() =>
                    dispatch({ type: 'FOCUS', id: agent.id, fromApp: true })
                  }
                  aria-label={`Focus ${agent.title} in app`}
                >
                  <span className={s.engineMark} data-engine={agent.engine}>
                    {agent.engine === 'claude'
                      ? '✳'
                      : agent.engine === 'codex'
                        ? '⌘'
                        : agent.name[0]}
                  </span>
                  <span>
                    {agent.title}
                    <small>
                      {agent.name} · {agent.machine}
                    </small>
                  </span>
                  <i data-activity={agent.activity} />
                </button>
                <div className={s.paneOutput}>
                  {receipt ? (
                    <>
                      <span className={s.terminalLabel}>YOU</span>
                      <p className={s.receivedWords}>
                        {receipt.intent !== 'task' && <b>/{receipt.intent} </b>}
                        {receipt.text}
                      </p>
                      {receipt.source && (
                        <blockquote>{receipt.source}</blockquote>
                      )}
                      <div className={s.agentReply}>
                        <Check size={12} />
                        <span>
                          {receipt.kind === 'answer'
                            ? 'Answer received.'
                            : 'Instruction received.'}
                        </span>
                      </div>
                    </>
                  ) : agent.result ? (
                    <>
                      <span className={s.terminalLabel}>RESEARCH</span>
                      {agent.result.map((text, i) => (
                        <p
                          key={text}
                          className={
                            state.readingId === agent.id &&
                            state.selection === i
                              ? s.highlightedPassage
                              : ''
                          }
                        >
                          {text}
                        </p>
                      ))}
                    </>
                  ) : pendingQuestion ? (
                    <>
                      <span className={s.terminalLabel}>YOUR DECISION</span>
                      <p>{pendingQuestion.text}</p>
                      {pendingQuestion.options.map((option, i) => (
                        <div
                          key={option}
                          className={`${s.appChoice} ${question?.id === pendingQuestion.id && state.choice === i ? s.appChoiceSelected : ''}`}
                        >
                          <span>{i + 1}</span>
                          {option}
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <span className={s.terminalLabel}>WORKING</span>
                      <p>{agent.detail}</p>
                      {isFocused ? (
                        <div
                          className={s.outputLines}
                          data-testid="app-reading-anchor"
                        >
                          <span>
                            {state.app.line}{' '}
                            <b>
                              {state.app.line < state.liveLine
                                ? 'Reading earlier output'
                                : 'Latest output'}
                            </b>
                          </span>
                          <p>Checking the current implementation.</p>
                          <p>Keeping the existing behavior intact.</p>
                          <p>Preparing the next pass.</p>
                        </div>
                      ) : (
                        <div className={s.quietOutput}>
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {composition && state.sheet === 'compose' && (
          <div className={s.appVoicePanel}>
            <span className={s.appOverlayEyebrow}>
              {composition.phase === 'listening'
                ? 'VOICE INPUT'
                : composition.intent === 'task'
                  ? 'YOUR WORDS'
                  : `${composition.intent.toUpperCase()} REQUEST`}{' '}
              <b>
                {recipient?.name} · {recipient?.machine}
              </b>
            </span>
            {composition.phase === 'ready' ? (
              <p className={s.transcribing}>
                Add direction from Pro when you’re ready.
              </p>
            ) : composition.phase === 'listening' ? (
              <p className={s.transcribing}>
                {composition.text
                  ? 'Add another thought…'
                  : 'Listening to a sample instruction…'}
              </p>
            ) : (
              <textarea
                aria-label="Edit instruction on the app"
                value={composition.text}
                disabled={composition.phase !== 'review'}
                onChange={(e) =>
                  dispatch({ type: 'EDIT_DRAFT', text: e.target.value })
                }
              />
            )}
            {composition.passage && (
              <blockquote>
                <span>
                  FROM{' '}
                  {
                    state.agents.find(
                      (a) => a.id === composition.passage!.agentId,
                    )?.name
                  }
                </span>
                {composition.passage.text}
              </blockquote>
            )}
            <small>
              {composition.phase === 'sending'
                ? 'Waiting for the host receipt'
                : composition.phase === 'uncertain'
                  ? 'Delivery is unconfirmed. The same instruction will be reconciled.'
                  : composition.phase === 'listening'
                    ? 'Sample voice · microphone is off'
                    : 'Review here. Send from Pro.'}
            </small>
          </div>
        )}
        {(state.sheet === 'find' || state.sheet === 'new') && (
          <div className={s.appFormPanel}>
            <div>
              <Terminal size={16} />
              <span>
                {state.sheet === 'find' ? 'Find Harness' : 'New Harness'}
              </span>
              <X size={13} />
            </div>
            {state.sheet === 'find' ? (
              <>
                <p>{state.query || 'Find your work…'}</p>
                <small>The same search is open on Pro.</small>
              </>
            ) : (
              <>
                <p>Explore another direction</p>
                <small>
                  {workspace.name} ·{' '}
                  {state.newEngine === 'claude' ? 'Claude Code' : 'Codex'}
                </small>
                <span className={s.appFormButton}>Create from Pro</span>
              </>
            )}
          </div>
        )}
        <div className={s.appStatusbar}>
          <span>
            <Circle size={7} fill="currentColor" />
            {state.agents.find((a) => a.id === state.app.agentId)?.machine}
          </span>
          <span>
            {state.visit
              ? `Return saved · line ${state.visit.line}`
              : `Line ${state.app.line}`}
          </span>
        </div>
      </div>
      <div className={s.monitorStand} />
      <div className={s.continuityCaption} aria-live="polite">
        <span className={s.connectionLine} />
        <p>
          {state.pending
            ? 'One instruction. One recipient. Waiting for its receipt.'
            : state.visit
              ? 'Your previous reading position is held. Return when you’re ready.'
              : state.carry
                ? 'The selected passage stays with you while you choose its next destination.'
                : state.sheet === 'question' || state.sheet === 'attention'
                  ? 'Handle the interruption here. Your desktop stays where it was.'
                  : state.sheet === 'map'
                    ? 'The arrangement in your hand is the arrangement on your monitor.'
                    : state.sheet === 'result'
                      ? 'Read here. Open there. Keep your place.'
                      : 'A small movement here. The right work, there.'}
        </p>
      </div>
      <div className={s.appReceipt} aria-live="polite">
        <Check size={13} />
        {state.commandLog.at(-1) ||
          'Workspace and reading position are in sync'}
      </div>
    </div>
  );
}
