// `fleet models` for a machine other than this one. The finder reads a machine's own disk and asks its
// own loopback ports, so it has to run there: over SSH it is copied to the machine and run by that
// machine's Node. Without Node 18+ there, a plain `find` still lists the model files, and says what is
// missing. A Harness link runs Grid commands only, so it cannot run the finder at all.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readlink, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellQuote } from './fleet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FINDER_FILES = ['inventory.mjs', 'candidates.mjs', 'finderMain.mjs'];
const DIR = '.cache/grid-harness/finder'; // relative to the remote home, where an SSH command starts
const NO_NODE = '__GRID_FINDER_NO_NODE__';

// The same roots the finder scans (inventory.mjs `defaultRoots`), for the listing without Node. Sizes
// in kilobytes: BusyBox `find` (Alpine) has no `M` suffix [run].
const FALLBACK = [
  'for d in ~/.grid/models ~/.ollama/models /usr/share/ollama/.ollama/models ~/.lmstudio/models',
  '~/.cache/lm-studio/models "${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"',
  '"${LLAMA_CACHE:-$HOME/Library/Caches/llama.cpp}" "${XDG_CACHE_HOME:-$HOME/.cache}/llama.cpp" ~/models ~/Models ~/Downloads;',
  'do [ -d "$d" ] && find -L "$d" -maxdepth 8 \\( -iname "*.gguf" -size +51200k -o -name config.json',
  '-o -path "*/manifests/*" -type f \\) 2>/dev/null; done | head -300',
].join(' ');

/** SSH options every call shares: the user's existing trust, never a prompt (as `invocation` in fleet.mjs). */
export function sshBase(machine) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    ...(machine.port ? ['-p', String(machine.port)] : []), machine.host];
}

function sshRun(machine, remote, { input = null, timeoutMs = 90_000, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const child = spawnImpl('ssh', [...sshBase(machine), remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout, stderr, ...result }); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: 124, error: `no answer from ${machine.host} within ${timeoutMs / 1000}s` }); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish({ code: 127, error: error.code === 'ENOENT' ? 'ssh is not installed here' : error.message }));
    child.once('close', code => finish({ code: code ?? 1, error: code === 0 ? null : stderr.trim().split('\n').pop() || `ssh exited ${code}` }));
    child.stdin.end(input ?? '');
  });
}

/**
 * The finder's output for `machine`: `{ text, full }`, where `full` says whether it is the finder's own
 * table (Node there) or only a file list. Throws with the reason when the machine cannot be read.
 */
export async function remoteModels(machine, { summary = true, spawnImpl = spawn } = {}) {
  if (machine.transport === 'harness') {
    throw new Error(`${machine.name || machine.id} is linked through Harness, which runs Grid commands only, so its model `
      + `files cannot be listed from here. Its hardware: fleet run --machine ${machine.id} -- device-info --json`);
  }
  if (machine.transport !== 'ssh') throw new Error(`fleet models --machine needs an SSH machine; ${machine.id} is ${machine.transport}.`);
  const call = (remote, options = {}) => sshRun(machine, remote, { spawnImpl, ...options });
  for (const file of FINDER_FILES) {
    const sent = await call(`mkdir -p ${DIR} && cat > ${DIR}/${file}`, { input: await readFile(join(HERE, file), 'utf8'), timeoutMs: 30_000 });
    if (sent.code !== 0) throw new Error(`Could not copy the finder to ${machine.host}: ${sent.error}`);
  }
  // A number, not a boolean: newer Node throws on `process.exit(true)`, which would read as "no Node".
  const node = 'command -v node >/dev/null 2>&1 && node -e "process.exit(Number(+process.versions.node.split(\'.\')[0] < 18))"';
  const run = await call(`if ${node}; then exec node ${DIR}/finderMain.mjs${summary ? ' --summary' : ''}; `
    + `else echo ${NO_NODE}; uname -sm; ${FALLBACK}; fi`);
  if (run.code !== 0) throw new Error(`The finder failed on ${machine.host}: ${run.error}`);
  if (!run.stdout.startsWith(NO_NODE)) return { text: run.stdout.trimEnd(), full: true };
  const [, system, ...files] = run.stdout.trimEnd().split('\n');
  return {
    full: false,
    text: [`machine   ${system} (${machine.host}) — Node 18+ is not installed there, so this is a file list only:`,
      'no context, memory fit, tool calls, engines or ports. Install Node there for the full table.', '',
      ...(files.length ? files : ['(no model files found)'])].join('\n'),
  };
}

