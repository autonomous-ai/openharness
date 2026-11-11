import 'dart:async';

import 'package:flutter/foundation.dart';

/// Tells an open page that the host now serves another release than the one
/// the page started on (task #2185). The page re-reads the host's release
/// manifest (`webReleaseVersion`, served `no-store`) every [every], and
/// [updateReady] latches once it names a version other than [running].
///
/// A manifest that cannot be read — offline, a failed deploy, an odd body —
/// is no answer: it neither raises nor clears the notice. A page that does
/// not know its own version ([running] null: `flutter run`, a failed read at
/// start-up) never says ready, since every release would differ from it.
class WebUpdateWatcher extends ChangeNotifier {
  WebUpdateWatcher({
    required this.running,
    required this.readLatest,
    this.every = const Duration(minutes: 5),
    bool Function()? shown,
  }) : _shown = shown ?? _always;

  static bool _always() => true;

  /// Whether the page is shown. A hidden tab asks the host nothing on the clock (task #2953);
  /// coming back to it checks at once (`pageShown`, [WebUpdateHost]).
  final bool Function() _shown;

  /// The version this page started on.
  final String? running;

  /// The version the host serves now; null when it cannot say.
  final Future<String?> Function() readLatest;

  /// How often the host is asked.
  final Duration every;

  bool _ready = false, _disposed = false;
  Timer? _timer;

  /// A release other than [running] is out.
  bool get updateReady => _ready;

  /// Asks the host once.
  Future<void> check() async {
    final known = running;
    if (_ready || _disposed || known == null) return;
    String? latest;
    try {
      latest = await readLatest();
    } catch (_) {
      return;
    }
    if (_disposed || latest == null || latest == known) return;
    _ready = true;
    notifyListeners();
  }

  /// Asks the host every [every] from now on, until disposed.
  void start() {
    _timer ??= Timer.periodic(every, (_) {
      if (_shown()) unawaited(check());
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
