/// Turning a WS frame into one log line that shows its shape, not its content.
///
/// The frames worth logging carry what people type and name (a prompt, a
/// message, a search, a tab, a folder) and the secrets they hold (a key, a
/// token, a session). A log line is written to `~/.harness/logs` and outlives
/// both, so it keeps only what happened: keys, ids, codes, numbers, counts and
/// lengths.
///
/// KEYS are kept, so a field nobody anticipated is still seen: the whole value
/// of this log is seeing fields nobody thought to name here. VALUES are
/// allowlisted: a string shows only when its key holds an id, an enum or a
/// version and the string is itself a short token, and is its length
/// otherwise. A secret-named key is blanked before anything else, so a key the
/// allowlist would show (`sessionId`) still reads `<redacted>`. [redactValue]
/// and [logToken] are exported so a test can pin the rule.
library;

/// Key names whose value must never reach the log. Broad on purpose: matching a
/// field that was not secret costs one unreadable line, missing one that was
/// costs a credential on disk.
final RegExp _secretKey = RegExp(
  r'key|token|secret|password|passphrase|credential|auth|bearer|cookie|session|email',
  caseSensitive: false,
);

/// A string a log may show as it is: an id, a code, a version. No space, so a
/// sentence never passes.
final RegExp _token = RegExp(r'^[A-Za-z0-9_.:-]{1,64}$');

/// A key shown as it is. A map keyed by content (a path, a file name) has keys
/// of any other shape, and those are content too.
final RegExp _identifierKey = RegExp(r'^[A-Za-z_][A-Za-z0-9_]{0,39}$');

/// Keys whose string value is an id, an enum or a version, besides any key
/// ending in `Id`.
const Set<String> _tokenKeys = {
  'id',
  'requestId',
  'engine',
  'status',
  'code',
  'error',
  'kind',
  'type',
  'model',
  'via',
  'decided',
  'version',
};

/// One frame payload as a log line: `{engine: codex, prompt: <27 chars>}`.
///
/// The cap is generous because of what these lines are for. An `agent_create`
/// reply carries a whole `Agent`, and a tighter cap would cut off its last
/// field, which is as likely as any to be the one somebody is reading the log
/// to find. A shown value is at most 64 characters, so one field cannot eat
/// the budget.
String summariseForLog(Object? value, {int maxLength = 1200}) {
  final text = redactValue(value);
  return text.length <= maxLength ? text : '${text.substring(0, maxLength)}…';
}

/// [value] rendered for a log by the rule above. Recurses into maps, so a
/// prompt or a secret nested a level or two down is caught too.
String redactValue(Object? value) => _render(value, holdsToken: false);

/// [value] itself when it is a short token, else its length: for a code or an
/// id whose shape is whatever the peer sent.
String logToken(Object? value) =>
    value is String && _token.hasMatch(value) ? value : _length(value);

String _length(Object? value) => '<${'$value'.length} chars>';

String _render(Object? value, {required bool holdsToken}) {
  if (value == null || value is bool || value is num) return '$value';
  if (value is Map) {
    final parts = [
      for (final entry in value.entries) _entry('${entry.key}', entry.value),
    ];
    return '{${parts.join(', ')}}';
  }
  if (value is List) {
    // Length, not contents: a list in a frame is a batch (agents, models,
    // frames) and printing it whole turns one line into a page.
    return '[${value.length} item${value.length == 1 ? '' : 's'}]';
  }
  return holdsToken ? logToken(value) : _length(value);
}

String _entry(String key, Object? value) {
  final shown = _identifierKey.hasMatch(key) ? key : _length(key);
  if (_secretKey.hasMatch(key)) return '$shown: <redacted>';
  final holdsToken = _tokenKeys.contains(key) || key.endsWith('Id');
  return '$shown: ${_render(value, holdsToken: holdsToken)}';
}

/// Anything in free-form CLI output that could be a secret, blanked.
///
/// [redactValue] above works on a decoded frame, where a secret is identified
/// by its KEY. A CLI's stdout has no keys: `harness auth status --json` prints
/// a session, and it goes into the transcript `cliLog` keeps. This is the same denylist idea applied to text — ported from
/// Grid's `redactLogSecrets` (`features/feedback/logic/log_bundle.dart`), so a
/// log line means the same thing in both products. Keep the two in step.
///
/// Conservative on purpose: it would rather blank a harmless high-entropy
/// string than write a live token to a file with a fortnight's retention.
String redactSecretsInText(String input) {
  var out = input;
  for (final rule in _textRedactions) {
    out = out.replaceAllMapped(rule.pattern, rule.replace);
  }
  return out;
}

typedef _Redaction = ({RegExp pattern, String Function(Match) replace});

final List<_Redaction> _textRedactions = [
  // `Bearer <token>` — the shape auth takes if it ever lands in output.
  (
    pattern: RegExp(r'(Bearer\s+)[A-Za-z0-9._\-]{8,}', caseSensitive: false),
    replace: (m) => '${m[1]}<redacted>',
  ),
  // Vendor keys with a well-known prefix (OpenAI `sk-…`, Anthropic `sk-ant-…`).
  (
    pattern: RegExp(r'\bsk-[A-Za-z0-9_\-]{8,}'),
    replace: (_) => 'sk-<redacted>',
  ),
  // `"session_token": "…"`, `key = …`, `password=…` — the value after any
  // secret-named field, however it is punctuated.
  (
    pattern: RegExp(
      '''(["']?\\b\\w*(?:token|secret|password|passphrase|credential|api[_-]?key)\\w*\\b["']?\\s*[:=]\\s*["']?)([^\\s"',}]{6,})''',
      caseSensitive: false,
    ),
    replace: (m) => '${m[1]}<redacted>',
  ),
  // A `?…token=…` or `?…key=…` inside a logged URL.
  (
    pattern: RegExp(
      r'([?&][^=\s&]*(?:token|key|secret|sig|signature)[^=\s&]*=)[^\s&]+',
      caseSensitive: false,
    ),
    replace: (m) => '${m[1]}<redacted>',
  ),
];
