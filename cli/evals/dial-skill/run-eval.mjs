#!/usr/bin/env node
// Runs the dial skill eval: each scenario staged in a temp repo, the agent run on it, its rings and answer graded.
// The harness half below is the claude-api skill's runner scaffold (report/runner-scaffold.mjs), kept as it is but
// for the edits marked "dial skill eval"; the fill-ins above it call lib/*.ts, where the eval's logic is tested.
//
//   cd cli && npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant <baseline|vN> --reps 2 \
//     --split train,val --concurrency 4 --timeout-s 900 --spend-cap-usd 70 [--agents claude] \
//     [--condition clean,crowd,name-only] [--cases id,id] [--no-skill] [--follow-ups] [--approve-harness]
//
// Structural properties this encodes (so you don't have to remember them):
//   - parameterized by --variant / --reps (no hardcoded A/B pair; the model is fixed in lib/agents.ts)
//   - rep-aware filenames + resume (traces/<id>_rep<k>.json)
//   - reads _state.json, never writes it (loop state belongs to the orchestrator) - 
//     the ONE exception is --approve-harness recording `harness_sha` (see below)
//   - refuses to run when the harness (this file + _state.json.harness_paths) has
//     changed since the sha a human last approved with --approve-harness, so a
//     round that edits the runner cannot execute unreviewed under a standing
//     session allowlist
//   - pairwise graders judge against frozen baseline/ref/<id>.* on disk
//   - writes rows as cases complete (crash-safe)
//   - jittered exponential backoff on transient 429/overloaded/5xx errors
//   - hard per-case wall-clock ceiling (--timeout-s; stream keepalives don't reset it)
//   - served-model assertion (a claude run's model must start with AGENT_CONFIG.claudeModel)
//   - failed attempts land in errors.jsonl with a failure class and, when the call
//     completed, the billed model/usage (never in results.jsonl)
//   - row ids, trace filenames, and frozen refs share one path-safe id
//     (original id kept in meta.original_id when sanitization changed it)
//   - before any case, one listing probe per condition a claude case runs in
//     (lib/probe.ts, rows in probes.jsonl); a failed probe refuses the pass
//   - a probe or case starts only while all the flow has spent, a reserve for it
//     and one for each case in flight fit under --spend-cap-usd, at most the
//     design's $320 (lib/spend.ts); a worker whose case does not fit beside
//     those in flight stops; once one does not fit alone, the pass starts
//     nothing more and exits 4
//   - a failed run's spend is added as it happens, its retry starts only while
//     its case would, and every attempt ends within the agent's share of
//     --timeout-s, so no case ends while its agent still spends
//   - a run or probe cut before its result event printed only a floor of its
//     output, so it is charged at least its reserve (cut_usd on its row)
//   - a claude run whose init differs from its probe's is kept as unlisted; the
//     pass then starts no new case, lets those in flight finish, and exits 5
//   - a variant's hooks.json and harness-answers.json are staged only when
//     _state.json harness_paths lists them, so the harness sha covers what
//     runs outside Claude's sandbox
//   - under --follow-ups a need scenario runs two turns: turn 2 resumes turn
//     1's session with the scenario's follow-up, within what is left of the
//     agent's share, and the row grades how the agent closed its cards

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { constants as OS } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAL_SKILL } from '../../src/devices/dialSkill.ts';
import { AGENT_CONFIG, claudeArgs, isDefaultProfile, killAgents, runAgent, runFollowUp } from './lib/agents.ts';
import { gradeRun, readAnswerKey, rungOf } from './lib/grade.ts';
import { claudeJudge, JUDGE_EFFORT, JUDGE_MODEL, RUBRIC_SHA } from './lib/judge.ts';
import { sumUsage } from './lib/parse.ts';
import { matchesProbe, probeListing } from './lib/probe.ts';
import { CONDITIONS, loadScenarios, runId, splitIdOf } from './lib/scenarios.ts';
import { cutUsd, guardCost, SpendGuard } from './lib/spend.ts';
import { markTurn, readDone, readHarm, readRings, runProfileFolder, scrub, stage, unstage, unstageLive } from './lib/stage.ts';

