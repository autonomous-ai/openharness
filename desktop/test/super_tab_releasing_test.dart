import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/backlog.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_groups.dart';

import 'support/super_tab_fixture.dart';

/// Shipped means released, not just merged (Dee, task #3452): the server lists
/// a merged task's `releasing` parts until a verified release carries it, and
/// sends none for a task merged before it recorded releases.
void main() {
  const now = 1793700000000;
  final at = DateTime.fromMillisecondsSinceEpoch(now);
  const url = 'https://github.com/acme/app/pull/7';

  SuperTabConversation merged({
    Object? releasing,
    Map<String, dynamic>? released,
    bool closed = false,
  }) => SuperTabConversation.fromJson({
    ...conversationFixture('work', 'A task'),
    'number': 7,
    'assignment': {'id': 'a1', 'agentId': 'kestrel', 'status': 'done'},
    'shippedAt': now,
    'pullRequestUrls': [url],
    'cards': {
      'pullRequests': [
        {'url': url, 'messageId': 'm-7', 'mergedAt': now},
      ],
    },
    'releasing': ?releasing,
    'released': ?released,
    if (closed) 'closed': true,
  });

  SuperTabTaskPlace? place(SuperTabConversation task) =>
      superTabTaskPlaceOf(task, readerId: 'owner', now: at);

  group('the Tasks board', () {
    test('a merged task still releasing is Waiting, with its parts', () {
      final p = place(merged(releasing: ['desktop', 'cli']))!;
      expect(p.column, SuperTabTaskColumn.waiting);
      expect(p.state, 'merged, releasing (Desktop, CLI)');
    });

    test('each part reads as its name', () {
      expect(
        place(merged(releasing: ['backend', 'web', 'desktop']))!.state,
        'merged, releasing (backend, Web, Desktop)',
      );
    });

    test('a released task is Shipped, with its pull request', () {
      final p = place(
        merged(
          released: {
            'at': now,
            'tags': ['v1.4.2_desktop'],
          },
        ),
      )!;
      expect(p.column, SuperTabTaskColumn.shipped);
      expect(p.state, 'PR #7');
    });

    test('a merge from before releases were recorded stays Shipped', () {
      expect(place(merged())!.column, SuperTabTaskColumn.shipped);
    });

    test('a list still empty, before the files are read, is releasing', () {
      final p = place(merged(releasing: []))!;
      expect(p.column, SuperTabTaskColumn.waiting);
      expect(p.state, 'merged, releasing');
    });

    test('the server says it: present means releasing', () {
      final p = place(
        SuperTabConversation.fromJson({
          ...conversationFixture('work', 'A task'),
          'assignment': {'id': 'a1', 'agentId': 'kestrel', 'status': 'done'},
          'releasing': ['cli'],
        }),
      )!;
      expect(p.column, SuperTabTaskColumn.waiting);
      expect(p.state, 'merged, releasing (CLI)');
    });

    test('a task merged and closed while releasing still waits', () {
      final p = place(merged(releasing: ['cli'], closed: true))!;
      expect(p.column, SuperTabTaskColumn.waiting);
    });

    test('the board lists it under Waiting, not Shipped', () {
      final board = superTabTaskBoard(
        [
          merged(releasing: ['desktop']),
        ],
        readerId: 'owner',
        now: at,
      );
      expect(board[SuperTabTaskColumn.waiting], hasLength(1));
      expect(board[SuperTabTaskColumn.shipped], isEmpty);
    });

    test('a task is not shipped while it is releasing', () {
      expect(superTabTaskShipped(merged(releasing: ['cli'])), isFalse);
      expect(superTabTaskShipped(merged()), isTrue);
    });

    test('a Done task with no pull request cards is not shipped while the '
        'server lists it as releasing, and is when it does not', () {
      SuperTabConversation done({List<String>? releasing}) =>
          SuperTabConversation.fromJson({
            ...conversationFixture('work', 'A task'),
            'assignment': {'id': 'a1', 'agentId': 'kestrel', 'status': 'done'},
            'releasing': ?releasing,
          });
      expect(superTabTaskShipped(done(releasing: [])), isFalse);
      expect(superTabTaskShipped(done(releasing: ['web'])), isFalse);
      expect(superTabTaskShipped(done()), isTrue);
    });
  });
}
