import '../core/local_key_value_store.dart';

/// Remembers that the initial launch prompt was offered or superseded by real
/// work. Escape is a decision too; reconnecting must never reopen the prompt.
class FirstHarnessLaunch {
  FirstHarnessLaunch({this.storage});
  final LocalKeyValueStore? storage;
  static const storageKey = 'first_harness_launch_v1';
  bool loaded = false;
  bool handled = false;
  Future<void>? _loading;
  Future<void> _saving = Future.value();

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    try {
      handled = await storage?.read(storageKey) == 'handled' || handled;
    } catch (_) {
      // Unavailable preferences never prevent entering the workspace.
    }
    loaded = true;
  }

  void handle() {
    if (handled) return;
    handled = true;
    _saving = _saving.then((_) async {
      try {
        await storage?.write(storageKey, 'handled');
      } catch (_) {
        // The decision still holds for this window.
      }
    });
  }

  Future<void> flush() => _saving;
}
