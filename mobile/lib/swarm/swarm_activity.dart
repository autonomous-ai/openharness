import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'model.dart';
import 'swarm_activity_feed.dart';
import 'swarm_chat_peeks.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_thread.dart' show SwarmThreadFocus;

/// Activity's filters, as Tony's prototype C3 names them.
enum SwarmActivityFilter {
  /// Decisions asked of the person and work waiting on them.
  needsYou('Needs you'),

  /// The Product Manager's tags of the person.
  mentions('@'),

  /// Threads the person wrote in or was tagged in.
  threads('Threads'),

  /// Others' reactions to what the person wrote.
  reactions('Reactions');

  /// What [threads] is called once the server lists replies to the person
  /// ([SwarmActivityFeed]), as Desktop calls it.
  static const repliesLabel = 'Replies';

  const SwarmActivityFilter(this.label);
  final String label;
}

/// One row of Activity, in the Swarm it is in.
sealed class SwarmActivityItem {
  const SwarmActivityItem(this.swarmId);
  final String swarmId;

  /// Stable across reads: what the row and its handled mark are keyed by.
  String get key;
  SwarmActivityFilter get filter;

  /// The chat Reply opens.
  String get conversationId;

  /// The message Reply opens the chat at; null opens it at its end.
  String? get messageId;

  /// When it happened, where that is known.
  DateTime? get at;

  /// The root of the thread the row's message lives only in; null for a
  /// message in the chat's main stream, which Reply lands on in the chat.
  String? get threadId => null;

  /// Where that thread lands: on the row's message, or at its first unread
  /// reply for a row that stands for the whole thread.
  SwarmThreadFocus? get threadFocus => null;
}

/// Something a Swarm asks of the person ([SwarmNeed]): Needs you, or @ for a
/// tag.
class SwarmActivityNeed extends SwarmActivityItem {
  SwarmActivityNeed(this.need) : super(need.swarmId);
  final SwarmNeed need;

  @override
  String get key => need.key;

  @override
  SwarmActivityFilter get filter => need is SwarmMentionNeed
      ? SwarmActivityFilter.mentions
      : SwarmActivityFilter.needsYou;

  @override
  String get conversationId => need.conversationId;

  @override
  String? get messageId => switch (need) {
    SwarmMentionNeed(:final mention) => mention.messageId,
    _ => null,
  };

  @override
  String? get threadId => switch (need) {
    SwarmMentionNeed(:final mention) => mention.threadId,
    _ => null,
  };

  @override
  SwarmThreadFocus? get threadFocus => switch (need) {
    SwarmMentionNeed(:final mention) when mention.threadId != null =>
      SwarmThreadFocus.message(mention.messageId),
    _ => null,
  };

  @override
  DateTime? get at => switch (need) {
    SwarmDecisionNeed(:final decision) => decision.createdAt,
    SwarmMentionNeed(:final mention) => mention.createdAt,
    SwarmWorkNeed(:final work) => work.conversation.changedAt,
  };
}

/// Whether [item] is of project [projectId], as [snapshot] — its Swarm's read
/// — has it: what it names and where it was asked must both be that project,
/// so a row whose chat moved, or that the read no longer has, shows in no
/// project's Activity.
bool swarmActivityItemIn(
  SwarmActivityItem item,
  SuperTabSnapshot snapshot,
  String projectId,
) {
  final named = switch (item) {
    SwarmActivityNeed(need: SwarmDecisionNeed(:final decision)) =>
      decision.projectId,
    SwarmActivityNeed(need: SwarmMentionNeed(:final mention)) =>
      mention.projectId,
    SwarmActivityNeed(need: SwarmWorkNeed(:final work)) => work.project.id,
    SwarmActivityThread(:final project) => project.id,
    SwarmActivityReaction(:final project) => project.id,
    // A server row names no project of its own: its chat's, as read here.
    SwarmActivityServerItem(:final conversationId) =>
      snapshot.conversation(conversationId)?.projectId,
  };
  return named == projectId &&
      snapshot.conversation(item.conversationId)?.projectId == projectId;
}

