# Viewer Surface v2 Implementation Plan (Remote Browser — Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote rendered surface (`viewer_surface`) feel like a local browser — exact pane size and pixel density, streamed frames, immediate input, touch, clipboard — on desktop, web and (for the first time) mobile.

**Architecture:** The CLI's `InteractiveViewers` (`cli/src/lib/interactiveViewer.ts`) keeps its single request type but gains a v2 mode: Chrome's `Page.startScreencast` feeds a sequence-numbered latest frame, `op:'frame'` with `after` long-polls (≤1 s) for a newer one, and `op:'input'` applies input immediately through a per-surface CDP chain. Clients detect v2 by `seq` in a reply and fall back to v1 against older machines. Mobile gets a copy of the session plus a touch surface and a Viewer page.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`; Flutter/Dart in `desktop/` (package `harness`, also the web build) and `mobile/` (package `harness_mobile`); Chrome DevTools Protocol over the existing minimal client in `cli/src/sharing/viewer.ts`.

**Spec:** `docs/superpowers/specs/2026-10-08-remote-browser-design.md` (this plan implements its "Phase 1"; Phase 2 — the `browser` agent and `harnessd-browser` process — is a separate plan built on this one's interfaces).

## Global Constraints

- No new frame types, no `HARNESSD_PROTOCOL` bump, no new dependencies in `cli/`, `desktop/` or `mobile/`.
- Old client ↔ new daemon and new client ↔ old daemon must both keep working (v1 behaviour unchanged when `after` is absent and `op` is `frame`).
- v1 limits: width 160–1920, height 120–1200. v2 limits: width 160–3840, height 120–2400, `scale` 1–3, events ≤ 64 per request, text ≤ 65 536 chars, clipboard reply ≤ 1 000 000 chars.
- Pixel cap: `width × height × scale² ≤ 4 200 000`; the daemon lowers the scale (never below 0.5) and reports the scale it used.
- Long-poll wait: 1 000 ms. Input queue: refuse with `VIEWER_BUSY` above 256 queued events per surface. Idle surface expiry stays 30 s; limits stay 8 surfaces total / 4 per connection.
- The surface stays owner-only (`cli/src/backendSocket.ts` gate unchanged) and never becomes a general CDP bridge: every event type is whitelisted and validated.
- There is no shared Dart package: mobile code is a copy of the desktop session, kept identical in logic (say so in its header comment).
- Visible copy follows `docs/naming-system.md`. Comments say why, in plain sentences (`cli/AGENTS.md` rule 7).
- Repo rule: do **not** `git commit` until the user asks; the "Commit" steps below are staging points — run them only when told to.

## Review Focus

1. **New client, old machine:** the first request must be v1-valid (≤ 1920×1200, `op:'frame'`, no v2-only events) or an older daemon answers `INVALID_VIEWER_REQUEST` and the viewer never opens. → Task 5 test "stays inside v1 until the machine answers with seq".
2. **Old client, new machine:** a request with no `after` gets exactly the v1 reply shape and an overlapping v1 frame still gets `VIEWER_BUSY`. → Task 3 test "keeps v1 semantics without after".
3. **Pane resized while a 1 s poll is waiting:** the new size must reach Chrome within ~100 ms, not after the poll returns. → Task 5 test "a resize goes out as an empty input, debounced".
4. **Very large pane on a dense screen** (e.g. 3840×2160 at scale 2): the daemon must lower the scale instead of refusing or sending a 30 MB frame, and the reply must say which scale was used. → Task 1 test "lowers the scale to the pixel cap" + Task 3 test "reports the scale it applied".
5. **Surface closed or connection dropped while a poll waits:** the poll must end with `VIEWER_CLOSED` at once, with no timer or waiter left behind. → Task 3 test "a waiting poll ends when its surface closes".

---

## File Structure

| File | Responsibility |
|---|---|
| `cli/src/sharing/viewer.ts` (modify) | `ViewerCapture` gains a `protected onEvent(method, params)` hook for CDP events of its page session. |
| `cli/src/lib/interactiveViewer.ts` (modify) | v2 parsing (`surfaceFrame`, `surfaceScale`), the screencast "screen" in `InteractiveViewerCapture`, v2 request rules in `InteractiveViewers`. |
| `cli/src/lib/interactiveViewer.spec.ts` (modify) | Unit tests with mocked CDP. |
| `cli/src/lib/interactiveViewer.chrome.spec.ts` (create) | Real-Chrome check, skipped where no Chrome is installed. |
| `desktop/lib/viewer/interactive_viewer.dart` (modify) | Session v2 loop, input op, scale, resize debounce, clipboard and ⌘/Ctrl shortcuts. |
| `desktop/test/interactive_viewer_test.dart` (modify) | Session tests. |
| `mobile/lib/surface/interactive_viewer_session.dart` (create) | Copy of the desktop session (logic identical). |
| `mobile/lib/surface/touch_viewer_surface.dart` (create) | Touch/keyboard surface widget for phones. |
| `mobile/lib/phone/viewer_page.dart` (create) | Full-screen Viewer page. |
| `mobile/lib/core/models.dart` (modify) | `Agent.viewerUrl/viewerError/viewerName`. |
| `mobile/lib/state/app_state.dart` (modify) | `AppNotifier.viewerSurface(...)`. |
| `mobile/lib/e2ee/envelope.dart` (modify) | Seal `viewer_surface`. |
| `mobile/lib/phone/terminal_page.dart` (modify) | "Viewer" row in the agent sheet. |
| `mobile/test/surface/interactive_viewer_session_test.dart`, `mobile/test/surface/viewer_page_test.dart` (create), `mobile/test/core_units_test.dart` (modify) | Mobile tests. |

---

### Task 1: v2 request parsing (`surfaceFrame`, `surfaceScale`)

**Files:**
- Modify: `cli/src/lib/interactiveViewer.ts` (types and `surfaceFrame`, top of file)
- Test: `cli/src/lib/interactiveViewer.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Frame = { width: number; height: number; scale: number; mobile: boolean; touch: boolean
    dark: boolean; reload: boolean; commands: Command[]; copy: 'copy' | 'cut' | null }
  export const MAX_SURFACE_PIXELS = 4_200_000
  export function surfaceScale(width: number, height: number, asked: number): number
  export function surfaceFrame(payload: Record<string, unknown>): Frame | null
  ```
  `Command` stays `{ method: string; params: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing tests** — append inside `describe('interactive viewer input boundary', …)` in `cli/src/lib/interactiveViewer.spec.ts`, and add `surfaceScale` to the import:

```ts
  it('reads v2 geometry and lowers the scale to the pixel cap', () => {
    expect(surfaceFrame(frame({ width: 390, height: 844, scale: 3, mobile: true, touch: true })))
      .toMatchObject({ width: 390, height: 844, scale: 3, mobile: true, touch: true, copy: null })
    expect(surfaceFrame(frame())).toMatchObject({ scale: 1, mobile: false, touch: false })
    expect(surfaceFrame(frame({ width: 3840, height: 2160, scale: 2 }))!.scale).toBe(surfaceScale(3840, 2160, 2))
    expect(surfaceScale(3840, 2160, 2)).toBeLessThan(1)
    expect(surfaceScale(3840, 2160, 2) ** 2 * 3840 * 2160).toBeLessThanOrEqual(4_200_000)
    expect(surfaceScale(800, 600, 2)).toBe(2)
    expect(surfaceScale(160, 120, 3)).toBe(3)
  })
  it('maps touch, key commands, printable key text, paste-sized text and copy', () => {
    const parsed = surfaceFrame(frame({ width: 400, height: 800, events: [
      { type: 'touch', event: 'touchStart', points: [{ x: .5, y: .5, id: 0 }], modifiers: 0 },
      { type: 'touch', event: 'touchEnd', points: [], modifiers: 0 },
      { type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4, text: 'a', commands: ['selectAll'] },
      { type: 'text', text: 'x'.repeat(65_536) },
      { type: 'cut' },
    ] }))!
    expect(parsed.commands).toEqual([
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [{ x: 199.5, y: 399.5, id: 0 }], modifiers: 0 } },
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchEnd', touchPoints: [], modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, text: 'a', commands: ['selectAll'] } },
      { method: 'Input.insertText', params: { text: 'x'.repeat(65_536) } },
    ])
    expect(parsed.copy).toBe('cut')
  })
  it.each([
    { width: 3841 }, { height: 2401 }, { scale: 0 }, { scale: 4 }, { scale: '2' }, { mobile: 'yes' }, { touch: 1 },
    { events: [{ type: 'touch', event: 'touchStart', points: Array(6).fill({ x: 0, y: 0, id: 0 }), modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchStart', points: [{ x: 2, y: 0, id: 0 }], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchStart', points: [{ x: 0, y: 0, id: 99 }], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'pinch', points: [], modifiers: 0 }] },
    { events: [{ type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, commands: ['evaluate'] }] },
    { events: [{ type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'too long text' }] },
    { events: [{ type: 'key', event: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' }] },
    { events: [{ type: 'text', text: 'a'.repeat(65_537) }] },
  ])('rejects malformed v2 input without executing it: %j', extra => {
    expect(surfaceFrame(frame(extra))).toBeNull()
  })
```

Also change the existing v1 rejection row `{ events: [{ type: 'text', text: 'a'.repeat(4097) }] }` to `'a'.repeat(65_537)` (the cap moves to paste size).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts`
Expected: FAIL — `surfaceScale` is not exported; touch/copy events return `null`.

- [ ] **Step 3: Implement** — replace the top of `cli/src/lib/interactiveViewer.ts` (from `type Payload` through the end of `surfaceFrame`) with:

```ts
type Payload = Record<string, unknown>
type Command = { method: string; params: Payload }
export type Frame = { width: number; height: number; scale: number; mobile: boolean; touch: boolean
  dark: boolean; reload: boolean; commands: Command[]; copy: 'copy' | 'cut' | null }
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean'
// Editing commands a Mac only gets through CDP when named: ⌘A/⌘Z do nothing as bare key events.
const KEY_COMMANDS = new Set(['selectAll', 'copy', 'cut', 'paste', 'undo', 'redo'])
const TOUCH_EVENTS = ['touchStart', 'touchMove', 'touchEnd', 'touchCancel']
/** About 4K at scale 1, or a 1440×900 pane at scale 1.7: what one relay hop carries comfortably. */
export const MAX_SURFACE_PIXELS = 4_200_000

/** The client's pixel density, lowered until one frame fits [MAX_SURFACE_PIXELS]. */
export function surfaceScale(width: number, height: number, asked: number): number {
  const fit = Math.sqrt(MAX_SURFACE_PIXELS / (width * height))
  return Math.max(0.5, Math.floor(Math.min(asked, fit) * 100) / 100)
}

/** Viewers can request only navigation. Flutter additionally verifies the owning DSH and active tab. */
export function monitorHostActions(value: unknown): Payload[] {
  // (unchanged body)
}

/** Deliberately not a general CDP bridge: a browser can only send ordinary viewer input. */
export function surfaceFrame(payload: Payload): Frame | null {
  if (!integer(payload.width, 160, 3840) || !integer(payload.height, 120, 2400)
    || typeof payload.dark !== 'boolean' || !optionalBoolean(payload.reload)
    || !optionalBoolean(payload.mobile) || !optionalBoolean(payload.touch)
    || (payload.scale !== undefined && (typeof payload.scale !== 'number' || !(payload.scale >= 1 && payload.scale <= 3)))) return null
  const width = payload.width, height = payload.height
  const events = payload.events ?? []
  if (!Array.isArray(events) || events.length > 64) return null
  const commands: Command[] = []
  let copy: Frame['copy'] = null
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null
    if (event.type === 'text') {
      if (typeof event.text !== 'string' || !event.text.length || event.text.length > 65_536) return null
      commands.push({ method: 'Input.insertText', params: { text: event.text } })
    } else if (event.type === 'key') {
      if (!['keyDown', 'keyUp'].includes(event.event) || typeof event.key !== 'string'
        || event.key.length < 1 || event.key.length > 64 || typeof event.code !== 'string' || event.code.length > 64
        || !integer(event.keyCode, 0, 255) || !integer(event.modifiers, 0, 15)) return null
      if (event.text !== undefined && (event.event !== 'keyDown' || typeof event.text !== 'string'
        || !event.text.length || event.text.length > 8)) return null
      if (event.commands !== undefined && (!Array.isArray(event.commands) || event.commands.length > 4
        || !event.commands.every((c: unknown) => typeof c === 'string' && KEY_COMMANDS.has(c)))) return null
      const text = event.text ?? (event.event === 'keyDown' && event.key === 'Enter' ? '\r' : undefined)
      commands.push({ method: 'Input.dispatchKeyEvent', params: {
        type: event.event, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers, ...(text !== undefined ? { text } : {}),
        ...(event.commands?.length ? { commands: event.commands } : {}),
      } })
    } else if (event.type === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(event.event)
        || !coordinate(event.x) || !coordinate(event.y) || !integer(event.buttons, 0, 7)
        || !['none', 'left', 'right', 'middle'].includes(event.button) || !integer(event.modifiers, 0, 15)
        || !integer(event.clickCount, 0, 2)) return null
      const params: Payload = { type: event.event, x: event.x * (width - 1), y: event.y * (height - 1),
        buttons: event.buttons, button: event.button, modifiers: event.modifiers, clickCount: event.clickCount }
      if (event.event === 'mouseWheel') {
        if (typeof event.deltaX !== 'number' || !Number.isFinite(event.deltaX) || Math.abs(event.deltaX) > 2000
          || typeof event.deltaY !== 'number' || !Number.isFinite(event.deltaY) || Math.abs(event.deltaY) > 2000) return null
        params.deltaX = event.deltaX; params.deltaY = event.deltaY
      }
      commands.push({ method: 'Input.dispatchMouseEvent', params })
    } else if (event.type === 'touch') {
      if (!TOUCH_EVENTS.includes(event.event) || !integer(event.modifiers, 0, 15)
        || !Array.isArray(event.points) || event.points.length > 5) return null
      const touchPoints: Payload[] = []
      for (const point of event.points) {
        if (!point || typeof point !== 'object' || !coordinate(point.x) || !coordinate(point.y) || !integer(point.id, 0, 31)) return null
        touchPoints.push({ x: point.x * (width - 1), y: point.y * (height - 1), id: point.id })
      }
      commands.push({ method: 'Input.dispatchTouchEvent', params: { type: event.event, touchPoints, modifiers: event.modifiers } })
    } else if (event.type === 'copy' || event.type === 'cut') {
      copy = event.type
    } else return null
  }
  const scale = surfaceScale(width, height, typeof payload.scale === 'number' ? payload.scale : 1)
  return { width, height, scale, mobile: payload.mobile === true, touch: payload.touch === true,
    dark: payload.dark, reload: payload.reload === true, commands, copy }
}
```

(Keep `monitorHostActions` exactly as it is today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts`
Expected: PASS. The existing test "applies viewport/theme changes once" may now fail only if Task 2 has not landed — it does not touch `surfaceFrame` output beyond new fields, so it should still pass.

