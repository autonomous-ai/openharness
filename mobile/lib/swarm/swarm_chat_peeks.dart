import 'dart:async';

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
/// screen opened again costs nothing; never on a timer of its own; only for
/// a list on screen, which takes back what still waits once it leaves
/// ([withdraw]); at most [parallel] at a time, and one read of a chat at a
/// time; and only through the route that checks who may read it. A chat the
/// person may not read is skipped quietly, under nothing of its own. In
/// memory only, and what a reader read goes the moment its access ends or it
/// reads from nothing again ([SwarmReader.generation]).
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

  /// The chats waiting their turn, oldest first, each once, for its latest
  /// counter.
  final _waiting = <(SwarmReader, String)>{};

  /// The chats being read, each with the entry it is read for.
  final _reading = <(SwarmReader, String), _Entry>{};
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

  /// [owner] wants [chatId] of [reader] read at [counter] (compared by
  /// value): its newest page, or with [after] the rows past that sequence.
  /// Nothing is asked if it was read or refused at that counter, is being
  /// read there, or failed [tries] times there. A chat waits its turn once,
  /// for its latest counter; one whose counter moves while it is read waits
  /// for that read to end.
  void want(
    SwarmReader reader,
    String chatId, {
    required Object counter,
    required Object owner,
    int? after,
  }) {
    if (_disposed || reader.accessRevoked) return;
    final key = (reader, chatId);
    var entry = _entries[key];
    if (entry == null || !_current(reader, entry)) {
      entry = _entries[key] = _Entry(counter, reader.generation);
    } else if (entry.counter != counter) {
      // What was read at an earlier counter shows until the new read answers.
      entry
        ..counter = counter
        ..failures = 0;
    }
    if (entry.readAt == counter ||
        entry.failures >= tries ||
        identical(_reading[key], entry) && entry.readingAt == counter) {
      return;
    }
    entry
      ..after = after
      ..owners.add(owner);
    _waiting.add(key);
    _pump();
  }

  /// [chatId] of [reader] is being read, or waits its turn.
  bool busyAt(SwarmReader reader, String chatId) {
    final key = (reader, chatId);
    final entry = _entries[key];
    return entry != null &&
        _current(reader, entry) &&
        (_waiting.contains(key) || identical(_reading[key], entry));
  }

  /// The person's Try again, for [owner]: [chatId] of [reader] is read once
  /// more if its last read failed, however many times it was tried.
  void retry(SwarmReader reader, String chatId, {required Object owner}) {
    final entry = _entries[(reader, chatId)];
    if (_disposed ||
        entry == null ||
        entry.failures == 0 ||
        !_current(reader, entry) ||
        busyAt(reader, chatId)) {
      return;
    }
    entry
      ..failures = 0
      ..owners.add(owner);
    _waiting.add((reader, chatId));
    _pump();
  }

  /// [owner] left the screen: what waits only for it is not read, and is
  /// asked again by its next [want]. What is being read finishes, and what
  /// another list waits for keeps its turn.
  void withdraw(Object owner) {
    _waiting.removeWhere((key) {
      final owners = _entries[key]?.owners;
      return owners == null || (owners..remove(owner)).isEmpty;
    });
  }

  /// Keeps what [readers] hold now and drops the rest: what was read of a
  /// Swarm off the list, of one whose access ended, or of one that reads
  /// from nothing again ([SwarmReader.generation]) leaves memory, and an
  /// answer still on its way for it is dropped.
  void keepOnly(Iterable<SwarmReader> readers) {
    final listed = readers.toSet();
    bool gone((SwarmReader, String) key, _Entry entry) =>
        !listed.contains(key.$1) || !_current(key.$1, entry);
    _entries.removeWhere(gone);
    _waiting.removeWhere((key) => !_entries.containsKey(key));
  }

  /// How many chats are held, read or being read.
  @visibleForTesting
  int get held => _entries.length;

  bool _current(SwarmReader reader, _Entry entry) =>
      !reader.accessRevoked && entry.generation == reader.generation;

  /// Starts the oldest waiting chats that are not being read already, up to
  /// [parallel] reads in all.
  void _pump() {
    while (!_disposed && _reading.length < parallel) {
      final key = _waiting
          .where((key) => !_reading.containsKey(key))
          .firstOrNull;
      if (key == null) return;
      _waiting.remove(key);
      final entry = _entries[key]?..owners.clear();
      if (entry == null ||
          !_current(key.$1, entry) ||
          entry.readAt == entry.counter ||
          entry.failures >= tries) {
        continue;
      }
      entry.readingAt = entry.counter;
      _reading[key] = entry;
      unawaited(
        _read(key, entry).whenComplete(() {
          if (identical(_reading[key], entry)) _reading.remove(key);
          _pump();
        }),
      );
    }
  }

  Future<void> _read((SwarmReader, String) key, _Entry entry) async {
    final (reader, chatId) = key;
    final counter = entry.counter, after = entry.after;
    bool live() =>
        !_disposed &&
        identical(_entries[key], entry) &&
        _current(reader, entry);
    // A failure counts against the counter it was read at, if still the
    // latest: one that moved meanwhile starts its own tries.
    void failed() {
      if (entry.counter == counter) entry.failures++;
    }

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
        ..readAt = counter;
      if (entry.counter == counter) entry.failures = 0;
    } on SuperTabFailure catch (failure) {
      if (!live()) return;
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code) ||
          const {403, 404}.contains(failure.statusCode)) {
        entry
          ..readAt = counter
          ..peek = null;
      } else {
        failed();
      }
    } catch (_) {
      if (!live()) return;
      // An answer that is not a page of this chat shows nothing of it.
      entry.peek = null;
      failed();
    } finally {
      entry.readingAt = null;
    }
    if (live()) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _entries.clear();
    _waiting.clear();
    _reading.clear();
    super.dispose();
  }
}

class _Entry {
  _Entry(this.counter, this.generation);
  final int generation;

  /// The counter last wanted; [readAt] the one it was last read (or
  /// refused) at, and [readingAt] the one it is being read at.
  Object counter;
  Object? readAt, readingAt;
  int? after;
  SwarmPeek? peek;

  /// Failed reads at [counter].
  int failures = 0;

  /// The lists that want it read, while it waits its turn.
  final owners = <Object>{};
}
