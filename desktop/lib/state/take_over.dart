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
