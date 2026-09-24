// Fixtures for the surfaces that say what a resting computer is doing (grid-reads-without-waking,
// issue 03): a daemon that records every `grid_models_list` it is asked, and the JSON it answers.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/ws_conn.dart';

/// A daemon that answers `grid_models_list` and records the payload of every ask — the thing the
/// app actually sent, never a recomputation of it.
class RecordingDaemon extends WsConn {
  RecordingDaemon(this.reply)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// The next answer to a plain read.
  Map<String, dynamic> reply;

  /// The answer to an ask carrying `wake`, when set; a plain read's [reply] otherwise.
  Map<String, dynamic>? wakeReply;

  /// Every `grid_models_list` payload, in order.
  final asks = <Map<String, dynamic>>[];

  /// Every other request, by type — a retarget, say.
  final others = <({String type, Map<String, dynamic> payload})>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'grid_models_list') {
      others.add((type: type, payload: Map.of(payload)));
      return {};
    }
    asks.add(Map.of(payload));
    if (payload['wake'] != null && wakeReply != null) return wakeReply!;
    return reply;
  }
}

/// One `grids[i]` entry. Every field issue 03 adds is optional, so an old daemon's section is this
/// with none of them.
Map<String, Object?> section(
  String name, {
  bool own = false,
  List<Map<String, Object?>> models = const [],
  String? state,
  String? seenAt,
  int? lastKnownAge,
  String? wakeOutcome,
}) => {
  'name': name,
  'type': own ? 'permissioned-public' : 'permissioned-providers',
  'own': own,
  'models': models,
  'state': ?state,
  'seenAt': ?seenAt,
  'lastKnownAge': ?lastKnownAge,
  'wakeOutcome': ?wakeOutcome,
};

/// One row. [offlineMachine] makes it a row whose every serving computer seems offline.
Map<String, Object?> row(String id, String node, {String? offlineMachine}) => {
  'id': id,
  'node': node,
  if (offlineMachine != null)
    'unavailable': {
      'reason': 'offline',
      'machine': offlineMachine,
      'since': '2026-09-25T08:00:00.000Z',
    },
};

/// The whole `grid_models_list` document for [grids], own section first.
Map<String, dynamic> modelsReply(List<Map<String, Object?>> grids) {
  final own = grids.where((g) => g['own'] == true).firstOrNull;
  return {
    'gridName': own?['name'] ?? 'home',
    'models': own?['models'] ?? const <Object?>[],
    'grids': grids,
    'supportsModelLaunch': true,
  };
}

/// Every string drawn by a [Text] under [of] (the whole tree when null), in paint order — what a
/// person reads, to compare a surface against what it drew before.
List<String> textsUnder(WidgetTester tester, [Finder? of]) => tester
    .widgetList<Text>(
      of == null
          ? find.byType(Text)
          : find.descendant(of: of, matching: find.byType(Text)),
    )
    .map((text) => text.data ?? text.textSpan?.toPlainText() ?? '')
    .toList();

/// Matches any text a person could read that says "grid", in any case.
final saysGrid = find.textContaining(RegExp('grid', caseSensitive: false));
