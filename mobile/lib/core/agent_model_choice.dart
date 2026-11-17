/// One model an agent's engine offers it: a row of the agent's Model sheet (`chat/agent_settings_sheet.dart`).
///
/// The daemon's `models_list` with `catalog` (cli/src/services/models.ts `runtimeModelCatalog`): the engine's own
/// list — Claude Code's `/model` list, Codex's model cache — folded to one row per model.
class AgentModelChoice {
  const AgentModelChoice({
    required this.model,
    required this.name,
    this.description,
    this.efforts = const [],
  });

  /// What the runtime-v1 profile carries and the engine's `/model` takes: `opus`, `claude-fable-5-1`, `gpt-5.6-sol`.
  final String model;

  /// As people know it: "Opus 5.5".
  final String name;

  /// The engine's own line under it: "For complex work and everyday tasks".
  final String? description;

  /// The efforts it takes, as the engine names them (`low` … `max`, `ultracode`); `auto` first when it has one.
  /// Empty for a model that takes none.
  final List<String> efforts;

  /// The efforts a person picks between: `auto` is the engine choosing, not a level.
  List<String> get levels => [
    for (final effort in efforts)
      if (effort != 'auto') effort,
  ];

  static AgentModelChoice? fromJson(Map<String, dynamic> json) {
    final model = json['model'], name = json['name'];
    if (model is! String || model.isEmpty || name is! String) return null;
    final description = json['description'];
    final efforts = json['efforts'];
    return AgentModelChoice(
      model: model,
      name: name.isEmpty ? model : name,
      description: description is String && description.isNotEmpty
          ? description
          : null,
      efforts: efforts is List
          ? efforts.whereType<String>().toList(growable: false)
          : const [],
    );
  }

  /// The effort a move onto this model keeps: [current] where it takes it, else the engine's own choice (`auto`)
  /// where it offers that, else the first it takes. `auto` for a model that takes none.
  String effortFor(String? current) {
    if (current != null && efforts.contains(current)) return current;
    if (efforts.isEmpty || efforts.contains('auto')) return 'auto';
    return efforts.first;
  }
}

/// An effort as its segment says it: short enough that six fit a phone's width.
String effortShortLabel(String effort) => switch (effort) {
  'low' => 'Low',
  'medium' => 'Med',
  'high' => 'High',
  'xhigh' => 'XHigh',
  'max' => 'Max',
  'ultracode' => 'Ultracode',
  'minimal' => 'Minimal',
  'none' => 'None',
  'ultra' => 'Ultra',
  'auto' => 'Auto',
  _ => effort,
};
