/**
 * Rex as it ran on this macOS 26 Mac (Apple silicon), for the Rex adapter's specs (docs/specs/2026-11-25-dial-rex.md, the
 * spike). Recorded 2026-11-25 against the person's own Rex server, in sessions the spike made for itself and removed
 * after: Rex app 0.1.0 (2061), `rex 0.0.1793377904-ge6592f`, server API revision 8. Each value is the exact argv, exit code
 * and output of one `rex` command run from outside the session, as the daemon runs it. Ids are the recorded ones; the
 * home folder is shown as `/Users/u`.
 */
export const RECORDED_REX = {
  source: 'recorded',
  version: '0.0.1793377904-ge6592f',
  apiRevision: 8,
  /** What a Rex block's environment holds (`env` in a block), and the pane hints a hook sends of them. */
  env: {
    TERM_PROGRAM: 'rex',
    REX_BLOCK: 'block:01a210ed-5a96-7f3e-a907-8aa1ac357dcf',
    REX_SESSION: 'session:01a210ed-5a96-7e9a-a458-5e14e5bf854a',
    REX_SERVER: 'unix:///Users/u/Library/Application%20Support/rex/server.sock',
  },
  /** The parents of an agent typed at a block's shell: none of the Rex app's, the server's. */
  processChain: [
    { pid: 19445, ppid: 19244, tty: 'ttys082', executable: 'claude' },
    { pid: 19244, ppid: 19240, tty: 'ttys082', executable: '-zsh' },
    { pid: 19240, ppid: 38761, tty: 'ttys082', executable: '/usr/bin/login' },
    { pid: 38761, ppid: 1, tty: undefined,
      executable: '/Users/u/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex' },
  ],
  /** `rex block call -s <session> -b <block> process`, a block whose program is `cat`: exit 0. */
  process: {
    code: 0,
    stdout: '{"last_exit":null,"child":{"pid":80353,"user_id":501,"user":"u","name":"cat","path":"/bin/cat","invoked_path":"/bin/cat","argv0":"/bin/cat","cwd":"/Users/u/proj"},"foreground":{"pid":80353,"user_id":501,"user":"u","name":"cat","path":"/bin/cat","invoked_path":"/bin/cat","argv0":"/bin/cat","cwd":"/Users/u/proj"},"home":"/Users/u"}\n',
    foregroundPid: 80353,
  },
  /** `rex send -s <session> -b <block> -- '-n hello --flag'`: exit 0, nothing printed, the text typed as it is. */
  send: { code: 0, stdout: '' },
  /** `rex send-key -s <session> -b <block> enter`: exit 0. */
  sendKey: { code: 0, stdout: '' },
  /** `rex block focus -s <session> <block>`: exit 0; the session's active window became the block's. */
  focus: { code: 0, stdout: '' },
  /** Any of those for a block the session lacks: exit 3, on stderr. */
  missingBlock: { code: 3, stderr: 'Error: block target "block:00000000-0000-0000-0000-000000000000" not found\n' },
  /** Any of those for a session the server lacks: exit 3. */
  missingSession: {
    code: 3,
    stderr: 'Error: block target "block:01a210ed-5a96-7f3e-a907-8aa1ac357dcf" not found: session scope: session "session:00000000-0000-0000-0000-000000000000" not found\n',
  },
  /** `-s <block id>`, which Rex's docs offer for a newer server, on this one: exit 3. So the hook's REX_SESSION is needed. */
  blockAsSession: {
    code: 3,
    stderr: 'Error: block target "block:01a210f1-5248-7cec-b2d8-74fcb7b1f821" not found: session scope: "block:01a210f1-5248-7cec-b2d8-74fcb7b1f821" is a block ID, not a session\n',
  },
  /** `rex client ls --json`: the Rex app, its second connection (no `info`), and this `rex` command itself. */
  clientList: {
    code: 0,
    stdout: JSON.stringify({ clients: [
      { client_id: 'client:01a1f852-4611-76f5-8a9a-d89cf963e3a7', info: { kind: 'app', platform: 'macos', name: 'Rex', version: '0.1.0 (2061)', label: 'Mac Auto' },
        principal: { kind: 'peer', transport: 'unix', display: 'uid 501', uid: 501, gid: 20, pid: 80331 }, connected_at: '2026-11-20T16:38:23.889457+07:00',
        connection_state: 'connected', session_ids: ['session:01a1aadc-a884-75c0-925a-c90dbad4c89f', 'session:01a210ed-5a96-7e9a-a458-5e14e5bf854a'] },
      { client_id: 'client:01a1f852-4a54-75ff-9a5e-8110021fd355',
        principal: { kind: 'peer', transport: 'unix', display: 'uid 501', uid: 501, gid: 20, pid: 80331 }, connected_at: '2026-11-20T16:38:24.980394+07:00',
        connection_state: 'connected' },
      { client_id: 'client:01a210ed-5cdd-77d7-b375-a3a7a2c338f8', info: { kind: 'cli', platform: 'macos', name: 'rex', version: '0.0.1793377904-ge6592f' },
        principal: { kind: 'peer', transport: 'unix', display: 'uid 501', uid: 501, gid: 20, pid: 80390 }, connection_state: 'connected' },
    ] }),
    appClient: 'client:01a1f852-4611-76f5-8a9a-d89cf963e3a7',
    uid: 501,
  },
  /** `rex api call client.perform '{"client_id":…,"action":"session.select","args":{"session_id":…}}'` with the app's
   *  Remote Control on: exit 0. */
  performed: { code: 0, stdout: '{"performed_by":"client:01a1f852-4611-76f5-8a9a-d89cf963e3a7"}\n' },
  /** `rex ls --json`, two sessions in `session.list` order ("New sessions go at the end"). */
  sessions: {
    code: 0,
    stdout: '{"sessions":[{"session_id":"session:01a1aadc-a884-75c0-925a-c90dbad4c89f","label":"work"},{"session_id":"session:01a21118-b015-74f1-b8fd-c4b33bb58038","label":"dial-test"}]}\n',
  },
  /** `rex api call -s <session> session.view` of `dial-test`: three windows, "Rex.app shows them as tabs in this order",
   *  the first one active; the third split left and right, its blocks "in layout order". Each block's `host_id`,
   *  `owner`, `creator_name` and `flavor` left out. */
  sessionView: {
    code: 0,
    stdout: '{"revision":34,"session_id":"session:01a21118-b015-74f1-b8fd-c4b33bb58038","label":"dial-test","active_window_id":"window:01a21118-b035-7c25-9629-36fb2d22b2c7","windows":[{"window_id":"window:01a21118-b035-7c25-9629-36fb2d22b2c7","label":"Window 2d22b2c7","focused_block_id":"block:01a21118-b015-7718-a224-c2fa6ebb90f6","layers":[{"layer_id":"layer:01a21118-b035-7c2d-b4a9-bfa5685c487d","kind":"tiled","bounds":[0,0,1,1],"layout":{"rect":[0,0,1,1],"block_id":"block:01a21118-b015-7718-a224-c2fa6ebb90f6"},"blocks":[{"block_id":"block:01a21118-b015-7718-a224-c2fa6ebb90f6","label":"shell"}]}]},{"window_id":"window:01a21118-b0ef-78cd-97d8-44c7e5f4ec0b","label":"Window e5f4ec0b","focused_block_id":"block:01a21118-b08b-72de-bb72-56662a956af9","layers":[{"layer_id":"layer:01a21118-b0ef-78d5-a327-cd7323dee925","kind":"tiled","bounds":[0,0,1,1],"layout":{"rect":[0,0,1,1],"block_id":"block:01a21118-b08b-72de-bb72-56662a956af9"},"blocks":[{"block_id":"block:01a21118-b08b-72de-bb72-56662a956af9","label":"codex-api"}]}]},{"window_id":"window:01a21118-b14b-7f2e-9f48-566c9518e2de","label":"Window 9518e2de","focused_block_id":"block:01a21118-b126-714f-9307-0122d38629ad","layers":[{"layer_id":"layer:01a21118-b14b-7f3a-9391-4f5a705924c5","kind":"tiled","bounds":[0,0,1,1],"layout":{"rect":[0,0,1,1],"split":{"split_id":"split:01a21169-7caf-7a39-9e54-8059419f96da","direction":"horizontal","ratio":0.5,"before":{"rect":[0,0,0.5,1],"block_id":"block:01a21118-b126-714f-9307-0122d38629ad"},"after":{"rect":[0.5,0,0.5,1],"block_id":"block:01a21169-7c95-7d17-a75e-e125235d7eb1"}}},"blocks":[{"block_id":"block:01a21118-b126-714f-9307-0122d38629ad","label":"claude-api"},{"block_id":"block:01a21169-7c95-7d17-a75e-e125235d7eb1","label":"shell"}]}]}]}\n',
  },
  /** `rex block inspect -s <session> <block> --json`: the block under `block`, with its window, the app's tab (its `api`,
   *  `session_id` and the block's `host_id`, `owner`, `creator_name` and `flavor` left out). The shape is the one recorded
   *  of a `dial-test` block; the ids are `env`'s block's, and its window's is not a recorded one. */
  blockInspect: {
    code: 0,
    stdout: '{"block":{"block_id":"block:01a210ed-5a96-7f3e-a907-8aa1ac357dcf","window_id":"window:01a210ed-5ab0-7ac4-a5b1-bd8f14ba7c21","label":"shell","placement":"placed"}}\n',
    window: 'window:01a210ed-5ab0-7ac4-a5b1-bd8f14ba7c21',
  },
  /** `rex block call -s <session> -b <block> title` of a Claude Code block: the title its program set. */
  title: { code: 0, stdout: '{"title":"Phản hồi một chữ OK","owner":{"pid":43731,"name":"2.1.332"}}\n' },
  /** The same of a shell that set none. */
  titleNone: { code: 0, stdout: '{"title":""}\n' },
} as const
