import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// Cmd-P against a real daemon: the app's own transport, catalog and search
/// controller, the daemon's real index of real transcripts. Point it at a
/// running daemon (never the one serving your harnesses — see
/// docs/research/2026-09-26-session-search.md for the isolated setup):
///
///   HARNESS_SEARCH_E2E_PORT=28473 HARNESS_SEARCH_E2E_HOME=`its HOME` \
///     flutter test test/session_search_daemon_e2e_test.dart
///
/// Queries and expectations come from HARNESS_SEARCH_E2E_CASES, one per line:
/// `query => expected words in the top row's title or snippet`, `=> *` for
/// any content hit on the top row, or `=> -` for no content hits.
void main() {
  final port = Platform.environment['HARNESS_SEARCH_E2E_PORT'];
  final home = Platform.environment['HARNESS_SEARCH_E2E_HOME'];
  if (port == null || home == null) {
    test(
      'Cmd-P against a real daemon',
      () {},
      skip: 'Set HARNESS_SEARCH_E2E_PORT and _HOME.',
    );
    return;
  }
  final machineId = File('$home/.harness/computer-id')
      .readAsStringSync()
      .trim();
  late WsConn connection;

  Future<void> until(
    String label,
    bool Function() check, {
    int seconds = 10,
  }) async {
    final deadline = DateTime.now().add(Duration(seconds: seconds));
    while (DateTime.now().isBefore(deadline)) {
      if (check()) return;
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    fail('Timed out: $label');
  }

  setUpAll(() async {
    var connected = false;
    connection = WsConn(
      wsBaseUrl: '',
      autonomousEnv: 'prod',
      machineId: machineId,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: fail,
      onStatus: (status) => connected = status == ConnectionStatus.connected,
      onEvent: (_) async {},
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse('ws://127.0.0.1:$port/api/local-ws'),
    );
    await connection.connect();
    await until('connected', () => connected);
  });
  tearDownAll(() => connection.close());

  test('finds harnesses by what was said, fast, on the real index', () async {
    final listed = await connection.request(
      'agents_list',
      payload: const {'includeStopped': true},
    );
    final agents = [
      for (final raw in listed['agents'] as List)
        Agent.fromJson(raw as Map<String, dynamic>),
    ];
    expect(agents, isNotEmpty);
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    addTearDown(app.dispose);
    // The fixture machine stands for the daemon's own; the connection is real.
    app.machineStates['m']!.agents = agents;
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
      activityFirst: true,
      placement: HarnessPlacement.newTab,
    );
    addTearDown(search.dispose);

    final cases = (Platform.environment['HARNESS_SEARCH_E2E_CASES'] ?? '')
        .split('\n')
        .where((line) => line.contains('=>'))
        .map((line) => line.split('=>').map((part) => part.trim()).toList());
    final report = StringBuffer();
    var failures = 0;
    for (final [query, expected] in cases) {
      final started = DateTime.now();
      search.setQuery(query);
      final byName = search.rows.where((row) => !row.isCreate).length;
      // Answered: the controller holds this query's hits, or the daemon had none.
      await until(
        'answer for $query',
        () =>
            search.contentAnswered == query.trim() ||
            // A prefix (> @ # : * ?) opens another kind of search.
            search.isCommandMode ||
            search.isHelpMode ||
            search.isGroupMode ||
            search.isModelMode ||
            search.isStoreMode ||
            !SessionContentSearch(
              machines: () => const [],
              ask: (_, _, _) async => null,
            ).searchable(query),
      );
      final took = DateTime.now().difference(started).inMilliseconds;
      final rows = search.rows.where((row) => !row.isCreate).toList();
      final top = rows.isEmpty ? null : rows.first;
      final hit = top == null ? null : search.contentHitFor(top.id);
      final line = '${top?.title ?? '(none)'} ${hit?.plainSnippet ?? ''}'
          .toLowerCase();
      final ok = switch (expected) {
        '-' => rows.every((row) => search.contentHitFor(row.id) == null),
        '*' => hit != null,
        _ => expected.toLowerCase().split(' ').every(line.contains),
      };
      if (!ok) failures++;
      report.writeln(
        '${ok ? '✓' : '✗'} "$query" · ${rows.length} rows ($byName by name before the answer) · ${took}ms\n'
        '    1. ${top?.title} ${hit == null ? '' : '· ${hit.field}: ${hit.plainSnippet}'}\n'
        '${rows.skip(1).take(2).map((row) => '    · ${row.title} ${search.contentHitFor(row.id)?.plainSnippet ?? ''}').join('\n')}',
      );
      // The best row is selected; with none, the New Harness row.
      final selected = search.selected;
      if (top == null
          ? selected != null && !selected.isCreate
          : selected?.id != top.id) {
        failures++;
        report.writeln(
          '    ✗ selected ${selected?.title} instead of ${top?.title}',
        );
      }
    }
    // ignore: avoid_print
    print(report);
    expect(failures, 0, reason: report.toString());
  }, timeout: const Timeout(Duration(minutes: 5)));
}
