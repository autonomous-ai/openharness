import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import 'controller.dart';
import 'model.dart';

/// One of the reader's reminders that is due (backend reminders.ts): a message
/// they asked to come back to.
class SuperTabReminder {
  SuperTabReminder.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      messageId = row['messageId'] as String,
      messageSequence = (row['messageSequence'] as num?)?.toInt(),
      threadId = row['threadId'] as String?,
      authorName = superTabMap(row['author'] ?? const {})['name'] as String?,
      text = row['text'] as String? ?? '',
      dueAt = DateTime.parse(row['dueAt'] as String);
  final String id, conversationId, conversationTitle, messageId, text;
  final int? messageSequence;

  /// The thread's root when the message is a reply only in its thread.
  final String? threadId;
  final String? authorName;
  final DateTime dueAt;

  /// This reminder at this time: set again on its message, it is another.
  String get key => '$id@${dueAt.toUtc().toIso8601String()}';
}

/// When Remind me brings a message back, from now in the reader's own time.
enum SuperTabRemindIn {
  twentyMinutes('In 20 minutes'),
  oneHour('In 1 hour'),
  tomorrowMorning('Tomorrow at 09:00');

  const SuperTabRemindIn(this.label);
  final String label;

  DateTime from(DateTime now) => switch (this) {
    twentyMinutes => now.add(const Duration(minutes: 20)),
    oneHour => now.add(const Duration(hours: 1)),
    tomorrowMorning => DateTime(now.year, now.month, now.day + 1, 9),
  };
}

/// The reader's due reminders in one Swarm, for Activity's Reminders. Read when
/// the Swarm's digest of them moves (one set, replaced or cleared on any
/// device), and again when the next one is due: a timer set for that time,
/// never a poll. One per controller.
class SuperTabReminders extends ChangeNotifier {
  SuperTabReminders._(this.controller) {
    controller.addListener(_changed);
    controller.onDispose(dispose);
    _changed();
  }

  static final _all = Expando<SuperTabReminders>();
  static SuperTabReminders of(SuperTabController controller) =>
      _all[controller] ??= SuperTabReminders._(controller);

  final SuperTabController controller;

  /// A reminder that came due while the app was open: its one notice.
  void Function(SuperTabReminder reminder)? onArrived;

  List<SuperTabReminder> due = const [];
  String? error;
  String? _digest;
  int? _epoch;
  Timer? _wake;
  DateTime? _next;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _fails = 0;

  /// The reminders already told of, by id and due time: one set again on the
  /// same message is news again. One due before this started is not news.
  final _told = <String>{};
  final DateTime _since = clock.now();

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  void _changed() {
    final snapshot = controller.snapshot;
    if (_disposed || snapshot == null || controller.accessRevoked) return;
    final epoch = controller.visibilityEpoch;
    final digest = snapshot.remindersDigest;
    // A backend before reminders sends none: there is nothing to read.
    if (digest == null) return;
    // A timer may not run while the computer sleeps: a Swarm read after the
    // due time reads the list too.
    final overdue = _next != null && !clock.now().isBefore(_next!);
    if (digest == _digest && epoch == _epoch && !overdue) return;
    _digest = digest;
    _epoch = epoch;
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty && !_disposed);
    }().whenComplete(() => _loading = null);
  }

  Future<void> _read() async {
    final Map<String, dynamic> answer;
    // A failed read is not tried again on each Swarm read: its own timer
    // tries, more slowly each time ([_retryAfter]). Retry or a new digest may
    // read it sooner.
    _next = null;
    try {
      answer = await controller.request('GET', '$_path/reminders');
    } on SuperTabFailure catch (failure) {
      if (_disposed) return;
      if (failure.statusCode == 404) return;
      _readFailed();
      return;
    } catch (_) {
      if (_disposed) return;
      _readFailed();
      return;
    }
    if (_disposed) return;
    _fails = 0;
    final fresh = [
      for (final row in answer['due'] as List? ?? const [])
        SuperTabReminder.fromJson(superTabMap(row)),
    ];
    error = null;
    due = List.unmodifiable(fresh);
    for (final reminder in fresh.reversed) {
      if (_told.add(reminder.key) && !reminder.dueAt.isBefore(_since)) {
        onArrived?.call(reminder);
      }
    }
    _schedule(DateTime.tryParse(answer['next'] as String? ?? ''));
    notifyListeners();
  }

  /// How long after each failed read in a row the next one runs.
  static const _retryAfter = [
    Duration(seconds: 5),
    Duration(seconds: 15),
    Duration(seconds: 30),
    Duration(seconds: 60),
  ];

  /// Reads again by itself: one slow answer must not leave an error up until
  /// someone presses Retry. One miss is ordinary on a slow connection, so the
  /// list says it could not load from the second.
  void _readFailed() {
    final wait = _retryAfter[_fails.clamp(0, _retryAfter.length - 1)];
    _fails++;
    _wake?.cancel();
    _wake = Timer(wait, () {
      if (!_disposed && !controller.accessRevoked) unawaited(load());
    });
    if (_fails < 2) return;
    error = 'Could not load reminders. Try again.';
    notifyListeners();
  }

  /// Reads the list again when the next reminder is due.
  void _schedule(DateTime? next) {
    _wake?.cancel();
    _wake = null;
    _next = next;
    if (next == null) return;
    final wait = next.difference(clock.now());
    _wake = Timer(
      wait.isNegative ? Duration.zero : wait + const Duration(seconds: 1),
      () => unawaited(load()),
    );
  }

  /// Reminds the reader of [message] at [at]. False when the server did not
  /// keep it.
  Future<bool> set(SuperTabMessage message, DateTime at) async {
    try {
      await controller.request(
        'POST',
        '$_path/conversations/${Uri.encodeComponent(message.conversationId)}'
            '/messages/${Uri.encodeComponent(message.id)}/reminder',
        body: {'at': at.toUtc().toIso8601String()},
      );
    } catch (_) {
      return false;
    }
    // The digest moves with it; this device need not wait for a read.
    unawaited(load());
    return true;
  }

  /// [reminder] was opened: it is done, on every device.
  Future<void> open(SuperTabReminder reminder) async {
    due = List.unmodifiable(due.where((r) => r.id != reminder.id));
    notifyListeners();
    try {
      // A time of none clears it: the daemon and the web send only GET and POST.
      await controller.request(
        'POST',
        '$_path/conversations/${Uri.encodeComponent(reminder.conversationId)}'
            '/messages/${Uri.encodeComponent(reminder.messageId)}/reminder',
        body: {'at': null},
      );
    } catch (_) {
      if (_disposed) return;
      error = 'Could not clear the reminder. Try again.';
      unawaited(load());
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _wake?.cancel();
    controller.removeListener(_changed);
    super.dispose();
  }
}
