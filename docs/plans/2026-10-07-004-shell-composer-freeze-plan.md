# Shell composer: choosing with @ never freezes the shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a shell pane, Ctrl-N / `claude @…` → choose a computer, folder or model → the prompt comes back at once (or says why within a few seconds); the picker never sits still while it waits.

**Architecture:** The composer is a separate `hn --shell-picker` process started by the shell's line-editor widget (`tui/src/shell_integration.sh`), talking to the TUI over OSC 633 requests on the tty (`shell_context.rs`). Three waits block it today:
1. `_hn_request` (`shell_integration.sh:2-49`; the attempts at `:25-27`) retries a request **120 times with a 1 s read** — synchronously inside the ZLE/Readline widget (`_hn_picker_widget`, `:234-235`: `host-inline`, `model-inline`, `session-inline`; the same function also serves `ch`/`cm`/`hn sessions`, `:53-71`, and `_hn_choose`, `:196-198`). While it waits the shell accepts no keys: the user sees a frozen prompt for up to two minutes.
2. While that request is pending, the TUI refuses every other picker request (`shell_context.rs:454-455`: "close the current picker first") and only expires it after 100 s (`:850`). A `cancel` for the pending id is already handled (`:434-437` → `cancel` `:743` → `finish`, code 1, picker freed; tested at `:1308`).
3. The picker loop redraws only on a key or a reply (`shell_picker.rs:496-499` `dirty`), so its spinner stops while a remote folder scan runs (`Scan` in `shell_context/folders.rs`, notice `Searching folders…` at `:77`) — it looks hung. Worse, the inline picker never turns the spinner at all: `Screen::draw` (`shell_picker.rs:279-298`) passes `loading` to `inline_fzf` as `busy`, but `fzf_in_frame` only honours it for `PickerKind::Open` (`ui.rs:1486`, `reading = picker.busy.is_some() || Open && search_busy`) and the shell picker never sets `picker.busy`.
`exchange()` (Enter on `claude @x …`, via `--shell-compose-launch`) waits up to 180 s too (`shell_picker.rs:177-195`), but it is cancellable with Ctrl-C (`:181-185` sends `cancel`) and, today, draws nothing while it waits (`shell_composer.rs:517` is its only caller); keep it, and give it a visible wait (Task 3, step 3e).

The user's freeze ("gõ @ chọn gì đó là nó đơ") is choosing a computer: inside an agent draft (`codex @…`) the composer only edits the line (`edit` result, no request); the `-inline` requests come from Ctrl-P on a line that is not an agent command (`Draft::new` returns `None`, `shell_picker.rs` then prints `host\n<id>`), from `ch`/`cm`/`hn sessions`, and from the Ctrl-P sessions list. `host-inline` → the TUI switches the pane to that computer (`shell_context.rs:497` `switch_host`, defined at `:750`), the reply comes late or is lost after the stream reattaches, and the widget sits in the 120-try loop.

**Tech Stack:** POSIX sh (zsh/bash widgets), Rust, `tests/shell-integration.py` (real zsh/bash in private PTYs, fake picker and fake agents), `tests/composer-machine.py` (real zsh/bash in private PTYs with a fixture catalog).