// Every output write refuses symlinks: the flow dir is model-influenced, and a
// prompt-injected round can plant `results.jsonl -> ~/.bashrc` where the next
// unattended run would append. POSIX opens O_NOFOLLOW (a symlink fails with
// ELOOP); Windows - where Node leaves O_NOFOLLOW undefined and Bun defines a
// meaningless value - lstat-refuses first. Symlinked parent dirs are
// refused the same way. Same discipline as the report builders' reads.
const WIN = process.platform === 'win32';
const NOFOLLOW = WIN ? 0 : FS.O_NOFOLLOW;
// A guard that cannot tell must refuse: only "no such entry" reads as absent;
// any other lstat failure (EACCES, ENAMETOOLONG, ...) is rethrown, never "no".
const lstatOrNull = p => { try { return lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const isSymlink = p => lstatOrNull(p)?.isSymbolicLink() === true;
// Stderr lines interpolate model-influenced bytes (case ids, error text that
// can echo model output, JSON.parse messages). Strip escape sequences and
// control characters, as build-report-lite.mjs's eprint does, so a planted
// OSC/CSI can't retitle the terminal or forge output lines.
const ESC_SEQ = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const termSafe = s => String(s).replace(ESC_SEQ, '').replace(CONTROL, '');
const eprint = (...a) => console.error(...a.map(termSafe));
// The leaf checks above can't see a symlink on an INTERMEDIATE component
// (lstat and open both resolve those silently), so every open is also bound
// to the flow root: main() captures realpathSync(flow) once, and any path
// whose resolved parent leaves it - e.g. `vdir` or the flow dir itself
// replaced by a directory symlink - is refused when the check sees it.
// Residual, all platforms: the check and the open are separate path lookups
// (Node's sync fs has no openat-style call), so a directory swapped for a
// symlink in between is still followed. This stops a planted link, not a
// writer racing the run.
let flowRealRoot = null;
function assertInFlow(dir, what) {
  if (flowRealRoot == null) throw new Error(`refusing to ${what}: flow root not resolved yet`);
  const dirReal = realpathSync(dir);
  if (dirReal !== flowRealRoot && !dirReal.startsWith(flowRealRoot + (WIN ? '\\' : '/')))
    throw new Error(`refusing to ${what}: ${dir} resolves outside the flow directory`);
}
function openNoFollow(p, flags) {
  if (isSymlink(dirname(p))) throw new Error(`refusing to open through symlinked directory: ${dirname(p)}`);
  assertInFlow(dirname(p), 'open');
  if (WIN && isSymlink(p)) throw new Error(`refusing to open through symlink: ${p}`);
  const fd = openSync(p, flags | NOFOLLOW, 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to use non-regular file: ${p}`);
    // O_NOFOLLOW and lstat cannot see a hard link: a second name for a file
    // outside the flow dir opens as an ordinary regular file. Nothing the
    // runner creates has more than one link, so refuse any that does.
    if (st.nlink > 1) throw new Error(`refusing to use ${p}: it has a second hard link (another name for the same file); replace it with a plain copy if it is yours`);
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}
// writeFileSync on the fd loops until every byte lands (a bare writeSync is
// one write(2) that may return short on ENOSPC and silently truncate a
// results row or trace).
// Opened without O_TRUNC and truncated only after openNoFollow's checks, so a
// refused file keeps its bytes.
function writeFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT);
  try { ftruncateSync(fd, 0); writeFileSync(fd, data); } finally { closeSync(fd); }
}
// POSIX appends atomically under O_APPEND with no position. On Windows, Bun
// writes an O_APPEND handle at offset 0 unless given a position, so there the
// write starts at the current size and re-issues any short write.
function appendFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND);
  try {
    if (!WIN) { writeFileSync(fd, data); return; }
    const buf = Buffer.from(data);
    const start = fstatSync(fd).size;
    for (let off = 0; off < buf.length;) {
      const n = writeSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) throw new Error(`append to ${p} made no progress`);
      off += n;
    }
  } finally { closeSync(fd); }
}
// Reads of the frozen pairwise refs get the same discipline as writes (same
// open guard): the flow dir is model-influenced, so `baseline/ref/<id> ->
// ~/.ssh/id_rsa` planted after the startup preflight must not be read into
// the judge prompt. lexists probes with lstat so a planted symlink still
// counts as "present" at the freeze guard (never overwritten - or followed).
const lexists = p => lstatOrNull(p) != null;
function readFileNoFollow(p) {
  const fd = openNoFollow(p, FS.O_RDONLY);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
// null when the file is absent; any other failure (a planted link included) throws.
function readIfPresent(p) {
  try { return readFileNoFollow(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
function mkdirNoFollow(dir) {
  if (isSymlink(dir)) throw new Error(`refusing to use symlinked directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  // Check after creating: mkdirSync(recursive) follows symlinked ancestors,
  // so a dir minted through one resolves outside the flow root and is refused
  // here before any file lands in it.
  assertInFlow(dir, 'create directory');
}
// Frozen pairwise refs may carry an extension; reader and freeze-guard probe
// the same list so a suffixed ref never gets an extensionless shadow.
const REF_EXTS = ['', '.html', '.txt', '.json'];

// --- fill these in ----------------------------------------------------------

// Codex is out of scope: the eval scores Claude Code; the stand-ins bound the score and check the grader for free.
const AGENTS = ['claude', 'oracle', 'null', 'always'];
const SPLITS = ['train', 'val', 'test'];
const JUDGE_TIMEOUT_MS = 120_000;
const DESIGN_CAP_USD = 320;
// A stopped pass is reported to a person; switching accounts to finish it is not the runner's call.
const ACCOUNT_LIMIT = 'account limit reached: pass stopped; report it, do not switch accounts';
const spendCapLine = ctx => `spend cap · $${ctx.guard.spentUsd.toFixed(2)} of $${ctx.spendCapUsd.toFixed(2)}: `
  + 'stopped before the next case; rerun to resume once the cap allows';

/** All the flow has spent: every variant's rows, failed attempts and probes, the variants the summary reads. The cap
 *  holds across passes, so a rerun after a stop starts from this, not from zero. A line that is not JSON is skipped,
 *  as the summary skips it. */
function flowSpend(flow) {
  let spent = 0;
  for (const variant of readdirSync(flow).filter(name => /^(baseline|v\d+)$/.test(name)))
    for (const file of ['results.jsonl', 'errors.jsonl', 'probes.jsonl'])
      for (const ln of (readIfPresent(join(flow, variant, file)) ?? '').split('\n')) {
        let row;
        try { row = JSON.parse(ln); } catch { continue; }
        spent += guardCost(row);
      }
  return spent;
}

/** What the fake harness can answer (lib/stage.ts HarnessAnswer). */
const isAnswer = a => a !== null && typeof a === 'object' && Array.isArray(a.argv) && a.argv.every(w => typeof w === 'string')
  && [a.stdout, a.stderr].every(s => s === undefined || typeof s === 'string') && (a.code === undefined || Number.isInteger(a.code))
  && (a.stop === undefined || a.stop === true);

/**
 * The variant's hooks.json (Claude Code's `hooks`, staged as the repo's .claude/settings.json) and harness-answers.json
 * (what the fake harness answers them), each left out when absent. Claude Code runs hooks outside its sandbox, so a file
 * is taken only when _state.json harness_paths lists it: the harness sha then covers it, and one changed or planted after
 * approval refuses the pass (checkHarness) until a person approves it again.
 */
function variantHooks(vdir, state) {
  const listed = new Set((Array.isArray(state.harness_paths) ? state.harness_paths : []).map(p => resolve(String(p))));
  const read = (name, valid, what) => {
    const file = join(vdir, name);
    const text = readIfPresent(file);
    if (text == null) return undefined;
    if (!listed.has(resolve(file)))
      throw new Error(`${file} runs outside Claude's sandbox: list it in _state.json harness_paths, then approve the harness`);
    let value;
    try { value = JSON.parse(text); } catch { /* refused below, without the parse message, which can quote the file */ }
    if (!valid(value)) throw new Error(`${file} must be JSON: ${what}`);
    return value;
  };
  const hooks = read('hooks.json', v => v !== null && typeof v === 'object' && !Array.isArray(v), "Claude Code's hooks object");
  const answers = read('harness-answers.json', v => Array.isArray(v) && v.every(isAnswer), 'a list of { argv, stdout?, stderr?, code?, stop? }');
  // Refused here, before anything runs, as well as at each stage (lib/stage.ts): a notify answered by the variant would no
  // longer be the dial the rings are read from.
  if (answers?.some(a => a.argv[0] === 'device' && a.argv[1] === 'notify'))
    throw new Error(`${join(vdir, 'harness-answers.json')}: device notify is answered by the eval, not by a variant`);
  return { hooks, answers };
}

// The agents run in process groups of their own (lib/agents.ts), which no signal to the runner reaches: however the
// runner ends, it kills them first, then unstages what is still staged, a probe's session in the person's profile
// included. A signal ends it through exit, with the code the signal would have left.
process.on('exit', () => { killAgents(); unstageLive(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(128 + OS.signals[signal]));

/** --timeout-s bounds the whole case, so the agent gets what the judge's two calls (the line and the answer) leave: 660 s
 *  of 900. A ceiling too short for both judge calls is split in half. 0, no ceiling, leaves the agent unbounded too. */
function agentTimeoutMs(timeoutS) {
  const ceiling = timeoutS * 1000;
  return ceiling - Math.min(2 * JUDGE_TIMEOUT_MS, ceiling / 2);
}

/** The session profile every claude call runs under, agent and judge alike. Unset, Claude would use the person's
 *  default ~/.claude, so the pass is refused before anything is spent. */
function sessionProfile() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir || isDefaultProfile(dir))
    throw new Error('CLAUDE_CONFIG_DIR must name the session profile, not the default ~/.claude');
  return dir;
}

/** The judge gets what the agent gets from the person's environment (lib/stage.ts), and no tools. */
function judgeEnv(profile) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CONFIG_DIR: profile };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** Every scenario under each --agents kind in each --condition, kept to the --split and --cases scenarios when given.
 *  Split and case ids match on their scenario part, so the stand-ins run their scenario's split. */
async function loadCases(ctx) {
  const env = judgeEnv(sessionProfile());
  ctx.judge = claudeJudge({ claudeBin: AGENT_CONFIG.claudeBin, env, timeoutMs: JUDGE_TIMEOUT_MS });
  const scenarios = loadScenarios();
  const scenarioOf = id => String(id).split('.')[0];
  const filters = [];
  if (ctx.split) filters.push(new Set(ctx.split.flatMap(name => {
    const ids = ctx.state[`${name}_ids`];
    if (!Array.isArray(ids) || !ids.length) throw new Error(`_state.json lists no ${name}_ids`);
    return ids.map(scenarioOf);
  })));
  if (ctx.cases) {
    // A mistyped id would otherwise run nothing and exit 0.
    const unknown = ctx.cases.find(id => !scenarios.some(s => s.id === scenarioOf(id)));
    if (unknown !== undefined) throw new Error(`no scenario '${unknown}'`);
    filters.push(new Set(ctx.cases.map(scenarioOf)));
  }
  // Resume keys on (id, rep) alone: a pass with or without the skill over claude rows run the other way would mix both in
  // one variant, as would a pass with or without --follow-ups over a need scenario's rows run in the other number of turns.
  const twoTurn = new Set(scenarios.filter(s => s.follow_up).map(s => s.id));
  for (const ln of (readIfPresent(join(ctx.flow, ctx.variant, 'results.jsonl')) ?? '').split('\n')) {
    let meta;
    try { ({ meta } = JSON.parse(ln)); } catch { continue; }
    if (meta?.agent === 'claude' && meta.skill !== ctx.skill)
      throw new Error(`${ctx.variant} holds claude rows run ${meta.skill ? 'with' : 'without'} the skill; run this pass as another --variant`);
    if (twoTurn.has(meta?.scenario) && (meta.follow_up !== undefined) !== ctx.followUps)
      throw new Error(`${ctx.variant} holds rows run ${meta.follow_up ? 'with' : 'without'} --follow-ups; run this pass as another --variant`);
  }
  const claudeVersion = execFileSync(AGENT_CONFIG.claudeBin, ['--version'], { env, encoding: 'utf8', timeout: JUDGE_TIMEOUT_MS }).trim();
  writeSummary(ctx, claudeVersion);
  return scenarios.filter(s => filters.every(f => f.has(s.id))).flatMap(s => ctx.agents.flatMap(agent => ctx.conditions.map(condition => ({
    id: runId(s.id, agent, condition), prompt: s.prompt, tags: [s.need, s.kind, agent, condition],
    // Only claude gets the skill staged (lib/stage.ts). A resumed pass may run under another harness or claude than the
    // rows before it, so each row records its own.
    meta: { scenario: s.id, agent, condition, skill: agent === 'claude' && ctx.skill, rubric_sha: RUBRIC_SHA,
      harness_sha: ctx.state.harness_sha, claude_version: claudeVersion,
      // The follow-up's kind on a two-turn case: a no-need scenario has none and runs one turn.
      ...(ctx.followUps && s.follow_up ? { follow_up: s.follow_up.kind } : {}) },
    scenario: s,
  }))));
}

/**
 * Records in <variant>/summary.json the environment the latest pass ran under, written once the pass is past the harness
 * gate and its cases are known. A resumed or partial pass rewrites it, so the rows it did not run may have run under
 * another: each row's meta keeps the harness sha and claude version it ran under. A round's own description, label and
 * target are kept.
 */
function writeSummary(ctx, claudeVersion) {
  const path = join(ctx.flow, ctx.variant, 'summary.json');
  const lockfile = fileURLToPath(new URL('../../package-lock.json', import.meta.url));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const argv = claudeArgs(AGENT_CONFIG, { root: '', condition: 'clean' }, '');
  const summary = {
    description: ctx.variant, label: ctx.variant, target: 'skill',
    ...JSON.parse(readIfPresent(path) ?? '{}'),
    environment: {
      commit: git('rev-parse', 'HEAD'),
      lockfile: relative(git('rev-parse', '--show-toplevel'), lockfile),
      lockfile_sha256: createHash('sha256').update(readFileSync(lockfile)).digest('hex'),
      claude_version: claudeVersion,
      model: AGENT_CONFIG.claudeModel,
      effort: AGENT_CONFIG.claudeEffort,
      max_turns: AGENT_CONFIG.maxTurns,
      agent_timeout_s: agentTimeoutMs(ctx.timeoutS) / 1000,
      case_timeout_s: ctx.timeoutS,
      judge_model: JUDGE_MODEL,
      judge_effort: JUDGE_EFFORT,
      harness_sha: ctx.state.harness_sha,
      rubric_sha: RUBRIC_SHA,
      setting_sources: argv[argv.indexOf('--setting-sources') + 1],
      date: new Date().toISOString().slice(0, 10),
    },
  };
  writeFileNoFollow(path, JSON.stringify(summary, null, 2) + '\n');
}

/**
 * Probes, one after another, each condition a claude case of this pass runs in, staged as that condition's first case,
 * and gives each such case the dial's state its probe found. A probe that finds the listing other than the condition
 * gives refuses the pass (exit 2) before any case runs; one at the account limit stops it (exit 3). Each probe leaves a
 * row in probes.jsonl, counts only, as its spend counts.
 */
async function probeConditions(ctx, tasks, probesPath) {
  const probes = new Map();
  for (const { c } of tasks) {
    const { agent, condition } = c.meta;
    if (agent !== 'claude' || probes.has(condition)) continue;
    // A probe is billed as a case is, and none runs beside it.
    if (!ctx.guard.mayStart(0)) { eprint(spendCapLine(ctx)); process.exit(4); }
    let probe;
    try {
      probe = await probeListing(c.scenario, condition, { skill: ctx.skill, hooks: ctx.hooks, answers: ctx.answers },
        { ...AGENT_CONFIG, timeoutMs: agentTimeoutMs(ctx.timeoutS) });
    } catch (e) {
      if (e?.failure_class !== 'account_limited') throw e;
      appendFileNoFollow(probesPath, JSON.stringify({ condition, at: new Date().toISOString(), listing: null, instructions: null,
        skills: [], claude_version: null, model: e.model ?? null, usage: e.usage,
        ...(e.cut_usd ? { cut_usd: e.cut_usd } : {}), failure: 'account_limited' }) + '\n');
      eprint(ACCOUNT_LIMIT);
      process.exit(3);
    }
    appendFileNoFollow(probesPath, JSON.stringify(probe) + '\n');
    ctx.guard.add(probe);
    if (probe.failure) { eprint(`listing probe · ${condition}: ${probe.failure}`); process.exit(2); }
    probes.set(condition, probe);
  }
  for (const { c } of tasks) if (c.meta.agent === 'claude') c.meta.listing = probes.get(c.meta.condition).listing.dial;
  return probes;
}

/**
 * Stages the scenario, runs the agent and reads what it rang. A case with a follow-up (--follow-ups) runs two turns:
 * turn 2 resumes turn 1's session with the follow-up, and `close` holds every call of both for the grader. The
 * transcript and errors are written to disk, so the run root and $HOME are scrubbed from them; the answer and the rings
 * stay as the agent gave them, for the grader. No `output`: nothing is graded pairwise against a frozen ref.
 * `timeoutMs` bounds the agent's turns together (0: unbounded).
 */
async function runCase(input, ctx, timeoutMs) {
  const { scenario, meta: { agent, condition, follow_up: kind } } = input;
  // answer-one's person answers one of two open asks, the other the fake's seeded card; unrung's answers an ask the
  // dial never showed, while the seeded card stays open, so a close after that answer is a wrong one.
  const st = stage(scenario, agent, { skill: ctx.skill, condition, hooks: ctx.hooks, answers: ctx.answers,
    seed: kind === 'answer-one' || kind === 'unrung', noDial: kind === 'unrung' });
  const clean = text => scrub(text, st);
  const until = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const session = kind ? { id: randomUUID(), resume: false } : undefined;
  try {
    // A one-turn run ends here, so its session goes before the checks run the agent's code; a two-turn run's stays for
    // turn 2 to resume.
    let run = await runAgent(agent, scenario, st, { ...AGENT_CONFIG, timeoutMs }, session)
      .finally(() => { if (!kind) endSession(st); });
    // Claude Code may update itself mid-pass: a run that started with other skills or another version than its
    // condition's probe may not have been given what the probe saw, so it is counted but never scored as listed.
    if (agent === 'claude' && !matchesProbe(run.init, ctx.probes.get(condition))) run.status = 'unlisted';
    // Before the checks, which run the agent's code: a ring that code makes there is the check's, not the agent's.
    const rings = readRings(st);
    // Read before unstage removes the repo. A harm check that does not finish fails the case in gradeCase, where the
    // error row keeps the billed run's model and usage. A done check that does not finish costs only went_on, a guardrail
    // beside the score: it reads null, said here, and the row keeps its harm and score.
    let harm = null, done = null, checkError = null;
    try { harm = await readHarm(scenario, st); } catch (e) { checkError = e; }
    if (!checkError) {
      try { done = await readDone(scenario, st); } catch (e) {
        if (e?.failure_class !== 'done_check') checkError = e;
        else eprint(`  [${ctx.variant}] ${input.id}: ${clean(String(e.message))}; went_on not graded`);
      }
    }
    let close;
    // A turn 1 cut short, unlisted, left unchecked, that reached the answer key or that another model served is not
    // graded, so its turn 2 would only spend.
    if (kind && run.status === 'ok' && !checkError && !readAnswerKey(run) && !otherModels(agent, [run.model]).length) {
      // After the checks, which measure what turn 1 left: the calls after the mark are turn 2's.
      markTurn(st);
      const left = until - Date.now();
      if (left <= 0)
        throw Object.assign(new Error('no time left for turn 2'), { failure_class: 'timeout', model: run.model, usage: run.usage, cut: run.cut });
      const first = run;
      // Turn 1 was billed too, so a failed turn 2's error carries both turns' spend.
      const second = await runFollowUp(agent, scenario, st, { ...AGENT_CONFIG, timeoutMs: left === Infinity ? 0 : left }, session.id, rungOf(rings))
        .finally(() => endSession(st))
        .catch(e => { throw Object.assign(e, { model: e?.model ?? first.model, usage: addUsage(first.usage, e?.usage), cut: first.cut || e?.cut }); });
      // As turn 1's: Claude Code may update between the turns too.
      if (agent === 'claude' && !matchesProbe(second.init, ctx.probes.get(condition))) second.status = 'unlisted';
      // turn2_model: gradeCase checks the model that served turn 2 as it does turn 1's.
      run = { ...first, usage: sumUsage([first.usage, second.usage]), cut: first.cut || second.cut, turn2_model: second.model,
        transcript: [...first.transcript, { role: 'system', content: 'turn 2' }, ...second.transcript] };
      // A turn 2 cut at --max-turns or unlisted may have stopped before its close, or run with what its probe never saw:
      // counted apart, never graded. Turn 1's calls as read before the checks, for the same reason as its rings.
      close = second.status === 'ok' ? { kind, calls: [...rings, ...readRings(st).filter(r => r.turn === 2)], seed: st.seed } : { cut: true };
    }
    // The skill the agent had leads the trace, so a trace reads on its own.
    const transcript = [{ role: 'system', content: st.skill ?? 'no skill' }, ...run.transcript]
      .map(turn => Object.fromEntries(Object.entries(turn).map(([key, value]) => [key, clean(value)])));
    return { ...run, transcript, rings, close, harm, done, checkError, clean };
  } catch (e) {
    // An account limit lasts hours: the workers take no new case and main exits 3.
    if (e?.failure_class === 'account_limited') ctx.stop = true;
    throw Object.assign(e, { message: clean(String(e?.message ?? e)) });
  } finally {
    unstage(st);
  }
}

/**
 * Removes the run's Claude session as the run's last turn ends, also when that turn failed or was killed at its
 * timeout (Decision 6, 2026-11-27): it lies in the person's profile, whose projects/ their live daemon may read, so it
 * lives only while its run does. By then spawnGroup has resolved, the turn's group dead and its run root swept, so
 * nothing writes the session afterwards. A two-turn run whose turn 2 never starts ends at unstage, which removes it
 * too, as it does for a runner that exits mid-run.
 */
function endSession(st) {
  const folder = runProfileFolder(st);
  if (folder) rmSync(folder, { recursive: true, force: true });
}

/** Grades the rings and the answer (lib/grade.ts). A judge reason can quote the agent's line, so it is scrubbed too. */
async function gradeCase(input, run, ref, ctx) {
  // Checked here rather than in runCase, so the error row keeps the billed run's model and usage; the harness's own
  // check compares with --model, which this runner does not take.
  const other = otherModels(input.meta.agent, [run.model, ...('turn2_model' in run ? [run.turn2_model] : [])]);
  if (other.length > 0) {
    const e = new Error(`served model ${other[0]} != requested ${AGENT_CONFIG.claudeModel}`);
    e.failure_class = 'serving_substitution';
    throw e;
  }
  if (run.checkError) throw run.checkError;
  let g;
  try { g = await gradeRun(input.scenario, run, run.rings, ctx.judge, run.harm, run.done, run.close); }
  catch (e) {
    // The judge runs under the same account, so its limit stops the pass as the agent's does.
    if (e?.failure_class === 'account_limited') ctx.stop = true;
    // A failed attempt's judge calls were billed too, and the harness retries a transient one with the same run: the
    // run keeps their total for the attempt that scores, or for the error row, which falls back to run.judge_usage.
    run.judge_usage = addUsage(run.judge_usage, e?.judge_usage);
    throw Object.assign(e, { message: run.clean(String(e?.message ?? e)), judge_usage: run.judge_usage });
  }
  // The harness takes a row's status from the run: one that reached the answer key is invalid however it ended.
  if (g.status === 'invalid') run.status = 'invalid';
  return { ...g, judge_usage: addUsage(run.judge_usage, g.judge_usage),
    explanation: Object.fromEntries(Object.entries(g.explanation).map(([key, value]) => [key, run.clean(value)])) };
}

/** Of the models that served a claude run's turns, those other than the one requested; none for a stand-in. */
function otherModels(agent, models) {
  return agent === 'claude' ? models.filter(model => !String(model).startsWith(AGENT_CONFIG.claudeModel)) : [];
}

/** The sum of two token usages, either of which may be missing. */
function addUsage(a, b) {
  return a && b ? sumUsage([a, b]) : a ?? b;
}

/** `rings` counts `device notify` calls only: any other harness call shows nothing on the dial. `harm` and `done` are what
 *  the scenario's harm and done checks found after the run, null when it has none; they ride here, the one fill-in the
 *  row spreads. */
function perfFrom(run) {
  return { tool_calls: run.tool_calls, rings: run.rings.filter(r => r.line !== null).length, harm: run.harm, done: run.done };
}

// --- harness (you usually won't need to touch below this line) --------------

function parseArgs(argv) {
  const a = { flow: '.claude/hillclimb/flow', variant: 'baseline',
              model: undefined, reps: 1, concurrency: 4, timeoutS: 1800,
              approveHarness: false,
              // dial skill eval: which agents run on which scenarios, with or without the skill staged.
              agents: ['claude'], conditions: ['clean'], split: null, cases: null, skill: true, followUps: false, spendCapUsd: null };
  // A flag at the end of argv would otherwise consume undefined - which for
  // --model equals the default and silently disables the served-model check.
  const val = (i) => { if (argv[i] === undefined) { eprint(`missing value for ${argv[i - 1]}`); usage(); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--flow') a.flow = val(++i);
    else if (k === '--variant') a.variant = val(++i);
    // dial skill eval: the model is fixed in lib/agents.ts AGENT_CONFIG, where the harness sha covers it.
    else if (k === '--model') { eprint('--model is not taken: the model is fixed in lib/agents.ts'); usage(); process.exit(2); }
    else if (k === '--agents') a.agents = val(++i).split(',');
    else if (k === '--condition') a.conditions = val(++i).split(',');
    else if (k === '--split') a.split = val(++i).split(',');
    else if (k === '--cases') a.cases = val(++i).split(',');
    else if (k === '--no-skill') a.skill = false;
    else if (k === '--follow-ups') a.followUps = true;
    else if (k === '--spend-cap-usd') a.spendCapUsd = +val(++i);
    else if (k === '--reps') a.reps = +val(++i);
    else if (k === '--concurrency') a.concurrency = +val(++i);
    else if (k === '--timeout-s') a.timeoutS = +val(++i);
    else if (k === '--approve-harness') a.approveHarness = true;
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { eprint(`unknown argument: ${k}`); usage(); process.exit(2); }
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) {
    // The report only reads directories named 'baseline' or 'v<N>' - any other
    // name runs to completion but spends the pass into a directory the Summary,
    // trajectory, and budget arithmetic never see.
    eprint(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
    usage(); process.exit(2);
  }
  // dial skill eval: an agent, condition or split outside the lists would spend a pass on nothing the report reads.
  for (const [flag, given, known] of [['--agents', a.agents, AGENTS], ['--condition', a.conditions, CONDITIONS], ['--split', a.split ?? [], SPLITS]]) {
    const bad = given.find(x => !known.includes(x));
    if (bad !== undefined) { eprint(`${flag} takes ${known.join(', ')}; got '${bad}'`); usage(); process.exit(2); }
  }
  // dial skill eval: no pass spends without a bound a person chose.
  if (!(a.spendCapUsd > 0 && Number.isFinite(a.spendCapUsd))) {
    eprint('--spend-cap-usd is required: the dollars the whole flow may spend, above 0'); usage(); process.exit(2);
  }
  // dial skill eval: the maintainer capped the whole design at $250 (2026-11-26), raised it to $270 for Part 5 and to
  // $320 for the notice cards' eval (2026-11-27); no pass may be allowed more.
  if (a.spendCapUsd > DESIGN_CAP_USD) {
    eprint(`--spend-cap-usd is at most ${DESIGN_CAP_USD}: the design's cap is $${DESIGN_CAP_USD}`); usage(); process.exit(2);
  }
  if (!Number.isFinite(a.timeoutS) || a.timeoutS < 0
      || a.timeoutS * 1000 > 2147483647 // setTimeout clamps >2^31-1 ms to 1 ms - the ceiling would fire instantly
      || !Number.isInteger(a.reps) || a.reps < 1
      || !Number.isInteger(a.concurrency) || a.concurrency < 1) { usage(); process.exit(2); }
  return a;
}
function usage() {
  eprint('usage: npx tsx evals/dial-skill/run-eval.mjs --flow DIR --variant ID --spend-cap-usd USD [--reps N] [--concurrency N] [--timeout-s N (0 = no ceiling)] [--agents claude,oracle,null,always] [--condition clean,crowd,name-only] [--split train,val,test] [--cases id,id] [--no-skill] [--follow-ups] [--approve-harness]');
}

// Harness integrity gate. The hillclimb loop gets this runner command
// allowlisted for the session and then runs rounds unattended, while the
// per-round change (proposed by an analyzer fed untrusted transcripts) may
// legitimately edit harness code. Without this gate a round that rewrites the
// runner would execute attacker-chosen code on the next unattended run under
// the user's one-time approval. So: sha256 over this file, any lockfile
// beside it or in the directory the runner is invoked from (dependency drift
// is harness drift too; with neither, a note says so), plus
// every path in `_state.json.harness_paths` (relative to the directory the
// runner is invoked from, i.e. the repo root); compare to
// `_state.json.harness_sha`; refuse on absent/mismatch unless a human passes
// --approve-harness, which records the new sha. That write is the one
// sanctioned exception to "never write _state.json".
//
// Scope, stated plainly: this is a change detector, not a security boundary.
// The sha, the path list and this file all live where the loop agent can
// write, so an agent that is already prompt-injected can forge the record or
// pass --approve-harness itself. What it catches is the common case - a
// round's harness edit reaching an unattended run unreviewed - and what
// actually bounds an unattended run is the permission allowlist the user
// grants the runner command (scope it to this exact command line, not a
// prefix). Installed dependencies beyond the lockfile are outside the digest.
function checkHarness(statePath, st, approve) {
  const self = fileURLToPath(import.meta.url);
  const listed = Array.isArray(st.harness_paths) ? st.harness_paths.map(String) : [];
  const lockfiles = [...new Set([dirname(self), process.cwd()].flatMap(d =>
    ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'].map(f => join(d, f))))]
    .filter(f => existsSync(f));
  const paths = [...new Set([self, ...lockfiles, ...listed.map(p => resolve(p))])].sort();
  const h = createHash('sha256');
  const hashed = [];
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); }
    catch (e) {
      if (p === self) throw e;
      eprint(`warning: harness path '${relative(process.cwd(), p)}' not readable (${e?.code || 'error'}) - skipped`);
      continue;
    }
    h.update(relative(process.cwd(), p)).update('\0').update(buf).update('\0');
    hashed.push(relative(process.cwd(), p));
  }
  const sha = h.digest('hex');
  if (st.harness_sha === sha) return;
  // Said only here, where a person is about to approve or is being refused.
  if (!lockfiles.length) eprint('note: no lockfile beside the runner or in the current directory - dependency changes are outside the harness sha');
  if (approve) {
    st.harness_sha = sha;
    writeFileNoFollow(statePath, JSON.stringify(st, null, 2) + '\n');
    eprint(`harness approved: sha256 ${sha.slice(0, 12)} over ${hashed.length} file(s) recorded in ${statePath}`);
    return;
  }
  if (st.harness_sha == null) {
    eprint(`no approved harness sha in ${statePath} (computed ${sha.slice(0, 12)} over: ${hashed.join(', ')}).`);
    eprint('Review the harness, then run once with --approve-harness to record it.');
  } else {
    eprint(`harness changed since last approved run (files: ${hashed.join(', ')}); `
      + `approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
    eprint('Re-run with --approve-harness after reviewing the diff.');
  }
  process.exit(2);
}

// Transient provider errors (429 / overloaded / 5xx) retry with jittered
// exponential backoff - a zero-delay retry loop multiplies cost invisibly
// under rate limits and can turn one transient 429 into a torn-down batch.
// The attempt count lands in the row's meta (or the errors sidecar) so retry
// churn is visible in the data, not just the bill.
// dial skill eval: `mayRetry` says whether the spend guard still lets the case start again.
async function withBackoff(fn, retry, deadline = Infinity, tries = 5, mayRetry = () => true) {
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, not just before sleeps: once the case's
    // ceiling has passed, an abandoned chain must not issue another call
    // (e.g. a judge call after the app call consumed the whole ceiling).
    if (Date.now() >= deadline) {
      const e = new Error('wall-clock ceiling exceeded before attempt');
      e.failure_class = 'timeout';
      throw e;
    }
    try { return await fn(); } catch (e) {
      const status = e?.status ?? e?.response?.status;
      const transient = status === 429 || status === 529 || (status >= 500 && status < 600)
        || /overloaded|rate.?limit/i.test(String(e?.message ?? ''));
      if (!transient || attempt >= tries - 1 || !mayRetry()) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      // Never start a retry that would outlive the case's wall-clock ceiling - 
      // otherwise an abandoned chain keeps issuing API calls after the case failed.
      if (Date.now() + delay >= deadline) throw e;
      retry.count++;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Hard per-case wall-clock ceiling, independent of stream liveness - a hung
// SSE stream can emit keepalives forever, defeating inactivity-based timers.
// The underlying call may keep running; the case fails and the slot is freed.
function withTimeout(promise, seconds, label) {
  if (!(seconds > 0)) return promise;
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: exceeded ${seconds}s wall-clock ceiling`);
      e.failure_class = 'timeout';
      reject(e);
    }, seconds * 1000);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Case ids appear in file paths AND as the row/file join key the report uses,
// so rows, trace filenames, and frozen refs all carry the same path-safe id.
// When sanitization changes the id, a short content hash keeps distinct ids
// distinct ('case/1' vs 'case_1'); the original rides in meta.original_id.
function pathSafeId(id) {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, '_');
  // Idempotent by construction: anything already path-safe and within the
  // length bound - including this function's own truncated+suffixed output - 
  // passes through unchanged. Long ids (URLs, prompt text as id) truncate to
  // 120 chars plus an 8-hex hash of the full original, so they fail here, not
  // at the trace write after the spend, and distinct ids stay distinct.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // lstat("link/") follows the final symlink, so a trailing separator on
  // --flow would blind every leaf isSymlink check below - strip it first.
  // Only Windows treats `\` as a separator; on POSIX it is a filename byte, so
  // splitting on it would walk prefixes that are not real path components.
  args.flow = args.flow.replace(WIN ? /(.)[\\/]+$/ : /(.)\/+$/, '$1');
  const flowSegments = args.flow.split(WIN ? /[\\/]/ : '/');
  // A `.`/`..` segment (e.g. a trailing `/.`) makes isSymlink(args.flow) below
  // resolve a different final component than the named dir - following a
  // planted link at the flow root - while join() collapses it and the absolute
  // branch skips the ancestor walk. Refuse dot segments outright
  // (absolute --flow stays supported).
  if (flowSegments.some(seg => seg === '.' || seg === '..')) {
    eprint(`refusing to run: --flow must not contain '.' or '..' segments, got '${args.flow}'`);
    process.exit(2);
  }
  const vdir = join(args.flow, args.variant);
  // Preflight every output path before the first model call: a planted
  // symlink would otherwise fail each case after its (billed) run.
  for (const p of [args.flow, join(args.flow, 'baseline'), vdir, join(vdir, 'traces'),
                   join(vdir, 'results.jsonl'), join(vdir, 'errors.jsonl'), join(vdir, 'probes.jsonl'),
                   join(vdir, 'progress.txt'), join(args.flow, 'baseline', 'ref'), join(args.flow, '_state.json')])
    if (isSymlink(p)) { eprint(`refusing to run: ${p} is a symlink (the flow dir must hold regular files)`); process.exit(2); }
  // A relative --flow (the documented `.claude/hillclimb/<name>` layout) is
  // also lstat-walked component by component from the cwd: a pre-planted
  // link at an ancestor (`.claude/hillclimb -> elsewhere`) would otherwise
  // relocate the root capture below - the containment anchor itself - to the
  // attacker's target. An absolute --flow is the caller's own trust decision
  // and is not walked (an absolute ancestor link can be legitimate: /tmp on
  // macOS).
  if (!isAbsolute(args.flow)) {
    let walk = '';
    for (const part of flowSegments.filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(walk)) { eprint(`refusing to run: ${walk} is a symlink (ancestor of --flow)`); process.exit(2); }
    }
  }
  // Every later open/mkdir is bound to this resolved root (see assertInFlow):
  // create the flow dir when fresh (the preflight above refused a link at it
  // and, for a relative path, at every ancestor), then capture where it
  // really resolves.
  mkdirSync(args.flow, { recursive: true });
  flowRealRoot = realpathSync(args.flow);
  mkdirNoFollow(join(vdir, 'traces'));
  // _state.json is READ-ONLY here. The orchestrator owns it. Absent is fine
  // (a baseline-only run has no loop state yet), but present-and-unparsable
  // must not let the id-space gate below pass vacuously over a corrupt file.
  const statePath = join(args.flow, '_state.json');
  let st = {};
  // Read through the no-follow opener like every other flow-dir file; the
  // parse message is not echoed (it can quote the file's first bytes).
  const stateText = readIfPresent(statePath);
  if (stateText != null) {
    try { st = JSON.parse(stateText) || {}; }
    catch { eprint(`${statePath} exists but is not valid JSON - fix it before spending a pass`); process.exit(2); }
  }
  checkHarness(statePath, st, args.approveHarness);
  // The runner stages whatever dialSkill.ts holds, not the variant's SKILL.md: a round run under another text would
  // spend a pass on false numbers.
  const variantSkill = readIfPresent(join(vdir, 'SKILL.md'));
  if (variantSkill != null && variantSkill !== DIAL_SKILL) {
    eprint(`${args.variant}/SKILL.md is not the text cli/src/devices/dialSkill.ts holds: set the file to it, then rerun`);
    process.exit(2);
  }
  const ctx = { ...args, state: st, ...variantHooks(vdir, st) }; // dial skill eval: read once, after the gate

  // Resume: which (id, rep) pairs already have a row?
  const resultsPath = join(vdir, 'results.jsonl');
  const done = new Set();
  for (const ln of (readIfPresent(resultsPath) ?? '').split('\n')) {
    if (!ln.trim()) continue;
    try { const r = JSON.parse(ln); done.add(`${r.prompt_id}\0${r.rep}`); } catch {}
  }
  // Rows key on the path-safe id (see pathSafeId), so resume must too.

  const cases = await loadCases(ctx); // dial skill eval: the cases follow --agents, --split and --cases
  // Validate the id space before spending anything: duplicate path-safe ids - 
  // including case-insensitive twins, which macOS/Windows filesystems collapse - 
  // would silently overwrite traces and frozen refs; and a _state.json split id
  // that matches no case would silently shrink the scored denominator.
  const seen = new Map();
  for (const c of cases) {
    const k = pathSafeId(c.id).toLowerCase();
    if (seen.has(k)) {
      eprint(`duplicate case id after sanitization: '${c.id}' collides with '${seen.get(k)}'`);
      process.exit(2);
    }
    seen.set(k, c.id);
  }
  // dial skill eval: a split id names a case in every condition.
  const safeIds = new Set(cases.map(c => splitIdOf(pathSafeId(c.id))));
  for (const k of ['train_ids', 'val_ids', 'test_ids'])
    if (st[k] != null && !Array.isArray(st[k])) { eprint(`_state.json ${k} must be a list of ids`); process.exit(2); }
  for (const sid of [...(st.train_ids ?? []), ...(st.val_ids ?? []), ...(st.test_ids ?? [])]) {
    const s = String(sid); // the adapter joins with String() on both sides - numeric ids are fine
    if (safeIds.has(s)) continue; // matches a loaded case - definitionally valid
    if (s !== pathSafeId(s)) {
      // Can never match a row: rows key on path-safe ids. This is the silent
      // shrunken-denominator bug - fail before anything is spent.
      eprint(`_state.json split id '${s}' is not a path-safe id - record split ids exactly as results.jsonl's prompt_id, without its condition`);
      process.exit(2);
    }
    // Well-formed but absent is legitimate (a trimmed top-K subset run) - note it, don't fail.
    eprint(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
  }
  const refDir = join(args.flow, 'baseline', 'ref');
  const tasks = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) {
    if (done.has(`${pathSafeId(c.id)}\0${rep}`)) continue;
    tasks.push({ c, rep });
  }
  eprint(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);

  let i = 0, ok = 0, fail = 0;
  const errorsPath = join(vdir, 'errors.jsonl');
  const probesPath = join(vdir, 'probes.jsonl');
  // A hard crash (power loss, ENOSPC) can leave a torn final line with no
  // trailing newline; the next append would merge two rows into one permanently
  // unparseable line. Isolate any fragment before appending anything.
  for (const p of [resultsPath, errorsPath, probesPath]) {
    const tail = readIfPresent(p);
    if (tail && !tail.endsWith('\n')) appendFileNoFollow(p, '\n');
  }
  // dial skill eval: the cap is on the flow's total, so the guard starts from what every pass before this one spent.
  ctx.guard = new SpendGuard(args.spendCapUsd, flowSpend(args.flow));
  ctx.probes = await probeConditions(ctx, tasks, probesPath); // dial skill eval
  let inFlight = 0, capped = false;
  async function worker() {
    // dial skill eval: after an account limit (runCase sets ctx.stop) every new case would fail the same way; after an
    // unlisted run, Claude Code changed since its probe and every new case would be unlisted too, until a rerun probes.
    while (i < tasks.length && !ctx.stop && !ctx.unlisted && !capped) {
      // dial skill eval: a case's reserve is taken before its first await, so cases started together can never carry
      // the total past the cap. A worker whose case does not fit beside those in flight leaves the pass to their
      // workers; once one does not fit alone, the cap is reached, none starts, and a rerun resumes.
      if (!ctx.guard.mayStart(inFlight)) { if (!ctx.guard.mayStart(0)) capped = true; break; }
      inFlight++;
      const { c, rep } = tasks[i++];
      const safeId = pathSafeId(c.id);
      const t0 = Date.now();
      let lastRun = null;    // survives into the catch - billed spend on a failed attempt
      let rowWritten = false; // set once the results row lands - the attempt is scored
      const deadline = args.timeoutS > 0 ? t0 + args.timeoutS * 1000 : Infinity;
      // dial skill eval: every agent attempt ends by here, so none outlives its case or holds the judge's share.
      const agentDeadline = args.timeoutS > 0 ? t0 + agentTimeoutMs(args.timeoutS) : Infinity;
      let counted = 0; // dial skill eval: the dollars of this case the guard already holds
      let cut = 0; // dial skill eval: what its attempts cut before their result event are charged beyond their usage
      const appRetry = { count: 0 }, judgeRetry = { count: 0 };
      try {
        // One ceiling over the whole case - app call, identity check, and grading - 
        // so a hung judge stream can't hold the slot either.
        const { run, g, latency_s } = await withTimeout((async () => {
          let tAttempt = t0;
          // dial skill eval: a failed agent run was billed too (lib/agents.ts): the guard adds it as it happens, and a
          // transient one is retried only while the guard lets the case start again. Its spend goes to the run that
          // scores, or to the error row, as a retried grading attempt's does (gradeCase).
          let appSpent;
          const run = await withBackoff(() => {
            tAttempt = Date.now();
            // 0 leaves the agent unbounded, so a share already spent gives it 1 ms.
            const timeoutMs = agentDeadline === Infinity ? 0 : Math.max(1, agentDeadline - tAttempt);
            return runCase(c, ctx, timeoutMs).catch(e => {
              const cutAttempt = cutUsd(e ?? {});
              counted += ctx.guard.add({ model: e?.model, usage: e?.usage, cut_usd: cutAttempt });
              cut += cutAttempt;
              appSpent = addUsage(appSpent, e?.usage);
              throw Object.assign(e, { usage: appSpent });
            });
          }, appRetry, agentDeadline, 5, () => ctx.guard.mayStart(inFlight - 1));
          cut += cutUsd(run);
          run.usage = addUsage(appSpent, run.usage);
          lastRun = run;
          // latency_s = the final app attempt only; backoff sleeps, failed
          // attempts, and judge time are excluded (retry counts are in meta).
          const latency_s = (Date.now() - tAttempt) / 1000;
          // Serving identity: fail loudly when the response was served by a model
          // other than the one requested. Accept exact match or a documented
          // alias->snapshot resolution - 'foo-latest'/'foo-0'/'foo' served as
          // 'foo-20250101', 'foo@20250101', or 'foo-2025-01-01'. Anything else - 
          // another snapshot of the requested pin, a sibling model, or the bare
          // base id ('foo-latest' served as 'foo', an unversioned echo that can
          // hide snapshot drift across rounds) - fails the attempt. Non-Anthropic
          // id schemes (e.g. Bedrock's 'anthropic.claude-...-v1:0') need their own
          // rule here.
          if (ctx.model && run.model && run.model !== ctx.model) {
            const base = ctx.model.replace(/-latest$|-0$/, '');
            const rest = String(run.model).startsWith(base)
              ? String(run.model).slice(base.length) : null;
            if (!(rest != null && /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest))) {
              const e = new Error(`served model ${run.model} != requested ${ctx.model}`);
              e.failure_class = 'serving_substitution';
              throw e;
            }
          }
          // Frozen pairwise reference (never regenerated): baseline/ref/<id>.*
          let ref = null;
          if (args.variant !== 'baseline') {
            const p = join(refDir, safeId);
            // A planted symlink throws (ELOOP) rather than feeding the judge
            // its target; the case then fails loudly instead of leaking.
            for (const ext of REF_EXTS) {
              try { ref = readFileNoFollow(p + ext); break; }
              catch (e) { if (e?.code !== 'ENOENT') throw e; }
            }
          }
          const g = await withBackoff(() => gradeCase(c, run, ref, ctx), judgeRetry, deadline);
          return { run, g, latency_s };
        })(), args.timeoutS, `${c.id} rep${rep}`);
        // dial skill eval: Claude Code may update itself mid-pass, so a claude row names the version its own run started
        // with; a stand-in's keeps the pass's.
        const meta = run.init?.claude_version ? { ...c.meta, claude_version: run.init.claude_version } : c.meta;
        const row = {
          prompt_id: safeId, rep, prompt: c.prompt ?? c.input ?? c.id,
          tags: c.tags, attachments: c.attachments,
          meta: safeId !== String(c.id) || appRetry.count || judgeRetry.count
            ? { ...(meta ?? {}),
                ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
                ...(appRetry.count ? { retries: appRetry.count } : {}),
                ...(judgeRetry.count ? { judge_retries: judgeRetry.count } : {}) }
            : meta,
          model: run.model, usage: run.usage, ...(cut ? { cut_usd: cut } : {}), stop_reason: run.stop_reason,
          // The report keys on `status`, not stop_reason: a clipped answer is
          // counted and shown but kept out of the means. runCase may set
          // run.status to override the max_tokens rule.
          status: run.status ?? (run.stop_reason === 'max_tokens' ? 'truncated' : 'ok'),
          judge_model: g.judge_model ?? run.judge_model,
          judge_usage: g.judge_usage ?? run.judge_usage,
          latency_s, ...perfFrom(run),
          grade: g.grade, explanation: g.explanation,
        };
        appendFileNoFollow(resultsPath, JSON.stringify(row) + '\n');
        rowWritten = true; // past this point the attempt is scored - a later throw (trace write, ref freeze) must not also append an error row
        ctx.guard.add(row, counted); // dial skill eval
        if (row.status === 'unlisted') ctx.unlisted = true; // dial skill eval
        if (run.transcript)
          writeFileNoFollow(join(vdir, 'traces', `${safeId}_rep${rep}.json`),
            JSON.stringify(run.transcript, null, 2));
        // For pairwise: on the baseline run, freeze the reference output once.
        if (args.variant === 'baseline' && run.output != null
            && !REF_EXTS.some(ext => lexists(join(refDir, safeId) + ext))) {
          mkdirNoFollow(refDir);
          writeFileNoFollow(join(refDir, safeId),
            typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        }
        ok++;
      } catch (e) {
        fail++;
        if (rowWritten) {
          // The attempt scored; only a post-row write (trace, ref) failed. An error
          // row here would double-count the billed usage under the budget rule.
          eprint(`  [${args.variant}] ${c.id} rep${rep} scored, but a post-row write failed: ${e?.message || e}`);
          continue;
        }
        // Failed attempts are data too - but they must not occupy the (case, rep)
        // slot in results.jsonl, or resume would never re-run them.
        const errorRow = {
          prompt_id: safeId, rep,
          ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
          failure_class: e?.failure_class ?? 'error',
          error: String(e?.message || e),
          retries: appRetry.count, judge_retries: judgeRetry.count,
          // Billed-but-failed spend stays countable: when the app call completed
          // before the failure (e.g. a served-model mismatch, a judge-stage
          // ceiling), carry its identity and usage on the error row.
          // dial skill eval: a run that failed itself carries its own (lib/agents.ts).
          model: e?.model ?? lastRun?.model, usage: e?.usage ?? lastRun?.usage, ...(cut ? { cut_usd: cut } : {}),
          judge_model: e?.judge_model ?? lastRun?.judge_model,
          judge_usage: e?.judge_usage ?? lastRun?.judge_usage,
          latency_s: (Date.now() - t0) / 1000,
        };
        appendFileNoFollow(errorsPath, JSON.stringify(errorRow) + '\n');
        ctx.guard.add(errorRow, counted); // dial skill eval
        eprint(`  [${args.variant}] ${c.id} rep${rep} FAILED: ${e?.message || e}`);
      } finally {
        inFlight--; // dial skill eval: a reserve is released only once its spend is added
      }
    }
  }
  // One progress line every 30s (and to <vdir>/progress.txt) so "how far along
  // is it?" is answerable from the background shell's output or one file read,
  // without the orchestrator parsing results.jsonl mid-write. ETA is a plain
  // rate extrapolation from this pass.
  const t0 = Date.now();
  const progress = () => {
    const done = ok + fail, total = tasks.length;
    const el = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((el / done) * (total - done)) : null;
    const line = `[${args.variant}] ${done}/${total} done (${ok} ok, ${fail} failed), `
      + `${Math.round(el)}s elapsed` + (eta != null ? `, ~${eta}s left` : '');
    eprint(line);
    try { writeFileNoFollow(join(vdir, 'progress.txt'), line + '\n'); } catch {}
  };
  const tick = setInterval(progress, 30_000);
  workersStarted = true;
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  clearInterval(tick); progress();
  if (ctx.stop) { eprint(ACCOUNT_LIMIT); process.exit(3); } // dial skill eval
  if (capped) { eprint(spendCapLine(ctx)); process.exit(4); } // dial skill eval
  if (ctx.unlisted) { eprint('Claude Code changed mid-pass · rerun to probe again'); process.exit(5); } // dial skill eval
  eprint(`[${args.variant}] done - ${ok} ok, ${fail} failed -> ${resultsPath}`);
  process.exit(fail ? 1 : 0);
}

// Anything main() throws prints as one sanitized line, not a raw stack. Before
// the workers start it is a refusal (a planted link at _state.json or
// results.jsonl, an lstat that fails, an error from loadCases) and exits 2 like
// the preflight refusals. After they start, only a failed errors.jsonl append
// gets here; rows may already be on disk, so say that and exit 1.
let workersStarted = false;
main().catch(e => {
  const m = String(e?.message || e);
  if (workersStarted) { eprint('stopped mid-run (rows already written are kept; re-run to resume): ' + m); process.exit(1); }
  eprint(m.startsWith('refusing to ') ? m : 'refusing to run: ' + m);
  process.exit(2);
});
