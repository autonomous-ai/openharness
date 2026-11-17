import 'dart:async';

import 'package:flutter/foundation.dart';

/// One row of an agent's conversation as chat (`chat/chat_view.dart`).
enum ChatRole { user, assistant, tool }

class ChatItem {
  ChatItem.user(this.text) : role = ChatRole.user, toolId = null, tool = null;

  ChatItem.assistant(this.text, {this.commentary = false})
    : role = ChatRole.assistant,
      toolId = null,
      tool = null;

  ChatItem.tool({required this.toolId, required this.tool, required this.text})
    : role = ChatRole.tool;

  final ChatRole role;

  /// The words: what was asked, what was answered, or what a tool was given (its command, its file).
  String text;

  /// What the agent says on the way rather than as its answer (Codex's commentary): drawn quieter.
  bool commentary = false;

  final String? toolId;
  final String? tool;

  /// A tool's end has arrived.
  bool toolDone = false;
  bool toolError = false;
}

/// Where a conversation's first read stands.
enum ChatLoad { idle, loading, loaded, failed }

/// What `session_get` answers with: a page of the conversation's events, oldest first.
typedef ChatHistoryPage = ({
  List<Map<String, dynamic>> events,
  bool hasMore,
  String? oldestCursor,
});

/// Reads a page of history: the newest one when [before] is null, else the page before that cursor.
/// Throws when the machine could not answer.
typedef ChatHistoryReader = Future<ChatHistoryPage> Function(String? before);

/// One agent's conversation, as chat: its history read a page at a time, and its live events on top.
///
/// ⚠️ **Live events that land while the first page is being read wait for it, and are dropped when
/// the page already holds them.** The read and the stream overlap: an answer written to the
/// transcript during the read is both in the page and on its way live. See [_alreadyAtTail].
class ChatConversation extends ChangeNotifier {
  ChatConversation({required this.read, this.streamsText = false});

  /// Tells how many history events a page asks for — transcript records, not chat rows.
  static const pageSize = 80;

  /// The most rows kept: older ones go when more arrive, as a terminal's scrollback does.
  static const maxItems = 1500;

  /// Reads a page of this conversation's history.
  final ChatHistoryReader read;

  /// The engine sends its answer in pieces (OpenCode, Kilo) rather than a block at a time.
  final bool streamsText;

  final List<ChatItem> items = [];
  ChatLoad load = ChatLoad.idle;
  bool hasMore = false;
  String? _oldestCursor;
  bool loadingOlder = false;

  /// A turn is under way: the agent is working on what was last asked.
  bool working = false;
  DateTime? workingSince;

  /// How long the last finished turn took, and whether it was stopped.
  Duration? lastTurn;
  bool lastTurnStopped = false;

  /// Live events held while the first page is read — see the class note.
  List<(String, Map<String, dynamic>)>? _held;

  bool _disposed = false;

  /// Reads the newest page, once; a failed read can be asked again.
  Future<void> open() async {
    if (load == ChatLoad.loading || load == ChatLoad.loaded) return;
    load = ChatLoad.loading;
    _held = [];
    _changed();
    try {
      final page = await read(null);
      if (_disposed) return;
      items.clear();
      for (final event in page.events) {
        _apply(event['type'], event['payload'], live: false);
      }
      hasMore = page.hasMore;
      _oldestCursor = page.oldestCursor;
      load = ChatLoad.loaded;
      final held = _held ?? const [];
      _held = null;
      for (final (type, payload) in held) {
        if (!_alreadyAtTail(type, payload)) _apply(type, payload, live: true);
      }
    } catch (_) {
      if (_disposed) return;
      _held = null;
      load = ChatLoad.failed;
    }
    _trim();
    _changed();
  }

  /// Reads the page before the oldest one held, for a reader scrolled to the top.
  Future<void> loadOlder() async {
    final cursor = _oldestCursor;
    if (!hasMore || cursor == null || loadingOlder || load != ChatLoad.loaded) {
      return;
    }
    loadingOlder = true;
    _changed();
    try {
      final page = await read(cursor);
      if (_disposed) return;
      final older = ChatConversation(read: read, streamsText: streamsText);
      for (final event in page.events) {
        older._apply(event['type'], event['payload'], live: false);
      }
      items.insertAll(0, older.items);
      older.dispose();
      hasMore = page.hasMore;
      _oldestCursor = page.oldestCursor;
    } catch (_) {
      // The top stays where it is; scrolling there again asks again.
    } finally {
      loadingOlder = false;
      _changed();
    }
  }

  /// One live event from the machine (`turn_started`, `user_message`, `text_delta`, `tool_start`,
  /// `tool_end`, `turn_ended`).
  void ingest(String type, Map<String, dynamic> payload) {
    if (_disposed) return;
    final held = _held;
    if (held != null) {
      held.add((type, payload));
      // The turn's state is not in the transcript, so it is not waited for.
      _turnState(type);
      _changed();
      return;
    }
    if (load != ChatLoad.loaded) {
      _turnState(type);
      _changed();
      return;
    }
    _apply(type, payload, live: true);
    _trim();
    _changed();
  }

  void _turnState(String type) {
    if (type == 'turn_started') {
      working = true;
      workingSince = DateTime.now();
    } else if (type == 'turn_ended') {
      working = false;
    }
  }

