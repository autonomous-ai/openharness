import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';

/// What a closed chat held: its messages, oldest first, and where the
/// earlier ones start.
typedef SwarmChatKept = ({
  List<SuperTabMessage> messages,
  SuperTabPage? before,
});

/// The chats last read on this phone, so one opened again shows at once what
/// was read and reads only what is newer ([SwarmConversation]). In memory
/// only: nothing of a chat is written to the device.
///
/// A chat is kept for the reader that read it, and only while that reader's
/// Swarm read still has it. A read that leaves it out (the person taken out
/// of it), a read again from nothing, or the reader's access ending forgets
/// it — the person leaving the Swarm, signing out or turning Swarm off each
/// takes the reader's access away before it goes ([SwarmReader.revoke]).
abstract final class SwarmChatCache {
  /// How many chats are kept: the one closed longest ago goes first.
  static const size = 10;

  /// How many of a chat's messages are kept: the newest, a page of them as
  /// the backend reads it. Those before are read again as earlier messages.
  static const page = 100;

  /// Oldest first.
  static final _kept = <(SwarmReader, String), _Kept>{};

  /// The readers with a chat kept, each told to [_check] at its reads.
  static final _watched = <SwarmReader, VoidCallback>{};

  /// What [reader] last kept of chat [id], while it may still show it.
  static SwarmChatKept? take(SwarmReader reader, String id) {
    final kept = _kept[(reader, id)];
    if (kept == null || !_holds(reader, id, kept.generation)) return null;
    return (messages: kept.messages, before: kept.before);
  }

  /// Keeps chat [id] as [reader] read it — its newest [page] of [messages],
  /// oldest first, and where the earlier ones start — as the newest kept;
  /// unless its Swarm's read no longer has it, or nothing of it was read.
  static void keep(
    SwarmReader reader,
    String id, {
    required List<SuperTabMessage> messages,
    required SuperTabPage? before,
  }) {
    _kept.remove((reader, id));
    if (messages.length > page) {
      messages = List.unmodifiable(messages.sublist(messages.length - page));
      before = SuperTabPage.of(messages.first);
    }
    if (messages.isNotEmpty && _holds(reader, id, reader.generation)) {
      _kept[(reader, id)] = _Kept(messages, before, reader.generation);
      while (_kept.length > size) {
        _kept.remove(_kept.keys.first);
      }
    }
    _settle();
  }

  /// Forgets chat [id] of [reader]: the person can no longer read it.
  static void drop(SwarmReader reader, String id) {
    if (_kept.remove((reader, id)) != null) _settle();
  }

  @visibleForTesting
  static int get length => _kept.length;

  @visibleForTesting
  static void clear() {
    _kept.clear();
    _settle();
  }

  /// [reader] may still show chat [id] as read under [generation].
  static bool _holds(SwarmReader reader, String id, int generation) =>
      !reader.accessRevoked &&
      reader.generation == generation &&
      reader.snapshot?.conversation(id) != null;

  /// [reader] read its Swarm, or lost it: what it can no longer show goes.
  static void _check(SwarmReader reader) {
    _kept.removeWhere(
      (key, kept) =>
          key.$1 == reader && !_holds(reader, key.$2, kept.generation),
    );
    _settle();
  }

  /// Each reader with a chat kept is watched, and no other.
  static void _settle() {
    final holding = {for (final (reader, _) in _kept.keys) reader};
    for (final reader in _watched.keys.toList()) {
      if (!holding.contains(reader)) {
        reader.removeListener(_watched.remove(reader)!);
      }
    }
    for (final reader in holding) {
      if (_watched.containsKey(reader)) continue;
      final check = _watched[reader] = () => _check(reader);
      reader.addListener(check);
    }
  }
}

class _Kept {
  _Kept(this.messages, this.before, this.generation);
  final List<SuperTabMessage> messages;
  final SuperTabPage? before;

  /// The reader's [SwarmReader.generation] it was read under.
  final int generation;
}