**Spec:** user report 2026-10-07 + answer "Ô gõ trong shell (Ctrl-N)". Investigation: not reproduced as a hard hang locally (needs a second computer); the blocking loops above are confirmed by reading the code.

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **No 3 s cut-off.** Opening a shell on another computer legitimately takes up to 60 s (`agent_create`'s budget), so cancelling at 3 s would break `ch` to a slow machine. Instead, an `-inline` request: (a) prints a progress line on the terminal **at once** — `Opening a shell on <computer>… Ctrl-C to cancel` (model / session verbs: `Switching model…`, `Opening session…`); (b) waits at most **60 s** (`_hn_attempts=60` for `*-inline`); (c) Ctrl-C cancels it (the existing INT trap sends `cancel`) and returns the prompt with the line unchanged; (d) on running out, the one-line `<computer> did not answer. Your line is unchanged; try again.` Every "3 s" in Tasks 1, 2 and 4 means this rule instead; the `Gone` journey asserts: the progress line appears within 1 s, Ctrl-C gives the prompt back within 1 s with the line unchanged, and the next pick works. The TUI's pending `-inline` expiry becomes 65 s (not 5 s).
2. **The likeliest freeze is Enter after `@computer` (`exchange()`), which draws nothing for up to 180 s.** Step 3e (a visible wait: `Starting on <computer>… Ctrl-C to cancel` with a turning spinner) is required, not optional, and gets its own fixture check in Task 1 (`claude @Slow` + Enter: the text appears within 1 s).
3. **A failed list request** shows its message in the list and retries at most 3 times, 2 s apart, then stays open showing the error until Esc — never an endless retry loop.

## Global Constraints

- The shell stays usable and never looks dead: a request inside a line-editor widget says at once what it is waiting for, can always be cancelled with Ctrl-C, and gives up after 60 s with the line restored unchanged and a one-line message (see Controller ruling 1).
- The request id stays the same across retries (the TUI dedupes it, `shell_integration.sh:20-21` comment) — no action runs twice.
- zsh and bash 4/5 and macOS `/bin/bash` 3.2 all keep working (`composer-machine.py` runs zsh and `HN_COMPOSER_TEST_BASH`).
- No launch from the picker without Enter (the fixture's rule: "Starting an agent is a failure").

## Review Focus

- A reply that arrives after a Ctrl-C cancel or the 60 s limit must not change the line the user is now typing (the TUI must drop it: the request was cancelled).
- Ctrl-C while waiting returns the prompt and cancels the request (the `INT` trap already sends `cancel`).
- Choosing the same computer again right after a timed-out one works (no "close the current picker first").
- A computer that is offline: the picker says so in its status line, not a frozen spinner.
- The picker's spinner keeps turning with no key pressed while a folder scan runs.

---

### Task 1: Reproduce — a computer that never answers (widget) and one that answers late (picker)

The widget's `-inline` requests are not reachable from `composer-machine.py`: its fixture only accepts `list-compose` / `list-sessions` (`:90`, an agent draft edits the line and never sends `host-inline`), and a non-agent draft would send `list-host`, which the fixture rejects. So:
- the **never answers** journey goes into `tui/tests/shell-integration.py`, which already drives the real widget with a fake picker (`picker-choice` file) and answers `host-inline`/`model-inline`/`session-inline` itself through `s.reply(match)`; not replying is the `Gone` computer;
- the **answers late** journey (`Slow`) goes into `tui/tests/composer-machine.py`, whose fixture gets one new computer with a delayed folder reply.

**Files:**
- Modify: `tui/tests/shell-integration.py` (insert before the `(root/'picker-choice').unlink()` at `:138`, inside the `for shell … for custom …` loop, so it runs for zsh and bash, with and without custom aliases)
- Modify: `tui/tests/composer-machine.py` (`Shell.__init__` `:33-34`, `pump` `:70-121`, host rows `:97-98`, machine/path `:95,:100`, new journey at the end of `check` before `:219`)

- [ ] **Step 1: Gone — the widget gives the line back (shell-integration.py)**

Uses only the file's own helpers: `Shell.send`, `Shell.read_until(pattern, seconds)` (returns and clears the buffer), `Shell.result(marker)`, the `REQUEST` regex, `s.reply`.

```python
                # A computer that never answers: the widget gives the line back within
                # 3 s, cancels the request, says so, and the draft is untouched.
                (root/'picker-choice').write_text('host\nGone\n')
                s.send("printf 'GONE_%s\\n' LRIGHT")
                s.send('\x02'*5+'\x10')
                first=REQUEST.search(s.read_until(REQUEST))
                assert first[3]==b'host-inline' and base64.b64decode(first[4])==b'Gone'
                t0=time.monotonic()
                said=s.read_until(b'Gone did not answer',seconds=5)
                assert time.monotonic()-t0<4.5,'the shell waited too long'
                assert re.search(rb'633;hn;'+TOKEN.encode()+b';'+re.escape(first[2])+b';cancel;',said),'the request was not cancelled'
                if b'READY> ' not in said.split(b'Gone did not answer',1)[1]: s.read_until(b'READY> ')
                s.send('M\r')
                s.result(b'GONE_LMRIGHT')       # the line is exactly what it was
                # Right after it, another choice is served (the TUI freed the picker).
                (root/'picker-choice').write_text('host\nlocal\n')
                s.send('\x10')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'host-inline' and match[2]!=first[2]
                s.reply(match); s.read_until(b'READY> ')
```

- [ ] **Step 2: Slow — the fixture computer (composer-machine.py)**

(a) in `Shell.__init__` add `self.delayed = []`. (b) split the reply block at `:109-121` into a method and add a due-time flush at the top of `pump`:

```python
    def answer(self, request_id, catalog):
        path = self.root / '.harness/shell-requests' / TOKEN / request_id
        data = path.with_suffix('.json')
        try:
            if not path.exists():
                return  # the user changed scope before this reply
            data.write_text(json.dumps(catalog))
            data.chmod(0o600)
            fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            os.write(fd, ('HN:' + request_id + ':0:\n').encode())
            os.close(fd)
        except OSError:
            if path.exists():
                raise
```
and in `pump`, first lines:
```python
        for item in [d for d in self.delayed if d[0] <= time.monotonic()]:
            self.delayed.remove(item); self.answer(item[1], item[2])
```
(c) `:95` → `machine = 'remote-id' if host in ('Office','office','remote-id') else 'slow-id' if host in ('Slow','slow','slow-id') else 'local-id'`; `:98` add `dict(id='Slow', label='Slow', extra='slow-id')` to the host rows; `:100` → `path = {'remote-id': '~/office-project', 'slow-id': '~/slow-project'}.get(machine, '~/mac-project')`; replace the tail of `pump` (`:109-121`) with: `if machine == 'slow-id' and kind == 'folder': self.delayed.append((time.monotonic() + 8, request_id, catalog)); continue` then `self.answer(request_id, catalog)`. (The picker re-sends the same id every second; `self.answered` already dedupes it, so the delayed reply is queued once.)

(d) the journey, at the end of `check` before the `assert b'No such widget'` line:

```python
            # A computer whose folders take 8 s: the spinner keeps turning with no key pressed.
            s.load('codex '); n = s.count(); start = len(s.requests)
            s.host('Slow'); s.scope('folder', start, 'Slow')
            s.data = b''
            end = time.monotonic() + 2
            while time.monotonic() < end:
                s.pump()
            glyphs = set(re.findall('[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]', s.data.decode('utf-8', 'ignore')))
            assert len(glyphs) >= 2, ('the spinner did not turn', glyphs, s.data[-500:])
            s.send('\x1b'); s.wait(lambda: s.count() == n + 1, 'cancel slow folders')
```
(`re` and `time` are already imported there.) Before the fix this fails: the inline picker never sets `picker.busy`, so no spinner glyph is drawn at all.

- [ ] **Step 3: Run to see them fail** (isolated HOME, fake picker/agents only; no real agent CLI is started — `PATH` in both fixtures is `bin` + system dirs)

Run: `cd tui && python3 -u tests/shell-integration.py` → FAIL at `Gone did not answer` (the loop runs 120 s; the file's 120 s `faulthandler` would end it).
Run: `cd tui && cargo build --release --locked && env HN_COMPOSER_TEST_BINARY=target/release/harness-tui python3 -u tests/composer-machine.py` → FAIL at `the spinner did not turn`.

- [ ] **Step 4: Commit the failing journeys on the branch** (only with the user's approval, as always) — `git commit -am "composer: fixture computers that answer late or never"`

### Task 2: Widget requests give up after 3 s

**Files:**
- Modify: `tui/src/shell_integration.sh:25-27` (attempts by verb), `:46-48` (the give-up path of `_hn_request`)
- Modify: `tui/src/shell_context.rs:850` (pending `-inline` requests expire after 5 s, not 100 s). No change for `cancel`: `output` already clears a pending request on `cancel` (`:434-437`), so a cancelled `-inline` request frees the picker and its late `switch_host` result is discarded (`:777-784` deletes the shell it created) — the Review Focus items "late reply" and "same computer again" rest on that, with the new test below.
- Test: `tui/src/shell_context.rs` tests (next to `:1308`), `tui/tests/shell-integration.py` (Task 1)

- [ ] **Step 1: Failing Rust test** (helpers that exist in this module: `app()`, `prepare`, `bind`, `request(token, verb, query) -> Vec<u8>`, `output`, `tick`; `Request` fields `token,id,verb,query,pane,at`)

```rust
    #[tokio::test]
    async fn an_inline_request_the_shell_gave_up_on_is_dropped_and_frees_the_picker() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let id=uuid::Uuid::new_v4().to_string();
        app.shell_context.pending=Some(Request{token:token.clone(),id:id.clone(),pane:1,verb:"host-inline".into(),query:"Gone".into(),at:Instant::now()-Duration::from_secs(6)});
        tick(&mut app);
        assert!(app.shell_context.pending.is_none(),"an -inline request expires after 5 s");
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        // a later request is served, not refused with "close the current picker first"
        output(&mut app,1,&request(&token,"model-inline","default"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,0);
        // a young -inline request is kept, and a cancel for it frees the picker at once
        app.shell_context.pending=Some(Request{token:token.clone(),id:id.clone(),pane:1,verb:"host-inline".into(),query:"Gone".into(),at:Instant::now()});
        tick(&mut app);assert!(app.shell_context.pending.is_some());
        output(&mut app,1,format!("\x1b]633;hn;{token};{id};cancel;\x07").as_bytes());
        assert!(app.shell_context.pending.is_none());
        output(&mut app,1,&request(&token,"model-inline","default"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,0);
    }
```
- [ ] **Step 2: Run** — `cd tui && cargo test --locked an_inline_request_the_shell_gave_up` → FAIL (still pending after 6 s: the limit is 100 s)
- [ ] **Step 3: Implement**
  - `shell_integration.sh:25-27`: replace `_hn_attempts=120` + the `picker-ready` line with
    ```sh
    case "$1" in
        *-inline) _hn_attempts=3 ;;   # called from a line-editor widget: never block it past 3 s
        picker-ready) _hn_attempts=5 ;;
        *) _hn_attempts=120 ;;
    esac
    ```
    and replace the final `printf … 'Harness did not answer …'; exit 1` (`:47-48`) with
    ```sh
    case "$1" in
        *-inline)
            printf '\033]633;hn;%s;%s;cancel;\007' "$_HN_CONTEXT" "$_hn_id" >&4
            case "$1" in host-inline) _hn_who=$(printf '%s' "${2-}" | tr -d '[:cntrl:]');; *) _hn_who='' ;; esac
            printf '%s did not answer. Your line is unchanged; try again.\n' "${_hn_who:-Harness}" >&2 ;;
        *) printf '%s\n' 'Harness did not answer. Your shell is still available; try again.' >&2 ;;
    esac
    exit 1
    ```
    (The cancel goes out before `exit`, the same bytes as the INT trap at `:16`; the query of `model-inline`/`session-inline` is an id or route token, so only `host-inline` names the computer.) POSIX sh only; `read -t 1` and `case` already work on bash 3.2.
  - `shell_context.rs:850`: `let limit = if r.verb == "compose-launch" { 180 } else if r.verb.ends_with("-inline") { 5 } else { 100 };` and use `Duration::from_secs(limit)` in the comparison.
- [ ] **Step 4: Run** — `cd tui && cargo test --locked` (the existing `inline_cancel_and_invalid_session_return_to_the_same_shell` `:1308` and `lost_picker_timeout_and_account_change…` `:1178` — a non-inline `host` request at 110 s — must still pass), then `python3 -u tests/shell-integration.py` (the Task 1 `Gone` journey now PASSES; the existing retry test `cm default` at `:197-203` still sees its retry at 1 s).
- [ ] **Step 5: Commit** (with approval) — `git commit -am "composer: a computer that does not answer gives the prompt back in 3 s"`

### Task 3: The picker keeps drawing while it waits

**Files:**
- Modify: `tui/src/shell_picker.rs:279-298` (`Screen::draw`: paint through one helper that sets `picker.busy` while loading — without it `inline_fzf` never spins, see Architecture 3), `:487-499` (the loop: redraw every 120 ms while loading), `:517-531` (a failed list request shows its message in the status line instead of ending the picker)
- Test: `tui/src/shell_picker.rs` tests (module starts at `:668`; the inline-render tests are at `:811-845`)

- [ ] **Step 1: Failing tests**

```rust
    #[test]
    fn frames_are_due_only_while_loading() {
        let t=Instant::now();
        assert!(frame_due(true,t,t+Duration::from_millis(150)));
        assert!(!frame_due(true,t,t+Duration::from_millis(50)));
        assert!(!frame_due(false,t,t+Duration::from_secs(5)),"an idle picker draws nothing");
        assert!(is_loading(false,"") && is_loading(true,"Searching folders…") && !is_loading(true,"Office is offline"));
    }
    #[test]
    fn a_loading_inline_picker_spins_and_a_loaded_one_does_not() {
        let area=Rect::new(0,0,60,12);
        for loading in [true,false,true] {
            let mut picker=Picker::new("","");configure(&mut picker,false);
            let mut buf=Buffer::empty(area);
            theme::begin_animation_frame(true);
            paint_inline(&mut buf,area,&mut picker,loading,vec![],false);
            assert_eq!(theme::needs_animation_frame(),loading);
            assert!(picker.busy.is_none(),"the busy mark is not left on the picker");
        }
        theme::fzf_reset();
    }
```
- [ ] **Step 2: Run** — `cd tui && cargo test --locked frame_due loading_inline` → FAIL (does not compile: the helpers do not exist)
- [ ] **Step 3: Implement**
  - a) helpers next to `clean` (`:176`): 
    ```rust
    fn is_loading(items_loaded:bool,status:&str)->bool { !items_loaded || status.ends_with('…') }
    fn frame_due(loading:bool,last:Instant,now:Instant)->bool { loading && now.duration_since(last)>=Duration::from_millis(120) }
    fn paint_inline(next:&mut Buffer,area:Rect,picker:&mut Picker,loading:bool,lines:Vec<Line<'static>>,bottom:bool)->Position {
        let busy=std::mem::replace(&mut picker.busy,loading.then(||"loading".to_string()));
        let at=crate::ui::inline_fzf(next,area,picker,loading,lines,bottom);
        picker.busy=busy;at
    }
    ```
  - b) `Screen::draw` (`:286`): `let loading=is_loading(items.is_some(),&picker.status);` and `let cursor=paint_inline(&mut next,area,picker,loading,lines,bottom);` (replaces the `inline_fzf` call at `:290`; the `picker.empty` handling around it stays).
  - c) loop (`:487-499`): add `let mut last_draw=Instant::now();` beside `let mut dirty=true;` and make the draw block
    ```rust
    if dirty || frame_due(is_loading(items.is_some(),&picker.status),last_draw,Instant::now()) {
        theme::begin_animation_frame(true);
        screen.draw(&mut picker,items.as_ref(),last_id.as_deref())?;dirty=false;last_draw=Instant::now();
    }
    ```
    The poll at `:517` is already `event::poll(16 ms)`, so no timeout change is needed; `render_diff` sends only the changed spinner cell. Redrawing is restricted to a visible spinner (an in-flight request with rows already shown has nothing to animate).
  - d) failed request: today `r.poll(...)?` (`:518`) ends the picker with the error on stderr (which the widget swallows). Handle it in place:
    ```rust
    let polled=r.poll(&mut screen.out);
    match polled {
        Ok(Some(mut value)) => { /* the existing body unchanged */ },
        Ok(None) => {},
        Err(e) => {   // "Office is offline", "Harness did not answer", …: say it in the list, retry in 2 s
            picker.status=e.to_string();
            if items.is_none() { items=Some(Items::default()); }
            request=None;due=Instant::now()+Duration::from_secs(2);dirty=true;
        }
    }
    ```
    A status that does not end in `…` with `items` set is drawn as the empty-list message (`Screen::draw` `:290-292`), not as a spinner. 
  - e) `exchange()` visible wait (`:187-193`): write one line `Starting…` to its tty handle `out` right after `Request::new`, and erase it (`\r\x1b[2K`) when the loop returns or is interrupted; Ctrl-C still cancels. (No automated test: `exchange` needs a tty; covered by the by-hand check in Task 4.)
- [ ] **Step 4: Run** — `cd tui && cargo test --locked` (the picker tests at `:811-845` still pass), then `python3 -u tests/composer-machine.py` with `HN_COMPOSER_TEST_BINARY` — the `Slow` spinner journey PASSES.
- [ ] **Step 5: Commit** (with approval) — `git commit -am "composer: the picker shows it is working while a computer answers"`

### Task 4: Gate

- [ ] `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui` — all pass (`validate-tui-native.py:47` runs `tests/shell-integration.py`); `composer-machine` now passes its zsh part on macOS (its bash 3.2 part's existing "agent catalog" failure is the separate known issue — note it in the PR, do not hide it).
- [ ] By hand in an isolated hn with two fixture computers (not the user's live harnesses): Ctrl-P on `ls `, `@`, choose the unreachable one → prompt back and a message ≤ 3 s; open folders on a slow computer → spinner turns; Enter on `claude @Slow` shows `Starting…` until it answers.