/// A thread in a project chat that the person wrote in or was tagged in.
class SwarmActivityThread extends SwarmActivityItem {
  const SwarmActivityThread(
    super.swarmId, {
    required this.project,
    required this.chatId,
    required this.thread,
    this.root,
  });
  final SuperTabProject project;
  final String chatId;
  final SuperTabThread thread;

  /// Its first message, when the page read has it.
  final SuperTabMessage? root;

  @override
  String get key => 'thread:$swarmId:${thread.id}';

  @override
  SwarmActivityFilter get filter => SwarmActivityFilter.threads;

  @override
  String get conversationId => chatId;

  @override
  String? get messageId => thread.id;

  @override
  String? get threadId => thread.id;

  @override
  SwarmThreadFocus? get threadFocus => const SwarmThreadFocus.firstUnread();

  @override
  DateTime? get at => thread.lastAt;
}

/// A reply to the person's message or a reaction to it, as the server lists
/// it ([SwarmActivityFeed]): under Threads (called Replies) or Reactions.
class SwarmActivityServerItem extends SwarmActivityItem {
  const SwarmActivityServerItem(super.swarmId, this.entry);
  final SwarmActivityEntry entry;

  @override
  String get key => 'activity:$swarmId:${entry.id}';

  @override
  SwarmActivityFilter get filter => entry.kind == SwarmActivityKind.reply
      ? SwarmActivityFilter.threads
      : SwarmActivityFilter.reactions;

  @override
  String get conversationId => entry.conversationId;

  /// A reply that lives only in its thread opens at the thread.
  @override
  String? get messageId => entry.threadId ?? entry.messageId;

  @override
  String? get threadId => entry.threadId;

  @override
  SwarmThreadFocus? get threadFocus =>
      entry.threadId == null ? null : SwarmThreadFocus.message(entry.messageId);

  @override
  DateTime? get at => entry.createdAt;
}

/// Others' reactions to one of the person's messages in a project chat.
class SwarmActivityReaction extends SwarmActivityItem {
  const SwarmActivityReaction(
    super.swarmId, {
    required this.project,
    required this.chatId,
    required this.message,
    required this.reactions,
  });
  final SuperTabProject project;
  final String chatId;
  final SuperTabMessage message;

  /// Each emoji with who gave it, the person themself left out.
  final List<SuperTabReactionCount> reactions;

  @override
  String get key => 'reaction:$swarmId:${message.id}';

  @override
  SwarmActivityFilter get filter => SwarmActivityFilter.reactions;

  @override
  String get conversationId => chatId;

  @override
  String? get messageId => message.id;

  @override
  String? get threadId => message.inMainStream ? null : message.thread;

  @override
  SwarmThreadFocus? get threadFocus =>
      threadId == null ? null : SwarmThreadFocus.message(message.id);

  @override
  DateTime? get at => message.createdAt;

  /// Who gave which emoji, in one value: a reaction seen is handled until
  /// this moves.
  String get signature => ([
    for (final r in reactions)
      for (final who in r.by) '${r.emoji.key}:${who.kind}:${who.id}',
  ]..sort()).join(',');
}

/// Activity, in place of Needs you (Tony's prototype C3; Product Manager's
/// brief 10-30): what the Swarms ask of the person (Needs you, @), the replies
/// and reactions to what they wrote, each filter counted, and the needs they
/// acted on kept as handled.
///
/// Needs you and @ are the inbox's, read already. Replies and Reactions are
/// the server's, as Desktop reads them ([SwarmActivityFeed], #2453): unread
/// in bold, and read on every device once Activity is left — only those
/// Activity had open. The badge counts what Desktop's does: decisions and
/// tags waiting, and replies unread.
///
/// From a server before Activity (no digest, or 404), that Swarm's rows are
/// built on the phone as before: Threads and Reactions come
/// from each project chat's newest page ([SwarmChatPeeks]), read only while
/// Activity is [shown] and only when the chat's counters moved; Buddy chats
/// and task chats are not read. A thread is handled once the person read the
/// chat past its last reply, or opened it here; a reaction once opened here.
/// Those marks are kept on the phone under the account and the Swarm (thread
/// and message ids, and numbers; no words), and leave it with the Swarm. A
/// need the person answered, marked done or opened here stays as a handled
/// row for the session.
class SwarmActivity extends ChangeNotifier {
  SwarmActivity(this.session, {LocalKeyValueStore? store})
    : store = store ?? session.inbox.readMarks {
    inbox.addListener(_changed);
    session.addListener(_changed);
    session.peeks.addListener(_changed);
    _changed();
  }

