import 'model.dart';

/// One piece of work waiting on the reader: its worker needs a person or is
/// stuck.
class SwarmWaitingWork {
  SwarmWaitingWork(this.conversation, this.project, this.snapshot);
  final SuperTabConversation conversation;
  final SuperTabProject project;
  final SuperTabSnapshot snapshot;

  /// `needs_human` or `blocked`.
  String get status => conversation.assignment!['status'] as String;

  /// The worker's name.
  String get agentName =>
      snapshot.agentName(conversation.assignment!['agentId'] as String? ?? '');

  /// What the worker wrote with the status: its question, or why it is stuck.
  String? get question => switch (conversation.assignment!['result']) {
    final String text when text.trim().isNotEmpty => text.trim(),
    _ => null,
  };
}

/// Each conversation's partner, the person its work needs (`partnerId`, named
/// by its Lead; backend v2 K), read from the raw state: the model the phone
/// shares with the desktop does not carry it yet.
Map<String, String> swarmPartners(Map<String, dynamic> state) => {
  for (final row in state['conversations'] as List? ?? const [])
    if (row case {'id': final String id, 'partnerId': final String partner})
      id: partner,
};

/// The work in [snapshot] waiting on [accountId]: a worker needs a person or
/// is stuck, and the reader is who it waits on — the conversation's partner
/// when it has one, else the project's owner (Lead's ruling, 2026-10-27). A
/// decision or tag asked of a person by name reaches them on its own
/// (`SwarmAsks`), so it is never counted here for anyone else.
///
/// The one place this rule lives: when people's areas reach the phone, the
/// owner gives way to whoever covers the area here.
List<SwarmWaitingWork> swarmWaitingWork(
  SuperTabSnapshot snapshot,
  String accountId, {
  Map<String, String> partners = const {},
}) => [
  for (final conversation in snapshot.conversations)
    if (superTabWorkWaits(conversation.assignment?['status']))
      if (snapshot.projects
              .where((p) => p.id == conversation.projectId)
              .firstOrNull
          case final project?)
        if ((partners[conversation.id] ?? project.ownerId) == accountId)
          SwarmWaitingWork(conversation, project, snapshot),
];
