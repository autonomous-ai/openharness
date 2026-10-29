import 'package:flutter/foundation.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';

/// One project on Buddies (Tony's prototype C2): the person's own Buddy in
/// [project] of Swarm [swarmId], by its [name] ("Buddy" while none runs) and
/// how it stands ([note]: "offline", "starting" or "not started"; null while
/// it runs), their Buddy chat there ([chat]; null while none is opened) and
/// the last message in it once read ([last]), [unread] while the chat has a
/// message past the person's read mark.
@immutable
class SwarmBuddyRow {
  const SwarmBuddyRow({
    required this.swarmId,
    required this.project,
    required this.name,
    this.note,
    this.chat,
    this.last,
    this.unread = false,
  });

  final String swarmId;
  final SuperTabProject project;
  final String name;
  final String? note;
  final SuperTabConversation? chat;
  final SuperTabMessage? last;
  final bool unread;

  /// When the chat last moved: its last message, or the chat's own change
  /// until that is read.
  DateTime? get at => last?.createdAt ?? chat?.changedAt;

  /// The row's key: a project id may be in another Swarm too.
  String get key => '$swarmId/${project.id}';
}

/// [row]'s second line: its last message on one line, "You: " before the
/// person's own and the writer's name before the PM's private lines
/// ([swarmIsPmLine]), named in [reader], the row's own Swarm; what stands in
/// for it while there is none. Empty while the last message is not read.
String swarmBuddyLine(SwarmBuddyRow row, SwarmReader? reader) {
  final chat = row.chat;
  final last = row.last;
  if (chat == null) return 'No Buddy yet';
  if (last == null) return chat.mainSequence == 0 ? 'No messages yet' : '';
  final text = last.text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final said = text.isNotEmpty
      ? text
      : switch (last.attachments.length) {
          0 => '',
          1 => 'Sent a file',
          final n => 'Sent $n files',
        };
  final snapshot = reader?.snapshot;
  final String? who;
  if (!last.fromAgent && last.authorId == reader?.accountId) {
    who = 'You';
  } else if (reader != null && swarmIsPmLine(reader, last)) {
    who = snapshot?.agentName(last.authorId, fallback: last.authorName);
  } else if (!last.fromAgent) {
    final email = snapshot?.people
        .where((p) => p.id == last.authorId)
        .firstOrNull
        ?.email;
    who = email == null || email.isEmpty
        ? 'Someone'
        : superTabPersonName(email);
  } else {
    who = null;
  }
  return who == null ? said : '$who: $said';
}

/// Buddies (Tony's prototype C2; Product Manager's brief 10-30): a row for
/// each project of every listed Swarm ([SwarmBuddyRow]), newest first, with
/// the person's own Buddy there and their Buddy chat's last message.
///
/// Each of the person's own Buddy chats is read from its last message on
/// ([SwarmChatPeeks]), only while Buddies is [shown] and only when that
/// message moved; a reply only in a thread does not move it. Another
/// person's Buddy chat is never listed or read. Nothing is kept beyond what
/// the peeks keep, which leave with the Swarm's access.
class SwarmBuddyList extends ChangeNotifier {
  SwarmBuddyList(this.session) {
    inbox.addListener(_changed);
    session.peeks.addListener(_changed);
  }

  final SwarmSession session;

  SwarmInbox get inbox => session.inbox;

  bool _disposed = false;
  List<SwarmBuddyRow>? _rows;

  /// Screens showing Buddies ([watch]): while there is one, the Buddy chats
  /// are read when their last message moves.
  int _views = 0;
  bool get shown => _views > 0;

  /// A screen shows Buddies: its chats are read as they move.
  void watch() {
    if (_disposed || _views++ > 0) return;
    _want();
  }

  /// That screen went, or out of sight: once none shows it, the chats still
  /// waiting their turn for it are not read ([SwarmChatPeeks.withdraw]).
  void unwatch() {
    if (_views > 0 && --_views == 0) session.peeks.withdraw(this);
  }

  /// Every project's row, newest first; those with no time after, in the
  /// order read.
  List<SwarmBuddyRow> get rows => _rows ??= _build();

  /// The tab's badge: the Buddy chats with something unread.
  int get badge => rows.where((row) => row.unread).length;

  /// Some Buddy chat could not be read at its last message.
  bool get unreadChats => _anyChat(session.peeks.failedAt);

  /// A Buddy chat is being read for the first time since it moved, with
  /// nothing of it read yet.
  bool get reading => _anyChat(
    (reader, chat) =>
        session.peeks.busyAt(reader, chat) &&
        session.peeks.of(reader, chat) == null,
  );

  /// The person's Try again: the Buddy chats that failed are read again.
  void retry() => _anyChat((reader, chat) {
    session.peeks.retry(reader, chat, owner: this);
    return false;
  });

  bool _anyChat(bool Function(SwarmReader reader, String chatId) test) {
    for (final (reader, chat) in _chats()) {
      if (test(reader, chat.id)) return true;
    }
    return false;
  }

  /// The listed Swarms the person can still read, each with its reader.
  Iterable<(String, SwarmReader, SuperTabSnapshot)> _swarms() sync* {
    for (final swarm in inbox.swarms) {
      final reader = inbox.reader(swarm.id);
      final snapshot = reader?.snapshot;
      if (reader == null || snapshot == null || reader.accessRevoked) {
        continue;
      }
      yield (swarm.id, reader, snapshot);
    }
  }

  /// The person's own Buddy chats with a message in them.
  Iterable<(SwarmReader, SuperTabConversation)> _chats() sync* {
    for (final (_, reader, snapshot) in _swarms()) {
      for (final project in snapshot.projects) {
        final chat = swarmBuddyChat(reader, project.id);
        if (chat != null && chat.mainSequence > 0) yield (reader, chat);
      }
    }
  }

  /// Asks for each Buddy chat from its last message on: read only if that
  /// moved since it was last read.
  void _want() {
    for (final (reader, chat) in _chats()) {
      final last = chat.mainSequence;
      session.peeks.want(
        reader,
        chat.id,
        counter: last,
        after: last - 1,
        owner: this,
      );
    }
  }

  List<SwarmBuddyRow> _build() {
    final rows = <SwarmBuddyRow>[];
    for (final (id, reader, snapshot) in _swarms()) {
      for (final project in snapshot.projects) {
        final chat = swarmBuddyChat(reader, project.id);
        final peek = chat == null ? null : session.peeks.of(reader, chat.id);
        rows.add(
          SwarmBuddyRow(
            swarmId: id,
            project: project,
            name: swarmBuddyName(reader, project.id),
            note: swarmBuddyNote(reader, project.id),
            chat: chat,
            last: peek?.messages.where((m) => m.inMainStream).lastOrNull,
            unread: chat != null && (reader.readMarks?.unread(chat) ?? false),
          ),
        );
      }
    }
    // Stable: what has no time keeps the order read, after the rest.
    final order = {for (final (i, row) in rows.indexed) row: i};
    return List.unmodifiable(
      rows..sort((a, b) {
        final (x, y) = (a.at, b.at);
        if (x != null && y != null && x != y) return y.compareTo(x);
        if ((x == null) != (y == null)) return x == null ? 1 : -1;
        return order[a]!.compareTo(order[b]!);
      }),
    );
  }

  void _changed() {
    if (_disposed) return;
    _rows = null;
    if (shown) _want();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    inbox.removeListener(_changed);
    session.peeks.removeListener(_changed);
    super.dispose();
  }
}
