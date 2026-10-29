import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What one read of a chat brought: its messages, oldest first, and the
/// thread lines of the roots among them.
typedef SwarmPeek = ({
  List<SuperTabMessage> messages,
  Map<String, SuperTabThread> threads,
});

/// A few chats' newest rows, for the screens that list many chats at once:
/// Activity (each project chat's newest page) and Buddies (each Buddy chat
/// from its last message on). There is no read across chats on the server
/// yet, so each chat is read on its own, with the limits the Product Manager
/// set (10-30): a chat is read again only when its [want] counter moved, so a
/// screen opened again costs nothing; never on a timer of its own; at most
/// [parallel] at a time; and only through the route that checks who may read
/// it. A chat the person may not read is skipped quietly, under nothing of
/// its own. In memory only, and what a reader read goes the moment its
/// access ends or it reads from nothing again ([SwarmReader.generation]).
///
/// Follow-ups if it is slow: a page-size option on the messages route (it
/// answers 100 rows), and a summary route for Activity and Buddies.
class SwarmChatPeeks extends ChangeNotifier {
  SwarmChatPeeks({this.parallel = 2, this.tries = 3});

  /// How many chats are read at once.
  final int parallel;

  /// How many times a read that failed is tried again for one counter.
  final int tries;

  final _entries = <(SwarmReader, String), _Entry>{};
  final _queue = Queue<(SwarmReader, String)>();
  int _running = 0;
  bool _disposed = false;

  /// [chatId] of [reader] could not be read at its last counter: not a
  /// refusal, which is no failure to report.
  bool failedAt(SwarmReader reader, String chatId) {
    final entry = _entries[(reader, chatId)];
    return entry != null && entry.failures > 0 && _current(reader, entry);
  }

  /// What was last read of [chatId] in [reader], while the reader still
  /// holds what it was read under; null before, or once it is not.
  SwarmPeek? of(SwarmReader reader, String chatId) {
    final entry = _entries[(reader, chatId)];
    return entry != null && _current(reader, entry) ? entry.peek : null;
  }

  /// Reads [chatId] of [reader] unless it was read at [counter] (compared by
  /// value) already, is
  /// being read, was refused, or failed [tries] times there. Its newest page,
  /// or with [after] the rows past that sequence.
  void want(
    SwarmReader reader,
    String chatId, {
    required Object counter,
    int? after,
  }) {
    if (_disposed || reader.accessRevoked) return;
    final key = (reader, chatId);
    final held = _entries[key];
    if (held != null &&
        _current(reader, held) &&
        held.counter == counter &&
        (held.busy ||
            held.refused ||
            held.peek != null && held.failures == 0 ||
            held.failures >= tries)) {
      return;
    }
    final current = held != null && _current(reader, held);
    // What was read at an earlier counter shows until the new read answers.
    final entry = current && held.counter == counter
        ? held
        : _Entry(counter, reader.generation, peek: current ? held.peek : null);
    entry
      ..after = after
      ..busy = true;
    _entries[key] = entry;
    _queue.add(key);
    _pump();
  }

  /// Drops everything read of [reader]: it left the list.
  void forget(SwarmReader reader) {
    _entries.removeWhere((key, _) => key.$1 == reader);
    _queue.removeWhere((key) => key.$1 == reader);
  }

  bool _current(SwarmReader reader, _Entry entry) =>
      !reader.accessRevoked && entry.generation == reader.generation;

  void _pump() {
    while (!_disposed && _running < parallel && _queue.isNotEmpty) {
      final key = _queue.removeFirst();
      final entry = _entries[key];
      if (entry == null) continue;
      _running++;
      unawaited(
        _read(key, entry).whenComplete(() {
          _running--;
          _pump();
        }),
      );
    }
  }

  Future<void> _read((SwarmReader, String) key, _Entry entry) async {
    final (reader, chatId) = key;
    bool live() =>
        !_disposed &&
        identical(_entries[key], entry) &&
        _current(reader, entry);
    final after = entry.after;
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
              '/conversations/${Uri.encodeComponent(chatId)}/messages'
              '${after == null ? '' : '?after=$after'}',
        ),
      );
      if (!live()) return;
      final messages = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ]..sort(superTabMessageOrder);
      if (messages.any((m) => m.conversationId != chatId)) {
        throw const FormatException('A different conversation was returned.');
      }
      final threads = [
        for (final row in answer['threads'] as List? ?? const [])
          SuperTabThread.fromJson(superTabMap(row)),
      ];
      entry
        ..peek = (
          messages: List.unmodifiable(messages),
          threads: Map.unmodifiable({for (final t in threads) t.id: t}),
        )
        ..failures = 0;
    } on SuperTabFailure catch (failure) {
      if (!live()) return;
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code) ||
          const {403, 404}.contains(failure.statusCode)) {
        entry
          ..refused = true
          ..peek = null;
      } else {
        entry.failures++;
      }
    } catch (_) {
      if (!live()) return;
      // An answer that is not a page of this chat shows nothing of it.
      entry
        ..failures += 1
        ..peek = null;
    } finally {
      entry.busy = false;
    }
    if (live()) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _entries.clear();
    _queue.clear();
    super.dispose();
  }
}

class _Entry {
  _Entry(this.counter, this.generation, {this.peek});
  final Object counter;
  final int generation;
  SwarmPeek? peek;
  int? after;
  int failures = 0;
  bool busy = false, refused = false;
}
