import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'model.dart';
import 'swarm_chat_peeks.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';

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
  DateTime? get at => switch (need) {
    SwarmDecisionNeed(:final decision) => decision.createdAt,
    SwarmMentionNeed(:final mention) => mention.createdAt,
    SwarmWorkNeed(:final work) => work.conversation.changedAt,
  };
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
  DateTime? get at => thread.lastAt;
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
  DateTime? get at => message.createdAt;

  /// Who gave which emoji, in one value: a reaction seen is handled until
  /// this moves.
  String get signature => ([
    for (final r in reactions)
      for (final who in r.by) '${r.emoji.key}:${who.kind}:${who.id}',
  ]..sort()).join(',');
}

/// Activity, in place of Needs you (Tony's prototype C3; Product Manager's
/// brief 10-30): what the Swarms ask of the person (Needs you, @), the threads
/// they are in and others' reactions to what they wrote, each filter counted,
/// and the rows they acted on kept as handled.
///
/// Needs you and @ are the inbox's, read already. Threads and Reactions come
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

  /// Each listed Swarm's handled marks.
  final _marks = <String, _SwarmMarks>{};

  Map<SwarmActivityFilter, List<SwarmActivityItem>>? _built;

  /// Screens showing Activity ([watch]): while there is one, the project
  /// chats are read when their counters move.
  int _views = 0;
  bool get shown => _views > 0;

  /// A screen shows Activity: its chats are read as their counters move.
  void watch() {
    if (_disposed || _views++ > 0) return;
    _want();
  }

  /// That screen went, or out of sight: once none shows it, the chats still
  /// waiting their turn for it are not read ([SwarmChatPeeks.withdraw]).
  void unwatch() {
    if (_views > 0 && --_views == 0) session.peeks.withdraw(this);
  }

  /// The rows of [filter]: those still to handle, newest first, then the
  /// handled ones.
  List<SwarmActivityItem> items(SwarmActivityFilter filter) =>
      (_built ??= _build())[filter] ?? const [];

  /// The rows of [filter] still to handle.
  int count(SwarmActivityFilter filter) =>
      items(filter).where((item) => handled(item) == null).length;

  /// The tab's badge, as the prototype draws it: what needs the person.
  int get badge => count(SwarmActivityFilter.needsYou);

  /// Some project chat could not be read at its last change.
  bool get unreadChats => _anyChat(session.peeks.failedAt);

  /// A project chat is being read for the first time since it moved, with
  /// nothing of it read yet: Threads and Reactions may still fill.
  bool get reading => _anyChat(
    (reader, chat) =>
        session.peeks.busyAt(reader, chat) &&
        session.peeks.of(reader, chat) == null,
  );

  /// The person's Try again: the project chats that failed are read again.
  void retry() => _anyChat((reader, chat) {
    session.peeks.retry(reader, chat, owner: this);
    return false;
  });

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
        final opened = marks.values['t:${thread.id}'];
        return mine ||
                read == null ||
                thread.lastSequence <= read ||
                opened is int && thread.lastSequence <= opened
            ? 'Read'
            : null;
      case SwarmActivityReaction():
        final seen = _marks[item.swarmId]?.values['r:${item.message.id}'];
        return seen == item.signature ? 'Seen' : null;
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
          session.held(need) != null ||
          (asks?.answering.contains(decision.id) ?? false) ||
          asks?.unconfirmed(decision) != null;
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
      case SwarmActivityReaction():
        _marks[item.swarmId]?.put('r:${item.message.id}', item.signature);
    }
    _built = null;
    notifyListeners();
  }

  bool _open(SwarmActivityNeed item) =>
      inbox.needs.any((need) => need.key == item.key);

  /// Each project chat [reader] holds, with its project: never a Buddy chat.
  Iterable<({SuperTabProject project, SuperTabConversation chat})>
  _projectChats(SwarmReader reader) sync* {
    final snapshot = reader.snapshot;
    if (snapshot == null || reader.accessRevoked) return;
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
  /// phone and its handled rows with it; one newly listed reads its marks.
  void _sweep() {
    final listed = {for (final swarm in inbox.swarms) swarm.id};
    bool gone(String swarmId) =>
        !listed.contains(swarmId) ||
        (inbox.reader(swarmId)?.accessRevoked ?? true);
    for (final MapEntry(key: id, value: marks) in _marks.entries.toList()) {
      if (gone(id) || !identical(inbox.reader(id), marks.reader)) {
        _marks.remove(id)!.forget();
      }
    }
    _acted.removeWhere((_, acted) => gone(acted.swarmId));
    _gone.removeWhere((_, row) => gone(row.item.swarmId));
    for (final id in listed) {
      final reader = inbox.reader(id);
      if (reader == null || reader.accessRevoked || _marks.containsKey(id)) {
        continue;
      }
      _marks[id] = _SwarmMarks(reader, store, accountId, onLoaded: _changed);
    }
  }

  bool _held(String key) => inbox.needs.any(
    (need) =>
        need.key == key &&
        need is SwarmDecisionNeed &&
        session.held(need) != null,
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
