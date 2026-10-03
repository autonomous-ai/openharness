/// The engines that can resume with a first message, so Take Over Now can tell
/// them to continue (`FIRST_PROMPT_ARGS` in cli/src/lib/engineLaunch.ts). Any
/// other resumes where it was stopped and waits.
const engineResumesWithMessage = {'claude', 'codex', 'opencode'};

/// How to take a conversation over from the terminal that has it open: the
/// `takeOver` of `agent_create`.
enum TakeOver {
  /// It is between turns: its terminal quits and it opens here.
  idle,

  /// Mid-turn: the turn is stopped, and the conversation told to continue.
  now,

  /// Mid-turn: it moves here when the turn ends.
  wait,
}
