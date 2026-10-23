import 'dart:math';

/// The last review verdict a group's reviewer posted: `Ready: yes|no|with fixes`,
/// with the revision it covers when the message names one.
class SuperTabVerdict {
  const SuperTabVerdict(this.ready, this.revision);
  final String ready;
  final String? revision;

  String get label =>
      revision == null ? 'Ready: $ready' : 'Ready: $ready on $revision';
}

final _ready = RegExp(
  r'^\W*Ready:\s*(yes|no|with fixes)\b',
  caseSensitive: false,
  multiLine: true,
);
final _labeledRevision = RegExp(
  r'\b(?:revision|head|commit|sha)\b\W{0,3}([0-9a-f]{7,40})\b',
  caseSensitive: false,
);
final _bareRevision = RegExp(r'\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b');

/// Null when the text carries no `Ready:` line.
SuperTabVerdict? parseSuperTabVerdict(String text) {
  final ready = _ready.firstMatch(text)?.group(1);
  if (ready == null) return null;
  final revision =
      _labeledRevision.firstMatch(text)?.group(1) ??
      _bareRevision.firstMatch(text)?.group(0);
  return SuperTabVerdict(
    ready.toLowerCase(),
    revision?.substring(0, min(revision.length, 9)),
  );
}