  final SwarmSession session;

  /// Where the handled marks of threads and reactions are kept; null keeps
  /// them in memory.
  final LocalKeyValueStore? store;

  SwarmInbox get inbox => session.inbox;
  String get accountId => session.accountId;

  /// How many handled needs are kept as rows once they leave the inbox.
  static const keptHandled = 20;

  /// How many marks each Swarm keeps on the phone: the oldest go first.
  static const keptMarks = 500;

  bool _disposed = false, _tracking = false;

  /// Needs acted on here, by key, with what was done: "Opened" at once,
  /// "Approved", "Answered" or "Done" once it was sent.
  final _acted = <String, ({String swarmId, String word})>{};

  /// Decisions approved from Activity: their answer, once sent, is "Approved".
  final _approving = <String>{};

  /// Needs acted on here that left the inbox, newest last.
  final _gone = <String, ({SwarmActivityNeed item, String word})>{};

  /// Each listed Swarm's handled marks, while its server has no Activity.
  final _marks = <String, _SwarmMarks>{};

  /// Each listed Swarm's replies and reactions from the server.
  final _feeds = <String, SwarmActivityFeed>{};

  /// The server rows each Swarm's Activity had open in this visit, by id:
  /// what is marked read when it is left.
  final _shownRows = <String, Set<String>>{};

  Map<SwarmActivityFilter, List<SwarmActivityItem>>? _built;

  /// Screens showing Activity ([watch]): while there is one, the project
  /// chats are read when their counters move.
  int _views = 0;
  bool get shown => _views > 0;

  /// A screen shows Activity: its chats are read as their counters move.
  void watch() {
    if (_disposed || _views++ > 0) return;
    _shownRows.clear();
    for (final feed in _feeds.values) {
      feed.opened();
    }
    _want();
  }

  /// That screen went, or out of sight: once none shows it, the chats still
  /// waiting their turn for it are not read ([SwarmChatPeeks.withdraw]), and
  /// the server rows it had open are read on every device.
  void unwatch() {
    if (_views > 0 && --_views == 0) {
      session.peeks.withdraw(this);
      if (_disposed) return;
      for (final MapEntry(key: id, value: feed) in _feeds.entries) {
        feed.closed({...?_shownRows[id]});
      }
      _shownRows.clear();
    }
  }

  /// A screen showing Activity has [items] open: their server rows are read
  /// once it is left ([unwatch]). Nothing is kept while none is in sight.
  void showing(Iterable<SwarmActivityItem> items) {
    if (_disposed || !shown) return;
    for (final item in items) {
      if (item is SwarmActivityServerItem) {
        (_shownRows[item.swarmId] ??= {}).add(item.entry.id);
      }
    }
  }

  /// The rows of [filter]: those still to handle, newest first, then the
  /// handled ones.
  List<SwarmActivityItem> items(SwarmActivityFilter filter) =>
      (_built ??= _build())[filter] ?? const [];

  /// The rows of [filter] still to handle, or unread.
  int count(SwarmActivityFilter filter) => items(filter).where(waiting).length;

  /// Whether [item] counts in its filter's number: a server row while it is
  /// unread on every device, any other while it is still to handle.
  bool waiting(SwarmActivityItem item) => switch (item) {
    SwarmActivityServerItem(:final entry) => !entry.read,
    _ => handled(item) == null,
  };

