import 'model.dart';

/// One piece of work waiting on the reader: its worker needs a person or is
/// stuck, or waits at a prompt in its terminal ([atPrompt], task #3029).
class SwarmWaitingWork {
  SwarmWaitingWork(
    this.conversation,
    this.project,
    this.snapshot, {
    this.promptAgentId,
  });
  final SuperTabConversation conversation;
  final SuperTabProject project;
  final SuperTabSnapshot snapshot;

  /// The agent at a prompt in its terminal, when that is what waits.
  final String? promptAgentId;

  /// Whether its agent waits at a prompt in its terminal, whatever its status.
  bool get atPrompt => promptAgentId != null;

  /// `needs_human` or `blocked`; `prompt` for an agent at a prompt.
  String get status =>
      atPrompt ? 'prompt' : conversation.assignment!['status'] as String;

  /// The worker's name.
  String get agentName => snapshot.agentName(
    promptAgentId ?? conversation.assignment!['agentId'] as String? ?? '',
  );

  /// What the worker wrote with the status: its question, or why it is stuck.
  /// At a prompt, it says so: the prompt itself is in its terminal.
  String? get question => atPrompt
      ? 'Waiting at a prompt in its terminal'
      : switch (conversation.assignment!['result']) {
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
///
/// Worked out once per read, reader and [partners]; the list is shared, so it
/// cannot be changed.
List<SwarmWaitingWork> swarmWaitingWork(
  SuperTabSnapshot snapshot,
  String accountId, {
  Map<String, String> partners = const {},
}) {
  final kept = _kept[snapshot];
  if (kept != null &&
      kept.accountId == accountId &&
      identical(kept.partners, partners)) {
    return kept.work;
  }
  final work = List<SwarmWaitingWork>.unmodifiable([
    for (final conversation in snapshot.conversations)
      if (superTabWorkWaits(conversation.assignment?['status']))
        if (snapshot.projectById(conversation.projectId) case final project?)
          if ((partners[conversation.id] ?? project.ownerId) == accountId)
            SwarmWaitingWork(conversation, project, snapshot),
    // An agent at a prompt in a task of the reader's: the backend chose them
    // (the task's requester, or the device machine's owner), so no rule here.
    for (final wait in snapshot.promptsWaiting)
      if (snapshot.conversation(wait.conversationId) case final conversation?)
        if (snapshot.projectById(conversation.projectId) case final project?)
          SwarmWaitingWork(
            conversation,
            project,
            snapshot,
            promptAgentId: wait.agentId,
          ),
  ]);
  _kept[snapshot] = (accountId: accountId, partners: partners, work: work);
  return work;
}

/// Each read's waiting work, kept with the read: a replaced read takes it
/// with it, and another reader or new partners work it out again.
final _kept =
    Expando<
      ({
        String accountId,
        Map<String, String> partners,
        List<SwarmWaitingWork> work,
      })
    >('swarm waiting work');