- [ ] **Step 5: Commit (only when the user asks)**

```bash
git add cli/src/lib/interactiveViewer.ts cli/src/lib/interactiveViewer.spec.ts
git commit -m "feat(viewer): v2 surface input — touch, key commands, copy, density"
```

---

### Task 2: The screencast "screen" in `InteractiveViewerCapture`

**Files:**
- Modify: `cli/src/sharing/viewer.ts` (message handler in `start`, ~line 74)
- Modify: `cli/src/lib/interactiveViewer.ts` (`InteractiveViewerCapture`)
- Test: `cli/src/lib/interactiveViewer.spec.ts`

**Interfaces:**
- Consumes: `Frame` from Task 1.
- Produces (on `InteractiveViewerCapture`):
  ```ts
  export interface Shot { seq: number; data: string }
  get frameSeq(): number                                  // newest frame's seq, 0 before any
  async apply(frame: Frame): Promise<void>                // viewport, touch, media, reload, input
  async frame(frame: Frame): Promise<string>              // v1: apply, then a screenshot (unchanged behaviour)
  async next(after: number, waitMs: number): Promise<Shot | null>  // newest frame with seq > after, or null
  wake(): void                                            // ends every waiting next() now
  async editable(): Promise<boolean>                      // focus is in a text field
  async selection(): Promise<string>                      // selected text, ≤ 1 000 000 chars
  async deleteSelection(): Promise<void>                  // Delete key, for cut in an editable field
  ```
  On `ViewerCapture`: `protected onEvent(method: string, params: Record<string, unknown>): void` (no-op by default).

- [ ] **Step 1: Write the failing tests** — append a new `describe` to `cli/src/lib/interactiveViewer.spec.ts`:

