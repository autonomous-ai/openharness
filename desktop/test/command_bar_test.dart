import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/command_bar.dart';

CommandBarAction action({
  String id = 'settings',
  String version = 'v1',
  bool session = false,
  CommandKind kind = CommandKind.command,
  Future<String?> Function(String)? perform,
  String context = '',
}) => CommandBarAction(
  id: id,
  version: version,
  title: 'Open Settings',
  detail: 'Appearance and accounts',
  kind: kind,
  automatic: kind == CommandKind.command,
  isSession: session,
  perform: perform,
  context: context,
);

void main() {
  test('typing is local and a superseded decision cannot execute', () async {
    var calls = 0, executions = 0;
    final answer = Completer<Map<String, dynamic>>();
    CancelToken? token;
    final a = action(
      perform: (_) async {
        executions++;
        return null;
      },
    );
    final bar = CommandBarController(
      catalog: () => [a],
      resolve: (_, cancel) {
        calls++;
        token = cancel;
        return answer.future;
      },
    );
    addTearDown(bar.dispose);
    bar.edit('settings');
    expect(calls, 0);
    expect(bar.rows.single.id, a.id);
    final first = bar.submit('change my theme');
    bar.edit('another request');
    expect(token!.isCancelled, isTrue);
    answer.complete({'selectedId': a.id, 'autoExecute': true});
    await first;
    expect(executions, 0);
    expect(bar.query, 'another request');
    expect(bar.phase, CommandPhase.idle);
  });

  test('sending needs explicit selection even if a response requests auto execution', () async {
    var executions = 0;
    String? sent;
    final a = action(
      kind: CommandKind.send,
      perform: (text) async {
        executions++;
        sent = text;
        return null;
      },
    );
    final bar = CommandBarController(
      catalog: () => [a],
      resolve: (_, _) async => {'selectedId': a.id, 'autoExecute': true},
    );
    addTearDown(bar.dispose);
    await bar.submit('Fix the auth retry bug');
    expect(executions, 0);
    expect(bar.rows.single.id, a.id);
    await bar.choose(a);
    expect(executions, 1);
    expect(sent, 'Fix the auth retry bug');
  });

  test('revalidates session identity before sending, and prevents double submission', () async {
    final finish = Completer<String?>();
    var executions = 0;
    final first = action(
      perform: (_) {
        executions++;
        return finish.future;
      },
    );
    var current = first;
    final bar = CommandBarController(
      catalog: () => [current],
      resolve: (_, _) async => {},
    );
    addTearDown(bar.dispose);
    current = action(version: 'replacement');
    await bar.choose(first);
    expect(executions, 0);
    expect(bar.error, contains('changed'));
    current = first;
    final running = bar.choose(first);
    await bar.choose(first);
    expect(executions, 1);
    finish.complete(null);
    await running;
  });

  test('unknown model identities cannot become executable actions', () async {
    var executions = 0;
    final bar = CommandBarController(
      catalog: () => [
        action(
          perform: (_) async {
            executions++;
            return null;
          },
        ),
      ],
      resolve: (_, _) async => {'selectedId': 'invented', 'autoExecute': true},
    );
    addTearDown(bar.dispose);
    await bar.submit('run anything');
    expect(executions, 0);
    expect(bar.error, isNotNull);
  });

  test(
    'a superseded semantic search cannot replace newer local suggestions',
    () async {
      final answer = Completer<Map<String, dynamic>>();
      final a = action(kind: CommandKind.open, session: true);
      final bar = CommandBarController(
        catalog: () => [a],
        resolve: (_, _) => answer.future,
      );
      addTearDown(bar.dispose);
      bar.edit('find old work');
      final first = bar.find();
      bar.edit('nothing matches this');
      answer.complete({
        'matches': [
          {'id': a.id},
        ],
      });
      await first;
      expect(bar.rows, isEmpty);
      expect(bar.semanticResults, isFalse);
    },
  );

  test('bounds the transmitted catalog and excludes non-sessions from semantic matching', () {
    final bar = CommandBarController(
      catalog: () => List.generate(
        200,
        (i) => action(id: '$i', context: 'x' * 700, session: i.isEven),
      ),
      resolve: (_, _) async => {},
    );
    addTearDown(bar.dispose);
    final snapshot = bar.snapshot();
    expect(snapshot.length, lessThanOrEqualTo(96));
    expect(
      jsonEncode(snapshot.map((a) => a.toJson()).toList()).length,
      lessThan(32000),
    );
    expect(bar.snapshot(sessionsOnly: true).every((a) => a.isSession), isTrue);
  });

  test(
    'watches only reevaluate changed evidence and never expand to new sessions',
    () async {
      var calls = 0;
      var available = [
        action(
          id: 'session',
          kind: CommandKind.open,
          session: true,
          context: 'Tests failed',
        ),
      ];
      final sentIds = <List<String>>[];
      final bar = CommandBarController(
        catalog: () => available,
        resolve: (request, _) async {
          calls++;
          sentIds.add(
            (request['candidates'] as List)
                .map((a) => a['id'] as String)
                .toList(),
          );
          return {
            'matches': [
              {'id': 'session'},
            ],
          };
        },
      );
      addTearDown(bar.dispose);
      bar.edit('Notify me when tests pass');
      await bar.startWatch();
      expect(calls, 1);
      await bar.checkWatches();
      expect(calls, 1);
      available = [
        action(
          id: 'session',
          kind: CommandKind.open,
          session: true,
          context: 'Tests passed',
        ),
        action(id: 'new-session', kind: CommandKind.open, session: true),
      ];
      await bar.checkWatches();
      expect(calls, 2);
      expect(sentIds.last, ['session']);
      expect(bar.watchMatches, 1);
      bar.stopWatch(bar.watches.single);
      await bar.checkWatches();
      expect(calls, 2);
    },
  );

  test('watch errors pause evaluation until explicit resume', () async {
    var calls = 0;
    final bar = CommandBarController(
      catalog: () => [action(kind: CommandKind.open, session: true)],
      resolve: (_, _) async {
        calls++;
        throw Exception('offline');
      },
    );
    addTearDown(bar.dispose);
    bar.edit('Watch for completion');
    await bar.startWatch();
    await bar.checkWatches();
    expect(calls, 1);
    expect(bar.watches.single.error, isNotNull);
  });
}
