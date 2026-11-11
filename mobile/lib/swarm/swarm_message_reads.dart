import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import 'package:harness_mobile/logging/app_log.dart';

import 'model.dart';
import 'swarm_message_link.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// Where a read of one message by itself stands ([SwarmMessageReads]).
enum SwarmReadState {
  /// Asked for, not answered yet.
  loading,

  /// Read: [SwarmMessageRead.message] holds it.
  found,

  /// Gone, or not the reader's to read: the backend tells the two apart for
  /// no one, so neither does this.
  gone,

  /// Not answered: offline, a server error, or a server too old to read one
  /// message.
  failed,
}

/// What a read of one message by itself answered.
@immutable
class SwarmMessageRead {
  const SwarmMessageRead._(this.state) : message = null;
  const SwarmMessageRead.found(SuperTabMessage this.message)
    : state = SwarmReadState.found;

  static const loading = SwarmMessageRead._(SwarmReadState.loading);
  static const gone = SwarmMessageRead._(SwarmReadState.gone);
  static const failed = SwarmMessageRead._(SwarmReadState.failed);

  final SwarmReadState state;

  /// The message, once [SwarmReadState.found]; null otherwise.
  final SuperTabMessage? message;
}

/// Whether a message read by itself is one to show: a waiting notice is
/// never announced, and an update request is no chat row (the desktop's
/// `AppLinkSwarms.read`).
bool swarmShowsRead(SuperTabMessage message) =>
    !const {'delivery-hold', 'update-request'}.contains(message.source['kind']);

/// Messages read one at a time, outside the pages a chat holds: the original
/// of a quote whose page is not read, and what a message link points at (the
/// desktop's `quoted` and `AppLinkSwarms.read`), each read with the Swarm's
/// own request so the backend decides what the reader may see.
///
/// In memory only, for the account's session ([SwarmSession]), and at most
/// [kept]: the one drawn longest ago goes first. Any answer is asked for again
/// only when it is drawn again [retryAfter] later, so nothing reads in a loop;
/// a message found shows meanwhile, as the reader may since have lost its chat,
/// and stays when the later read is not answered.
class SwarmMessageReads extends ChangeNotifier {
  SwarmMessageReads({
    this.retryAfter = const Duration(minutes: 1),
    this.kept = 100,
  });

  final Duration retryAfter;
  final int kept;

  /// By link, the one asked for longest ago first.
  final _reads = <String, _Read>{};
  bool _disposed = false;

  /// What [link] points at, as [reader] (its Swarm's) may read it: asked for
  /// the first time it is wanted, [SwarmMessageRead.loading] until then.
  /// Asked again while an earlier answer shows, never twice at once.
  SwarmMessageRead read(SwarmReader reader, SwarmMessageLink link) {
    if (_disposed || reader.tabId != link.tabId) return SwarmMessageRead.gone;
    if (reader.accessRevoked) {
      // What it read goes with it.
      _reads.removeWhere((_, read) => identical(read.reader, reader));
      return SwarmMessageRead.gone;
    }
    final url = link.url;
    final known = _reads.remove(url);
    // A read for another reader, or before access was read again from
    // nothing, may show what the reader can no longer see.
    final current =
        known != null &&
        identical(known.reader, reader) &&
        known.generation == reader.generation;
    if (current &&
        (known.reading || clock.now().difference(known.at) < retryAfter)) {
      _reads[url] = known;
      return known.value;
    }
    final read = _Read(reader, reader.generation)
      ..value = current ? known.value : SwarmMessageRead.loading;
    _reads[url] = read;
    while (_reads.length > kept) {
      _reads.remove(_reads.keys.first);
    }
    // Asked for while a screen is drawn: answered after it.
    scheduleMicrotask(() => _read(link, read));
    return read.value;
  }

  Future<void> _read(SwarmMessageLink link, _Read read) async {
    bool stale() =>
        _disposed ||
        !identical(_reads[link.url], read) ||
        read.generation != read.reader.generation;
    if (stale()) return;
    var value = SwarmMessageRead.failed;
    try {
      final answer = superTabMap(
        await read.reader.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(link.tabId)}'
              '/conversations/${Uri.encodeComponent(link.conversationId)}'
              '/messages?messageId=${Uri.encodeQueryComponent(link.messageId)}',
        ),
      );
      final rows = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ];
      if (rows.isEmpty) {
        value = SwarmMessageRead.gone;
      } else if (rows.length == 1 &&
          rows.single.id == link.messageId &&
          rows.single.conversationId == link.conversationId) {
        value = swarmShowsRead(rows.single)
            ? SwarmMessageRead.found(rows.single)
            : SwarmMessageRead.gone;
      } else {
        appLog.warn('swarm', 'One message read: not the message asked for');
      }
    } on SuperTabFailure catch (failure) {
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        value = SwarmMessageRead.gone;
      } else {
        appLog.warn('swarm', 'One message not read: ${failure.code}');
      }
    } catch (failure) {
      appLog.warn('swarm', 'One message not read: ${failure.runtimeType}');
    }
    if (stale()) return;
    final kept =
        value.state == SwarmReadState.failed && read.value.message != null;
    read
      ..reading = false
      ..at = clock.now()
      ..value = kept ? read.value : value;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _reads.clear();
    super.dispose();
  }
}

class _Read {
  _Read(this.reader, this.generation);
  final SwarmReader reader;
  final int generation;
  bool reading = true;
  DateTime at = DateTime.fromMillisecondsSinceEpoch(0);
  SwarmMessageRead value = SwarmMessageRead.loading;
}