```ts
describe('interactive viewer screen', () => {
  const v2 = (extra = {}) => surfaceFrame(frame({ width: 400, height: 300, scale: 2, ...extra }))!
  const cast = (capture: InteractiveViewerCapture, data: string, sessionId: number) =>
    (capture as any).onEvent('Page.screencastFrame', { data, sessionId, metadata: {} })

  it('streams at the pane’s size and density, and acks a frame only when it is taken', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2({ mobile: true, touch: true }))
    const waiting = capture.next(0, 1000)
    await Promise.resolve()
    expect(call.mock.calls.map(c => c[0])).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmulatedMedia', 'Page.startScreencast',
    ])
    expect(call.mock.calls[0][1]).toEqual({ width: 400, height: 300, deviceScaleFactor: 2, mobile: true })
    expect(call.mock.calls[3][1]).toMatchObject({ format: 'jpeg', quality: 75, maxWidth: 800, maxHeight: 600 })
    cast(capture, 'one', 7)
    expect(await waiting).toEqual({ seq: 1, data: 'one' })
    expect(call).toHaveBeenLastCalledWith('Page.screencastFrameAck', { sessionId: 7 })
    expect(capture.frameSeq).toBe(1)
  })
  it('answers at once when a newer frame is already there, and null after the wait', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2())
    void capture.next(0, 1000); await Promise.resolve()
    cast(capture, 'one', 1)
    expect(await capture.next(0, 1000)).toEqual({ seq: 1, data: 'one' })
    const later = capture.next(1, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await later).toBeNull()
    vi.useRealTimers()
  })
  it('falls back to a screenshot when no screencast frame comes', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    vi.spyOn(capture, 'capture').mockResolvedValue('still')
    await capture.apply(v2())
    const first = capture.next(0, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toEqual({ seq: 1, data: 'still' })
    vi.useRealTimers()
  })
  it('restarts the screencast when the size changes, and wake() ends a waiting poll', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2())
    const waiting = capture.next(0, 60_000)
    await Promise.resolve()
    await capture.apply(v2({ width: 500 }))
    expect(call.mock.calls.slice(-3).map(c => c[0])).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast', 'Page.startScreencast'])
    capture.wake()
    expect(await waiting).toBeNull()
  })
  it('drops an oversized frame but keeps the stream moving', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    cast(capture, 'x'.repeat(2 * 1024 * 1024 + 1), 3)
    expect(capture.frameSeq).toBe(0)
    expect(call).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 3 })
  })
  it('reads focus and selection through bounded expressions only', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call')
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValueOnce({ result: { value: 'y'.repeat(1_000_100) } })
      .mockResolvedValue({})
    expect(await capture.editable()).toBe(true)
    expect(await capture.selection()).toHaveLength(1_000_000)
    await capture.deleteSelection()
    expect(call.mock.calls.slice(-2).map(c => (c[1] as any).type)).toEqual(['keyDown', 'keyUp'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts`
Expected: FAIL — `apply`, `next`, `wake`, `editable` are not functions; `onEvent` never called.

- [ ] **Step 3: Add the event hook to `ViewerCapture`** — in `cli/src/sharing/viewer.ts`, widen the message type and call the hook:

```ts
    this.ws.on('message', raw => {
      let message: { id?: number; method?: string; sessionId?: string; params?: Payload; result?: Payload; error?: unknown }
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.method === 'Page.loadEventFired' && message.sessionId === this.session) this.loaded?.()
      // Page events for subclasses (the interactive viewer's screencast). Only our page's session.
      if (message.method && message.sessionId === this.session) this.onEvent(message.method, message.params ?? {})
      const entry = this.pending.get(message.id ?? -1)
```

and add inside the class (next to `call`):

```ts
  /** A CDP event from this renderer's page. The read-only Share renderer needs none. */
  protected onEvent(_method: string, _params: Payload): void {}
```

- [ ] **Step 4: Implement the screen** — replace `InteractiveViewerCapture` in `cli/src/lib/interactiveViewer.ts` with:

```ts
export interface Shot { seq: number; data: string }

/** Separate from the read-only observer renderer. No cookies, profile, or app credentials. */
export class InteractiveViewerCapture extends ViewerCapture {
  private geometry = ''
  private size = { width: 1280, height: 800, scale: 1 }
  private dark: boolean | null = null
  private touch = false
  private casting = false
  private latest: Shot | null = null
  private seq = 0
  // The screencast frame Chrome waits on. Acked only when a surface takes it: Chrome sends the next
  // frame after the ack, so an unwatched page (a three.js scene drawing at 60 fps) costs nothing, and
  // the frame rate follows how fast the client reads.
  private unacked: number | null = null
  private waiters = new Set<() => void>()

  get frameSeq(): number { return this.seq }

  async takeHostActions(target: string): Promise<Payload[]> {
    // (unchanged body)
  }

  protected override onEvent(method: string, params: Payload): void {
    if (method !== 'Page.screencastFrame' || typeof params.sessionId !== 'number') return
    if (typeof params.data !== 'string' || params.data.length > 2 * 1024 * 1024) {
      // Too large for one reply: skip it, and ack so Chrome keeps sending smaller ones.
      void this.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      return
    }
    this.unacked = params.sessionId
    this.latest = { seq: ++this.seq, data: params.data }
    this.wake()
  }

  async apply(frame: Frame): Promise<void> {
    const geometry = `${frame.width}x${frame.height}@${frame.scale}${frame.mobile ? 'm' : ''}`
    if (geometry !== this.geometry) {
      await this.call('Emulation.setDeviceMetricsOverride', {
        width: frame.width, height: frame.height, deviceScaleFactor: frame.scale, mobile: frame.mobile,
      })
      this.geometry = geometry
      this.size = { width: frame.width, height: frame.height, scale: frame.scale }
      // maxWidth/maxHeight are fixed when a screencast starts: a new size needs a new screencast.
      if (this.casting) await this.cast()
    }
    if (frame.touch !== this.touch) {
      await this.call('Emulation.setTouchEmulationEnabled', { enabled: frame.touch, maxTouchPoints: frame.touch ? 5 : 1 })
      this.touch = frame.touch
    }
    if (frame.reload) await this.call('Page.reload')
    if (frame.dark !== this.dark || frame.reload) {
      await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: frame.dark ? 'dark' : 'light' }] })
      this.dark = frame.dark
    }
    for (const command of frame.commands) await this.call(command.method, command.params)
  }

  /** v1: one request, one screenshot — what a client that predates `after` still gets. */
  async frame(frame: Frame): Promise<string> {
    await this.apply(frame)
    return this.capture()
  }

  private async cast(): Promise<void> {
    if (this.casting) await this.call('Page.stopScreencast')
    this.unacked = null
    await this.call('Page.startScreencast', { format: 'jpeg', quality: 75,
      maxWidth: Math.round(this.size.width * this.size.scale), maxHeight: Math.round(this.size.height * this.size.scale) })
    this.casting = true
  }

  async next(after: number, waitMs: number): Promise<Shot | null> {
    if (!this.casting) await this.cast()
    let woken = false
    if (!this.latest || this.latest.seq <= after) {
      woken = await new Promise<boolean>(resolve => {
        const done = (byWake: boolean) => { clearTimeout(timer); this.waiters.delete(wake); resolve(byWake) }
        const wake = () => done(true)
        const timer = setTimeout(() => done(false), waitMs)
        this.waiters.add(wake)
      })
    }
    // A page that has not painted since the screencast started sends nothing: once the wait runs
    // out (not when a newer poll or a close ended it), show the page as it is.
    if (!this.latest && !woken) this.latest = { seq: ++this.seq, data: await this.capture() }
    const shot = this.latest
    if (!shot || shot.seq <= after) return null
    if (this.unacked !== null) {
      const sessionId = this.unacked; this.unacked = null
      void this.call('Page.screencastFrameAck', { sessionId }).catch(() => {})
    }
    return shot
  }

  wake(): void {
    for (const done of [...this.waiters]) done()
  }

  private async evaluate(expression: string): Promise<unknown> {
    const reply = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    return (reply.result as { value?: unknown } | undefined)?.value
  }

  async editable(): Promise<boolean> {
    return await this.evaluate(`(() => { const e = document.activeElement; if (!e) return false;
      if (e.isContentEditable || e.tagName === 'TEXTAREA') return true;
      return e.tagName === 'INPUT' && !['button','checkbox','radio','submit','reset','file','image','range','color','hidden'].includes(e.type) })()`) === true
  }

  async selection(): Promise<string> {
    const value = await this.evaluate(`(() => { const e = document.activeElement;
      if (e && typeof e.value === 'string' && typeof e.selectionStart === 'number') return e.value.slice(e.selectionStart, e.selectionEnd);
      return String(getSelection() ?? '') })()`)
    return typeof value === 'string' ? value.slice(0, 1_000_000) : ''
  }

  async deleteSelection(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, modifiers: 0 })
    }
  }
}
```

Note: the "falls back to a screenshot" test passes because `capture()` (mocked) is used when no screencast frame arrived during the wait. The existing test "applies viewport/theme changes once" stays green: with `touch:false` and `scale:1` the first call list is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts src/sharing/viewer.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit (only when the user asks)**

```bash
git add cli/src/sharing/viewer.ts cli/src/lib/interactiveViewer.ts cli/src/lib/interactiveViewer.spec.ts
git commit -m "feat(viewer): stream the surface by screencast, acked when read"
```

---

### Task 3: v2 request rules in `InteractiveViewers`

**Files:**
- Modify: `cli/src/lib/interactiveViewer.ts` (`Surface`, `InteractiveViewers`)
- Test: `cli/src/lib/interactiveViewer.spec.ts` (`describe('owner viewer sessions', …)`)

**Interfaces:**
- Consumes: `Frame`, `surfaceFrame` (Task 1); `apply`, `frame`, `next`, `wake`, `frameSeq`, `editable`, `selection`, `deleteSelection`, `takeHostActions`, `start`, `stop` (Task 2).
- Produces the wire contract:
  - `op:'frame'` without `after` → v1 reply `{data, mime:'image/jpeg', width, height, hostActions}` **plus** `seq` and `scale`; overlapping v1 frames → `VIEWER_BUSY`.
  - `op:'frame'` with `after: integer ≥ 0` → `{data, mime, width, height, scale, seq, hostActions}` or `{seq, unchanged: true}`; a newer poll on the same surface ends the older one with `unchanged`.
  - `op:'input'` → `{ok: true, seq, editable, clipboard?}`; `VIEWER_BUSY` only when more than 256 events are queued.
  - Errors unchanged: `INVALID_VIEWER_REQUEST`, `VIEWER_UNAVAILABLE`, `VIEWER_LIMIT`, `VIEWER_CLOSED`.

