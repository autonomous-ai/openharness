/// The first egg's habits (`daemons/README.md`, First egg: habits) that a
/// phone can see for itself. Each is reported once with `zoo.habit`; the
/// server grants the egg.
///
/// | key         | on the phone                                                   |
/// |-------------|----------------------------------------------------------------|
/// | `turn`      | NOT REPORTED: the phone cannot tell a turn it started from one  |
/// |             | typed on the computer; the desktop and harnessd see those.     |
/// | `split`     | NOT REPORTED: a phone shows one harness at a time.             |
/// | `find`      | a harness opened from the phone's search                       |
/// | `elsewhere` | NOT REPORTED: nothing the phone receives says which device     |
/// |             | started a harness (an agent carries no origin, and a question  |
/// |             | the daemon shapes never reaches a phone on the relay), so      |
/// |             | "answered from another device" has no signal here. harnessd or |
/// |             | the backend has to report it.                                  |
/// | `machine`   | two of the account's computers seen online                     |
/// | `store`     | NOT REPORTED: the phone sees no turn end in a Store harness it |
/// |             | could tell apart from any other.                               |
/// | `resume`    | a paused harness resumed from the phone                        |
/// | `days`      | the app in front on three different local days                 |
library;

import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';
import 'zoo_client.dart';

class PhoneHabits {
  PhoneHabits(this.zoo, {this.storage, DateTime Function()? now})
    : _now = now ?? DateTime.now {
    zoo.addListener(_report);
  }

  final ZooClient zoo;

  /// Where the days the app was used are kept; null in tests.
  final LocalKeyValueStore? storage;
  final DateTime Function() _now;

  static const daysKey = 'daemons.days.v1';
  static const daysNeeded = 3;

  /// Habits seen, reported once the zoo has loaded (a resume before the first
  /// read is not lost).
  final _seen = <String>{};
  final _online = <String>{};
  Set<String>? _days;
  Future<void>? _loadingDays;
  bool _disposed = false;

  void _see(String key) {
    if (_disposed || !_seen.add(key)) return;
    _report();
  }

  void _report() {
    if (_disposed || !zoo.loaded) return;
    for (final key in _seen) {
      zoo.habit(key);
    }
  }

  /// A harness was opened from the phone's search.
  void found() => _see('find');

  /// A paused harness came back from the phone.
  void resumed() => _see('resume');

  /// The account's computers the phone can see as online right now. Two
  /// different ones, ever, is a second computer connected to the account.
  void observeOnline(Iterable<String> machineIds) {
    _online.addAll(machineIds);
    if (_online.length >= 2) _see('machine');
  }

  /// The app is in front today.
  Future<void> noteDay() async {
    if (_disposed) return;
    await (_loadingDays ??= _loadDays());
    final days = _days!;
    final now = _now();
    final today =
        '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
    if (days.add(today)) {
      final sorted = days.toList()..sort();
      while (sorted.length > 7) {
        days.remove(sorted.removeAt(0));
      }
      try {
        await storage?.write(daysKey, jsonEncode(sorted));
      } catch (_) {
        // A day not written is a day counted again tomorrow; nothing more.
      }
    }
    if (days.length >= daysNeeded) _see('days');
  }

  Future<void> _loadDays() async {
    final days = <String>{};
    try {
      final raw = await storage?.read(daysKey);
      final decoded = raw == null ? null : jsonDecode(raw);
      if (decoded is List) {
        for (final day in decoded) {
          if (day is String) days.add(day);
        }
      }
    } catch (_) {
      // A missing or corrupt record starts the count again.
    }
    _days = days;
  }

  void dispose() {
    _disposed = true;
    zoo.removeListener(_report);
  }
}