  /// Whether [item] shows bold: a server row unread, or unread when this
  /// visit began; any other while it is still to handle.
  bool unread(SwarmActivityItem item) => switch (item) {
    SwarmActivityServerItem(:final entry) =>
      _feeds[item.swarmId]?.isUnread(entry) ?? false,
    _ => handled(item) == null,
  };

  /// What [filter] is called: Threads is Replies once a server lists them.
  String label(SwarmActivityFilter filter) =>
      filter == SwarmActivityFilter.threads && repliesFromServer
      ? SwarmActivityFilter.repliesLabel
      : filter.label;

  /// Some listed Swarm's replies and reactions come from its server.
  bool get repliesFromServer => _feeds.values.any((feed) => feed.fromServer);

  /// The tab's badge, as Desktop counts its Activity: each Swarm's decisions
  /// and tags waiting, and the replies to the person not read on any device.
  /// A Swarm whose server has no Activity counts what needs the person, as
  /// before.
  int get badge {
    var count = 0;
    final before = <String>{};
    for (final swarm in inbox.swarms) {
      final reader = inbox.reader(swarm.id);
      final snapshot = reader?.snapshot;
      if (reader == null || reader.accessRevoked || snapshot == null) continue;
      final feed = _feeds[swarm.id];
      if (feed != null && feed.fromServer) {
        count +=
            snapshot.decisionsWaiting +
            snapshot.mentionsWaiting +
            feed.unreadReplies;
      } else {
        before.add(swarm.id);
      }
    }
    if (before.isEmpty) return count;
    return count +
        items(SwarmActivityFilter.needsYou)
            .where((item) => before.contains(item.swarmId) && waiting(item))
            .length;
  }

  /// Some project chat could not be read at its last change, or some
  /// Swarm's Activity could not be read from its server.
  bool get unreadChats =>
      _anyChat(session.peeks.failedAt) ||
      _feeds.values.any((feed) => feed.fromServer && feed.error != null);

  /// A project chat is being read for the first time since it moved, with
  /// nothing of it read yet, or a Swarm's Activity is read from its server
  /// for the first time: Replies and Reactions may still fill.
  bool get reading =>
      _feeds.values.any(
        (feed) => feed.fromServer && !feed.loaded && feed.error == null,
      ) ||
      _anyChat(
        (reader, chat) =>
            session.peeks.busyAt(reader, chat) &&
            session.peeks.of(reader, chat) == null,
      );

  /// The person's Try again: the project chats that failed are read again,
  /// and each Swarm's Activity that failed.
  void retry() {
    for (final feed in _feeds.values) {
      if (feed.fromServer && feed.error != null) feed.retry();
    }
    _anyChat((reader, chat) {
      session.peeks.retry(reader, chat, owner: this);
      return false;
    });
  }

  /// Whether [test] holds for a project chat of a listed Swarm.
  bool _anyChat(bool Function(SwarmReader reader, String chatId) test) {
    for (final swarm in inbox.swarms) {
      final reader = inbox.reader(swarm.id);
      if (reader == null) continue;
      for (final (project: _, :chat) in _projectChats(reader)) {
        if (test(reader, chat.id)) return true;
      }
    }
    return false;
  }

  /// What the person did with [item], in a word, once it counts as handled;
  /// null while it is still to handle.
  String? handled(SwarmActivityItem item) {
    switch (item) {
      case SwarmActivityNeed():
        if (_gone[item.key] case final gone?) return gone.word;
        final acted = _acted[item.key]?.word;
        return acted == 'Opened' ? acted : null;
      case SwarmActivityThread(:final thread):
        final marks = _marks[item.swarmId];
        final reader = inbox.reader(item.swarmId);
        if (marks == null || reader == null) return null;
        final mine = switch (thread.authors.firstOrNull) {
          {'kind': 'person', 'id': final String id} => id == accountId,
          _ => false,
        };
        final read = reader.readMarks?.readThrough(item.chatId);
        // Read through on any device: the thread's own mark (server or phone).
        final threadRead = reader.readMarks?.threadThrough(
          item.chatId,
          thread.id,
        );
        final opened = marks.values['t:${thread.id}'];
        return mine ||
                read == null ||
                thread.lastSequence <= read ||
                threadRead != null && thread.lastSequence <= threadRead ||
                opened is int && thread.lastSequence <= opened
            ? 'Read'
            : null;
      case SwarmActivityReaction():
        final seen = _marks[item.swarmId]?.values['r:${item.message.id}'];
        return seen == item.signature ? 'Seen' : null;
      // Read or not, a server row is never handled here: its server says
      // whether it is read ([unread]).
      case SwarmActivityServerItem():
        return null;
    }
  }

