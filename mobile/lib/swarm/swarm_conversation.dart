import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// One conversation on the phone: its messages and what the person posts to
/// it — the desktop's `SuperTabController` messages and composer, for one
/// conversation at a time.
///
/// Messages are read as the latest page when opened, older pages on demand,
/// and new ones when the Swarm's read says the conversation moved past the
/// last one shown (`lastMessageSequence`): no read of its own while nothing
/// was posted. Keep the [reader] shown while this is on screen.
///
/// A conversation the Swarm's read no longer has hides its messages at once
/// and is asked for by id, as a closed one is in no full read. One the person
/// cannot read keeps nothing here: messages, draft and a post not confirmed.
class SwarmConversation extends ChangeNotifier {
  SwarmConversation(this.reader, this.id) {
    reader.addListener(_swarmChanged);
    reader.reads.addListener(_swarmChanged);
  }

  final SwarmReader reader;
  final String id;

  /// Oldest first.
  List<SuperTabMessage> messages = const [];

  /// What the last read or post could not do, as a sentence.
  String? error;

  /// A post is on its way.
  bool sending = false;

  SuperTabPage? _before;
  bool _read = false, _lost = false, _disposed = false;
  Future<void>? _reading, _readingOlder, _locating;

  /// Moves when what was read is dropped: a read asked for before then
  /// answers nothing.
  int _epoch = 0;
  String _draft = '';

  /// Agents mentioned in the draft, by id, with the token that names them.
  final _mentions = <String, String>{};

  /// The post on its way, then — while its answer never came — retried under
  /// the same operation id, so the backend runs it once.
  Map<String, dynamic>? _pending;

  /// What the draft was when [_pending] left it: a refusal puts it back.
  ({String draft, Map<String, String> mentions, SuperTabMessage? replyTo})?
  _sent;

  SuperTabMessage? _replyingTo;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
      '/conversations/${Uri.encodeComponent(id)}/messages';

  SuperTabConversation? get conversation => reader.snapshot?.conversation(id);

  /// Earlier messages wait to be read.
  bool get hasOlder => _before != null;

  /// A post was sent and not confirmed: [send] retries it.
  bool get unconfirmed => _pending != null && !sending;

  /// The post on its way or not confirmed, out of the draft: drawn at the
  /// foot of the chat, "Sending…" and then [unconfirmed], until it is read
  /// back.
  ({String text, String? replyTo})? get pending {
    final command = _pending?['command'] as Map?;
    if (command == null) return null;
    return (
      text: command['text'] as String,
      replyTo: command['replyTo'] as String?,
    );
  }

  /// The message the draft answers: the reply bar over the composer, and the
  /// post's `replyTo`.
  SuperTabMessage? get replyingTo => _replyingTo;
  set replyingTo(SuperTabMessage? message) {
    _replyingTo = message;
    notifyListeners();
  }

