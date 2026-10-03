/// The daemon's two lasting switches, kept on this computer, and the panel's
/// last tab:
///
/// - **Motion**: work frames, the wave and blinks. Off, the face still
///   changes with the mood; nothing moves. Reduce Motion and a background
///   window stop motion too, whatever this says.
/// - **Quiet**: no line in the status line at all until it is turned off
///   (a nap lasts 15 minutes; Quiet lasts until you say).
/// - **Tab**: the panel opens where it was left (`now`, `zoo`, `lessons`,
///   `settings`).
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

class DaemonSettings extends ChangeNotifier {
  DaemonSettings({this.storage, this.canPersist});

  static const storageKey = 'daemons.settings.v1';
  final LocalKeyValueStore? storage;

  /// A temporary preview must not read or replace the real preferences.
  final bool Function()? canPersist;

  /// The panel's tabs, in order (1–4).
  static const tabs = ['now', 'zoo', 'lessons', 'settings'];

  bool _motion = true, _quiet = false;
  String _tab = tabs.first;
  bool _disposed = false;
  Future<void> _saving = Future.value();

  bool get motion => _motion;
  bool get quiet => _quiet;
  String get tab => _tab;

  set tab(String value) {
    if (_tab == value || !tabs.contains(value)) return;
    _tab = value;
    _changed();
  }

  set motion(bool value) {
    if (_motion == value) return;
    _motion = value;
    _changed();
  }

  set quiet(bool value) {
    if (_quiet == value) return;
    _quiet = value;
    _changed();
  }

  /// Read what was kept. A missing or unreadable value keeps the defaults:
  /// motion on, quiet off.
  Future<void> load() async {
    if (canPersist?.call() == false) return;
    try {
      final raw = await storage?.read(storageKey);
      final value = raw == null ? null : jsonDecode(raw);
      if (_disposed || canPersist?.call() == false || value is! Map) return;
      final motion = value['motion'], quiet = value['quiet'];
      final tab = value['tab'];
      var changed = false;
      if (tab is String && tabs.contains(tab) && tab != _tab) {
        _tab = tab;
        changed = true;
      }
      if (motion is bool && motion != _motion) {
        _motion = motion;
        changed = true;
      }
      if (quiet is bool && quiet != _quiet) {
        _quiet = quiet;
        changed = true;
      }
      if (changed) notifyListeners();
    } catch (_) {}
  }

  void _changed() {
    if (_disposed) return;
    notifyListeners();
    if (canPersist?.call() == false) return;
    final data = jsonEncode({'motion': _motion, 'quiet': _quiet, 'tab': _tab});
    _saving = _saving.then((_) async {
      try {
        await storage?.write(storageKey, data);
      } catch (_) {}
    });
  }

  Future<void> flush() => _saving;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