  /// The option Approve sends for [item]: a decision's recommended one;
  /// null for anything else, and while an answer is held or on its way.
  String? approveOption(SwarmActivityItem item) {
    if (item case SwarmActivityNeed(need: final SwarmDecisionNeed need)
        when _open(item)) {
      final decision = need.decision;
      final asks = inbox.asks(need.swarmId);
      final busy =
          session.holding(need) ||
          (asks?.answering.contains(decision.id) ?? false) ||
          asks?.unconfirmed(decision) != null ||
          (asks?.unconfirmedDelegate(decision) ?? false);
      final choice = decision.recommended;
      if (!busy && choice >= 0 && choice < decision.options.length) {
        return decision.options[choice];
      }
    }
    return null;
  }

  bool canApprove(SwarmActivityItem item) => approveOption(item) != null;

  /// Holds [item]'s recommended option for the session's Undo window, then
  /// sends it ([SwarmSession.hold]); the screen asks first. Sent, it is
  /// "Approved".
  void approve(SwarmActivityItem item) {
    if (_disposed || !canApprove(item)) return;
    final need = (item as SwarmActivityNeed).need as SwarmDecisionNeed;
    _approving.add(item.key);
    session.hold(need, need.decision.recommended);
  }

  /// The person opened [item] with Reply: handled at once. A need stays
  /// handled until it changes (its key moves); a thread until a newer reply,
  /// a reaction until someone else reacts.
  void replied(SwarmActivityItem item) {
    if (_disposed) return;
    switch (item) {
      case SwarmActivityNeed():
        if (!_open(item)) return;
        _acted[item.key] = (swarmId: item.swarmId, word: 'Opened');
      case SwarmActivityThread(:final thread):
        _marks[item.swarmId]?.put('t:${thread.id}', thread.lastSequence);
        // Read on every device too (backend readMarks.ts thread marks).
        inbox
            .reader(item.swarmId)
            ?.readMarks
            ?.markThreadRead(item.chatId, thread.id, thread.lastSequence);
      case SwarmActivityReaction():
        _marks[item.swarmId]?.put('r:${item.message.id}', item.signature);
      // Read on every device once Activity is left, as on Desktop.
      case SwarmActivityServerItem():
        return;
    }
    _built = null;
    notifyListeners();
  }

  /// Where [item]'s thread lands when it is opened: ask before [replied],
  /// which reads a whole thread, so its first unread reply is still known.
  SwarmThreadFocus? landingOf(SwarmActivityItem item) {
    if (item is! SwarmActivityThread) return item.threadFocus;
    final reader = inbox.reader(item.swarmId);
    final through =
        reader?.readMarks?.threadThrough(item.chatId, item.thread.id) ??
        reader?.snapshot?.threadMarks[item.chatId]?[item.thread.id] ??
        0;
    return SwarmThreadFocus.firstUnread(after: through);
  }

  bool _open(SwarmActivityNeed item) =>
      inbox.needs.any((need) => need.key == item.key);

