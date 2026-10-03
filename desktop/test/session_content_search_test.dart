import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

const _o = kSnippetMarkOpen;
const _c = kSnippetMarkClose;

SessionContentHit hit(
  String agentId, {
  String machineId = 'm',
  bool together = true,
  double score = .5,
  int position = 0,
  String snippet = 'the ${_o}dial$_c scroll',
  String field = 'ask',
}) => SessionContentHit(
  machineId: machineId,
  agentId: agentId,
  sessionId: 'session-$agentId',
  field: field,
  snippet: snippet,
  together: together,
  score: score,
  position: position,
);

/// A daemon that answers only `session_search`, from [answers] by query.
class SearchConnection extends WsConn {
  SearchConnection(this.answers)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final Map<String, List<Map<String, dynamic>>> answers;
  final asked = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'session_search') return {'error': 'UNSUPPORTED'};
    final query = payload['query'] as String;
    asked.add(query);
    return {'hits': answers[query] ?? const [], 'indexed': 3, 'pending': 0};
  }
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 30));

/// Past Open Harness's pause-in-typing debounce and the reply.
Future<void> answered() =>
    Future<void>.delayed(const Duration(milliseconds: 250));

void main() {
  group('SessionContentHit', () {
    test('reads a daemon reply and refuses what it cannot use', () {
      final hits = SessionContentHit.listFromReply('m', {
        'hits': [
          {
            'agentId': 'a1',
            'sessionId': 's1',
            'field': 'answer',
            'snippet': 'halved the ${_o}scroll$_c delta',
            'together': true,
            'score': 1.7,
            'turn': 4,
            'at': 1790000000000,
          },
          {'sessionId': 's2'},
          'junk',
        ],
      });
      expect(hits, hasLength(1));
      expect(hits.single.destinationId, agentDestinationId('m', 'a1'));
      expect(hits.single.score, 1);
      expect(hits.single.plainSnippet, 'halved the scroll delta');
      expect(
        hits.single.at,
        DateTime.fromMillisecondsSinceEpoch(1790000000000),
      );
      expect(SessionContentHit.listFromReply('m', {'error': 'X'}), isEmpty);
    });

    test('reads a conversation Harness did not start, and refuses one it cannot resume', () {
      final hits = SessionContentHit.listFromReply('m', {
        'hits': [
          {
            'agentId': '',
            'sessionId': '01a0c4ad-de5e-7000-8000-000000000001',
            'engine': 'codex',
            'field': 'ask',
            'snippet': 'compare ${_o}retention$_c',
            'score': .8,
            'lastAt': 1790000000000,
            'external': {
              'title': 'Retention cohorts',
              'cwd': '/work/cohorts',
              'origin': 'codex-app',
              'open': true,
            },
          },
          // No folder to resume in, and no engine to resume with: not a row.
          {
            'agentId': '',
            'sessionId': 's2',
            'engine': 'claude',
            'external': {'title': 'x'},
          },
          {
            'agentId': '',
            'sessionId': 's3',
            'external': {'cwd': '/work'},
          },
          {'agentId': '', 'sessionId': 's4'},
        ],
      });
      expect(hits, hasLength(1));
      final hit = hits.single;
      expect(
        hit.destinationId,
        externalDestinationId('m', '01a0c4ad-de5e-7000-8000-000000000001'),
      );
      expect(hit.lastAt, DateTime.fromMillisecondsSinceEpoch(1790000000000));
      expect(hit.external!.engine, 'codex');
      expect(hit.external!.cwd, '/work/cohorts');
      expect(hit.external!.title, 'Retention cohorts');
      expect(hit.external!.originLabel, 'Codex app');
      expect(hit.external!.open, isTrue);
    });

    test('snippet runs bold exactly the marked words', () {
      expect(snippetRuns('a ${_o}dial$_c and ${_o}scroll$_c.'), [
        (text: 'a ', matched: false),
        (text: 'dial', matched: true),
        (text: ' and ', matched: false),
        (text: 'scroll', matched: true),
        (text: '.', matched: false),
      ]);
      expect(snippetRuns('unclosed ${_o}mark'), [
        (text: 'unclosed ', matched: false),
        (text: 'mark', matched: true),
      ]);
      expect(snippetLead('ask'), '> ');
      expect(snippetLead('tools'), r'$ ');
      expect(snippetLead('answer'), '');
    });

    testWidgets('a snippet reads as one line with its words in bold', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: SessionSnippetText(hit('a1'), style: const TextStyle()),
        ),
      );
      final text = tester.widget<Text>(find.byType(Text));
      expect(text.textSpan!.toPlainText(), '> the dial scroll');
      expect(text.maxLines, 1);
    });
  });

  group('SessionContentSearch', () {
    test('asks every machine once per pause in typing and keeps the best hit per harness', () async {
      final asked = <(String, String)>[];
      final gate = Completer<void>();
      final search = SessionContentSearch(
        machines: () => ['m', 'n'],
        debounce: const Duration(milliseconds: 5),
        ask: (machine, query, _) async {
          asked.add((machine, query));
          if (machine == 'n') await gate.future;
          return machine == 'm'
              ? [
                  hit('a1', together: false, score: .9),
                  hit('a1', together: true, score: .2),
                ]
              : [hit('b1', machineId: 'n')];
        },
      );
      addTearDown(search.dispose);
      search.search('d');
      search.search('di');
      search.search('dia');
      search.search('dial');
      await settle();
      expect(asked, [('m', 'dial'), ('n', 'dial')]);
      // One harness, its best conversation: all words together beats spread.
      expect(search.hits.keys, [agentDestinationId('m', 'a1')]);
      expect(search.hits.values.single.together, isTrue);
      expect(search.answered, 'dial');
      gate.complete();
      await settle();
      expect(search.hits.keys, hasLength(2));
    });

    test(
      'drops a late answer to an older question and clears for new words',
      () async {
        final answers = <String, Completer<List<SessionContentHit>?>>{};
        final search = SessionContentSearch(
          machines: () => ['m'],
          debounce: Duration.zero,
          ask: (_, query, _) => (answers[query] = Completer()).future,
        );
        addTearDown(search.dispose);
        search.search('dial');
        await settle();
        search.search('dial scroll');
        await settle();
        answers['dial']!.complete([hit('old')]);
        await settle();
        expect(search.hits, isEmpty);
        answers['dial scroll']!.complete([hit('new')]);
        await settle();
        expect(search.hits.keys, [agentDestinationId('m', 'new')]);
        // Typing on keeps the answer on screen; different words clear it.
        search.search('dial scroll f');
        expect(search.hits, isNotEmpty);
        search.search('keyboard');
        expect(search.hits, isEmpty);
        search.search('k');
        await settle();
        expect(answers.keys, isNot(contains('k')));
      },
    );
  });

  test('an earlier answer vouches only for words its snippet shows', () async {
    final search = SessionContentSearch(
      machines: () => ['m'],
      debounce: Duration.zero,
      ask: (_, query, _) async => query == 'mob'
          ? [
              hit('a1', snippet: 'the ${_o}mobile$_c swipe feels slow'),
              hit('a2', snippet: 'the ${_o}mobile$_c build broke'),
            ]
          : Completer<List<SessionContentHit>?>().future,
    );
    addTearDown(search.dispose);
    search.search('mob');
    await settle();
    expect(search.hitsFor('mob').keys, hasLength(2));
    search.search('mob swipe');
    expect(search.hitsFor('mob swipe').keys, [agentDestinationId('m', 'a1')]);
    expect(search.hitsFor('mob swi').keys, [agentDestinationId('m', 'a1')]);
    expect(search.hitsFor('mob build keyboard'), isEmpty);
  });

  test(
    'a time in the words goes to the machines as a window, not as words',
    () async {
      final asked = <(String, DateTime?, DateTime?)>[];
      final search = SessionContentSearch(
        machines: () => ['m'],
        debounce: Duration.zero,
        now: () => DateTime(2026, 9, 26, 14, 30),
        ask: (_, words, when) async {
          asked.add((words, when?.from, when?.to));
          return [hit('a1', snippet: 'fix the ${_o}dial$_c')];
        },
      );
      addTearDown(search.dispose);
      search.search('dial last week');
      await settle();
      expect(asked, [('dial', DateTime(2026, 9, 14), DateTime(2026, 9, 21))]);
      expect(search.hitsFor('dial last week'), hasLength(1));
      // Another time: that answer says nothing about it.
      expect(search.hitsFor('dial yesterday'), isEmpty);
      // A time alone is a search: what was worked on then.
      search.search('yesterday');
      await settle();
      expect(asked.last, ('', DateTime(2026, 9, 25), DateTime(2026, 9, 26)));
    },
  );

  test(
    '"today" is the same window keystroke to keystroke, though now moves',
    () async {
      var clock = DateTime(2026, 9, 26, 14, 30);
      final search = SessionContentSearch(
        machines: () => ['m'],
        debounce: Duration.zero,
        now: () => clock = clock.add(const Duration(milliseconds: 7)),
        ask: (_, words, when) async => words == 'dia'
            ? [hit('a1', snippet: 'the ${_o}dial$_c scroll')]
            : Completer<List<SessionContentHit>?>().future,
      );
      addTearDown(search.dispose);
      search.search('today dia');
      await settle();
      search.search('today dial');
      expect(search.hitsFor('today dial').keys, [
        agentDestinationId('m', 'a1'),
      ]);
      // Read once per query and answer, however many rows ask.
      expect(
        identical(search.hitsFor('today dial'), search.hitsFor('today dial')),
        isTrue,
      );
      expect(search.hitsFor('yesterday dial'), isEmpty);
    },
  );

  group('ranking with what was said', () {
    SwarmDestination row(String id, String title, int hour) => SwarmDestination(
      id: agentDestinationId('m', id),
      title: title,
      detail: '',
      swarmId: null,
      current: false,
      agentId: id,
      machineId: 'm',
      lastActivityAt: DateTime.utc(2026, 9, 26, hour),
    );

    test(
      'what was said ranks under names, real words above scattered letters',
      () {
        final rows = [
          row('named', 'Dial scroll fix', 1),
          row('scattered', 'Dig all logs', 12),
          row('said', 'Claude harness 9-25 7:25', 3),
          row('said better', 'Codex harness 9-24 1:20', 2),
          row('spread', 'Keyboard', 11),
          row('nothing', 'Mobile', 10),
        ];
        final hits = {
          for (final found in [
            hit('said better', position: 0),
            hit('said', position: 1),
            hit('spread', together: false, position: 2),
          ])
            found.destinationId: found,
        };
        expect(
          rankSwarmDestinationsByActivity(
            rows,
            'dial',
            contentHits: hits,
          ).map((r) => r.agentId),
          ['named', 'said better', 'said', 'spread', 'scattered'],
        );
        // Without the index the conversations are invisible.
        expect(
          rankSwarmDestinationsByActivity(rows, 'dial').map((r) => r.agentId),
          ['named', 'scattered'],
        );
      },
    );

    test("each machine's first hit is as good as another's first", () {
      SwarmDestination on(String machine, String id, int hour) =>
          SwarmDestination(
            id: agentDestinationId(machine, id),
            title: 'Claude harness $id',
            detail: '',
            swarmId: null,
            current: false,
            agentId: id,
            machineId: machine,
            lastActivityAt: DateTime.utc(2026, 9, 26, hour),
          );
      final rows = [on('m', 'm1', 1), on('m', 'm2', 9), on('n', 'n1', 5)];
      final hits = {
        for (final found in [
          // A remote machine's lone weak hit scores 1.0 against its own best,
          // yet ranks with the other machine's first, not above everything.
          hit('m1', score: .7),
          hit('m2', score: .6, position: 1),
          hit('n1', machineId: 'n', score: 1),
        ])
          found.destinationId: found,
      };
      expect(
        rankSwarmDestinationsByActivity(
          rows,
          'retention',
          contentHits: hits,
        ).map((r) => r.agentId),
        ['n1', 'm1', 'm2'],
      );
    });
  });

  group('Open Harness', () {
    test(
      'finds a harness by what was said in it, with the best match selected',
      () async {
        final connection = SearchConnection({
          'retention cohorts': [
            {
              'agentId': 'a7',
              'sessionId': 's7',
              'field': 'answer',
              'snippet': 'Day-7 ${_o}retention$_c by ${_o}cohort$_c is 35%',
              'together': true,
              'score': .9,
            },
            {
              'agentId': 'a3',
              'sessionId': 's3',
              'field': 'ask',
              'snippet': 'the ${_o}retention$_c chart',
              'together': false,
              'score': .5,
            },
            // A harness this app does not list is ignored.
            {'agentId': 'gone', 'sessionId': 'sx', 'snippet': '', 'score': 1},
          ],
        });
        final app = createApp(
          connected: true,
          connectionForTest: (_) => connection,
        );
        addTearDown(app.dispose);
        final search = SwarmSearchController(
          app,
          const [],
          adding: true,
          offersCreate: true,
          activityFirst: true,
          placement: HarnessPlacement.newTab,
        );
        addTearDown(search.dispose);

        search.setQuery('retention cohorts');
        final found = search.rows.where((row) => !row.isCreate).toList();
        expect(found, isEmpty);
        await answered();
        expect(connection.asked, ['retention cohorts']);
        expect(
          search.rows.where((row) => !row.isCreate).map((row) => row.agentId),
          ['a7', 'a3'],
        );
        expect(search.selected!.agentId, 'a7');
        expect(
          search.contentHitFor(agentDestinationId('m', 'a7'))!.field,
          'answer',
        );

        // Commands and scoped modes never go to the session index.
        search.setQuery('>retention');
        await answered();
        expect(connection.asked, ['retention cohorts']);
        expect(search.contentHitFor(agentDestinationId('m', 'a7')), isNull);
      },
    );

    test('a time narrows Open Harness to what was worked on then', () async {
      final now = DateTime.now();
      final connection = SearchConnection({
        '': [
          {
            'agentId': 'vouched',
            'sessionId': 's',
            'field': 'ask',
            'snippet': 'what I asked then',
            'together': true,
            'score': 1,
          },
        ],
      });
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      app.machineStates['m']!.agents = [
        Agent(
          id: 'then',
          name: 'Then',
          engine: 'codex',
          terminalAvailable: true,
          lastActivityAt: DateTime(now.year, now.month, now.day - 1, 12),
        ),
        Agent(
          id: 'old',
          name: 'Old',
          engine: 'codex',
          terminalAvailable: true,
          lastActivityAt: now.subtract(const Duration(days: 20)),
        ),
        // Last active just now, but a machine saw it worked on in the window.
        Agent(
          id: 'vouched',
          name: 'Vouched',
          engine: 'codex',
          terminalAvailable: true,
          lastActivityAt: now,
        ),
      ];
      addTearDown(app.dispose);
      final search = SwarmSearchController(
        app,
        const [],
        adding: true,
        offersCreate: true,
        activityFirst: true,
        placement: HarnessPlacement.newTab,
      );
      addTearDown(search.dispose);
      search.setQuery('yesterday');
      expect(search.wordsQuery, '');
      await answered();
      expect(connection.asked, ['']);
      expect(
        search.rows.where((row) => !row.isCreate).map((row) => row.agentId),
        ['vouched', 'then'],
      );
      expect(
        search.contentHitFor(agentDestinationId('m', 'vouched'))!.snippet,
        'what I asked then',
      );
    });

    test('a restored draft searches what was said too', () async {
      final connection = SearchConnection({
        'retention': [
          {
            'agentId': 'a7',
            'sessionId': 's7',
            'snippet': 'x',
            'together': true,
            'score': 1,
          },
        ],
      });
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      addTearDown(app.dispose);
      SwarmSearchController open() => SwarmSearchController(
        app,
        const [],
        adding: true,
        offersCreate: true,
        activityFirst: true,
        placement: HarnessPlacement.newTab,
      );
      final first = open()..setQuery('retention');
      final draft = first.draft;
      first.dispose();
      await answered();
      connection.asked.clear();
      final again = open();
      addTearDown(again.dispose);
      again.restoreDraft(draft, newTab: true);
      await answered();
      expect(connection.asked, ['retention']);
      expect(again.rows.map((row) => row.agentId), contains('a7'));
    });

    test(
      'a hit arriving later does not take the row somebody moved to',
      () async {
        final connection = SearchConnection({
          'agent 1': [
            {
              'agentId': 'a55',
              'sessionId': 's',
              'snippet': 'x',
              'together': true,
              'score': 1,
            },
          ],
        });
        final app = createApp(
          connected: true,
          connectionForTest: (_) => connection,
        );
        app.machineStates['m']!.agents = [
          for (final (id, name) in [
            ('a1', 'Agent 1'),
            ('a10', 'Agent 10'),
            ('a55', 'Other'),
          ])
            Agent(id: id, name: name, engine: 'codex', terminalAvailable: true),
        ];
        addTearDown(app.dispose);
        final search = SwarmSearchController(
          app,
          const [],
          adding: true,
          offersCreate: true,
          activityFirst: true,
          placement: HarnessPlacement.newTab,
        );
        addTearDown(search.dispose);
        search.setQuery('agent 1');
        final first = search.selected!.agentId;
        search.move(1);
        final moved = search.selected!.id;
        expect(search.selected!.agentId, isNot(first));
        await answered();
        expect(search.rows.map((row) => row.agentId), contains('a55'));
        expect(search.selected!.id, moved);
      },
    );
  });
}
