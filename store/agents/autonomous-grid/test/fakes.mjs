// Stand-ins shared by the no-wake and wake tests: a `grid` binary that logs every argv it is run
// with, and the Harness daemon's loopback bridge that the viewer's "Wake now" talks to.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { device, reads, remoteNodes } from './fixtures.mjs';

/** The per-grid reads a poll makes automatically, each of which must carry `--no-wake`. */
export const READS = ['engines','models','stats'];

/** A fake `grid` of one version, answering each verb from `verbs` and logging every argv it saw. An
 *  "old" one refuses `--no-wake` exactly as argparse does: a usage line on stderr and exit 2. */
export async function fakeGrid(dir, name, plan, log) {
  const file = join(dir, name);
  await replan(file, plan);
  await writeFile(file, `#!/usr/bin/env node
const fs=require('fs');const plan=JSON.parse(fs.readFileSync(${JSON.stringify(`${file}.json`)},'utf8'));
const argv=process.argv.slice(2);const log=${JSON.stringify(log)};
fs.appendFileSync(log,JSON.stringify({binary:${JSON.stringify(name)},argv})+'\\n');
if(plan.rejectsNoWake&&argv.includes('--no-wake')){process.stderr.write('usage: grid [-h] [--remote | --local] {models,engines,stats,info} ...\\ngrid: error: unrecognized arguments: --no-wake\\n');process.exit(2);}
const verb=argv.find(a=>!a.startsWith('-'))||'';const turn=plan.verbs[verb];
if(!turn){process.stdout.write('[]');process.exit(0);}
if(turn.stdout!==undefined)process.stdout.write(typeof turn.stdout==='string'?turn.stdout:JSON.stringify(turn.stdout));
if(turn.stderr)process.stderr.write(turn.stderr);process.exit(turn.exit??0);
`, { mode: 0o755 });
  return file;
}
/** What the fake `grid` at [file] answers from its next run on. Renamed into place: a poll may be
 *  running it at this moment, and a half-written plan would read as a grid that is down. */
export async function replan(file, { rejectsNoWake = false, verbs = {} }) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ rejectsNoWake, verbs }));
  await rename(temporary, `${file}.json`);
}
export const awakeVerbs = {
  use:{stdout:{mode:'remote',active:'test-grid'}}, ls:{stdout:[{grid:'test-grid',type:'permissioned-public'}]},
  info:{stdout:{grid:'test-grid',type:'permissioned-public',status:'running',grid_url:'https://relay.example'}},
  engines:{stdout:remoteNodes}, models:{stdout:reads.models.value}, stats:{stdout:reads.stats.value}, 'device-info':{stdout:device},
};
// One line per call, APPENDED: the viewer runs several \`grid\` reads at once, and a read-modify-write of
// one JSON document crashed a fake that caught it half written — which read as the grid being down.
export const logged = async log => (await readFile(log,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
export const verbOf = argv => argv.find(a=>!a.startsWith('-'));

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function encode(opcode, payload = '') {
  const data = Buffer.from(payload), length = data.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.from(BigInt(length).toString(16).padStart(16, '0'), 'hex')]);
  return Buffer.concat([head, data]);
}
function decode(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f, offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const masked = (buffer[1] & 0x80) !== 0, start = offset + (masked ? 4 : 0);
  if (buffer.length < start + length) return null;
  const data = Buffer.from(buffer.subarray(start, start + length));
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= buffer[offset + (i % 4)];
  return { opcode: buffer[0] & 0x0f, data, size: start + length };
}

/**
 * The Harness daemon's loopback bridge (`ws://127.0.0.1:<port>/api/local-ws`), speaking just enough of
 * RFC 6455 for Node's own WebSocket client: unfragmented text frames, ping and close. Every JSON frame a
 * client sends is kept, per connection and in arrival order; `respond(frame, send)` answers it.
 */
export async function fakeBridge(respond = () => {}) {
  const connections = [], sockets = new Set();
  let closing = false;
  const server = createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    // An upgrade that lands after close() began is never adopted: the server would wait on it forever.
    if (closing || req.url !== '/api/local-ws') { socket.destroy(); return; }
    sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${ACCEPT_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = { frames: [], closed: false };
    connections.push(connection);
    const send = frame => { if (!socket.destroyed) socket.write(encode(1, JSON.stringify(frame))); };
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (let frame = decode(pending); frame; frame = decode(pending)) {
        pending = pending.subarray(frame.size);
        if (frame.opcode === 8) { connection.closed = true; socket.end(encode(8, frame.data.subarray(0, 2))); return; }
        if (frame.opcode === 9) { socket.write(encode(10, frame.data)); continue; }
        if (frame.opcode !== 1) continue;
        const parsed = JSON.parse(frame.data.toString('utf8'));
        connection.frames.push(parsed);
        respond(parsed, send);
      }
    });
    socket.on('close', () => { connection.closed = true; sockets.delete(socket); });
    socket.on('error', () => {});
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return {
    url: `ws://127.0.0.1:${server.address().port}/api/local-ws`,
    connections,
    frames: () => connections.flatMap(c => c.frames),
    close: () => new Promise(done => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => done()); server.closeAllConnections();
    }),
  };
}
