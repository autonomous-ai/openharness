/// Display the model observed by the daemon, without treating it as a local
/// model selection. The runtime-v1 wire ID is shared with CLI model controls.
String? runtimeModelName(
  Object? value, {
  required String agentId,
  String? engine,
}) => runtimeModelDetails(value, agentId: agentId, engine: engine)?.name;

/// Keep the observed effort with its model and validate both against the same
/// agent/engine identity. Missing metadata never implies a default effort.
({String name, String effort})? runtimeModelDetails(
  Object? value, {
  required String agentId,
  String? engine,
}) {
  if (value is! String || value.length > 1024) return null;
  final match = RegExp(
    r'^runtime-v1:([^:]+):([a-z0-9_-]+):([^@]+)@([a-z0-9_-]+)$',
    caseSensitive: false,
  ).firstMatch(value);
  if (match == null || match[2]!.toLowerCase() != engine?.toLowerCase()) {
    return null;
  }
  try {
    if (Uri.decodeComponent(match[1]!) != agentId) return null;
    var model = Uri.decodeComponent(match[3]!).trim();
    // Older daemons included the adjacent path column from OpenCode's footer.
    // Keep provider/model IDs intact; only strip an explicitly padded path.
    if (engine?.toLowerCase() == 'opencode') {
      model = model
          .split(RegExp(r' {3,}(?=/|~/|[A-Za-z]:[\\/])'))
          .first
          .trimRight();
    }
    if (model.isEmpty ||
        model == '<synthetic>' ||
        model.length > 256 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(model)) {
      return null;
    }
    // Claude may report only a family alias. Never invent a version for it.
    final claude = RegExp(
      r'^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+(?:[-.]\d{1,2})*))?(\[1m\])?$',
      caseSensitive: false,
    ).firstMatch(model);
    if (claude != null) {
      final family = claude[1]!.toLowerCase();
      final version = claude[2]?.replaceAll('-', '.');
      final name =
          '${family[0].toUpperCase()}${family.substring(1)}'
          '${version == null ? '' : ' $version'}${claude[3] ?? ''}';
      return (name: name, effort: match[4]!.toLowerCase());
    }
    final gpt = RegExp(
      r'^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|terra|luna|codex))?$',
      caseSensitive: false,
    ).firstMatch(model);
    if (gpt != null) {
      final family = gpt[2]?.toLowerCase();
      return (
        name:
            'GPT-${gpt[1]}${family == null ? '' : ' ${family[0].toUpperCase()}${family.substring(1)}'}',
        effort: match[4]!.toLowerCase(),
      );
    }
    // Unknown names, dated IDs and local/provider-qualified IDs stay exact.
    return (name: model, effort: match[4]!.toLowerCase());
  } on ArgumentError {
    return null;
  } on FormatException {
    return null;
  }
}

/// One compact label for native and Flutter model controls. Unknown effort
/// words stay exact so a newer daemon does not get mislabeled by an older app.
String modelLabelWithEffort(String model, String? effort) {
  if (effort == null || effort.isEmpty) return model;
  final label = switch (effort) {
    'auto' => 'Auto',
    'none' => 'None',
    'off' => 'Off',
    'minimal' => 'Minimal',
    'low' => 'Low',
    'medium' => 'Medium',
    'high' => 'High',
    'xhigh' => 'XHigh',
    'max' => 'Max',
    'ultra' => 'Ultra',
    'ultracode' => 'Ultracode',
    _ => effort,
  };
  return '$model · $label';
}
