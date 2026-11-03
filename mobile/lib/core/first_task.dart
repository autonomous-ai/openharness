// What a machine accepts as a harness's first task (`prompt` on `agent_create`) — the desktop's
// rule, kept to the same answer as `desktop/lib/core/first_task.dart`.

/// The first tasks offered by New Harness and the phone's first session.
const firstTaskIdeas = [
  'Explain this project to me',
  'Find a bug and fix it',
  'Run the tests',
];

/// The engines that can be opened with a first message: the non-null entries of the CLI's
/// `FIRST_PROMPT_ARGS` (cli/src/lib/engineLaunch.ts). A machine refuses a first message for any
/// other engine (`PROMPT_UNSUPPORTED`). test/first_task_test.dart holds the two lists to the same
/// answer: one missing here is an engine whose first task New drops without a word.
const kFirstTaskEngines = {'claude', 'codex', 'opencode', 'omp', 'hermes'};

/// Whether a harness on [engine] can start on a first task.
bool takesFirstTask(String engine) => kFirstTaskEngines.contains(engine);

/// The longest first task a machine accepts, counted after trimming: the CLI's
/// `MAX_FIRST_PROMPT_CHARS`. Longer is refused (`PROMPT_TOO_LONG`), never cut.
const kFirstTaskMaxLength = 2000;

/// What New says to a first task longer than [kFirstTaskMaxLength], in the desktop's words, or
/// null while it fits. Counted after trimming, as the machine counts.
///
/// ⚠️ Said, never fixed by cutting: a task cut to fit is not the one that was written, and the
/// person is the one to choose what goes.
String? firstTaskLengthError(String task) {
  final length = task.trim().length;
  if (length <= kFirstTaskMaxLength) return null;
  return 'A first message can be $kFirstTaskMaxLength characters; '
      'this is $length.';
}
