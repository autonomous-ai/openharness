import 'dart:io';

import '../core/snapshot_store.dart';
import '../terminal/screen_snapshot.dart';

/// The last screens of the agents opened most recently in this run, so going back to one shows it at
/// once instead of a skeleton while its stream attaches.
///
/// Beside the few exact terminals `AppNotifier` keeps (`_keptScreens`), each a whole emulator,
/// scrollback and all: this keeps the visible screen alone ([ScreenSnapshot]), a few kilobytes, so it
/// can hold [capacity] of them — the agents Find, or a return to an earlier harness, opens next.
///
/// ⚠️ **In memory, never on the phone's disk (owner, 2026-10-01).** These screens used to be written
/// to disk so a launch could draw the agent it reopens before its machine answered. That screen
/// looked live for the two or three seconds it was not — a prompt that took no key, output hours
/// old — and a launch shows the skeleton instead now (`_Attaching` in `terminal_page.dart`). With
/// nothing left to read them in the next run, nothing is written: no terminal's contents on the
/// phone, and no write each time the app leaves the screen. What an earlier build wrote is deleted
/// at launch ([deleteLegacyFile]).
class KeptScreenStore {
  /// How many agents' screens are kept. The least recently kept goes first once there are more
  /// (owner, 2026-10-01: fifty — an account of seven or eight machines at ten to twenty sessions each
  /// opens well past the first two dozen). At a few kilobytes a screen, well under a megabyte in all.
  static const capacity = 50;

  /// By key (`machineId/agentId`), least recently kept first — see [put].
  final _screens = <String, ScreenSnapshot>{};

  /// The screen kept for [key], or null.
  ScreenSnapshot? read(String key) => _screens[key];

  /// Keep [snapshot] as [key]'s screen, as the most recent.
  void put(String key, ScreenSnapshot snapshot) {
    _screens.remove(key);
    _screens[key] = snapshot;
    while (_screens.length > capacity) {
      _screens.remove(_screens.keys.first);
    }
  }

  /// Forget [key]'s screen — its agent was deleted, or is gone from its machine's list.
  void remove(String key) => _screens.remove(key);

  /// Forget every kept screen — signing out: they are that account's terminals.
  void clear() => _screens.clear();

  /// Delete the file an earlier build kept these screens in, if it is still there: a terminal's
  /// contents left on the phone with nothing to read them. Never throws — a file that will not go is
  /// in the app's CACHE directory, which the OS empties when space runs low.
  ///
  /// Can go once no install still has the file; until then it costs one look at the disk a launch.
  static Future<void> deleteLegacyFile() async {
    try {
      // Where that build put it, resolved the way it was — without a plugin, as `containerHome` is
      // (`core/host_platform.dart`): iOS names `<container>/tmp`, whose sibling `Library/Caches` is
      // the cache; Android's temporary directory IS its cache directory.
      final temporary = Directory.systemTemp;
      final directory = Platform.isIOS
          ? '${temporary.parent.path}/Library/Caches/harness'
          : '${temporary.path}/harness';
      final store = FileSnapshotStore(
        'kept-screens',
        directory: Directory(directory),
      );
      await store.clear();
      // And a write the app was closed in the middle of ([FileSnapshotStore.write]).
      final partial = File('${store.file.path}.tmp');
      if (await partial.exists()) await partial.delete();
    } on Object {
      // Left for the OS to clear with the rest of the cache.
    }
  }
}
