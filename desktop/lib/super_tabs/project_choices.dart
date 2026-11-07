import 'package:flutter/foundation.dart' show visibleForTesting;

import 'controller.dart';
import 'model.dart' show superTabMap;

/// What the form says when the list could not be read, beside Retry.
const kProjectsUnread = 'Couldn’t load the projects.';

/// A project's Lead, as the project list names it.
typedef SuperTabProjectLead = ({String agentId, String name});

/// One project a new agent may take as its main project (spec 2026-11-07-members-and-leads, section 1): only projects
/// the reader can read, as the server decides.
class SuperTabProjectChoice {
  SuperTabProjectChoice._(Map<String, dynamic> row)
    : id = row['id'] as String? ?? '',
      name = row['name'] as String? ?? '',
      about = _words(row['about']),
      repositoryName = _words(row['repositoryName']),
      lead = switch (row['lead']) {
        {'agentId': final String agentId, 'name': final String name} => (
          agentId: agentId,
          name: name,
        ),
        _ => null,
      },
      waiting = (row['waiting'] as num?)?.toInt() ?? 0;

  final String id, name;
  final String? about, repositoryName;
  final SuperTabProjectLead? lead;

  /// Approved tasks nobody is on yet.
  final int waiting;

  /// What the project is: its own line, else its repository's name, else nothing.
  String get purpose => about ?? repositoryName ?? '';

  static String? _words(Object? value) =>
      value is String && value.trim().isNotEmpty ? value.trim() : null;
}

/// One project as the list sends it, for a gallery or a test that draws rows without a read.
@visibleForTesting
SuperTabProjectChoice superTabProjectChoiceForTest(Map<String, dynamic> row) =>
    SuperTabProjectChoice._(row);

/// The project list, read once when the Cmd-N form or Join's Bring agent opens.
abstract final class SuperTabProjectChoices {
  /// The readable projects in the server's order (the one to pick first at the top), and [pick], the one that starts
  /// picked. [invitedTo]: the project of the invitation the person joined from. Null from a backend before the list
  /// (404), which keeps today's form; any other failure is thrown, to be said with Retry.
  static Future<({List<SuperTabProjectChoice> projects, String? pick})?> read(
    SuperTabRequest request,
    String tabId, {
    String? invitedTo,
  }) async {
    final Map<String, dynamic> answer;
    try {
      answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/project-list'
            '${invitedTo == null ? '' : '?invitedTo=${Uri.encodeQueryComponent(invitedTo)}'}',
      );
    } on SuperTabFailure catch (failure) {
      if (failure.statusCode == 404) return null;
      rethrow;
    }
    final projects = [
      for (final row in answer['projects'] as List? ?? const [])
        if (row is Map) SuperTabProjectChoice._(superTabMap(row)),
    ];
    final pick = answer['pick'];
    return (
      projects: projects,
      pick: projects.any((p) => p.id == pick) ? pick as String : null,
    );
  }
}
