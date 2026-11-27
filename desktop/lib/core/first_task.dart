// What a machine accepts as a harness's first task (`prompt` on
// `agent_create`), so New Harness can say so before Create rather than after.

/// The engines that can be opened with a first message: the non-null entries of
/// the CLI's `FIRST_PROMPT_ARGS` (cli/src/lib/engineLaunch.ts). A machine refuses
/// a first message for any other engine (`PROMPT_UNSUPPORTED`).
/// test/first_task_test.dart holds the two lists to the same answer.
const kFirstTaskEngines = {
  'claude',
  'codex',
  'opencode',
  'omp',
  'hermes',
  'openclaw',
};

/// Whether a harness on [engine] — its base engine, for a Store harness — can
/// start on a first task.
bool takesFirstTask(String engine) => kFirstTaskEngines.contains(engine);

/// Whether a switch to [engine] carries the conversation handoff, which it starts on as its first task: it takes one,
/// and its tools work in the pane's folder, where the machine writes the handoff file. OpenClaw's work in its Gateway
/// agent's own workspace (cli/src/engines/openclaw/runtimeProfile.ts), where that file is not, so a switch to it starts
/// a new conversation.
bool takesHandoff(String engine) =>
    takesFirstTask(engine) && engine != 'openclaw';

/// The longest first task a machine accepts, counted after trimming: the CLI's
/// `MAX_FIRST_PROMPT_CHARS`. Longer is refused (`PROMPT_TOO_LONG`), never cut.
const kFirstTaskMaxLength = 2000;
