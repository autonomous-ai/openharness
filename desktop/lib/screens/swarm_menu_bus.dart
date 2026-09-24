import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/test_run.dart';

/// The seam both native menu surfaces talk through.
///
/// On macOS the state the title bar draws crosses to AppKit over the
/// `harness/swarm_tabs` channel and the actions come back over it; the Swift
/// side owns that half. Linux has no native menu bar to hand the payloads to,
/// so this bus is ALSO where the Linux menu bar (`widgets/linux_menu_bar.dart`)
/// reads them from and the path its rows dispatch back through — one contract,
/// two hosts, and Dart keeps a single switch (`_onNative`) for either side.
class SwarmMenuBus {
  /// The platform default: the channel on macOS, the state model on Linux.
  ///
  /// Never the channel under test, whatever the host: the Linux bar's tests
  /// run on macOS machines too, and there the channel has nobody on the other
  /// end, so the bar would draw no state and its rows would reach no handler.
  /// A test that wants the channel asks for [SwarmMenuBus.forChannel].
  SwarmMenuBus() : _channelBacked = Platform.isMacOS && !kUnderTest;

  /// The channel, even on a Linux test host — a screen forced onto the
  /// native-tabs path must keep talking to something a test can mock.
  SwarmMenuBus.forChannel() : _channelBacked = true;

  /// macOS hands the payloads to AppKit; Linux keeps them here for the bar.
  final bool _channelBacked;

  final SwarmMenuState state = SwarmMenuState();

  Future<dynamic> Function(MethodCall call)? _handler;

  /// Dart → native. On macOS this crosses to Swift; on Linux the menu state and
  /// the keymap land in [state] (what the menu bar draws, and the shortcut
  /// hints beside its rows) and the rest have no reader here.
  Future<void> send(String method, [Map<Object?, Object?>? arguments]) async {
    if (_channelBacked) {
      await const MethodChannel('harness/swarm_tabs')
          .invokeMethod<void>(method, arguments);
      return;
    }
    switch (method) {
      case 'update':
      case 'keymapState':
        state.apply(method, arguments ?? const <Object?, Object?>{});
    }
  }

  /// Registers where the native side's actions arrive. On macOS this is the
  /// platform handler; on Linux the menu bar calls [receive] with the same
  /// shape a native menu would have delivered.
  void setHandler(Future<dynamic> Function(MethodCall call)? handler) {
    if (_channelBacked) {
      const MethodChannel('harness/swarm_tabs').setMethodCallHandler(handler);
      return;
    }
    _handler = handler;
  }

  /// Delivers one action to Dart — the Linux menu bar's half of the channel.
  Future<dynamic> receive(MethodCall call) async {
    final handler = _handler;
    if (handler == null) return null;
    return handler(call);
  }
}

/// The menu bar's one shared bus.
final swarmMenuBus = SwarmMenuBus();

/// The state a native menu bar draws, parsed from the same payloads
/// SwarmTitlebar.swift and HarnessKeymap.swift consume. Field-for-field the
/// Swift side's `SwarmHistoryEntry`, with the same tolerance for a short row:
/// a missing key reads as absent, never as a crash.
class SwarmMenuState extends ChangeNotifier {
  bool enabled = false;
  bool canReopen = false;
  bool canFind = false;
  bool canClosePane = false;
  bool canGoBack = false;
  bool canGoForward = false;
  List<SwarmMenuEntry> history = const [];
  List<SwarmMenuEntry> closedHistory = const [];

  /// The per-pane commands the focused pane can take right now: restart,
  /// share, the viewer and the composer. validateMenuItem reads the same map.
  Map<String, bool> paneActions = const {};

  /// Each menu action's (and keymap command's) shortcut, as the Keyboard
  /// Shortcuts sheet writes it.
  /// macOS sets a row's key equivalent from the same binding
  /// (HarnessKeymap.applyMenuKeys), so a rebinding shows up in both.
  Map<String, String> hints = const {};

  void apply(String method, Map<Object?, Object?> args) {
    switch (method) {
      case 'update':
        enabled = args['enabled'] as bool? ?? false;
        canReopen = args['canReopen'] as bool? ?? false;
        canFind = args['canFind'] as bool? ?? false;
        canClosePane = args['canClosePane'] as bool? ?? false;
        canGoBack = args['canGoBack'] as bool? ?? false;
        canGoForward = args['canGoForward'] as bool? ?? false;
        history = _parseEntries(args['history'], closed: false);
        closedHistory = _parseEntries(args['closedHistory'], closed: true);
        paneActions = {
          if (args['paneActions'] case final Map actions)
            for (final MapEntry(:key, :value) in actions.entries)
              if (key is String && value is bool) key: value,
        };
      case 'keymapState':
        hints = _parseHints(args['contexts']);
      default:
        return;
    }
    notifyListeners();
  }

  /// The dispose path pushes empty payloads so a macOS menu stops showing
  /// state; on Linux the same pushes clear the bar.
  void clear() {
    enabled = false;
    canReopen = false;
    canFind = false;
    canClosePane = false;
    canGoBack = false;
    canGoForward = false;
    history = const [];
    closedHistory = const [];
    paneActions = const {};
    notifyListeners();
  }

  /// The first binding per menu action, workspace bindings first: a menu row
  /// shows one chord, and the workspace's is the one that works from anywhere.
  static Map<String, String> _parseHints(Object? contexts) {
    final hints = <String, String>{};
    if (contexts is! Map) return hints;
    final ordered = [
      contexts['workspace'],
      for (final MapEntry(:key, :value) in contexts.entries)
        if (key != 'workspace') value,
    ];
    for (final bindings in ordered) {
      if (bindings is! List) continue;
      for (final binding in bindings) {
        if (binding is! Map) continue;
        final hint = binding['hint'];
        if (hint is! String || hint.isEmpty) continue;
        // By menu action, and by command id for a row that sends the command
        // itself (Help's Quick Start). The two never collide: ids are dotted.
        for (final id in [binding['menuAction'], binding['command']]) {
          if (id is String) hints.putIfAbsent(id, () => hint);
        }
      }
    }
    return hints;
  }

  static List<SwarmMenuEntry> _parseEntries(
    Object? rows, {
    required bool closed,
  }) => [
    if (rows is List)
      for (final row in rows)
        if (row is Map) SwarmMenuEntry.fromMap(row, closed: closed),
  ];
}

/// One row of the History menu — a recently visited tab or a closed one.
class SwarmMenuEntry {
  const SwarmMenuEntry({
    required this.id,
    required this.title,
    required this.machineName,
    required this.detail,
    required this.engine,
    required this.iconAsset,
    required this.agentCount,
    required this.current,
    required this.canReopen,
    required this.closed,
  });

  factory SwarmMenuEntry.fromMap(
    Map<dynamic, dynamic> row, {
    required bool closed,
  }) => SwarmMenuEntry(
    id: row['id'] as String? ?? '',
    title: row['title'] as String? ?? '',
    machineName: row['machineName'] as String? ?? '',
    detail: row['detail'] as String? ?? '',
    engine: row['engine'] as String?,
    iconAsset: row['iconAsset'] as String?,
    agentCount: (row['agentCount'] as num?)?.toInt(),
    current: row['current'] as bool? ?? false,
    canReopen: row['canReopen'] as bool? ?? false,
    closed: closed,
  );

  final String id;
  final String title;
  final String machineName;
  final String detail;
  final String? engine;
  final String? iconAsset;
  final int? agentCount;
  final bool current;
  final bool canReopen;
  final bool closed;
}
