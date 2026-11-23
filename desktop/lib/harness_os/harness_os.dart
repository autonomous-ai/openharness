import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

/// One `os_device` request to a computer (CLI services/osDevice.ts), as [AppNotifier.osDevice]
/// sends it: `{error: 'UNAVAILABLE'}` while it cannot be reached, its own code otherwise.
typedef OsDeviceRequest = Future<Map<String, dynamic>> Function(
  String machineId,
  Map<String, dynamic> payload, {
  Duration timeout,
});

/// What this window knows of the account's Intern 3 computers (Harness OS): each one's last
/// `status`, and the hotspot and disk of every one seen, kept between launches so a computer
/// switched off and on again — offline, waiting at its disk's password — still offers Unlock.
///
/// The same reading as the phone's (mobile `AppNotifier.osStatus` and `harnessOsComputers`).
class HarnessOs extends ChangeNotifier {
  HarnessOs({required this.request, this.storage});

  final OsDeviceRequest request;
  final LocalKeyValueStore? storage;

  static const storageKey = 'harness_os_computers';

  /// How long a status answer is used before [refresh] asks again.
  static const fresh = Duration(minutes: 5);

  final Map<String, Map<String, dynamic>> status = {};
  final Map<String, DateTime> _asked = {};
  final Map<String, ({String hotspot, bool encrypted})> computers = {};
  bool _loaded = false, _disposed = false;

  bool runsHarnessOs(String machineId) =>
      status[machineId]?['harnessOs'] == true;

  /// What its daemon does beyond its update and Wi-Fi, as its status says (CLI osDevice.ts
  /// `features`): `sign_out`, `password`, `ssh`, `github`, `check_update`, `computer_use`.
  bool feature(String machineId, String name) {
    final features = status[machineId]?['features'];
    return features is List && features.contains(name);
  }

  String? wifi(String machineId) {
    final wifi = status[machineId]?['wifi'];
    final ssid = wifi is Map ? wifi['ssid'] : null;
    return ssid is String && ssid.isNotEmpty ? ssid : null;
  }

  Map<String, dynamic> update(String machineId) {
    final update = status[machineId]?['update'];
    return update is Map ? Map<String, dynamic>.from(update) : const {};
  }

  bool updateAvailable(String machineId) {
    if (update(machineId)['available'] != true) return false;
    final parts = this.parts(machineId);
    // Named part by part: only what changes. A computer that does not name its parts says it whole.
    if (parts.isEmpty) return true;
    return newRelease(machineId) ||
        parts['hn']?['available'] == true ||
        parts['cli']?['available'] == true;
  }

  /// A Harness OS release newer than the one running — 0.1.9 after 0.1.8, not a later build of
  /// 0.1.8, which a computer on 0.1.8 still offers (os/release_update.py compares whole packages).
  bool newRelease(String machineId) {
    final os = parts(machineId)['os'];
    if (os?['available'] != true) return false;
    final next = os?['next'] as String?, running = os?['running'] as String?;
    return next == null ||
        running == null ||
        releaseOf(next) != releaseOf(running);
  }

  /// A package version as its release: `0.1.8.r1792577066.g8df82cc2bc-1` is `0.1.8`.
  static String releaseOf(String version) =>
      RegExp(r'^\d+\.\d+\.\d+').firstMatch(version)?.group(0) ?? version;

  /// Each part, as the last status said (CLI osDevice.ts `update.parts`): `os`, `hn`, `cli`, each
  /// `{running, available, next}`. Empty from a computer that does not say.
  Map<String, Map<String, dynamic>> parts(String machineId) {
    final parts = update(machineId)['parts'];
    if (parts is! Map) return const {};
    return {
      for (final entry in parts.entries)
        if (entry.key is String && entry.value is Map)
          entry.key as String: Map<String, dynamic>.from(entry.value as Map),
    };
  }

  /// The update waiting needs the computer restarted: a new OS package, or one applied already
  /// that waits for its restart. hn and the CLI alone do not.
  bool updateRestarts(String machineId) {
    if (update(machineId)['restartRequired'] == true) return true;
    return newRelease(machineId);
  }

  /// An offline computer that waits at its disk's password after a restart: Unlock, over its
  /// hotspot, is how it starts.
  bool encrypted(String machineId) => computers[machineId]?.encrypted == true;

  String? hotspot(String machineId) => computers[machineId]?.hotspot;

  /// Asks [machineId] what it is and whether it has an update, unless asked lately ([force] asks
  /// now).
  Future<void> refresh(String machineId, {bool force = false}) async {
    final asked = _asked[machineId];
    if (!force && asked != null && DateTime.now().difference(asked) < fresh) {
      return;
    }
    _asked[machineId] = DateTime.now();
    final reply = await request(machineId, {'action': 'status'});
    if (_disposed) return;
    // An older CLI answers UNSUPPORTED/UNSUPPORTED_OS: not Harness OS as far as this window knows.
    if (reply['error'] == 'UNAVAILABLE') {
      _asked.remove(machineId);
      return;
    }
    status[machineId] = reply;
    _remember(machineId, reply);
    notifyListeners();
  }

  /// Reads the computers seen before, once.
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final stored = await storage?.read(storageKey);
      if (stored == null || _disposed) return;
      final decoded = jsonDecode(stored);
      if (decoded is! Map) return;
      for (final entry in decoded.entries) {
        final value = entry.value;
        if (entry.key is! String ||
            value is! Map ||
            value['hotspot'] is! String) {
          continue;
        }
        computers.putIfAbsent(
          entry.key as String,
          () => (
            hotspot: value['hotspot'] as String,
            encrypted: value['encrypted'] == true,
          ),
        );
      }
      notifyListeners();
    } catch (_) {
      // Unreadable: learned again from each computer's next status.
    }
  }

  void _remember(String machineId, Map<String, dynamic> reply) {
    final hotspot = reply['hotspot'];
    if (reply['harnessOs'] != true || hotspot is! String || hotspot.isEmpty) {
      return;
    }
    final next = (hotspot: hotspot, encrypted: reply['encrypted'] == true);
    if (computers[machineId] == next) return;
    computers[machineId] = next;
    _save();
  }

  /// Signed out from here: no Unlock for it any more. Its unlock would open the disk of a computer
  /// that is set up again — Set up Intern 3, with a sign-in — before it is online anywhere.
  void forget(String machineId) {
    status.remove(machineId);
    _asked.remove(machineId);
    if (computers.remove(machineId) != null) _save();
    notifyListeners();
  }

  /// A sign-out or another sign-in: every status is asked again. The computers seen are kept, by
  /// machine id, which no other account's computer has.
  void resetStatus() {
    status.clear();
    _asked.clear();
  }

  void _save() {
    final json = jsonEncode({
      for (final entry in computers.entries)
        entry.key: {
          'hotspot': entry.value.hotspot,
          'encrypted': entry.value.encrypted,
        },
    });
    unawaited(storage?.write(storageKey, json).catchError((_) {}));
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