const GGUF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.gguf$/;

/**
 * Make a GGUF already on a machine servable by Grid there, without copying it: `join --serve` reads only
 * `~/.grid/models` and keeps just the file name [run], so the file is linked in. A projector is linked as
 * `<name>.mmproj.gguf`, the name `--serve` finds it by [run]. An existing name is never replaced.
 */
export async function linkModel(machine, file, name, { projector, env = process.env, spawnImpl = spawn } = {}) {
  if (!GGUF_NAME.test(name)) throw new Error('NAME is a plain file name ending in .gguf.');
  const pairs = [[file, name], ...(projector ? [[projector, name.replace(/\.gguf$/, '.mmproj.gguf')]] : [])];
  if (pairs.some(([source]) => !isAbsolute(source))) throw new Error('Give FILE (and --projector) as full paths on that machine, as `fleet models` prints them.');
  if (machine.transport === 'harness') throw new Error(`${machine.name || machine.id} is linked through Harness, which runs Grid commands only; a model for it comes from the catalog (pull).`);
  if (machine.transport === 'local') {
    const dir = join(env.GRID_HOME || join(homedir(), '.grid'), 'models');
    await mkdir(dir, { recursive: true });
    const lines = [];
    for (const [source, target] of pairs) {
      if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`No file at ${source}.`);
      const at = join(dir, target);
      const current = await readlink(at).catch(error => (error.code === 'ENOENT' ? null : '(not a link)'));
      if (current === source) { lines.push(`already linked ${at}`); continue; }
      if (current !== null) throw new Error(`${at} already exists and is not a link to ${source}; choose another NAME.`);
      await symlink(source, at);
      lines.push(`linked ${at} -> ${source}`);
    }
    const engine = join(env.GRID_HOME || join(homedir(), '.grid'), 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!(await stat(engine).catch(() => null))) lines.push(noEngine(machine.id).replace(` --machine ${machine.id}`, ''));
    return { text: lines.join('\n') };
  }
  if (machine.transport !== 'ssh') throw new Error(`Unknown transport for ${machine.id}.`);
  const script = [
    ...(machine.gridHome ? [`GRID_HOME=${shellQuote(machine.gridHome)}; export GRID_HOME;`] : []),
    'd="${GRID_HOME:-$HOME/.grid}/models"; mkdir -p "$d" || exit 5;',
    'link() { if [ ! -f "$1" ]; then echo "No file at $1." >&2; exit 3; fi;',
    'if [ -L "$d/$2" ] && [ "$(readlink "$d/$2")" = "$1" ]; then echo "already linked $d/$2";',
    'elif [ -e "$d/$2" ] || [ -L "$d/$2" ]; then echo "$d/$2 already exists and is not a link to $1; choose another NAME." >&2; exit 4;',
    'else ln -s "$1" "$d/$2" && echo "linked $d/$2 -> $1"; fi; };',
    ...pairs.map(([source, target]) => `link ${shellQuote(source)} ${shellQuote(target)} || exit $?;`),
    // The join after this needs Grid's own engine there, and needs it to RUN: without it the join still
    // says "starting" and the engine dies at once in a log on that machine — "llama-server not found", or
    // "libgomp.so.1: cannot open shared object file" on a minimal Ubuntu [run].
    'e="${GRID_HOME:-$HOME/.grid}/bin/llama-server"; [ -x "$e" ] || e="$(command -v llama-server 2>/dev/null)";',
    `if [ -z "$e" ]; then echo ${shellQuote(noEngine(machine.id))};`,
    'elif ! err="$("$e" --version 2>&1)"; then',
    `echo "NOT READY: Grid's engine is installed on this machine but does not start: $(printf %s "$err" | head -1)";`,
    `echo "  A missing lib*.so is a system package there (libgomp.so.1 = libgomp1); tell the person which one — installing it is theirs to do."; fi;`,
  ].join(' ');
  const result = await sshRun(machine, script, { spawnImpl, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not link on ${machine.host}: ${result.error}`);
  return { text: result.stdout.trimEnd() };
}

const noEngine = id => `NOT READY: Grid's engine (llama.cpp) is not installed on this machine, so a join here would die at start. `
  + `Ask first (a download), then: "$GRID_FLEET" run --machine ${id} -- engine install llama.cpp`;