  /// Each project chat [reader] holds, with its project: never a Buddy chat.
  /// None while its server lists Activity: nothing of them is read then.
  Iterable<({SuperTabProject project, SuperTabConversation chat})>
  _projectChats(SwarmReader reader) sync* {
    final snapshot = reader.snapshot;
    if (snapshot == null || reader.accessRevoked) return;
    if (_feeds[reader.tabId]?.fromServer ?? false) return;
    for (final project in snapshot.projects) {
      final chat = snapshot.conversation(project.leadConversationId);
      if (chat == null || chat.isBuddyChat) continue;
      yield (project: project, chat: chat);
    }
  }

  void _changed() {
    if (_disposed) return;
    _sweep();
    _seed();
    _built = null;
    if (shown) _want();
    // What a send does is told before the send starts (SwarmSession._send):
    // what was done is looked at once it has.
    if (!_tracking) {
      _tracking = true;
      scheduleMicrotask(() {
        _tracking = false;
        if (!_disposed) _track();
      });
    }
    notifyListeners();
  }

  /// A Swarm off the list, or no longer readable, takes its marks off the
  /// phone and its handled rows with it, and its server rows; one newly
  /// listed reads its marks and its server's Activity. Once its server has
  /// answered Activity, the marks kept on the phone for it go: the server
  /// keeps what is read.
  void _sweep() {
    final listed = {for (final swarm in inbox.swarms) swarm.id};
    bool gone(String swarmId) =>
        !listed.contains(swarmId) ||
        (inbox.reader(swarmId)?.accessRevoked ?? true);
    for (final MapEntry(key: id, value: feed) in _feeds.entries.toList()) {
      if (gone(id) || !identical(inbox.reader(id), feed.reader)) {
        _feeds.remove(id)!
          ..removeListener(_changed)
          ..dispose();
        _shownRows.remove(id);
      }
    }
    for (final MapEntry(key: id, value: marks) in _marks.entries.toList()) {
      if (gone(id) ||
          !identical(inbox.reader(id), marks.reader) ||
          _answered(id)) {
        _marks.remove(id)!.forget();
      }
    }
    _acted.removeWhere((_, acted) => gone(acted.swarmId));
    _gone.removeWhere((_, row) => gone(row.item.swarmId));
    for (final id in listed) {
      final reader = inbox.reader(id);
      if (reader == null || reader.accessRevoked) continue;
      if (!_feeds.containsKey(id)) {
        final feed = _feeds[id] = SwarmActivityFeed(reader);
        if (shown) feed.opened();
        feed.addListener(_changed);
      }
      if (_marks.containsKey(id) || _answered(id)) continue;
      _marks[id] = _SwarmMarks(reader, store, accountId, onLoaded: _changed);
    }
  }

  /// Swarm [id]'s server has listed its Activity: what is read is kept
  /// there, not on the phone.
  bool _answered(String id) => switch (_feeds[id]) {
    final feed? => feed.fromServer && feed.loaded && feed.error == null,
    null => false,
  };

  bool _held(String key) => inbox.needs.any(
    (need) =>
        need.key == key && need is SwarmDecisionNeed && session.holding(need),
  );

  /// On this phone's first Activity of a Swarm, the reactions already there
  /// count as seen: a new phone does not start with all of them new.
  void _seed() {
    for (final MapEntry(key: id, value: marks) in _marks.entries) {
      if (!marks.loaded || marks.found) continue;
      for (final (:project, :chat) in _projectChats(marks.reader)) {
        if (marks.seeded.contains(chat.id)) continue;
        final peek = session.peeks.of(marks.reader, chat.id);
        if (peek == null) continue;
        marks.seeded.add(chat.id);
        for (final item in _reactions(id, project, chat.id, peek)) {
          marks.put('r:${item.message.id}', item.signature);
        }
      }
    }
  }

  /// Asks for each project chat as its counters stand: read only if they
  /// moved since it was last read.
  void _want() {
    for (final swarm in inbox.swarms) {
      final reader = inbox.reader(swarm.id);
      if (reader == null) continue;
      for (final (project: _, :chat) in _projectChats(reader)) {
        session.peeks.want(
          reader,
          chat.id,
          counter: (chat.lastMessageSequence, chat.reactionSeq),
          owner: this,
        );
      }
    }
  }