- [ ] **Step 1: Write the failing tests** — in `describe('owner viewer sessions', …)`, extend the fake capture in `beforeEach` and add tests:

```ts
  // in beforeEach, replace the capture literal with:
      const capture = { start: vi.fn(async () => {}), frame: vi.fn(async () => 'jpeg'), apply: vi.fn(async () => {}),
        next: vi.fn(async (_after: number) => ({ seq: 1, data: 'cast' }) as { seq: number; data: string } | null),
        wake: vi.fn(), frameSeq: 1, editable: vi.fn(async () => false), selection: vi.fn(async () => 'picked'),
        deleteSelection: vi.fn(async () => {}), takeHostActions: vi.fn(async () => []), stop: vi.fn(async () => {}) }
```

```ts
  it('keeps v1 semantics without after, and says its seq and scale', async () => {
    expect(await viewers.request('one', frame())).toEqual({ data: 'jpeg', mime: 'image/jpeg', width: 800, height: 600, scale: 1, seq: 1, hostActions: [] })
    expect(captures[0].frame).toHaveBeenCalledOnce()
    expect(captures[0].next).not.toHaveBeenCalled()
  })
  it('long-polls with after and reports the scale it applied', async () => {
    expect(await viewers.request('one', frame({ after: 0, width: 3840, height: 2160, scale: 2 })))
      .toMatchObject({ data: 'cast', seq: 1, width: 3840, height: 2160, scale: expect.any(Number) })
    const reply = await viewers.request('one', frame({ after: 0, width: 3840, height: 2160, scale: 2 }))
    expect(reply.scale).toBeLessThan(1)
    expect(captures[0].next).toHaveBeenCalledWith(0, 1000)
    captures[0].next.mockResolvedValueOnce(null)
    expect(await viewers.request('one', frame({ after: 1 }))).toEqual({ seq: 1, unchanged: true })
  })
  it('a newer poll ends the older one; input runs while a poll waits', async () => {
    await viewers.request('one', frame({ after: 0 }))
    let release!: (shot: { seq: number; data: string } | null) => void
    captures[0].next.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    const input = await viewers.request('one', frame({ op: 'input', events: [{ type: 'text', text: 'hi' }] }))
    expect(input).toEqual({ ok: true, seq: 1, editable: false })
    expect(captures[0].apply).toHaveBeenLastCalledWith(expect.objectContaining({ commands: [{ method: 'Input.insertText', params: { text: 'hi' } }] }))
    const newer = viewers.request('one', frame({ after: 1 }))
    expect(captures[0].wake).toHaveBeenCalled()
    release({ seq: 2, data: 'late' })
    expect(await older).toEqual({ seq: 1, unchanged: true })
    expect(await newer).toMatchObject({ data: 'cast' })
  })
  it('copies and cuts the selection, deleting only in an editable field', async () => {
    await viewers.request('one', frame({ after: 0 }))
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'copy' }] }))).toMatchObject({ clipboard: 'picked' })
    expect(captures[0].deleteSelection).not.toHaveBeenCalled()
    captures[0].editable.mockResolvedValue(true)
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'cut' }] }))).toMatchObject({ clipboard: 'picked', editable: true })
    expect(captures[0].deleteSelection).toHaveBeenCalledOnce()
  })
  it('refuses input only when too much is queued', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].apply.mockImplementation(() => new Promise(() => {}))
    const sixtyFour = Array(64).fill({ type: 'text', text: 'x' })
    for (let i = 0; i < 4; i++) void viewers.request('one', frame({ op: 'input', events: sixtyFour }))
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'text', text: 'x' }] }))).toHaveProperty('error', 'VIEWER_BUSY')
  })
  it('a waiting poll ends when its surface closes', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].next.mockImplementationOnce(() => new Promise(resolve => { captures[0].wake.mockImplementationOnce(() => resolve(null)) }))
    const waiting = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    viewers.closeConnection('one')
    expect(await waiting).toHaveProperty('error', 'VIEWER_CLOSED')
    expect(captures[0].stop).toHaveBeenCalledOnce()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts`
Expected: FAIL — v1 reply lacks `seq`/`scale`; `op:'input'` is `INVALID_VIEWER_REQUEST`.

- [ ] **Step 3: Implement** — replace `interface Surface` and `InteractiveViewers.request`/`remove` in `cli/src/lib/interactiveViewer.ts`:

```ts
interface Surface {
  connId: string
  agentId: string
  target: string
  capture: InteractiveViewerCapture
  starting: Promise<void> | null
  busy: boolean            // a v1 frame is in flight: v1 clients pull one frame at a time
  chain: Promise<unknown>  // every CDP command for this surface, in order
  queued: number           // input events waiting on the chain
  poll: number             // the newest frame poll; an older one answers `unchanged`
  actionsAt: number
  timer: NodeJS.Timeout
}

/** Owner-only, bounded renderers. One frame in flight per surface, so a slow client cannot accumulate JPEGs. */
export class InteractiveViewers {
  private readonly surfaces = new Map<string, Surface>()
  constructor(private readonly target: (agentId: string) => string | null,
    private readonly create = () => new InteractiveViewerCapture()) {}

  async request(connId: string, payload: Payload): Promise<Payload> {
    const { surfaceId, agentId, op } = payload
    if (typeof surfaceId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(surfaceId)
      || typeof agentId !== 'string' || !agentId.length || agentId.length > 160
      || !['frame', 'input', 'close'].includes(String(op))
      || (payload.after !== undefined && !integer(payload.after, 0, Number.MAX_SAFE_INTEGER))) return { error: 'INVALID_VIEWER_REQUEST' }
    const key = `${connId}/${surfaceId}`
    let surface = this.surfaces.get(key)
    if (surface && surface.agentId !== agentId) return { error: 'INVALID_VIEWER_REQUEST' }
    if (op === 'close') { this.remove(key); return { closed: true } }
    const frame = surfaceFrame(payload)
    if (!frame) return { error: 'INVALID_VIEWER_REQUEST' }
    const target = viewerTarget(this.target(agentId))
    if (!target) { this.remove(key); return { error: 'VIEWER_UNAVAILABLE', detail: 'This harness has no live viewer yet.' } }
    if (surface && surface.target !== target) { this.remove(key); surface = undefined }
    if (!surface) {
      if (this.surfaces.size >= 8 || [...this.surfaces.values()].filter(s => s.connId === connId).length >= 4) {
        return { error: 'VIEWER_LIMIT', detail: 'Close another viewer to open this one.' }
      }
      surface = { connId, agentId, target, capture: this.create(), starting: null, busy: false,
        chain: Promise.resolve(), queued: 0, poll: 0, actionsAt: 0, timer: setTimeout(() => this.remove(key), 30_000) }
      surface.timer.unref()
      this.surfaces.set(key, surface)
    }
    surface.timer.refresh()
    const live = surface
    const gone = () => this.surfaces.get(key) !== live
    // Through the chain: input and a frame poll's viewport change must reach Chrome in arrival order.
    const run = <T>(work: () => Promise<T>): Promise<T> => {
      const result = live.chain.then(work)
      live.chain = result.catch(() => {})
      return result
    }
    try {
      if (op === 'input') {
        if (live.queued + frame.commands.length > 256) return { error: 'VIEWER_BUSY' }
        live.queued += frame.commands.length
        try {
          await (live.starting ??= live.capture.start(target))
          const reply = await run(async () => {
            await live.capture.apply(frame)
            const clipboard = frame.copy ? await live.capture.selection() : undefined
            const editable = await live.capture.editable()
            if (frame.copy === 'cut' && editable) await live.capture.deleteSelection()
            return { ok: true, seq: live.capture.frameSeq, editable, ...(clipboard !== undefined ? { clipboard } : {}) }
          })
          return gone() ? { error: 'VIEWER_CLOSED' } : reply
        } finally { live.queued -= frame.commands.length }
      }
      if (payload.after === undefined) {
        // v1: the client predates long-polling and pulls one frame at a time.
        if (live.busy) return { error: 'VIEWER_BUSY' }
        live.busy = true
        try {
          await (live.starting ??= live.capture.start(target))
          if (gone()) return { error: 'VIEWER_CLOSED' }
          const data = await run(() => live.capture.frame(frame))
          const hostActions = await live.capture.takeHostActions(target)
          if (gone()) return { error: 'VIEWER_CLOSED' }
          return { data, mime: 'image/jpeg', width: frame.width, height: frame.height, scale: frame.scale, seq: live.capture.frameSeq, hostActions }
        } finally { live.busy = false }
      }
      const poll = ++live.poll
      live.capture.wake()
      await (live.starting ??= live.capture.start(target))
      await run(() => live.capture.apply(frame))
      const shot = await live.capture.next(Number(payload.after), 1000)
      if (gone()) return { error: 'VIEWER_CLOSED' }
      if (poll !== live.poll || !shot) return { seq: live.capture.frameSeq, unchanged: true }
      // The host queue is the Monitor's navigation; twice a second is plenty, and each read is a CDP round trip.
      let hostActions: Payload[] = []
      if (Date.now() - live.actionsAt >= 500) { live.actionsAt = Date.now(); hostActions = await live.capture.takeHostActions(target) }
      return { data: shot.data, mime: 'image/jpeg', width: frame.width, height: frame.height, scale: frame.scale, seq: shot.seq, hostActions }
    } catch (error) {
      if (!gone()) this.remove(key)
      return { error: 'VIEWER_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The viewer could not start.' }
    }
  }

  private remove(key: string): void {
    const surface = this.surfaces.get(key)
    if (!surface) return
    this.surfaces.delete(key); clearTimeout(surface.timer)
    surface.capture.wake()
    void surface.capture.stop().catch(() => {})
  }
  // refresh, closeConnection, closeAll: unchanged
}
```

