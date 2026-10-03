#!/usr/bin/env node
import { createLog, verifyEngine, verifyModel, verifyRelay, relayOnlyRefusal } from '../lib/verify.mjs';
import { join, resolve } from 'node:path';
import { atomicJson, DEFAULT_CONFIG, execute, gridJson, harnessNameFor, nameJoin, readConfig, runTracked } from '../lib/fleet.mjs';
import { createCollector } from '../lib/telemetry.mjs';
import { discoverMachines } from '../lib/harness.mjs';
import { inventory, machineState, summarize } from '../lib/inventory.mjs';
import { mlxCandidates } from '../lib/candidates.mjs';
import { recipe } from '../lib/recipes.mjs';
import { modelFacts } from '../lib/modelFacts.mjs';
import { linkModel, remoteModels } from '../lib/remoteModels.mjs';
import { serve, stop } from '../lib/serve.mjs';
import { connectWorkspace, initializeWorkspace, mergeMachines, readStatus } from '../lib/connect.mjs';

const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (command === 'init') {
    const { access, mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await access(join(workspace, 'grid-fleet.json')).catch(() => atomicJson(join(workspace, 'grid-fleet.json'), DEFAULT_CONFIG));
    const {connection} = await initializeWorkspace(workspace);
    await createCollector(workspace)();
    console.log(`Grid workspace ready: ${workspace}`);
    if (connection.message) console.log(connection.message);
  } else if (command === 'connect') {
    let mode,grid,remember=false;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--mode' && mode===undefined) mode=args[++i];
      else if(args[i]==='--grid' && grid===undefined) grid=args[++i];
      else if(args[i]==='--remember' && !remember) remember=true;
      else throw new Error('Use: fleet connect --mode local|remote --grid NAME [--remember]');
    }
    await connectWorkspace(workspace,{mode,grid,remember});
    const snapshot = await createCollector(workspace)();
    console.log(JSON.stringify({mode,grid,remembered:remember,status:snapshot.status,enginesOnline:snapshot.summary.enginesOnline},null,2));
  } else if (command === 'status') {
    if(args.length && !(args.length===1 && args[0]==='--json')) throw new Error('Use: fleet status [--json]');
    console.log(JSON.stringify(await readStatus(workspace),null,2));
  } else if (command === 'doctor') {
    const result = await execute({ transport: 'local' }, ['version']);
    const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    const [a=0,b=0,c=0] = (version || '').split('.').map(Number);
    if (!result.ok || !(a > 0 || b > 3 || (b === 3 && c >= 47))) throw new Error('Grid >= 0.3.47 is required. Run toolchain/setup.sh or update the selected Harness runtime.');
    console.log(`ok   Grid ${version}\nok   Node ${process.versions.node}\nok   local fleet viewer\ninfo Paired Harness machines use encrypted connections; SSH targets use existing keys`);
  } else if (command === 'discover') {
    if (args.length && (args.length !== 1 || args[0] !== '--add')) throw new Error('Use: fleet discover [--add]');
    const found = await discoverMachines();
    if (args[0] === '--add') {
      const config = await readConfig(workspace);
      await atomicJson(join(workspace,'grid-fleet.json'), mergeMachines(config,found));
    }
    console.log(JSON.stringify(found,null,2));
  } else if (command === 'refresh') {
    const snapshot = await createCollector(workspace)();
    console.log(JSON.stringify(snapshot, null, 2));
    process.exitCode = snapshot.status === 'unavailable' ? 1 : 0;
  } else if (command === 'config') {
    console.log(JSON.stringify(await readConfig(workspace), null, 2));
  } else if (command === 'verify' && !args.includes('--at') && !args.includes('--alias')) {
    // The Models panel's receipt form: one request, published as an operation the panel reads.
    const flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--grid', '--model'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Use: fleet verify --grid NAME --model MODEL');
      flags.set(args[i], args[i + 1]);
    }
    const config = await readConfig(workspace);
    const machine = config.machines.find(m => m.id === config.controller);
    console.log(JSON.stringify(await verifyModel(workspace, machine, config.mode, flags.get('--grid') || config.grid, flags.get('--model'))));
  } else if (command === 'models') {
    const extraRoots = [], extraPorts = [];
    let summary = false, target;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--root' && args[i + 1]) extraRoots.push(resolve(args[++i]));
      else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) extraPorts.push(Number(args[++i]));
      else if (args[i] === '--machine' && args[i + 1]) target = args[++i];
      else if (args[i] === '--summary') summary = true;
      else if (args[i] !== '--json') throw new Error('Use: fleet models [--machine ID] [--summary] [--root DIR]... [--port N]...');
    }
    const config = target ? await readConfig(workspace) : null;
    const machine = target ? config.machines.find(m => m.id === target) : null;
    if (target && !machine) throw new Error(`Unknown machine ${target}. Add it to grid-fleet.json first.`);
    if (machine && machine.transport !== 'local') {
      if (extraRoots.length || extraPorts.length) throw new Error('--root and --port apply to this machine only.');
      console.log((await remoteModels(machine, { summary })).text);
    } else {
      const found = await inventory({ extraRoots, extraPorts });
      console.log(summary ? summarize(found) : JSON.stringify(found, null, 2));
    }
  } else if (command === 'link') {
    const usage = 'Use: fleet link [--machine ID] FILE [NAME.gguf] [--projector FILE]';
    let target, projector;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--machine' && args[i + 1]) target = args[++i];
      else if (args[i] === '--projector' && args[i + 1]) projector = args[++i];
      else if (args[i].startsWith('-')) throw new Error(usage);
      else rest.push(args[i]);
    }
    if (rest.length < 1 || rest.length > 2) throw new Error(usage);
    const config = await readConfig(workspace);
    const machine = config.machines.find(m => m.id === (target || config.controller));
    if (!machine) throw new Error(`Unknown machine ${target}. Add it to grid-fleet.json first.`);
    const local = machine.transport === 'local';
    const file = local ? resolve(rest[0]) : rest[0];
    const name = rest[1] || file.split('/').pop();
    console.log((await linkModel(machine, file, name, { projector: projector && local ? resolve(projector) : projector })).text);
  } else if (command === 'recipe') {
    if (args.length !== 2) throw new Error('Use: fleet recipe vllm|sglang ORG/NAME');
    try { console.log(JSON.stringify({ found: true, ...(await recipe(args[0], args[1])) }, null, 2)); }
    catch (error) {
      if (error.code !== 'NO_RECIPE') throw error;
      console.log(JSON.stringify({ found: false, message: error.message,
        next: `No official recipe. Read the model itself: fleet model-facts ${args[1]} — then follow "No recipe" in the engine skill. Never invent flags.` }, null, 2));
      process.exitCode = 3;
    }
  } else if (command === 'candidates') {
    const [engine, ...rest] = args;
    if (engine !== 'mlx') throw new Error('Use: fleet candidates mlx [--search WORDS] [--sort downloads|trending|recent] [--context TOKENS]');
    const options = { search: '', sort: 'downloads', contextTokens: 65536 };
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === '--search' && rest[i + 1]) options.search = rest[i + 1];
      else if (rest[i] === '--sort' && rest[i + 1]) options.sort = rest[i + 1];
      else if (rest[i] === '--context' && Number(rest[i + 1]) >= 65536) options.contextTokens = Number(rest[i + 1]);
      else throw new Error('Use: fleet candidates mlx [--search WORDS] [--sort downloads|trending|recent] [--context TOKENS≥65536]');
    }
    const machine = await machineState();
    const metal = machine.accelerators.find(gpu => gpu.vendor === 'apple' && gpu.totalBytes);
    console.log(JSON.stringify({ machine: { chip: machine.chip, gpuBudgetBytes: metal?.totalBytes ?? null, availableBytes: machine.memory?.availableBytes ?? null },
      ...(await mlxCandidates({ ...options, budgetBytes: metal?.totalBytes })) }, null, 2));
  } else if (command === 'verify') {
    const options = { tools: true };
    for (let i = 0; i < args.length; i++) {
      if (['--at', '--model', '--kind', '--grid', '--alias'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else if (args[i] === '--no-tools') options.tools = false;
      else throw new Error('Use: fleet verify --at http://HOST:PORT/v1 --model ID [--kind ENGINE] [--no-tools] [--grid GRID --alias NAME], or --grid GRID --alias NAME alone');
    }
    const usage = 'Use: fleet verify --at http://HOST:PORT/v1 --model ID [--kind ENGINE] [--no-tools] [--grid GRID --alias NAME], or --grid GRID --alias NAME alone for an engine on another machine';
    if (Boolean(options.grid) !== Boolean(options.alias) || (options.at ? !options.model : !options.grid)) throw new Error(usage);
    if (!options.at) {
      const config = await readConfig(workspace);
      const listed = await gridJson({ id: 'local', transport: 'local' }, config.mode, ['models', options.grid], { timeoutMs: 30_000 });
      const refusal = listed.ok ? relayOnlyRefusal(listed.value, options.alias, config.machines.find(m => m.transport === 'local')?.name) : null;
      if (refusal) throw new Error(refusal);
    }
    const log = createLog();
    const engine = options.at
      ? await verifyEngine({ url: options.at, model: options.model, kind: options.kind, tools: options.tools, log })
      : { ok: true, steps: [] };
    let relay = null;
    if (engine.ok && options.grid) {
      const config = await readConfig(workspace), local = { id: 'local', transport: 'local' };
      const info = await execute(local, [`--${config.mode}`, 'info', options.grid, '--env'], { timeoutMs: 30_000 });
      const env = Object.fromEntries([...`${info.stdout}`.matchAll(/(?:export\s+)?(OPENAI_BASE_URL|OPENAI_API_KEY)=["']?([^"'\s]+)/g)].map(m => [m[1], m[2]]));
      relay = env.OPENAI_BASE_URL
        ? await verifyRelay({ alias: options.alias, engineModel: options.model, log, relay: { baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY },
          listModels: async () => {
            const listed = await gridJson(local, config.mode, ['models', options.grid], { timeoutMs: 30_000 });
            return listed.ok ? { ok: true, models: (Array.isArray(listed.value) ? listed.value : []).map(row => row.model ?? row.id) } : listed;
          } })
        : { ok: false, steps: [{ name: 'relay endpoint', ok: false, note: `grid info ${options.grid} --env gave no OPENAI_BASE_URL` }] };
    }
    const ok = engine.ok && (relay?.ok ?? true);
    console.log(JSON.stringify({ ok, engine: engine.steps, relay: relay?.steps ?? null }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } else if (command === 'serve') {
    const boundary = args.indexOf('--');
    const usage = 'Use: fleet serve NAME [--env KEY=VALUE]... -- ENGINE COMMAND...';
    if (boundary < 1 || boundary === args.length - 1) throw new Error(usage);
    const env = {};
    for (let i = 1; i < boundary; i += 2) {
      const pair = args[i] === '--env' ? args[i + 1]?.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/) : null;
      if (!pair) throw new Error(usage);
      env[pair[1]] = pair[2];
    }
    console.log(JSON.stringify(await serve(workspace, args[0], args.slice(boundary + 1), { env }), null, 2));
  } else if (command === 'stop') {
    if (args.length !== 1) throw new Error('Use: fleet stop NAME');
    console.log(JSON.stringify(await stop(workspace, args[0]), null, 2));
  } else if (command === 'model-facts') {
    if (args.length !== 1) throw new Error('Use: fleet model-facts ORG/NAME|MODEL_FOLDER');
    const facts = await modelFacts(args[0]);
    console.log(JSON.stringify(facts, null, 2));
    if (!facts.found || facts.gated && !facts.architecture) process.exitCode = 3;
  } else if (command === 'run') {
    const boundary = args.indexOf('--');
    if (boundary < 0 || boundary === args.length - 1) throw new Error('Use: fleet run [--machine ID] -- <grid arguments>');
    const flags = args.slice(0,boundary), gridArgs = args.slice(boundary + 1);
    let target, thinking;
    for (let i=0;i<flags.length;i+=2) {
      if (flags[i]==='--machine' && target===undefined && flags[i+1]) target=flags[i+1];
      else if (flags[i]==='--thinking' && thinking===undefined && ['on','off'].includes(flags[i+1])) thinking=flags[i+1]==='on';
      else throw new Error('Use --machine ID and/or --thinking on|off before --.');
    }
    if (thinking!==undefined && gridArgs[0]!=='join') throw new Error('--thinking configures engine startup; use it with join.');
    const config = await readConfig(workspace);
    const machineId = target || config.controller;
    const machine = config.machines.find(m => m.id === machineId);
    if (!machine) throw new Error(`Unknown machine ${machineId}. Add it to grid-fleet.json first.`);
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    // A join is labelled with the machine's name as Harness Machines shows it, read now — see nameJoin.
    const named = gridArgs[0] === 'join' ? nameJoin(gridArgs, harnessNameFor(machine, await discoverMachines().catch(() => []))) : gridArgs;
    const result = await runTracked(workspace, machine, config.mode, named, { signal: abort.signal, thinking });
    if (!result.ok && result.error) console.error(result.error);
    process.exitCode = result.code;
  } else {
    console.log(`Grid fleet workspace tools

  fleet init                       Initialize from your remembered or active Grid
  fleet connect --mode MODE --grid NAME [--remember]
                                   Select a reachable grid; optionally reuse it in new workspaces
  fleet status [--json]             Read the viewer's observations without network access
  fleet verify --grid NAME --model MODEL
                                   Verify a first reply and publish readiness to Models
  fleet doctor                     Check Grid and Node
  fleet discover [--add]            Discover your Harness machines
  fleet config                     Validate and print fleet inventory
  fleet models [--machine ID] [--summary] [--root DIR] [--port N]
                                   Read-only: model files other apps downloaded, engines
                                   answering, memory and swap now. --machine reads an SSH
                                   machine with its own Node (a file list without it)
  fleet link [--machine ID] FILE [NAME.gguf] [--projector FILE]
                                   Link a GGUF already on that machine into its
                                   ~/.grid/models so join --serve can serve it (no copy)
  fleet recipe vllm|sglang ORG/NAME The engine's official recipe for that model, read live;
                                   exit 3 when there is none (never invent flags then)
  fleet model-facts ORG/NAME|DIR   What the model says about itself: architecture, context,
                                   chat-template tool syntax, card commands, engine support
  fleet candidates mlx [--search WORDS] [--sort downloads|trending|recent]
                                   MLX models sized for this Mac at a 64K+ context (no download)
  fleet verify --at URL/v1 --model ID [--kind ENGINE] [--no-tools] [--grid GRID --alias NAME]
                                   Bounded, narrated acceptance: ready, listed, answer, tool call,
                                   speed; with --grid, listed by the relay and answering through it
  fleet serve NAME [--env KEY=VALUE]... -- COMMAND...
                                   Start an engine other than Grid's so it outlives this shell:
                                   own session, log in run/NAME.log, PID in run/NAME.pid
  fleet stop NAME                  Stop only the PID that serve recorded for NAME
  fleet verify --grid GRID --alias NAME
                                   The relay half only, for an engine on another machine
  fleet refresh                    Read Grid, update viewer and verdict
  fleet run [--machine ID] -- ARGS  Run any Grid command on a configured machine

Use --thinking on|off before -- to configure a supported model's thinking at join.

Examples:
  "$GRID_FLEET" run -- engines --json
  "$GRID_FLEET" run --machine studio --thinking off -- join home --serve model.gguf --name studio
  "$GRID_FLEET" run --machine studio -- leave home --engine studio

Grid’s own help is available with: fleet run -- --help
Workspace: ${workspace}`);
    if (command !== 'help') process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
