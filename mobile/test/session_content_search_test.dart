import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/phone_search_catalog.dart'
    show phoneAgentId;
import 'package:harness_mobile/phone/search_result_text.dart' show snippetLead, snippetRuns;
import 'package:harness_mobile/state/session_content_search.dart';

/// The desktop's `session_content_search_test.dart`, for the same file on the phone: Find asks
/// every machine's session index as Cmd-P does.
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

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 30));

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
      expect(hits.single.destinationId, phoneAgentId('m', 'a1'));
      expect(hits.single.score, 1);
      expect(hits.single.plainSnippet, 'halved the scroll delta');
      expect(
        hits.single.at,
        DateTime.fromMillisecondsSinceEpoch(1790000000000),
      );
      expect(SessionContentHit.listFromReply('m', {'error': 'X'}), isEmpty);
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
      expect(search.hits.keys, [phoneAgentId('m', 'a1')]);
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
        expect(search.hits.keys, [phoneAgentId('m', 'new')]);
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
    expect(search.hitsFor('mob swipe').keys, [phoneAgentId('m', 'a1')]);
    expect(search.hitsFor('mob swi').keys, [phoneAgentId('m', 'a1')]);
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
      expect(search.hitsFor('today dial').keys, [phoneAgentId('m', 'a1')]);
      // Read once per query and answer, however many rows ask.
      expect(
        identical(search.hitsFor('today dial'), search.hitsFor('today dial')),
        isTrue,
      );
      expect(search.hitsFor('yesterday dial'), isEmpty);
    },
  );
}
