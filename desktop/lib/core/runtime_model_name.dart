/// Display the model observed by the daemon, without treating it as a local
/// model selection. The runtime-v1 wire ID is shared with CLI model controls.
String? runtimeModelName(
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
    final model = Uri.decodeComponent(match[3]!).trim();
    if (model.isEmpty ||
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
      return '${family[0].toUpperCase()}${family.substring(1)}'
          '${version == null ? '' : ' $version'}${claude[3] ?? ''}';
    }
    final gpt = RegExp(
      r'^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|terra|luna|codex))?$',
      caseSensitive: false,
    ).firstMatch(model);
    if (gpt != null) {
      final family = gpt[2]?.toLowerCase();
      return 'GPT-${gpt[1]}${family == null ? '' : ' ${family[0].toUpperCase()}${family.substring(1)}'}';
    }
    // Unknown names, dated IDs and local/provider-qualified IDs stay exact.
    return model;
  } on ArgumentError {
    return null;
  } on FormatException {
    return null;
  }
}
