import 'dart:convert';

/// The most bytes the project document may hold, and the longest summary of a
/// save (backend superTabs/instructions).
const kInstructionsMaxBytes = 65536;
const kInstructionsSummaryMax = 200;

DateTime _time(Object? value) =>
    DateTime.tryParse(value as String? ?? '') ??
    DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

/// One note the coordinator keeps for the document: a request that is not yet
/// part of it.
class SuperTabNote {
  SuperTabNote.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String? ?? '',
      text = row['text'] as String? ?? '',
      askedBy = row['askedBy'] as String? ?? '',
      at = _time(row['at']),
      expiresAt = DateTime.tryParse(row['expiresAt'] as String? ?? '');
  final String id, text, askedBy;
  final DateTime at;
  final DateTime? expiresAt;
}

/// A project's instruction document with its notes.
class SuperTabInstructions {
  SuperTabInstructions.fromJson(Map<String, dynamic> row)
    : projectId = row['projectId'] as String? ?? '',
      revision = (row['revision'] as num?)?.toInt() ?? 0,
      hash = row['hash'] as String?,
      text = row['text'] as String? ?? '',
      template = row['template'] == true,
      coordinatorName = row['coordinatorName'] as String? ?? 'Product Manager',
      notesRevision = (row['notesRevision'] as num?)?.toInt() ?? 0,
      notes = List.unmodifiable([
        for (final note in row['notes'] as List? ?? const [])
          if (note is Map<String, dynamic>) SuperTabNote.fromJson(note),
      ]);
  final String projectId, text, coordinatorName;
  final int revision, notesRevision;
  final String? hash;

  /// The text is still the template nobody has saved over.
  final bool template;
  final List<SuperTabNote> notes;
}

/// One saved revision; [text] only when a single revision was read.
class SuperTabRevision {
  SuperTabRevision.fromJson(Map<String, dynamic> row)
    : revision = (row['revision'] as num?)?.toInt() ?? 0,
      hash = row['hash'] as String?,
      summary = row['summary'] as String? ?? '',
      writtenBy = switch (row['writtenBy']) {
        {'kind': final String kind, 'id': final String id} => (
          kind: kind,
          id: id,
        ),
        _ => (kind: 'system', id: ''),
      },
      askedBy = row['askedBy'] as String?,
      at = _time(row['at']),
      text = row['text'] as String?;
  final int revision;
  final String? hash;
  final String summary;

  /// `kind` is `person`, `agent` or `system`.
  final ({String kind, String id}) writtenBy;
  final String? askedBy;
  final DateTime at;
  final String? text;
}

/// The backend path of the document, its history or one revision.
String superTabInstructionsPath(
  String tabId,
  String projectId, {
  bool revisions = false,
  int? revision,
}) {
  final base =
      '/api/super-tabs/${Uri.encodeComponent(tabId)}/projects/'
      '${Uri.encodeComponent(projectId)}/instructions';
  if (revision != null) return '$base/revisions/$revision';
  return revisions ? '$base/revisions' : base;
}

final _sectionHeading = RegExp(r'^##(?!#)\s');

/// The names under the `### ` headings of the document's first `## Roles`
/// section, each once, 1-40 characters.
List<String> superTabInstructionRoleNames(String text) {
  final names = <String>[];
  final seen = <String>{};
  var inRoles = false;
  for (final raw in const LineSplitter().convert(text)) {
    final line = raw.trimRight();
    if (_sectionHeading.hasMatch(line)) {
      if (inRoles) break;
      inRoles = line.substring(2).trim().toLowerCase() == 'roles';
    } else if (inRoles && line.startsWith('### ')) {
      final name = line.substring(4).trim();
      if (name.isNotEmpty &&
          name.length <= 40 &&
          seen.add(name.toLowerCase())) {
        names.add(name);
      }
    }
  }
  return names;
}

/// A 404 without the backend's own code: a backend that has no such route.
bool superTabMissingRoute(String code, int statusCode) =>
    statusCode == 404 && code != 'NOT_FOUND';