  /// What was done with each need, once it is done: an answer on its way
  /// is sent, a tag being marked is done. A need acted on that left the
  /// inbox stays as a handled row.
  void _track() {
    final open = {for (final need in inbox.needs) need.key: need};
    var changed = false;
    for (final need in open.values) {
      final asks = inbox.asks(need.swarmId);
      final String? word = switch (need) {
        SwarmDecisionNeed(:final decision)
            when (asks?.answering.contains(decision.id) ?? false) ||
                asks?.unconfirmed(decision) != null =>
          _approving.contains(need.key) ? 'Approved' : 'Answered',
        SwarmMentionNeed(:final mention)
            when asks?.finishing(mention) ?? false =>
          'Done',
        _ => null,
      };
      if (word != null && _acted[need.key]?.word != word) {
        _acted[need.key] = (swarmId: need.swarmId, word: word);
        changed = true;
      }
      // A Done that failed is not done.
      if (need case SwarmMentionNeed(:final mention)
          when asks?.notDone(mention) != null &&
              _acted[need.key]?.word == 'Done') {
        _acted.remove(need.key);
        changed = true;
      }
    }
    // An Approve undone, or dropped before it was sent, is no Approve.
    _approving.removeWhere((key) => !_acted.containsKey(key) && !_held(key));
    for (final key in _acted.keys.toList()) {
      if (open.containsKey(key)) continue;
      final acted = _acted.remove(key)!;
      _approving.remove(key);
      final row = _last[key];
      if (row != null) {
        _gone[key] = (item: row, word: acted.word);
        while (_gone.length > keptHandled) {
          _gone.remove(_gone.keys.first);
        }
      }
      changed = true;
    }
    _last
      ..clear()
      ..addAll({
        for (final need in open.values) need.key: SwarmActivityNeed(need),
      });
    if (changed) {
      _built = null;
      notifyListeners();
    }
  }

  /// Each open need's row as last seen: what a handled row shows once it
  /// left the inbox.
  final _last = <String, SwarmActivityNeed>{};