  void _apply(Object? type, Object? rawPayload, {required bool live}) {
    if (type is! String) return;
    final payload = rawPayload is Map
        ? rawPayload.cast<String, dynamic>()
        : const <String, dynamic>{};
    switch (type) {
      case 'turn_started':
        working = true;
        workingSince = DateTime.now();
        _addUser(payload['userMessage']);
      case 'user_message':
        _addUser(payload['content']);
      case 'text_delta':
        final content = payload['content'];
        if (content is! String || content.isEmpty) return;
        final commentary = payload['commentary'] == true;
        final last = items.isEmpty ? null : items.last;
        if (streamsText &&
            last != null &&
            last.role == ChatRole.assistant &&
            last.commentary == commentary) {
          last.text += content;
        } else {
          items.add(ChatItem.assistant(content, commentary: commentary));
        }
      case 'tool_start':
        final id = payload['id'];
        items.add(
          ChatItem.tool(
            toolId: id is String ? id : null,
            tool: payload['tool'] is String
                ? payload['tool'] as String
                : 'Tool',
            text: toolInputSummary(payload['input']),
          ),
        );
      case 'tool_end':
        final id = payload['id'];
        for (var i = items.length - 1; i >= 0; i--) {
          final item = items[i];
          if (item.role == ChatRole.tool && item.toolId == id) {
            item.toolDone = true;
            item.toolError = payload['isError'] == true;
            break;
          }
        }
      case 'turn_ended':
        working = false;
        final since = workingSince;
        lastTurn = live && since != null
            ? DateTime.now().difference(since)
            : null;
        lastTurnStopped = payload['aborted'] == true;
        workingSince = null;
    }
  }

  /// A request is said twice live — `turn_started` carries it, and `user_message` follows — and
  /// drawn once.
  void _addUser(Object? content) {
    if (content is! String || content.trim().isEmpty) return;
    for (var i = items.length - 1; i >= 0; i--) {
      final item = items[i];
      if (item.role != ChatRole.user) continue;
      if (item.text.trim() == content.trim() && i >= items.length - 1) return;
      break;
    }
    items.add(ChatItem.user(content));
  }

  /// Whether a live event held during the first read is already in what the read returned.
  bool _alreadyAtTail(String type, Map<String, dynamic> payload) {
    final tail = items.length > 12 ? items.sublist(items.length - 12) : items;
    switch (type) {
      case 'turn_started':
      case 'user_message':
        final text = (payload['userMessage'] ?? payload['content']);
        return text is String &&
            tail.any((i) => i.role == ChatRole.user && i.text == text);
      case 'text_delta':
        final text = payload['content'];
        return text is String &&
            tail.any((i) => i.role == ChatRole.assistant && i.text == text);
      case 'tool_start':
        return tail.any(
          (i) => i.role == ChatRole.tool && i.toolId == payload['id'],
        );
      default:
        return false;
    }
  }

  void _trim() {
    if (items.length > maxItems) {
      items.removeRange(0, items.length - maxItems);
      hasMore = false;
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// What a tool was given, in a line: the command, the file, the search — whichever it has.
String toolInputSummary(Object? input) {
  String cut(String s) {
    final line = s.trim().split('\n').first;
    return line.length > 160 ? '${line.substring(0, 159)}…' : line;
  }

  if (input is String) return cut(input);
  if (input is! Map) return '';
  for (final key in const [
    'command',
    'cmd',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
    'prompt',
  ]) {
    final value = input[key];
    if (value is String && value.trim().isNotEmpty) return cut(value);
    if (value is List && value.isNotEmpty) return cut(value.join(' '));
  }
  for (final value in input.values) {
    if (value is String && value.trim().isNotEmpty) return cut(value);
  }
  return '';
}

/// The conversations open as chat, one per agent and session, at most [maxOpen]: the one least
/// recently opened goes first.
class ChatConversations {
  ChatConversations({required this.reader});

  static const maxOpen = 6;

  /// How a conversation reads its history: [machineId]'s `session_get` for [sessionId].
  final ChatHistoryReader Function(String machineId, String sessionId) reader;

  final Map<String, ChatConversation> _open = {};

  static String _key(String machineId, String agentId, String sessionId) =>
      '$machineId\u0000$agentId\u0000$sessionId';

  /// [agentId]'s conversation [sessionId], opened (and its history read) if it is not already.
  ChatConversation open(
    String machineId,
    String agentId,
    String sessionId, {
    bool streamsText = false,
  }) {
    final key = _key(machineId, agentId, sessionId);
    // Asked on every build of the page showing it: only a conversation not yet held reads anything.
    // A failed read is asked again from its Retry, never by a rebuild.
    final held = _open.remove(key);
    final conversation =
        held ??
        ChatConversation(
          read: reader(machineId, sessionId),
          streamsText: streamsText,
        );
    _open[key] = conversation;
    if (held != null) return conversation;
    // Let go of, not disposed: a page still showing one keeps it, and it simply hears no more.
    while (_open.length > maxOpen) {
      _open.remove(_open.keys.first);
    }
    unawaited(conversation.open());
    return conversation;
  }

  /// A live event for [agentId]'s session — nothing when it is not open as chat.
  void ingest(
    String machineId,
    String agentId,
    String? sessionId,
    String type,
    Map<String, dynamic> payload,
  ) {
    for (final entry in _open.entries) {
      final parts = entry.key.split('\u0000');
      if (parts[0] != machineId || parts[1] != agentId) continue;
      if (sessionId != null && parts[2] != sessionId) continue;
      entry.value.ingest(type, payload);
    }
  }

  void clear() => _open.clear();
}
