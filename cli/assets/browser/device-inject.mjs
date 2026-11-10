/**
 * Device (Browser settings, Advanced): a standing process in the browser's container, started by entrypoint.sh when
 * `DEVICE` is set. It holds its own CDP connection and attaches to every page, frame and worker as it is created,
 * paused at start, and adds a script that reports the person's GPU, CPU cores and memory before the page's first line
 * runs. So it covers a page a person opens before the agent ever calls a tool. Once Chrome has taken the auto-attach it
 * writes a ready file, which entrypoint.sh waits for before the browser is ready: a tab opened before that would
 * report the machine's own values. Ported from ai-assitant-sanbox
 * `gateway-source/scripts/sandbox-browser-inject.py`.
 *
 * Node's own modules only: the image's Node (Debian's, 20) has no WebSocket client without a flag, so a minimal one for
 * CDP's text frames is here, as the prior art had its own.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const WORKERS = new Set(['worker', 'shared_worker', 'service_worker'])
const DOCUMENTS = new Set(['page', 'iframe'])
// The browser takes a few seconds to answer CDP after it starts; the entrypoint's own ready check waits as long.
const CDP_TRIES = 300
const CDP_RETRY_MS = 200
const TIMEOUT_MS = 5_000

/** The script a page or worker runs first. Getters and getParameter keep a native-looking toString. */
export function deviceScript({ gpuVendor, gpuRenderer, cpuCores, memoryGb }) {
  // Chrome reports deviceMemory rounded down to a power of two and capped at 8; any other value is a tell.
  const memory = Math.min(8, 2 ** Math.floor(Math.log2(memoryGb)))
  const cfg = { gpu: [gpuVendor, gpuRenderer], cores: cpuCores, memory }
  return '(() => {'
    + `const cfg = ${JSON.stringify(cfg)};`
    + 'const nativeToString = Function.prototype.toString;'
    + 'const names = new WeakMap();'
    + "const mask = (fn, name) => { names.set(fn, 'function ' + name + '() { [native code] }'); return fn; };"
    + 'Function.prototype.toString = mask(function toString() { return names.has(this) ? names.get(this) : nativeToString.call(this); }, \'toString\');'
    + 'const getter = (proto, prop, value) => {'
    + ' const d = Object.getOwnPropertyDescriptor(proto, prop); if (!d) return;'
    + " Object.defineProperty(proto, prop, { ...d, get: mask(function () { return value; }, 'get ' + prop) }); };"
    + 'const N = (self.Navigator || self.WorkerNavigator).prototype;'
    + "getter(N, 'hardwareConcurrency', cfg.cores);"
    + "getter(N, 'deviceMemory', cfg.memory);"
    + 'for (const C of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {'
    + ' if (!C) continue;'
    + ' const original = C.prototype.getParameter;'
    + ' C.prototype.getParameter = mask(function getParameter(p) {'
    + '  if (p === 0x9245) return cfg.gpu[0];'
    + '  if (p === 0x9246) return cfg.gpu[1];'
    + "  return original.call(this, p); }, 'getParameter'); }"
    + '})();'
}

