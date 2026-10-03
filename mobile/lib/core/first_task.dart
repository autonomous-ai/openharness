// What a machine accepts as a harness's first task (`prompt` on `agent_create`) — the desktop's
// rule, kept to the same answer as `desktop/lib/core/first_task.dart`.

/// The engines that can be opened with a first message: the non-null entries of the CLI's
/// `FIRST_PROMPT_ARGS` (cli/src/lib/engineLaunch.ts). A machine refuses a first message for any
/// other engine (`PROMPT_UNSUPPORTED`).
const kFirstTaskEngines = {'claude', 'codex', 'opencode'};

/// Whether a harness on [engine] can start on a first task.
bool takesFirstTask(String engine) => kFirstTaskEngines.contains(engine);

/// The longest first task a machine accepts, counted after trimming: the CLI's
/// `MAX_FIRST_PROMPT_CHARS`. Longer is refused (`PROMPT_TOO_LONG`), never cut.
const kFirstTaskMaxLength = 2000;
