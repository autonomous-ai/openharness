/// One `/` command an agent's engine offers: a row of the chat's `/` list (`chat/command_list.dart`).
///
/// The daemon's `models_list` with `commands` (cli/src/services/models.ts `agentCommands`): Claude Code's own list,
/// its built-in commands and the person's, the project's and their plugins' skills.
class AgentCommand {
  const AgentCommand({
    required this.name,
    this.description = '',
    this.argumentHint = '',
  });

  /// What follows the `/`: `compact`, `telegram:access`.
  final String name;

  /// The engine's own line for it: "Free up context by summarizing the conversation so far".
  final String description;

  /// The argument it takes, as the engine shows it: `[instructions]`; empty for none.
  final String argumentHint;

  static AgentCommand? fromJson(Map<String, dynamic> json) {
    final name = json['name'];
    if (name is! String || name.isEmpty) return null;
    final description = json['description'], hint = json['argumentHint'];
    return AgentCommand(
      name: name,
      description: description is String ? description : '',
      argumentHint: hint is String ? hint : '',
    );
  }

  /// The commands [typed] (what follows the `/`, no space yet) names: those starting with it first, then those
  /// holding it, each in the engine's order. Everything for a bare `/`.
  static List<AgentCommand> matching(List<AgentCommand> all, String typed) {
    final query = typed.toLowerCase();
    if (query.isEmpty) return all;
    final starts = <AgentCommand>[], holds = <AgentCommand>[];
    for (final command in all) {
      final name = command.name.toLowerCase();
      if (name.startsWith(query)) {
        starts.add(command);
      } else if (name.contains(query)) {
        holds.add(command);
      }
    }
    return [...starts, ...holds];
  }
}
