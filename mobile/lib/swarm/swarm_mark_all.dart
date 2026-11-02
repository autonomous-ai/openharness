import 'dart:async';

import 'model.dart';
import 'swarm_chat_notify.dart';
import 'swarm_reader.dart';
import 'swarm_read_marks.dart';

/// How long Mark all read waits before its marks go to the server, as the
/// desktop's `SuperTabController.markAllHold`: read marks never move back
/// there, so Undo works by not sending them yet.
const swarmMarkAllHold = Duration(seconds: 6);

/// One Mark all read waiting for its Undo, over the Swarms Home shows (the
/// desktop's `SuperTabMarkAll`): every chat it marked reads as read on this
/// phone at once ([SwarmReadMarks.holdAllRead]); the marks go to the server
/// once [hold] passes, or at once when the app leaves the screen or closes
/// ([commit]); [undo] within it puts every chat back and sends nothing. A
/// Swarm whose access is lost meanwhile sends nothing ([SwarmReadMarks]
/// drops what it holds).
class SwarmMarkAll {
  SwarmMarkAll._(this._parts, Duration hold, this._onDone)
    : count = _parts.fold(0, (n, part) => n + part.$2.length) {
    _timer = Timer(hold, commit);
  }

  /// Marks every chat shown unread in [marks] read, held for [hold]; null
  /// when nothing is unread. [onDone] runs once it is sent, undone or
  /// dropped.
  static SwarmMarkAll? start(
    Iterable<SwarmReadMarks> marks, {
    Duration hold = swarmMarkAllHold,
    void Function()? onDone,
  }) {
    final parts = [
      for (final m in marks)
        if (m.holdAllRead() case final through when through.isNotEmpty)
          (m, through),
    ];
    if (parts.isEmpty) return null;
    return SwarmMarkAll._(parts, hold, onDone);
  }

  /// How many chats it marked read.
  final int count;
  final List<(SwarmReadMarks, Map<String, int>)> _parts;
  final void Function()? _onDone;
  late final Timer _timer;
  bool _done = false;

  /// Whether its marks were sent, or it was undone.
  bool get done => _done;

  /// Completes once it is sent (true) or undone (false), in the same step:
  /// whatever waits on it — its toast closing — happens before anything
  /// that follows, such as a second Mark all read's toast.
  Future<bool> get settled => _settled.future;
  final _settled = Completer<bool>.sync();

  /// Puts every chat it marked back as it was, if the marks are not sent.
  void undo() {
    if (!_finish(sent: false)) return;
    for (final (marks, through) in _parts) {
      marks.dropHeld(through);
    }
  }

  /// Sends the marks now: the Undo window is over, or the app leaves.
  void commit() {
    if (!_finish(sent: true)) return;
    for (final (marks, through) in _parts) {
      marks.sendHeld(through);
    }
  }

  bool _finish({required bool sent}) {
    if (_done) return false;
    _done = true;
    _timer.cancel();
    _settled.complete(sent);
    _onDone?.call();
    return true;
  }
}

/// Whether Mark all read has anything to mark in [readers]: a chat shown
/// unread that is not dormant or muted ([SwarmReadMarks.holdAllRead]).
bool swarmAnyUnread(Iterable<SwarmReader> readers) {
  for (final reader in readers) {
    final snapshot = reader.snapshot;
    final marks = reader.readMarks;
    if (reader.accessRevoked || snapshot == null || marks == null) continue;
    for (final SuperTabConversation group in snapshot.conversations) {
      if (!group.dormant && !swarmMuted(reader, group) && marks.unread(group)) {
        return true;
      }
    }
  }
  return false;
}