async function debuggerUrl(cdpBase) {
  for (let i = 0; i < CDP_TRIES; i++) {
    try {
      const res = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return (await res.json()).webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await new Promise(wake => setTimeout(wake, CDP_RETRY_MS))
  }
  throw new Error('CDP did not answer')
}

/** Opens the WebSocket; resolves with its socket, `send(text)` and `onText(handler)`. */
function webSocket(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url.replace(/^ws/, 'http'), {
      timeout: TIMEOUT_MS,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
    })
    req.on('timeout', () => req.destroy(new Error('CDP did not answer')))
    req.on('error', reject)
    req.on('response', (res) => { res.resume(); reject(new Error(`CDP refused the WebSocket (${res.statusCode})`)) })
    req.on('upgrade', (_res, socket, head) => {
      socket.setTimeout(0)
      socket.on('error', () => socket.destroy())
      let buffer = head
      let parts = []
      let onText = () => {}
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (buffer.length < 2) return
          let length = buffer[1] & 0x7f
          let offset = 2
          if (length === 126) [length, offset] = buffer.length < 4 ? [-1, 0] : [buffer.readUInt16BE(2), 4]
          else if (length === 127) [length, offset] = buffer.length < 10 ? [-1, 0] : [Number(buffer.readBigUInt64BE(2)), 10]
          if (length < 0 || buffer.length < offset + length) return
          const fin = buffer[0] & 0x80
          const opcode = buffer[0] & 0x0f
          const payload = buffer.subarray(offset, offset + length)
          buffer = buffer.subarray(offset + length)
          if (opcode === 0x8) return void socket.destroy()
          // Ping and pong: Chrome sends none to a client.
          if (opcode > 0x8) continue
          parts.push(payload)
          if (!fin) continue
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          onText(text)
        }
      })
      resolve({
        socket,
        onText: (handler) => { onText = handler },
        // A client's frames are masked. Every command here is far under 64 KB, so two length forms are enough.
        send: (text) => {
          const data = Buffer.from(text, 'utf8')
          const mask = randomBytes(4)
          const head = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 0xff])
          for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
          socket.write(Buffer.concat([head, mask, data]))
        },
      })
    })
  })
}

/** Connects to the browser at `cdpBase` and keeps every new target reporting `device`. Resolves with the socket once
 *  Chrome took the auto-attach, and writes `readyFile` then; rejects when it refused it or did not answer. */
export async function startDevice(cdpBase, device, readyFile) {
  const source = deviceScript(device)
  const ws = await webSocket(await debuggerUrl(cdpBase))
  let id = 0
  const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }))
  const auto = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
  const attached = new Set()
  let autoAttachId
  let answered
  const autoAttached = new Promise((resolve, reject) => { answered = { resolve, reject } })
  ws.onText((text) => {
    const { id: answerTo, error, method, params = {} } = JSON.parse(text)
    if (answerTo !== undefined && answerTo === autoAttachId) {
      if (error) answered.reject(new Error(`Target.setAutoAttach failed: ${error.message}`))
      else answered.resolve()
    } else if (method === 'Target.targetCreated') {
      // A page that existed before this started, or opened without auto-attach.
      const info = params.targetInfo ?? {}
      if (info.type === 'page' && !info.attached) send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    } else if (method === 'Target.attachedToTarget') {
      const session = params.sessionId
      const info = params.targetInfo ?? {}
      if (WORKERS.has(info.type) && !String(info.url ?? '').startsWith('chrome')) {
        // A worker is paused before its first line: report the device, then let it run.
        send('Runtime.evaluate', { expression: source }, session)
      } else if (DOCUMENTS.has(info.type) && !attached.has(info.targetId)) {
        attached.add(info.targetId)
        // Chrome runs a session's document-start scripts only once it has enabled the Page domain.
        send('Page.enable', {}, session)
        send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, session)
        // Its frames in other processes, and its workers, are paused for the script too.
        send('Target.setAutoAttach', auto, session)
      }
      send('Runtime.runIfWaitingForDebugger', {}, session)
    } else if (method === 'Target.targetDestroyed') {
      attached.delete(params.targetId)
    }
  })
  send('Target.setAutoAttach', auto)
  autoAttachId = id
  send('Target.setDiscoverTargets', { discover: true })
  let timer
  try {
    await Promise.race([autoAttached, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Target.setAutoAttach was not answered')), TIMEOUT_MS)
    })])
  } catch (error) {
    ws.socket.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
  writeFileSync(readyFile, '')
  return ws.socket
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startDevice('http://127.0.0.1:9222', JSON.parse(process.env.DEVICE), '/tmp/device-ready').then((socket) => {
    // Without the connection new pages would report the machine's own values; the browser closing it means it is gone.
    socket.on('close', () => {
      console.error('device: the browser closed its CDP connection')
      process.exit(1)
    })
  }, (error) => {
    console.error(`device: ${error.message}`)
    process.exit(1)
  })
}