  Map<SwarmActivityFilter, List<SwarmActivityItem>> _build() {
    final rows = {
      for (final f in SwarmActivityFilter.values) f: <SwarmActivityItem>[],
    };
    for (final need in inbox.needs) {
      final item = SwarmActivityNeed(need);
      rows[item.filter]!.add(item);
    }
    for (final swarm in inbox.swarms) {
      final reader = inbox.reader(swarm.id);
      if (reader == null) continue;
      if (_feeds[swarm.id] case final feed? when feed.fromServer) {
        for (final entry in feed.items) {
          final item = SwarmActivityServerItem(swarm.id, entry);
          rows[item.filter]!.add(item);
        }
      }
      for (final (:project, :chat) in _projectChats(reader)) {
        final peek = session.peeks.of(reader, chat.id);
        if (peek == null) continue;
        rows[SwarmActivityFilter.threads]!.addAll(
          _threads(swarm.id, project, chat.id, peek),
        );
        rows[SwarmActivityFilter.reactions]!.addAll(
          _reactions(swarm.id, project, chat.id, peek),
        );
      }
    }
    int newest(SwarmActivityItem a, SwarmActivityItem b) =>
        (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0));
    for (final filter in [
      SwarmActivityFilter.threads,
      SwarmActivityFilter.reactions,
    ]) {
      rows[filter]!.sort(newest);
    }
    final built = <SwarmActivityFilter, List<SwarmActivityItem>>{};
    for (final MapEntry(key: filter, value: list) in rows.entries) {
      final handledNeeds = [
        for (final row in _gone.values.toList().reversed)
          if (row.item.filter == filter) row.item,
      ];
      built[filter] = List.unmodifiable([
        ...list.where((item) => handled(item) == null),
        ...list.where((item) => handled(item) != null),
        ...handledNeeds,
      ]);
    }
    return built;
  }

  Iterable<SwarmActivityThread> _threads(
    String swarmId,
    SuperTabProject project,
    String chatId,
    SwarmPeek peek,
  ) sync* {
    for (final thread in peek.threads.values) {
      if (!thread.people.contains(accountId) || thread.replies == 0) continue;
      yield SwarmActivityThread(
        swarmId,
        project: project,
        chatId: chatId,
        thread: thread,
        root: peek.messages.where((m) => m.id == thread.id).firstOrNull,
      );
    }
  }

  Iterable<SwarmActivityReaction> _reactions(
    String swarmId,
    SuperTabProject project,
    String chatId,
    SwarmPeek peek,
  ) sync* {
    for (final message in peek.messages) {
      if (message.fromAgent || message.authorId != accountId) continue;
      final others = [
        for (final r in message.reactions)
          if ([
                for (final who in r.by)
                  if (!(who.kind == 'person' && who.id == accountId)) who,
              ]
              case final by when by.isNotEmpty)
            SuperTabReactionCount(r.emoji, by),
      ];
      if (others.isEmpty) continue;
      yield SwarmActivityReaction(
        swarmId,
        project: project,
        chatId: chatId,
        message: message,
        reactions: List.unmodifiable(others),
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    inbox.removeListener(_changed);
    session.removeListener(_changed);
    session.peeks.removeListener(_changed);
    // Closing keeps the marks on the phone for the next session.
    _marks.clear();
    // An answer on its way belongs to the session that is gone.
    for (final feed in _feeds.values) {
      feed
        ..removeListener(_changed)
        ..dispose();
    }
    _feeds.clear();
    _shownRows.clear();
    super.dispose();
  }
}

/// One Swarm's handled marks on the phone: a thread's last reply opened, a
/// message's reactions seen.
class _SwarmMarks {
  _SwarmMarks(
    this.reader,
    this.store,
    String accountId, {
    required this.onLoaded,
  }) : _key = 'swarm_activity.$accountId.${reader.tabId}' {
    unawaited(_load());
  }

  final SwarmReader reader;
  final LocalKeyValueStore? store;
  final VoidCallback onLoaded;
  final String _key;
  final values = <String, Object>{};

  /// The project chats seeded on this phone's first Activity.
  final seeded = <String>{};
  bool loaded = false, found = false, _forgotten = false;

  Future<void> _load() async {
    final held = <String, Object>{};
    var found = false;
    try {
      if (await store?.read(_key) case final raw?) {
        if (jsonDecode(raw) case {'marks': final Map marks}) {
          for (final MapEntry(:key, :value) in marks.entries) {
            if (key is String && (value is int || value is String)) {
              held[key] = value as Object;
            }
          }
          found = true;
        }
      }
    } catch (_) {
      // An unreadable value is no marks: this Activity starts afresh.
    }
    if (_forgotten) return;
    for (final MapEntry(:key, :value) in held.entries) {
      // A thread opened before the marks were back keeps the higher of the
      // two: a mark read back late never lowers it. A reaction's signature
      // set since is the newer.
      final now = values[key];
      if (now == null || (now is int && value is int && value > now)) {
        values[key] = value;
      }
    }
    this.found = found;
    loaded = true;
    if (values.isNotEmpty) _write();
    onLoaded();
  }

  /// Keeps [value] under [key]: a thread's reply opened ([int]) only moves
  /// on, so an older one put later never lowers it.
  void put(String key, Object value) {
    if (_forgotten || values[key] == value) return;
    if (values[key] case final int had when value is int && value < had) {
      return;
    }
    values.remove(key);
    values[key] = value;
    while (values.length > SwarmActivity.keptMarks) {
      values.remove(values.keys.first);
    }
    _write();
  }

  void _write() {
    if (!loaded || _forgotten) return;
    unawaited(
      store
          ?.write(_key, jsonEncode({'marks': values}))
          .catchError((Object _) {}),
    );
  }

  /// The Swarm left: nothing of it stays on the phone.
  void forget() {
    _forgotten = true;
    values.clear();
    unawaited(store?.delete(_key).catchError((Object _) {}));
  }
}