Update the existing test "refuses overlapping captures and never returns a frame after disconnect" only if needed: it uses v1 frames (no `after`), so `VIEWER_BUSY` and `VIEWER_CLOSED` behave as before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.spec.ts && npx vitest run src/services/viewers.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (only when the user asks)**

```bash
git add cli/src/lib/interactiveViewer.ts cli/src/lib/interactiveViewer.spec.ts
git commit -m "feat(viewer): long-poll frames and immediate input on the surface"
```

---

### Task 4: Real-Chrome check

**Files:**
- Create: `cli/src/lib/interactiveViewer.chrome.spec.ts`

**Interfaces:**
- Consumes: `InteractiveViewerCapture`, `surfaceFrame` (Tasks 1–3); `viewerBrowser` from `cli/src/sharing/viewer.ts`.

- [ ] **Step 1: Write the test** (it is the deliverable; it runs only where Chrome is installed):

```ts
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { viewerBrowser } from '../sharing/viewer.js'
import { InteractiveViewerCapture, surfaceFrame } from './interactiveViewer.js'

// A page that turns green when clicked: proof that input reached Chrome and the stream moved on.
const PAGE = `<!doctype html><body style="margin:0;background:#c00" onclick="document.body.style.background='#0c0'">
<input id=f autofocus></body>`

describe.skipIf(!viewerBrowser())('interactive viewer against real Chrome', () => {
  let server: Server, url = ''
  const capture = new InteractiveViewerCapture()
  beforeAll(async () => {
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    await capture.start(url)
  }, 30_000)
  afterAll(async () => { await capture.stop(); server.close() })

  const frame = (extra = {}) => surfaceFrame({ width: 400, height: 300, dark: false, scale: 2, ...extra })!
  const size = (jpeg: string) => {
    const bytes = Buffer.from(jpeg, 'base64')
    for (let i = 2; i < bytes.length;) {          // walk JPEG segments to the SOF0/SOF2 header
      const marker = bytes[i + 1], length = bytes.readUInt16BE(i + 2)
      if (marker === 0xc0 || marker === 0xc2) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
      i += 2 + length
    }
    throw new Error('no JPEG size')
  }

  it('streams at twice the pixels for scale 2, and a tap changes the next frame', async () => {
    await capture.apply(frame())
    const first = (await capture.next(0, 3000))!
    expect(size(first.data)).toEqual({ width: 800, height: 600 })
    await capture.apply(frame({ events: [
      { type: 'pointer', event: 'mousePressed', x: .5, y: .5, buttons: 1, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'pointer', event: 'mouseReleased', x: .5, y: .5, buttons: 0, button: 'left', clickCount: 1, modifiers: 0 },
    ] }))
    const next = (await capture.next(first.seq, 3000))!
    expect(next.seq).toBeGreaterThan(first.seq)
    expect(next.data).not.toBe(first.data)
    expect(await capture.editable()).toBe(true)
  }, 30_000)
})
```

- [ ] **Step 2: Run it**

Run: `cd cli && npx vitest run src/lib/interactiveViewer.chrome.spec.ts`
Expected: PASS on a machine with Chrome (macOS dev machines have it); "skipped" in CI without Chrome. If the click does not change the frame, check that `next()` acks the first frame before waiting (Task 2) — an unacked frame stops the screencast.

- [ ] **Step 3: Commit (only when the user asks)**

```bash
git add cli/src/lib/interactiveViewer.chrome.spec.ts
git commit -m "test(viewer): screencast density and input against real Chrome"
```

---

### Task 5: Desktop and web session v2

**Files:**
- Modify: `desktop/lib/viewer/interactive_viewer.dart`
- Test: `desktop/test/interactive_viewer_test.dart`

**Interfaces:**
- Consumes: the wire contract of Task 3.
- Produces (Dart, copied verbatim into mobile by Task 6):
  ```dart
  InteractiveViewerSession(ViewerSurfaceRequest request, {void Function(Map<String, dynamic>)? onHostAction,
      void Function(String text)? onClipboard, bool mobile = false, bool touch = false});
  void configure(Size size, bool dark, {double scale = 1});
  void input(Map<String, dynamic> event);
  void reload();
  bool get isV2;          // the machine answered with `seq`
  bool editable;          // focus is in a text field on the page (v2 only)
  Uint8List? image; String? error;
  ```

- [ ] **Step 1: Write the failing tests** — append to `desktop/test/interactive_viewer_test.dart`:

```dart
  Map<String, dynamic> streamed(int seq) => {...picture(), 'seq': seq, 'scale': 2};

  testWidgets('stays inside v1 until the machine answers with seq', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) async {
      requests.add(payload);
      return picture();
    });
    session.configure(const Size(3000, 2000), true, scale: 2);
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.first['width'], 1920);
    expect(requests.first['height'], 1200);
    expect(requests.first.containsKey('after'), isFalse);
    expect(session.isV2, isFalse);
    session.dispose();
  });

  testWidgets('long-polls after seq and sends input as its own request', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final polls = <Completer<Map<String, dynamic>>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1, 'editable': true});
      final reply = Completer<Map<String, dynamic>>();
      polls.add(reply);
      return reply.future;
    });
    session.configure(const Size(800, 600), true, scale: 2);
    await tester.pump(const Duration(milliseconds: 1));
    polls[0].complete(streamed(1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.isV2, isTrue);
    expect(requests.last, containsPair('after', 1));
    expect(requests.last, containsPair('scale', 2.0));
    session.input({'type': 'text', 'text': 'hi'});
    await tester.pump(const Duration(milliseconds: 1));
    final input = requests.lastWhere((r) => r['op'] == 'input');
    expect(input['events'], [{'type': 'text', 'text': 'hi'}]);
    expect(session.editable, isTrue);
    polls.last.complete({'seq': 1, 'unchanged': true});
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.last['op'], 'frame');
    session.dispose();
  });

  testWidgets('a resize goes out as an empty input, debounced', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1});
      if (requests.where((r) => r['op'] == 'frame').length == 1) return Future.value(streamed(1));
      return Completer<Map<String, dynamic>>().future; // a poll that keeps waiting
    });
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    session.configure(const Size(900, 600), true);
    session.configure(const Size(1000, 600), true);
    await tester.pump(const Duration(milliseconds: 50));
    expect(requests.where((r) => r['op'] == 'input'), isEmpty);
    await tester.pump(const Duration(milliseconds: 100));
    final resize = requests.where((r) => r['op'] == 'input').toList();
    expect(resize, hasLength(1));
    expect(resize.single['width'], 1000);
    expect(resize.single['events'], isEmpty);
    session.dispose();
  });

  testWidgets('a copied selection lands on the clipboard callback', (tester) async {
    final copied = <String>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1, 'clipboard': 'hello'});
      if (payload['op'] == 'close') return Future.value({'closed': true});
      return payload.containsKey('after') ? Completer<Map<String, dynamic>>().future : Future.value(streamed(1));
    }, onClipboard: copied.add);
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    session.input({'type': 'copy'});
    await tester.pump(const Duration(milliseconds: 1));
    expect(copied, ['hello']);
    session.dispose();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && flutter test test/interactive_viewer_test.dart`
Expected: FAIL — `configure` has no `scale`, `isV2`/`editable`/`onClipboard` are undefined.

- [ ] **Step 3: Implement the session** — replace `InteractiveViewerSession` in `desktop/lib/viewer/interactive_viewer.dart` with:

```dart
/// One frame request in flight at a time bounds both rendering and network work.
///
/// A v1 machine answers each request with one frame. A v2 machine (its replies carry `seq`,
/// cli/src/lib/interactiveViewer.ts) long-polls frames — `after: seq` waits up to a second for a
/// newer one — and takes input as its own request, so a tap is not stuck behind a frame. Until the
/// machine has answered with `seq`, requests stay inside v1's bounds: an older machine refuses
/// anything larger. Input is connection-local: a failed request is never replayed.
class InteractiveViewerSession extends ChangeNotifier {
  InteractiveViewerSession(
    this.request, {
    this.onHostAction,
    this.onClipboard,
    this.mobile = false,
    this.touch = false,
  });
  final ViewerSurfaceRequest request;
  final void Function(Map<String, dynamic>)? onHostAction;
  final void Function(String text)? onClipboard;
  final bool mobile, touch;
  final String id = hexOf(secureRandomBytes(16));
  Uint8List? image;
  String? error;
  bool editable = false;
  bool Function()? focusInput;
  final _events = <Map<String, dynamic>>[];
  Timer? _timer, _resize;
  bool _disposed = false, _busy = false, _reload = false, _sending = false;
  int _width = 0, _height = 0;
  double _scale = 1;
  bool _dark = true;
  Size _asked = Size.zero;
  double _askedScale = 1;
  int? _seq;

  bool get isV2 => _seq != null;

  Map<String, dynamic> get _shape => {
    'surfaceId': id,
    'width': _width,
    'height': _height,
    'dark': _dark,
    'scale': _scale,
    'mobile': mobile,
    'touch': touch,
  };

  void configure(Size size, bool dark, {double scale = 1}) {
    if (_disposed || size.isEmpty) return;
    _asked = size;
    _askedScale = scale;
    final width = size.width.round().clamp(160, isV2 ? 3840 : 1920);
    final height = size.height.round().clamp(120, isV2 ? 2400 : 1200);
    final density = isV2 ? scale.clamp(1.0, 3.0) : 1.0;
    final changed = width != _width ||
        height != _height ||
        density != _scale ||
        dark != _dark;
    _width = width;
    _height = height;
    _scale = density;
    _dark = dark;
    if (!isV2) {
      if (!_busy && _timer == null) _schedule(Duration.zero);
      return;
    }
    if (!changed) return;
    // A frame poll may wait a second: send the new size at once as an empty input, once the drag settles.
    _resize?.cancel();
    _resize = Timer(const Duration(milliseconds: 100), () => unawaited(_flush(force: true)));
  }

  void input(Map<String, dynamic> event) {
    if (_disposed || error != null || image == null) return;
    // Motion can be coalesced, but never across a press, a release or a key.
    final moving = event['event'] == 'mouseMoved' || event['event'] == 'touchMove';
    if (moving && _events.isNotEmpty && _events.last['event'] == event['event']) {
      _events[_events.length - 1] = event;
    } else if (_events.length < 64) {
      _events.add(event);
    } else {
      _events.clear();
      error = 'The connection is too slow. Reconnect the viewer and try again.';
      _timer?.cancel();
      _timer = null;
      notifyListeners();
      return;
    }
    if (isV2) {
      unawaited(_flush());
    } else if (!_busy) {
      _schedule(Duration.zero);
    }
  }

  void reload() {
    if (_disposed) return;
    error = null;
    _events.clear();
    _reload = true;
    notifyListeners();
    if (!_busy) _schedule(Duration.zero);
  }

  void _schedule(Duration delay) {
    _timer?.cancel();
    _timer = Timer(delay, () {
      _timer = null;
      unawaited(_frame());
    });
  }

  String _failure(Object e) => switch (e) {
    WsRequestTimeout() =>
      'Update Harness on this machine to use its viewer in the browser.',
    WsRequestFailure(code: 'UNSUPPORTED') =>
      'Update Harness on this machine to use its viewer in the browser.',
    WsRequestFailure(:final detail) when detail?.trim().isNotEmpty == true =>
      detail!,
    _ => 'The viewer disconnected. Reconnect and try again.',
  };

  Future<void> _flush({bool force = false}) async {
    if (_disposed || _sending || error != null || (_events.isEmpty && !force)) {
      return;
    }
    _sending = true;
    final events = List<Map<String, dynamic>>.of(_events);
    _events.clear();
    try {
      final reply = await request({..._shape, 'op': 'input', 'events': events});
      if (_disposed) return;
      if (reply['error'] != null) {
        error = reply['detail'] as String? ?? 'The viewer is unavailable. Try again.';
        notifyListeners();
        return;
      }
      final nowEditable = reply['editable'] == true;
      if (nowEditable != editable) {
        editable = nowEditable;
        notifyListeners();
      }
      final text = reply['clipboard'];
      if (text is String) {
        (onClipboard ?? (t) => Clipboard.setData(ClipboardData(text: t)))(text);
      }
    } catch (e) {
      if (!_disposed) {
        error = _failure(e);
        notifyListeners();
      }
    } finally {
      _sending = false;
      if (!_disposed && _events.isNotEmpty) unawaited(_flush());
    }
  }

  Future<void> _frame() async {
    if (_disposed || _busy || _width == 0 || error != null) return;
    _busy = true;
    final wasV2 = isV2;
    final events = wasV2 ? const <Map<String, dynamic>>[] : List<Map<String, dynamic>>.of(_events);
    if (!wasV2) _events.clear();
    final reload = _reload;
    _reload = false;
    try {
      final reply = await request({
        ..._shape,
        'op': 'frame',
        'reload': reload,
        'events': events,
        if (wasV2) 'after': _seq,
      });
      if (_disposed) return;
      if (reply['error'] != null) {
        error = reply['detail'] as String? ?? 'The viewer is unavailable. Try again.';
      } else {
        final seq = reply['seq'];
        if (seq is int) _seq = seq;
        if (reply['unchanged'] != true) {
          if (reply['mime'] != 'image/jpeg' ||
              reply['data'] is! String ||
              (reply['data'] as String).length > 2 * 1024 * 1024) {
            error = 'The viewer sent an invalid image.';
          } else {
            image = base64Decode(reply['data'] as String);
            final actions = reply['hostActions'];
            if (actions is List && actions.length <= 8) {
              for (final action in actions) {
                if (action is Map<String, dynamic>) onHostAction?.call(action);
              }
            }
          }
        }
        // Just proved v2: widen to the pane's real size and density.
        if (!wasV2 && isV2) configure(_asked, _dark, scale: _askedScale);
      }
    } catch (e) {
      if (!_disposed) error = _failure(e);
    } finally {
      _busy = false;
      if (!_disposed) {
        notifyListeners();
        if (error == null) {
          if (isV2 && _events.isNotEmpty) unawaited(_flush());
          _schedule(
            isV2 || _events.isNotEmpty || _reload
                ? Duration.zero
                : const Duration(milliseconds: 160),
          );
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _resize?.cancel();
    _events.clear();
    unawaited(
      request({'surfaceId': id, 'op': 'close'})
          .catchError((_) => <String, dynamic>{}),
    );
    super.dispose();
  }
}
```

- [ ] **Step 4: Pass density and add editing shortcuts in `_InteractiveViewerState`**

In `build`, change the `configure` call to:

```dart
        widget.session.configure(
          _size,
          grid.AppTheme.brightness.value == Brightness.dark,
          scale: MediaQuery.devicePixelRatioOf(context),
        );
```

At the top of `_onKey`, before the Alt/Meta early return, add:

```dart
    final keys = HardwareKeyboard.instance;
    final mac = defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    // The page's own copy/paste never reaches this computer's clipboard (Chrome runs on the
    // machine), so the editing shortcuts go through the surface. v2 machines only: a v1 machine
    // refuses the copy/cut events and key commands.
    if (widget.session.isV2 &&
        event is KeyDownEvent &&
        (mac ? keys.isMetaPressed : keys.isControlPressed)) {
      final shortcut = _shortcut(event.logicalKey, keys.isShiftPressed);
      if (shortcut != null) {
        shortcut();
        return KeyEventResult.handled;
      }
    }
```

and add the method:

```dart
  VoidCallback? _shortcut(LogicalKeyboardKey key, bool shift) {
    final session = widget.session;
    void command(String letter, String name) {
      for (final down in [true, false]) {
        session.input({
          'type': 'key',
          'event': down ? 'keyDown' : 'keyUp',
          'key': letter,
          'code': 'Key${letter.toUpperCase()}',
          'keyCode': letter.toUpperCase().codeUnitAt(0),
          'modifiers': _modifiers,
          if (down) 'commands': [name],
        });
      }
    }
    if (key == LogicalKeyboardKey.keyC) return () => session.input({'type': 'copy'});
    if (key == LogicalKeyboardKey.keyX) return () => session.input({'type': 'cut'});
    if (key == LogicalKeyboardKey.keyV) {
      return () async {
        final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
        if (text == null || text.isEmpty) return;
        session.input({'type': 'text', 'text': text.length > 65536 ? text.substring(0, 65536) : text});
      };
    }
    if (key == LogicalKeyboardKey.keyA) return () => command('a', 'selectAll');
    if (key == LogicalKeyboardKey.keyZ) return () => command('z', shift ? 'redo' : 'undo');
    return null;
  }
```

