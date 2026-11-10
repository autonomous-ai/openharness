import 'controller.dart';
import 'model.dart';

/// A hand-off from an agent on the older built-in skills: a result saying it is
/// ready for review and naming a revision. The backend holds such work as
/// waiting for review in every project while those agents exist; Desktop
/// reads it only in a project without instructions ([superTabReadsHandoff]).
/// A copy of READY_FOR_REVIEW and REVISION in backend/src/superTabs/liveness.ts
/// (waitingForReview): change both together.
final _readyForReview = RegExp(r'\bready for review\b', caseSensitive: false);
final _revision = RegExp(
  r'(?:@|\b(?:at|head)\s+)[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b',
  caseSensitive: false,
);

/// The work an agent's row talks about: a question it waits on, its current
/// task, or a finished one whose pull request has not merged yet. Only a group
/// the viewer reads.
class SuperTabAgentWork {
  const SuperTabAgentWork(
    this.group, {
    this.awaitingMerge = false,
    this.readsHandoff = true,
  });
  final SuperTabConversation group;

  /// Whether a result saying "ready for review" is a hand-off: only in a
  /// project without instructions ([superTabReadsHandoff]).
  final bool readsHandoff;

  /// Done, with its pull request still open: the agent waits on its merge.
  final bool awaitingMerge;

  Map<String, dynamic>? get _assignment => group.assignment;
  String? get status => _assignment?['status'] as String?;

  /// Working, but handed over for review: the Swarm holds it without progress
  /// until a review finds problems in it (liveness.ts waitingForReview).
  bool get handedOver {
    final result = _assignment?['result'];
    return readsHandoff &&
        status == 'working' &&
        _assignment?['reviewFoundAt'] == null &&
        result is String &&
        _readyForReview.hasMatch(result) &&
        _revision.hasMatch(result);
  }

  /// When the agent last reported progress on it (backend assignment.progressAt).
  DateTime? get progressAt => _time(_assignment?['progressAt']);

  /// Until when its own last post holds it (backend assignment.leaseUntil).
  DateTime? get leaseUntil => _time(_assignment?['leaseUntil']);

  static DateTime? _time(Object? ms) =>
      ms is num ? DateTime.fromMillisecondsSinceEpoch(ms.toInt()) : null;
}

/// Whether [group]'s project predates instructions, where a result saying it
/// is ready for review still hands the work over.
bool superTabReadsHandoff(SuperTabController c, SuperTabConversation group) =>
    c.snapshot?.projectFor(group.id)?.hasInstructions != true;

/// Whether the viewer reads [group]: never a Buddy chat, and a private group
/// only when its people include them. The server sends no other; this keeps a
/// task, its title and a click to it away if one ever arrived.
bool superTabGroupReadable(SuperTabController c, SuperTabConversation group) =>
    !group.isBuddyChat &&
    (group.audience == null || group.audience!.contains(c.accountId));
