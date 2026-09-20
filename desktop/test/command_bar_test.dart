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
  List<String> phrases = const [],
  bool? automatic,
  Future<String?> Function()? goBack,
}) => CommandBarAction(
  id: id,
  version: version,
  title: 'Open Settings',
  detail: 'Appearance and accounts',
  kind: kind,
  automatic: automatic ?? kind == CommandKind.command,
  isSession: session,
  perform: perform,
  context: context,
  phrases: phrases,
  goBack: goBack,
);

void main() {
  test('an exact app command acts on Enter without a provider or a second selection', () async {
    var executions = 0, calls = 0;
    final a = action(
      phrases: ['open settings'],
      perform: (_) async {
        executions++;
        return null;
      },
    );
    final bar = CommandBarController(
      catalog: () => [a],
      resolve: (_, _) async {
        calls++;
        throw Exception('offline');
      },
    );
    addTearDown(bar.dispose);
    bar.edit('  OPEN   settings! ');
    expect(executions, 0);
    await bar.submit(bar.query);
    expect(executions, 1);
    expect(calls, 0);
    expect(bar.phase, CommandPhase.done);
    expect(bar.error, isNull);
  });

  test('partial matches and compound requests reach JEV without executing a local fragment', () async {
    var executions = 0;
    final requests = <String>[];
    final bar = CommandBarController(
      catalog: () => [
        action(
          phrases: ['open settings'],
          perform: (_) async {
            executions++;
            return null;
          },
        ),
      ],
      resolve: (request, _) async {
        requests.add(request['prompt'] as String);
        return {'selectedId': null};
      },
    );
    addTearDown(bar.dispose);
    for (final prompt in [
      'open',
      'do not open settings',
      'open settings and delete my projects',
      'open settings\nthen send the task',
    ]) {
      await bar.submit(prompt);
    }
    expect(executions, 0);
    expect(requests, hasLength(4));
    expect(requests.last, 'open settings\nthen send the task');
  });

  test('duplicate exact names remain a choice, including beyond the transmitted snapshot', () async {
    var calls = 0, executions = 0;
    final actions = List.generate(
      100,
      (i) => action(
        id: '$i',
        phrases: i == 0 || i == 99 ? ['open research'] : [],
        perform: (_) async {
          executions++;
          return null;
        },
      ),
    );
    final bar = CommandBarController(
      catalog: () => actions,
      resolve: (_, _) async {
        calls++;
        return {};
      },
    );
    addTearDown(bar.dispose);
    await bar.submit('open research');
    expect(calls, 0);
    expect(executions, 0);
    expect(bar.rows.map((a) => a.id), ['0', '99']);
    expect(bar.message, contains('Which one'));
    await bar.choose(bar.rows.last);
    expect(executions, 1);
  });

  for (final kind in [
    CommandKind.send,
    CommandKind.create,
    CommandKind.watch,
  ]) {
    test(
      '$kind cannot auto-run even if its flag and the provider both say yes',
      () async {
        var executions = 0;
        final a = action(
          kind: kind,
          automatic: true,
          phrases: ['do this'],
          perform: (_) async {
            executions++;
            return null;
          },
        );
        final bar = CommandBarController(
          catalog: () => [a],
          resolve: (_, _) async => {'selectedId': a.id, 'autoExecute': true},
        );
        addTearDown(bar.dispose);
        await bar.submit('do this');
        expect(executions, 0);
        expect(bar.phase, CommandPhase.choosing);
        expect(bar.watches, isEmpty);
      },
    );
  }

  test(
    'an explicit explanation accompanies competing semantic matches',
    () async {
      final a = action(kind: CommandKind.open);
      final bar = CommandBarController(
        catalog: () => [a],
        resolve: (_, _) async => {
          'selectedId': a.id,
          'autoExecute': false,
          'reviewReason': 'ambiguous_target',
        },
      );
      addTearDown(bar.dispose);
      await bar.submit('back to the research');
      expect(bar.message, contains('Which one did you mean'));
    },
  );

  test('Go back is offered only for a successful action and cleared on the next command', () async {
    var returns = 0;
    String? failure;
    final a = action(
      phrases: ['open settings'],
      perform: (_) async => failure,
      goBack: () async {
        returns++;
        return null;
      },
    );
    final bar = CommandBarController(
      catalog: () => [a],
      resolve: (_, _) async => {},
    );
    addTearDown(bar.dispose);
    await bar.submit('open settings');
    expect(bar.goBack, isNotNull);
    await bar.goBack!();
    expect(returns, 1);
    bar.edit('next');
    expect(bar.goBack, isNull);
    failure = 'Unavailable';
    await bar.submit('open settings');
    expect(bar.goBack, isNull);
  });

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
