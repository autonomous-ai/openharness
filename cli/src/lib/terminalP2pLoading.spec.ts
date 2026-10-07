import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('loads the real peer library once, only when a peer negotiation needs it', async () => {
  // Found by QA on a quiet machine: a gateway paid for werift before any P2P traffic.
  // Observe real module evaluation in a disposable split bundle, not Node's CommonJS cache.
  const root = mkdtempSync(join(tmpdir(), 'terminal-p2p-loading-'))
  const module = fileURLToPath(new URL('./terminalP2p.ts', import.meta.url))
  const cli = fileURLToPath(new URL('../../', import.meta.url))
  let observedModules = 0
  try {
    await build({
      stdin: {
        sourcefile: 'peer-loading.ts', resolveDir: cli, loader: 'ts',
        contents: `
          import assert from 'node:assert/strict';
          import { TerminalP2pInitiator, TerminalP2pResponderPool } from ${JSON.stringify(module)};
          const evaluations = () => globalThis.__qaPeerLibraryEvaluations ?? 0;
          assert.equal(evaluations(), 0, 'importing the gateway P2P module must not evaluate werift');
          const pool = new TerminalP2pResponderPool({ sendSignal() {}, onData() {},
            selectStunUrls: async () => ({ urls: [], udpReachable: null }) });
          const off = new TerminalP2pInitiator({
            policy: { enabled: false, protocolVersion: 1, stunUrls: [], openWaitMs: 0 },
            sendSignal() {}, onData() {},
          });
          try {
            off.start();
            assert.equal(await pool.handleSignal('unused', 'agents_list', {}), false);
            assert.equal(await pool.handleSignal('unused', 'p2p_offer', {}), true);
            await pool.handleSignal('unused', 'p2p_abort', {
              sessionId: '00000000-0000-4000-8000-000000000000', protocolVersion: 1,
            });
            assert.equal(evaluations(), 0, 'idle pools, disabled peers and irrelevant signals stay lightweight');
            const offer = { sessionId: '00000000-0000-4000-8000-000000000001',
              protocolVersion: 1, sdp: 'not-a-real-sdp', stunUrls: [] };
            if (process.env.EXPECT_PEER_LOAD_FAILURE === '1') {
              let failed;
              const failure = new Promise(resolve => { failed = resolve });
              const peer = new TerminalP2pInitiator({
                policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 0 },
                sendSignal() {}, onData() {},
                onState(state, _ms, reason) { if (state === 'failed') failed(reason) },
              });
              peer.start();
              assert.equal(await failure, 'offer_failed');
              assert.equal(await peer.waitUntilReady(1), false);
              await peer.stop('test_complete', false);
              // The gateway's dispatch boundary catches a rejected responder negotiation.
              await assert.rejects(pool.handleSignal('missing', 'p2p_offer', offer), /Cannot find module/);
              assert.equal(evaluations(), 0);
              console.log(JSON.stringify({ unavailable: true }));
            } else {
            // The real SDP parser must load to refuse this offer. No external STUN or TURN server.
            await pool.handleSignal('first', 'p2p_offer', offer);
            assert.equal(evaluations(), 1, 'the first offer must actually load the peer library');
            await Promise.all(['second', 'third'].map(id => pool.handleSignal(id, 'p2p_offer', offer)));
            assert.equal(evaluations(), 1, 'later and concurrent offers reuse the module');
            console.log(JSON.stringify({ evaluations: evaluations() }));
            }
          } finally {
            await off.stop('test_complete', false);
            await pool.stop();
          }
        `,
      },
      bundle: true, platform: 'node', format: 'esm', target: 'node20', splitting: true,
      outdir: root, entryNames: 'probe', chunkNames: 'part-[hash]', outExtension: { '.js': '.mjs' },
      external: ['bufferutil', 'utf-8-validate'], logLevel: 'silent',
      banner: { js: 'import{createRequire as ___cr}from"node:module";const require=___cr(import.meta.url);' },
      plugins: [{
        name: 'observe-real-peer-module',
        setup(builder) {
          builder.onLoad({ filter: /[\\/]werift[\\/]lib[\\/]index\.mjs$/ }, args => {
            observedModules++
            return { loader: 'js', resolveDir: dirname(args.path), contents:
              'globalThis.__qaPeerLibraryEvaluations = (globalThis.__qaPeerLibraryEvaluations ?? 0) + 1;\n'
              + readFileSync(args.path, 'utf8') }
          })
        },
      }],
    })
    expect(observedModules, 'the probe must observe the actual werift entry').toBe(1)
    // Vitest supplies throwaway homes. The child starts neither a daemon nor a tmux server.
    const output = execFileSync(process.execPath, [join(root, 'probe.mjs')], {
      cwd: cli, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    expect(JSON.parse(output.trim())).toEqual({ evaluations: 1 })
    // A missing split chunk costs only P2P. In particular begin() must not reject unhandled.
    const peerChunk = readdirSync(root).find(name => name.startsWith('part-')
      && readFileSync(join(root, name), 'utf8').includes('globalThis.__qaPeerLibraryEvaluations ='))
    expect(peerChunk, 'the actual peer module must live in a deferred chunk').toBeDefined()
    rmSync(join(root, peerChunk!))
    const unavailable = execFileSync(process.execPath, [join(root, 'probe.mjs')], {
      cwd: cli, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', EXPECT_PEER_LOAD_FAILURE: '1' },
    })
    expect(JSON.parse(unavailable.trim())).toEqual({ unavailable: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