  /// The person may post here: a writer of the Swarm, in a conversation that
  /// is not archived.
  bool get canPost {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null || group.archived) return false;
    return snapshot.people
            .where((p) => p.id == reader.accountId)
            .firstOrNull
            ?.canWrite ??
        false;
  }

  String get draft => _draft;
  set draft(String value) {
    _draft = value;
    _mentions.removeWhere((_, token) => !containsMention(value, token));
    notifyListeners();
  }

  /// Whether [text] names [token] as a word of its own: the desktop's rule.
  static bool containsMention(String text, String token) =>
      RegExp('(?:^|\\s)${RegExp.escape(token)}(?=\$|\\s|[.,!?;:])')
          .hasMatch(text);

  /// The name typed after an @ that ends the draft — what the mention picker
  /// narrows to; null while the draft does not end in one.
  String? get mentionQuery =>
      RegExp(r'(?:^|\s)@(\S*)$').firstMatch(_draft)?.group(1);

  /// [agentId]'s name in place of the @ being typed ([mentionQuery]), as
  /// [mention] adds it.
  void completeMention(String agentId) {
    if (mentionQuery case final query?) {
      _draft = _draft.substring(0, _draft.length - query.length - 1);
    }
    mention(agentId);
  }

  /// Adds [agentId]'s name to the draft; the post goes to it while the name
  /// stays in the text.
  void mention(String agentId) {
    final snapshot = reader.snapshot;
    if (snapshot == null) return;
    final token = '@${snapshot.agentName(agentId)}';
    final spaced = _draft.isEmpty || RegExp(r'\s$').hasMatch(_draft);
    _draft = '$_draft${spaced ? '' : ' '}$token ';
    _mentions[agentId] = token;
    notifyListeners();
  }

  /// The agents a post can mention: those in this conversation.
  List<SuperTabAgent> get mentionable {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null) return const [];
    return [for (final agentId in group.agentIds) ?snapshot.agent(agentId)];
  }

  /// The Swarm was read, changed or not.
  void _swarmChanged() {
    if (_disposed) return;
    if (reader.accessRevoked) {
      _lose();
      return;
    }
    if (reader.snapshot == null) return;
    final group = conversation;
    if (group == null) {
      if (messages.isNotEmpty || _read) {
        _forget();
        notifyListeners();
      }
      // Asked for by id until it is known unreadable; an ask that failed is
      // made again at the Swarm's next read.
      if (!_lost) unawaited(_locate());
      return;
    }
    _lost = false;
    final tail = messages.lastOrNull?.sequence ?? 0;
    if (!_read || group.lastMessageSequence > tail) unawaited(load());
  }

  /// Asks the reader for this conversation by id: a closed one comes back,
  /// and [_swarmChanged] reads it; one the person cannot read is lost.
  Future<void> _locate() => _locating ??= () async {
    try {
      if (!await reader.loadConversation(id) && !_disposed) {
        _lost = true;
        _lose();
      }
    } catch (_) {
      // Not known either way: asked again at the Swarm's next read.
    }
  }().whenComplete(() => _locating = null);

  /// Drops the messages read, and the answer of any read under way.
  void _forget() {
    messages = const [];
    _before = null;
    _read = false;
    _epoch++;
    _reading = null;
    _readingOlder = null;
  }

  /// The person cannot read this conversation: nothing of it stays.
  void _lose() {
    final held =
        messages.isNotEmpty ||
        _read ||
        _draft.isNotEmpty ||
        _pending != null ||
        _replyingTo != null ||
        error != null;
    _forget();
    _draft = '';
    _mentions.clear();
    _pending = null;
    _sent = null;
    _replyingTo = null;
    error = null;
    if (held) notifyListeners();
  }

  /// The latest page the first time, then what came after the newest shown;
  /// a conversation the Swarm's read does not have is asked for by id first.
  /// Joins a read under way.
  Future<void> load() {
    if (_disposed) return Future.value();
    if (reader.snapshot != null && conversation == null) return _locate();
    if (_reading case final reading?) return reading;
    late final Future<void> reading;
    reading = _load(older: false).whenComplete(() {
      if (identical(_reading, reading)) _reading = null;
    });
    return _reading = reading;
  }

  /// The page before the oldest shown.
  Future<void> loadOlder() {
    if (!hasOlder) return Future.value();
    if (_readingOlder case final reading?) return reading;
    late final Future<void> reading;
    reading = _load(older: true).whenComplete(() {
      if (identical(_readingOlder, reading)) _readingOlder = null;
    });
    return _readingOlder = reading;
  }

  Future<void> _load({required bool older}) async {
    final epoch = _epoch;
    try {
      final tail = messages.lastOrNull?.sequence;
      final before = _before;
      final query = older
          ? '?before=${before!.sequence}'
                '&beforeId=${Uri.encodeQueryComponent(before.id)}'
          : tail == null
          ? ''
          : '?after=$tail';
      final answer = superTabMap(await reader.request('GET', '$_path$query'));
      if (_disposed || epoch != _epoch) return;
      final incoming = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ];
      if (incoming.any((m) => m.conversationId != id)) {
        throw const FormatException('A different conversation was returned.');
      }
      final combined = {
        for (final m in messages) m.id: m,
        for (final m in incoming) m.id: m,
      };
      messages = List.unmodifiable(
        combined.values.toList()..sort(superTabMessageOrder),
      );
      if (older || !_read) _before = SuperTabPage.read(answer['next']);
      _read = true;
      error = null;
    } on SuperTabFailure catch (failure) {
      if (_disposed || epoch != _epoch) return;
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) _lose();
      error = failure.message;
    } catch (_) {
      if (_disposed || epoch != _epoch) return;
      error = 'Could not load messages. Try again.';
    }
    notifyListeners();
  }

  /// Posts the draft, to the agents mentioned in it and as a reply to
  /// [replyingTo] — or, while a post is [unconfirmed], sends that one again.
  /// The post leaves the draft at once and shows as [pending] until it is
  /// read back. True once the backend took it.
  Future<bool> send() async {
    if (sending || _disposed || !canPost) return false;
    final pending = _pending ?? _compose();
    if (pending == null) return false;
    if (_pending == null) {
      _sent = (
        draft: _draft,
        mentions: Map.of(_mentions),
        replyTo: _replyingTo,
      );
      _draft = '';
      _mentions.clear();
      _replyingTo = null;
    }
    _pending = pending;
    sending = true;
    error = null;
    notifyListeners();
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: pending,
      );
    } on SuperTabFailure catch (failure) {
      // A definitive refusal made no change: the text goes back to the draft
      // to correct. A lost answer keeps its receipt, so a retry is the same
      // post.
      final status = failure.statusCode;
      if (status >= 400 && status < 500 && status != 408 && status != 429) {
        _pending = null;
        _restore();
      }
      error = failure.message;
      return false;
    } catch (_) {
      error = 'Your message is not confirmed. Send again to check it.';
      return false;
    } finally {
      sending = false;
      if (!_disposed) notifyListeners();
    }
    unawaited(reader.refresh());
    // Shown as on its way until the read that brings it back.
    await load();
    if (_disposed || !identical(_pending, pending)) return true;
    _pending = null;
    _sent = null;
    notifyListeners();
    return true;
  }

  /// A refused post's text back in the draft, before anything typed since.
  void _restore() {
    final sent = _sent;
    _sent = null;
    if (sent == null) return;
    _draft = _draft.trim().isEmpty ? sent.draft : '${sent.draft}\n$_draft';
    _mentions.addAll(sent.mentions);
    _replyingTo ??= sent.replyTo;
  }

  Map<String, dynamic>? _compose() {
    final text = _draft.trim();
    final group = conversation;
    if (text.isEmpty || group == null) return null;
    return {
      'operationId': superTabOperationId(),
      'command': {
        'type': 'message.send',
        'conversationId': id,
        'text': text,
        'replyTo': _replyingTo?.id,
        'recipientIds': [
          for (final MapEntry(key: agentId, value: token) in _mentions.entries)
            if (containsMention(text, token) &&
                group.agentIds.contains(agentId))
              agentId,
        ],
      },
    };
  }

  @override
  void dispose() {
    _disposed = true;
    reader.removeListener(_swarmChanged);
    reader.reads.removeListener(_swarmChanged);
    super.dispose();
  }
}

