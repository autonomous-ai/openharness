import '../core/local_key_value_store.dart';
import 'desk_sync.dart';

/// Which computer this phone is looking at — the desktop's Profiles (`desktop/lib/state/
/// machine_profile.dart`), on the account's [DeskTab]s rather than on a window's swarms.
///
/// The account still has one desk, the same tabs on every computer and on this phone; a profile only
/// decides which of those tabs the phone shows. `null` is every computer. A machine id is that
/// computer alone: a tab is in it when every agent it names runs there. A tab that names no agent
/// stays, as on the desktop, so there is always a tab to be in.
bool deskTabMatchesMachineProfile(DeskTab tab, String? machineId) {
  if (machineId == null || machineId.isEmpty) return true;
  if (tab.panes.isEmpty) return true;
  return tab.panes.every((pane) => pane.machineId == machineId);
}

/// The tabs this phone shows for [machineId], in the desk's order. The desk's own list is not
/// touched: the other computers' tabs stay on it, they are only not drawn here.
///
/// A profile only hides. When it would hide every tab the phone shows them all — the desktop's rule
/// (`swarmsForMachineProfile`), and for its reason: nothing here may make a tab to stand in, because
/// a tab made on the phone is a tab on every computer of the account.
List<DeskTab> deskTabsForMachineProfile(List<DeskTab> tabs, String? machineId) {
  if (machineId == null || machineId.isEmpty) return tabs;
  final shown = [
    for (final tab in tabs)
      if (deskTabMatchesMachineProfile(tab, machineId)) tab,
  ];
  return shown.isEmpty ? tabs : shown;
}

/// The profile this phone chose, remembered across launches on the terms of the other per-phone
/// records (`AgentPreference`, `LastOpenedAgent`): with no storage — a test — it lives for the run
/// and is written nowhere.
///
/// A phone's own choice, never the desk's, exactly as a window's profile is that window's: picking a
/// computer here changes nothing on the desktop beside it.
class MachineProfileStore {
  MachineProfileStore(this.storage);

  final LocalKeyValueStore? storage;

  /// The desktop's key for the same choice. A phone's state file is its own, so the two never meet;
  /// the name says what is stored.
  static const _key = 'machine_profile_v1';

  /// The chosen machine id, or null for every computer.
  String? get value => _value;
  String? _value;

  Future<void>? _loading;
  Future<void> _writes = Future.value();

  /// Bumped by [select], so a read that lands after a choice made in this run cannot undo it.
  int _revision = 0;

  /// Idempotent: the launch and anything that asks later share one read.
  Future<void> load() => _loading ??= _read();

  Future<void> _read() async {
    final revision = _revision;
    try {
      final stored = (await storage?.read(_key))?.trim();
      if (revision != _revision) return;
      _value = stored == null || stored.isEmpty ? null : stored;
    } catch (_) {
      // Every computer, which is what a phone with no record shows anyway.
    }
  }

  /// Null or empty is every computer. Returns whether anything changed.
  bool select(String? machineId) {
    final clean = machineId?.trim();
    final next = clean == null || clean.isEmpty ? null : clean;
    _revision++;
    if (next == _value) return false;
    _value = next;
    // In order, one after another: two quick picks must land on disk as the second.
    _writes = _writes.then((_) async {
      try {
        if (next == null) {
          await storage?.delete(_key);
        } else {
          await storage?.write(_key, next);
        }
      } catch (_) {
        // Kept for this run; the next launch shows every computer.
      }
    });
    return true;
  }
}
