/// What the app says when the daemon refuses to move an agent to another model.
///
/// One sentence per refusal, in the app's own words. The daemon's `detail` is not shown: it is
/// written for its log and names the grid, and the user's vocabulary is "Subscription" and "Local".
/// Every code the daemon's `agent_retarget` can answer with is here, and an unknown one still gets a
/// sentence rather than the code — a new refusal in a newer daemon must not surface as `SOME_CODE`.
///
/// These refusals happen BEFORE the pane is touched (an engine with no way onto a Local model, a
/// busy agent, a machine that cannot resolve its Local models), so nothing in the terminal ever
/// says why. Until this existed, picking a Local model for a Cursor agent simply did nothing.
library;

String retargetRefusalMessage(String code, {required String engineLabel}) {
  return switch (code) {
    'GRID_ENGINE_UNSUPPORTED' =>
      '$engineLabel can only run on its own login, not a Local model.',
    'GRID_MODEL_REQUIRED' =>
      '$engineLabel needs a model named to run on a Local model.',
    'GRID_UNAVAILABLE' =>
      "Couldn't reach this machine's Local models. Try again in a moment.",
    'GRID_CONFIG_FAILED' =>
      "Couldn't write $engineLabel's Local-model configuration on this machine.",
    'GRID_CLEAR_FAILED' =>
      "Couldn't clear the Local-model settings from this agent's terminal.",
    'TMUX_TOO_OLD_FOR_GRID' => "This machine's tmux is too old to move an agent to a Local model. Update tmux there.",
    'TMUX_UNAVAILABLE' || 'TMUX_FAILED' =>
      "This machine's tmux did not answer. Try again in a moment.",
    // Changing model restarts the agent's process, which would cut off the
    // reply it is writing — so the daemon waits for the person, and the
    // sentence says what to do rather than naming the state ("mid-turn" read
    // as an error).
    'AGENT_BUSY' =>
      'This agent is still responding. Stop it or let it finish, then '
          'choose the model again.',
    'AGENT_NOT_FOUND' ||
    'MISSING_AGENT_ID' => 'This agent is no longer on the machine.',
    'NO_ACTIVE_PROCESS' || 'RETARGET_UNSUPPORTED_BACKEND' =>
      'This agent cannot change model right now.',
    'RESPAWN_FAILED' =>
      "$engineLabel did not start on the new model. The terminal shows what happened.",
    'INVALID_GRID' =>
      "This machine's Local models could not be resolved. Sign in again on it.",
    'UNSUPPORTED_ON_REMOTE' ||
    'UNSUPPORTED' => 'Update the harness CLI on this machine to change models.',
    _ => "Couldn't change this agent's model.",
  };
}