/// The person's private chat with [projectId]'s Product Manager: that
/// project's private conversation whose audience is them alone (the
/// desktop's `SuperTabController.pmChat`).
SuperTabConversation? swarmPmChat(SwarmReader reader, String projectId) =>
    reader.snapshot?.conversations
        .where(
          (g) =>
              g.projectId == projectId &&
              g.audience?.length == 1 &&
              g.audience!.single == reader.accountId,
        )
        .firstOrNull;

/// Opens [swarmPmChat], creating it on first use: chat only, for this person
/// alone, named after them, with the project's Lead in it. The create is one
/// fixed operation per person, membership and project, so a second tap or
/// another device gets the same conversation back, while a person who left
/// and rejoined gets a new one (the desktop's `openPmChat`). Answers its id,
/// or null when it could not be read back; a refusal throws.
Future<String?> openSwarmPmChat(SwarmReader reader, String projectId) async {
  if (swarmPmChat(reader, projectId) case final chat?) return chat.id;
  final me = reader.snapshot?.people
      .where((p) => p.id == reader.accountId)
      .firstOrNull;
  final email = me?.email;
  var operation =
      'pm-chat-$projectId-${reader.accountId}-${me?.generation ?? ''}';
  // The backend's operation ids are at most 160 characters.
  if (operation.length > 160) operation = operation.substring(0, 160);
  final answer = superTabMap(
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {
        'operationId': operation,
        'command': {
          'type': 'conversation.create',
          'projectId': projectId,
          'title': email == null || email.isEmpty
              ? 'Chat with PM'
              : email.split('@').first,
          'brief': '',
          'checks': <Object>[],
          'audience': {
            'personIds': [reader.accountId],
          },
        },
      },
    ),
  );
  final id = superTabMap(answer['result'] ?? const {})['conversationId'];
  if (id is! String) return null;
  await reader.refresh();
  return await reader.loadConversation(id) ? id : null;
}