(`defaultTargetPlatform` comes from `package:flutter/foundation.dart`, already exported by `material.dart`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && flutter test test/interactive_viewer_test.dart test/viewer_page_test.dart && flutter analyze lib/viewer`
Expected: PASS, no analyzer issues.

- [ ] **Step 6: Commit (only when the user asks)**

```bash
git add desktop/lib/viewer/interactive_viewer.dart desktop/test/interactive_viewer_test.dart
git commit -m "feat(desktop): stream the viewer surface at the pane's size and density"
```

---

### Task 6: Mobile session and touch surface

**Files:**
- Create: `mobile/lib/surface/interactive_viewer_session.dart`
- Create: `mobile/lib/surface/touch_viewer_surface.dart`
- Test: `mobile/test/surface/interactive_viewer_session_test.dart`

**Interfaces:**
- Consumes: the session API of Task 5 (copied).
- Produces:
  ```dart
  // interactive_viewer_session.dart: identical InteractiveViewerSession and ViewerSurfaceRequest
  class TouchViewerSurface extends StatefulWidget {
    const TouchViewerSurface({super.key, required this.session});
    final InteractiveViewerSession session;
  }
  ```

- [ ] **Step 1: Create the session file** — `mobile/lib/surface/interactive_viewer_session.dart`:

```dart
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../e2ee/bytes.dart';
import '../ws/ws_conn.dart';

typedef ViewerSurfaceRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

// Copied from desktop/lib/viewer/interactive_viewer.dart's InteractiveViewerSession — there is no
// shared Dart package. Keep the two identical in logic; change both together.
```

followed by the exact `InteractiveViewerSession` class from Task 5 Step 3 (no widget code, no terminal-text imports).

- [ ] **Step 2: Write the failing tests** — `mobile/test/surface/interactive_viewer_session_test.dart`:

```dart
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/surface/interactive_viewer_session.dart';
import 'package:harness_mobile/surface/touch_viewer_surface.dart';

Map<String, dynamic> streamed(int seq) => {
  'data': base64Encode([1, 2, 3]),
  'mime': 'image/jpeg',
  'width': 390,
  'height': 700,
  'scale': 3,
  'seq': seq,
};

void main() {
  testWidgets('a phone surface asks for mobile layout and touch', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      return payload.containsKey('after')
          ? Completer<Map<String, dynamic>>().future
          : Future.value(streamed(1));
    }, mobile: true, touch: true);
    session.configure(const Size(390, 700), true, scale: 3);
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.first, containsPair('mobile', true));
    expect(requests.first, containsPair('touch', true));
    expect(requests.last, containsPair('scale', 3.0));
    session.dispose();
  });

  testWidgets('a drag becomes touch events with moves coalesced', (tester) async {
    final inputs = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'input') {
        inputs.addAll((payload['events'] as List).cast<Map<String, dynamic>>());
        return Future.value({'ok': true, 'seq': 1});
      }
      if (payload['op'] == 'close') return Future.value({'closed': true});
      return payload.containsKey('after')
          ? Completer<Map<String, dynamic>>().future
          : Future.value(streamed(1));
    }, mobile: true, touch: true);
    await tester.pumpWidget(MaterialApp(
      home: SizedBox(width: 390, height: 700, child: TouchViewerSurface(session: session)),
    ));
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
    final gesture = await tester.startGesture(const Offset(195, 350));
    await gesture.moveBy(const Offset(0, -40));
    await gesture.moveBy(const Offset(0, -40));
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 1));
    final kinds = inputs.map((e) => e['event']).toList();
    expect(kinds.first, 'touchStart');
    expect(kinds.last, 'touchEnd');
    expect(inputs.last['points'], isEmpty);
    expect(inputs.every((e) => e['type'] == 'touch'), isTrue);
    session.dispose();
  });
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && flutter test test/surface/interactive_viewer_session_test.dart`
Expected: FAIL — `touch_viewer_surface.dart` does not exist.

- [ ] **Step 4: Implement the surface** — `mobile/lib/surface/touch_viewer_surface.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
// The same IME input adapter the phone's terminal uses.
// ignore: implementation_imports
import 'package:xterm/src/ui/custom_text_edit.dart';

import 'interactive_viewer_session.dart';

/// A remote page under the finger: touches go to Chrome as touches (the page scrolls and pinches
/// itself, with `touch: true` it believes it is on a phone), and the keyboard comes up when the page
/// focuses a text field.
class TouchViewerSurface extends StatefulWidget {
  const TouchViewerSurface({super.key, required this.session});
  final InteractiveViewerSession session;
  @override
  State<TouchViewerSurface> createState() => _TouchViewerSurfaceState();
}

class _TouchViewerSurfaceState extends State<TouchViewerSurface> {
  final _focus = FocusNode();
  final _editor = GlobalKey<CustomTextEditState>();
  final _points = <int, Offset>{};
  Size _size = Size.zero;
  bool _keyboard = false;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_followFocus);
  }

  @override
  void dispose() {
    widget.session.removeListener(_followFocus);
    _focus.dispose();
    super.dispose();
  }

  // The page decides when typing makes sense: show the keyboard while a text field has focus.
  void _followFocus() {
    if (widget.session.editable == _keyboard) return;
    _keyboard = widget.session.editable;
    if (_keyboard) {
      _editor.currentState?.requestKeyboard();
    } else {
      _focus.unfocus();
    }
  }

  void _touch(String type) => widget.session.input({
    'type': 'touch',
    'event': type,
    'points': [
      for (final point in _points.entries)
        {
          'x': (point.value.dx / _size.width).clamp(0.0, 1.0),
          'y': (point.value.dy / _size.height).clamp(0.0, 1.0),
          'id': point.key % 32,
        },
    ],
    'modifiers': 0,
  });

  void _key(String key, String code, int keyCode) {
    for (final down in [true, false]) {
      widget.session.input({
        'type': 'key',
        'event': down ? 'keyDown' : 'keyUp',
        'key': key,
        'code': code,
        'keyCode': keyCode,
        'modifiers': 0,
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        _size = constraints.biggest;
        widget.session.configure(
          _size,
          Theme.of(context).brightness == Brightness.dark,
          scale: MediaQuery.devicePixelRatioOf(context),
        );
        return ListenableBuilder(
          listenable: widget.session,
          builder: (context, _) {
            final error = widget.session.error;
            if (error != null) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(error, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      TextButton(onPressed: widget.session.reload, child: const Text('Retry')),
                    ],
                  ),
                ),
              );
            }
            final bytes = widget.session.image;
            if (bytes == null) return const Center(child: Text('Opening viewer…'));
            return CustomTextEdit(
              key: _editor,
              focusNode: _focus,
              onInsert: (text) => widget.session.input({'type': 'text', 'text': text}),
              onDelete: (count) {
                for (var i = 0; i < count.clamp(0, 32); i++) {
                  _key('Backspace', 'Backspace', 8);
                }
              },
              onComposing: (_, _) {},
              onKeyEvent: (_, _) => KeyEventResult.ignored,
              onAction: (_) {
                _key('Enter', 'Enter', 13);
                _editor.currentState?.resetEditingState();
              },
              child: Listener(
                behavior: HitTestBehavior.opaque,
                onPointerDown: (event) {
                  if (_points.length >= 5) return;
                  _points[event.pointer] = event.localPosition;
                  _touch('touchStart');
                },
                onPointerMove: (event) {
                  if (!_points.containsKey(event.pointer)) return;
                  _points[event.pointer] = event.localPosition;
                  _touch('touchMove');
                },
                onPointerUp: (event) {
                  if (_points.remove(event.pointer) != null) _touch('touchEnd');
                },
                onPointerCancel: (event) {
                  if (_points.remove(event.pointer) != null) _touch('touchCancel');
                },
                child: Image.memory(
                  bytes,
                  width: _size.width,
                  height: _size.height,
                  fit: BoxFit.fill,
                  gaplessPlayback: true,
                  excludeFromSemantics: true,
                ),
              ),
            );
          },
        );
      },
    );
  }
}
```

Check the vendored `CustomTextEdit` signature in `mobile/third_party/xterm/lib/src/ui/custom_text_edit.dart` before running: it requires `child, onInsert, onDelete, onComposing, onAction, onKeyEvent, focusNode` and (unlike desktop) has no `semanticLabel`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && flutter test test/surface/interactive_viewer_session_test.dart && flutter analyze lib/surface`
Expected: PASS.

- [ ] **Step 6: Commit (only when the user asks)**

```bash
git add mobile/lib/surface mobile/test/surface/interactive_viewer_session_test.dart
git commit -m "feat(mobile): touch surface for remote viewers"
```

---

### Task 7: Mobile wiring — model, sealed request, Viewer page

**Files:**
- Modify: `mobile/lib/core/models.dart` (`Agent` fields, constructor, `fromJson`, `copyWith`)
- Modify: `mobile/lib/state/app_state.dart` (add `viewerSurface` next to `teamRequest`, ~line 3994)
- Modify: `mobile/lib/e2ee/envelope.dart` (`encryptedDownTypes`)
- Create: `mobile/lib/phone/viewer_page.dart`
- Modify: `mobile/lib/phone/terminal_page.dart` (`_agentActions`, ~line 2413)
- Test: `mobile/test/core_units_test.dart`, `mobile/test/surface/viewer_page_test.dart`, `mobile/test/encrypted_down_types_test.dart` (existing, must pass)

**Interfaces:**
- Consumes: `InteractiveViewerSession`, `TouchViewerSurface` (Task 6).
- Produces:
  ```dart
  // Agent
  final String? viewerUrl; final String? viewerError; final String? viewerName;
  bool get hasViewer => viewerUrl != null || viewerError != null;
  // AppNotifier
  Future<Map<String, dynamic>> viewerSurface(String machineId, String agentId, Map<String, dynamic> payload);
  // ViewerPage
  const ViewerPage({super.key, required this.notifier, required this.machineId, required this.agent});
  ```

- [ ] **Step 1: Write the failing model test** — append to `mobile/test/core_units_test.dart` inside `main()`:

```dart
  test('an agent frame carries its viewer, and unsafe viewer URLs are dropped', () {
    final viewing = Agent.fromJson({
      'id': 'a', 'name': 'a',
      'viewerUrl': 'http://127.0.0.1:4100/?file=x.glb',
      'viewerName': 'Model viewer',
    });
    expect(viewing.viewerUrl, 'http://127.0.0.1:4100/?file=x.glb');
    expect(viewing.viewerName, 'Model viewer');
    expect(viewing.hasViewer, isTrue);
    expect(Agent.fromJson({'id': 'a', 'name': 'a', 'viewerUrl': 'javascript:alert(1)'}).viewerUrl, isNull);
    expect(Agent.fromJson({'id': 'a', 'name': 'a', 'viewerError': 'Viewer stopped'}).hasViewer, isTrue);
    expect(Agent.fromJson({'id': 'a', 'name': 'a'}).hasViewer, isFalse);
    expect(viewing.copyWith(name: 'b').viewerUrl, viewing.viewerUrl);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile && flutter test test/core_units_test.dart`
Expected: FAIL — `viewerUrl` is not a member of `Agent`.

- [ ] **Step 3: Add the fields** — in `mobile/lib/core/models.dart` `class Agent`:

```dart
  /// The harness's viewer page on its machine (`agentFrame.ts` `viewerUrl`), shown through the
  /// remote surface — the phone never loads it directly. Null when the harness has none.
  final String? viewerUrl;
  /// Why the viewer is not running, when it is not.
  final String? viewerError;
  final String? viewerName;

  bool get hasViewer => viewerUrl != null || viewerError != null;
```

Add `this.viewerUrl, this.viewerError, this.viewerName,` to the constructor; in `fromJson` add

```dart
      viewerUrl: _safeViewerUrl(j['viewerUrl']),
      viewerError: _safeDetail(j['viewerError']),
      viewerName: _safeLabel(j['viewerName']),
```

and in `copyWith` add `viewerUrl: viewerUrl, viewerError: viewerError, viewerName: viewerName,`. Add the sanitizer (same rule as desktop `desktop/lib/core/models.dart` `_safeViewerUrl`):

```dart
  /// A plain http(s) URL with a host, nothing else: it names the page the machine renders.
  static String? _safeViewerUrl(Object? raw) {
    if (raw is! String || raw.isEmpty || raw.length > 2048) return null;
    if (RegExp(r'[\x00-\x1f\x7f\s]').hasMatch(raw)) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null || !uri.hasAuthority) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    return raw;
  }
```

Run `flutter test test/core_units_test.dart` → PASS.

- [ ] **Step 4: Add the request and see the seal test fail** — in `mobile/lib/state/app_state.dart`, next to `teamRequest`:

```dart
  /// One request of a remote viewer surface (cli/src/lib/interactiveViewer.ts). Owner-only on the
  /// machine; sealed end to end like every machine request.
  Future<Map<String, dynamic>> viewerSurface(
    String machineId,
    String agentId,
    Map<String, dynamic> payload,
  ) {
    final connection = _conn(machineId);
    if (!connection.isReady) {
      return Future.error(StateError('Reconnect this machine to open its viewer.'));
    }
    return connection.request(
      'viewer_surface',
      payload: {...payload, 'agentId': agentId},
      timeout: const Duration(seconds: 25),
    );
  }
```

Run: `cd mobile && flutter test test/encrypted_down_types_test.dart`
Expected: FAIL in "a machine request the phone sends is sealed" — `viewer_surface` is sent but not sealed. (If `connection.isReady` does not exist on the mobile `WsConn`, use the readiness check `teamRequest`'s neighbours use; grep `isReady` in `mobile/lib/ws/ws_conn.dart`.)

- [ ] **Step 5: Seal it** — in `mobile/lib/e2ee/envelope.dart`, after `'terminal_chunked_upload_cancel',` add:

```dart
  // A remote viewer surface's frames and input (cli/src/lib/interactiveViewer.ts) — owner-only.
  'viewer_surface',
```

Run: `cd mobile && flutter test test/encrypted_down_types_test.dart` → PASS.

- [ ] **Step 6: Write the failing page test** — `mobile/test/surface/viewer_page_test.dart`:

```dart
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/viewer_page.dart';

void main() {
  testWidgets('the Viewer page shows the stream and its name, and closes the surface on leave', (tester) async {
    final requests = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> request(Map<String, dynamic> payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload.containsKey('after')) return Completer<Map<String, dynamic>>().future;
      return Future.value({'data': base64Encode([1, 2, 3]), 'mime': 'image/jpeg', 'width': 390, 'height': 700, 'seq': 1});
    }
    await tester.pumpWidget(MaterialApp(home: ViewerPage.withRequest(title: 'Model viewer', request: request)));
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Model viewer'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(requests.last['op'], 'close');
  });
}
```

Run: `cd mobile && flutter test test/surface/viewer_page_test.dart` → FAIL (no `viewer_page.dart`).

- [ ] **Step 7: Implement the page** — `mobile/lib/phone/viewer_page.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart';
import '../state/app_state.dart';
import '../surface/interactive_viewer_session.dart';
import '../surface/touch_viewer_surface.dart';

/// A harness's viewer, full screen on the phone: the machine renders the page, the phone shows it
/// and sends touches back. The surface closes when the page does.
class ViewerPage extends StatefulWidget {
  ViewerPage({super.key, required AppNotifier notifier, required String machineId, required Agent agent})
      : title = agent.viewerName ?? 'Viewer',
        request = ((payload) => notifier.viewerSurface(machineId, agent.id, payload));

  /// For tests: any request function.
  const ViewerPage.withRequest({super.key, required this.title, required this.request});

  final String title;
  final ViewerSurfaceRequest request;

  @override
  State<ViewerPage> createState() => _ViewerPageState();
}

class _ViewerPageState extends State<ViewerPage> {
  late final _session = InteractiveViewerSession(widget.request, mobile: true, touch: true);

  @override
  void dispose() {
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.title),
      actions: [
        IconButton(
          icon: const Icon(LucideIcons.rotateCw300),
          tooltip: 'Reload',
          onPressed: _session.reload,
        ),
      ],
    ),
    body: SafeArea(top: false, child: TouchViewerSurface(session: _session)),
  );
}
```

- [ ] **Step 8: Add the sheet row** — in `mobile/lib/phone/terminal_page.dart`, at the start of the list returned by `_agentActions(Agent agent)`:

```dart
    if (agent.hasViewer)
      PhoneSheetAction(
        icon: LucideIcons.monitor300,
        label: agent.viewerName ?? 'Viewer',
        chevron: true,
        onTap: () => Navigator.of(context).push(
          phoneRoute(
            (_) => ViewerPage(notifier: widget.notifier, machineId: widget.machineId, agent: agent),
          ),
        ),
      ),
```

and `import 'viewer_page.dart';` at the top.

- [ ] **Step 9: Run the mobile checks**

Run: `cd mobile && flutter test test/core_units_test.dart test/encrypted_down_types_test.dart test/surface && flutter analyze lib/phone/viewer_page.dart lib/phone/terminal_page.dart lib/state/app_state.dart lib/core/models.dart`
Expected: PASS, no analyzer issues.

- [ ] **Step 10: Manual check on a real viewer**

On a machine running the Blender harness (its `autonomous/model-viewer` viewer is live) with the CLI from this branch:
1. iOS simulator (recipe in memory `ios-simulator-xcode27`): open the Blender agent → ⋯ sheet → "Model viewer" → the model renders, a one-finger drag orbits it, the page is sharp (scale 3).
2. Web build (`desktop`, `flutter run -d chrome`): the viewer pane fills the pane exactly; resizing the split re-flows within ~0.1 s; ⌘C on selected text puts it on the Mac clipboard.
3. Desktop native macOS: unchanged (WKWebView proxy path).
Record what ran in the PR.

- [ ] **Step 11: Commit (only when the user asks)**

```bash
git add mobile/lib mobile/test
git commit -m "feat(mobile): open a harness's viewer from the agent sheet"
```

---

## Final verification (before asking for review)

```bash
cd cli && npx vitest run src/lib/interactiveViewer.spec.ts src/lib/interactiveViewer.chrome.spec.ts src/sharing/viewer.spec.ts src/services/viewers.spec.ts && npm run typecheck
cd cli && npx vitest run --config vitest.e2e.config.ts e2e/viewersProcess.e2e.ts
cd desktop && flutter test test/interactive_viewer_test.dart test/viewer_page_test.dart
cd mobile && flutter test test/core_units_test.dart test/encrypted_down_types_test.dart test/surface
```

PR CI runs the CLI/desktop/mobile unit checks of changed components; the real-Chrome spec and the manual checks of Task 7 Step 10 are recorded in the PR body.
