import 'package:harness/widgets/pane_header_actions.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/pull_request_badge.dart';

void main() {
  Widget frame(
    Object id,
    Future<Map<String, dynamic>> Function() read, {
    Future<bool> Function(Uri)? open,
    ValueNotifier<bool>? foreground,
    DateTime Function()? now,
    bool visible = true,
  }) => MaterialApp(
    home: Scaffold(
      body: TickerMode(
        enabled: visible,
        child: PullRequestBadge(
          identity: id,
          read: read,
          open: open,
          foreground: foreground,
          now: now,
        ),
      ),
    ),
  );
  testWidgets('standalone PR and branch remain beside the model selector', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 500,
            height: 46,
            child: PaneHeaderActions(
              details: const Text('branch-name'),
              modelPicker: const Text('OpenAI'),
              trailing: PullRequestBadge(
                identity: 'branch',
                read: () async => {
                  'status': 'found',
                  'number': 12,
                  'state': 'Open',
                  'url': 'https://github.com/acme/repo/pull/12',
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('branch-name').hitTestable(), findsOneWidget);
    expect(find.text('#12 Open').hitTestable(), findsOneWidget);
    expect(find.text('OpenAI').hitTestable(), findsOneWidget);
    expect(find.byTooltip('Zoom Pane'), findsNothing);
  });

  for (final state in ['Draft', 'Open', 'Merged', 'Closed']) {
    testWidgets('labels $state and opens the PR URL', (tester) async {
      Uri? opened;
      await tester.pumpWidget(
        frame(
          'branch',
          () async => {
            'status': 'found',
            'number': 12,
            'state': state,
            'url': 'https://github.com/acme/repo/pull/12',
          },
          open: (uri) async {
            opened = uri;
            return true;
          },
        ),
      );
      await tester.pump();
      await tester.tap(find.text('#12 $state'));
      expect(opened.toString(), 'https://github.com/acme/repo/pull/12');
      await tester.pumpWidget(const SizedBox());
    });
  }
  testWidgets('empty lookups and failures stay hidden', (tester) async {
    await tester.pumpWidget(frame('one', () async => {'status': 'none'}));
    await tester.pump();
    expect(find.byType(TextButton), findsNothing);
    await tester.pumpWidget(
      frame('two', () async => throw Exception('offline')),
    );
    await tester.pump();
    expect(find.byType(TextButton), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('a retained hidden pane does not start PR lookups', (
    tester,
  ) async {
    var reads = 0;
    Widget pane(bool visible) => MaterialApp(
      home: TickerMode(
        enabled: visible,
        child: PullRequestBadge(
          identity: 'branch',
          read: () async {
            reads++;
            return {'status': 'none'};
          },
        ),
      ),
    );
    await tester.pumpWidget(pane(false));
    await tester.pump(const Duration(minutes: 5));
    expect(reads, 0);
    await tester.pumpWidget(pane(true));
    await tester.pump();
    expect(reads, 1);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    '48 retained panes poll only four visible badges and stop in background',
    (tester) async {
      final foreground = ValueNotifier(true);
      final reads = List.filled(48, 0);
      await tester.pumpWidget(
        MaterialApp(
          home: Column(
            children: [
              for (var i = 0; i < reads.length; i++)
                TickerMode(
                  enabled: i < 4,
                  child: PullRequestBadge(
                    identity: i,
                    foreground: foreground,
                    now: tester.binding.clock.now,
                    read: () async {
                      reads[i]++;
                      return {'status': 'none'};
                    },
                  ),
                ),
            ],
          ),
        ),
      );
      await tester.pump(const Duration(minutes: 5));
      expect(reads.take(4), everyElement(6));
      expect(reads.skip(4), everyElement(0));
      foreground.value = false;
      await tester.pump(const Duration(minutes: 30));
      expect(reads.take(4), everyElement(6));
      expect(reads.skip(4), everyElement(0));
      foreground.value = true;
      await tester.pump();
      expect(reads.take(4), everyElement(7));
      expect(reads.skip(4), everyElement(0));
      await tester.pumpWidget(const SizedBox());
      foreground.dispose();
    },
  );
  testWidgets(
    'brief visibility changes retain cache and the original refresh deadline',
    (tester) async {
      final foreground = ValueNotifier(true);
      var reads = 0;
      Future<Map<String, dynamic>> read() async {
        reads++;
        return {
          'status': 'found',
          'number': 12,
          'state': 'Open',
          'url': 'https://github.com/acme/repo/pull/12',
        };
      }

      Widget pane(bool visible) => frame(
        'branch',
        read,
        foreground: foreground,
        now: tester.binding.clock.now,
        visible: visible,
      );
      await tester.pumpWidget(pane(true));
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpWidget(pane(false));
      foreground.value = false;
      await tester.pump(const Duration(seconds: 40));
      foreground.value = true;
      await tester.pumpWidget(pane(true));
      expect(reads, 1);
      expect(find.text('#12 Open'), findsOneWidget);
      await tester.pump(const Duration(seconds: 10));
      expect(reads, 2);
      await tester.pumpWidget(pane(false));
      await tester.pump(const Duration(minutes: 2));
      expect(reads, 2);
      await tester.pumpWidget(pane(true));
      await tester.pump();
      expect(reads, 3);
      await tester.pumpWidget(const SizedBox());
      foreground.dispose();
    },
  );
  testWidgets('background and resume join an outstanding request', (
    tester,
  ) async {
    final foreground = ValueNotifier(true);
    final pending = Completer<Map<String, dynamic>>();
    var reads = 0;
    await tester.pumpWidget(
      frame(
        'branch',
        () {
          reads++;
          return pending.future;
        },
        foreground: foreground,
        now: tester.binding.clock.now,
      ),
    );
    foreground.value = false;
    await tester.pump(const Duration(minutes: 2));
    foreground.value = true;
    await tester.pump();
    expect(reads, 1);
    foreground.value = false;
    pending.complete({'status': 'none'});
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    foreground.value = true;
    await tester.pump();
    expect(reads, 1);
    await tester.pumpWidget(const SizedBox());
    foreground.value = false;
    foreground.value = true;
    await tester.pump(const Duration(minutes: 2));
    expect(reads, 1);
    foreground.dispose();
  });
  testWidgets(
    'a branch changed while hidden reads only when shown and rejects its old reply',
    (tester) async {
      final pending = Completer<Map<String, dynamic>>();
      var oldReads = 0, newReads = 0;
      await tester.pumpWidget(
        frame('old', () {
          oldReads++;
          return pending.future;
        }),
      );
      Future<Map<String, dynamic>> readNew() async {
        newReads++;
        return {'status': 'none'};
      }

      await tester.pumpWidget(frame('new', readNew, visible: false));
      pending.complete({
        'status': 'found',
        'number': 12,
        'state': 'Open',
        'url': 'https://github.com/acme/repo/pull/12',
      });
      await tester.pump(const Duration(minutes: 2));
      expect(oldReads, 1);
      expect(newReads, 0);
      expect(find.text('#12 Open'), findsNothing);
      await tester.pumpWidget(frame('new', readNew));
      await tester.pump();
      expect(newReads, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'moving a retained badge between visibility scopes updates its subscription',
    (tester) async {
      final key = GlobalKey();
      var reads = 0;
      Widget layout(bool left) {
        final badge = PullRequestBadge(
          key: key,
          identity: 'branch',
          now: tester.binding.clock.now,
          read: () async {
            reads++;
            return {'status': 'none'};
          },
        );
        return MaterialApp(
          home: Row(
            children: [
              TickerMode(enabled: true, child: left ? badge : const SizedBox()),
              TickerMode(
                enabled: false,
                child: left ? const SizedBox() : badge,
              ),
            ],
          ),
        );
      }

      await tester.pumpWidget(layout(true));
      expect(reads, 1);
      await tester.pumpWidget(layout(false));
      await tester.pump(const Duration(minutes: 5));
      expect(reads, 1);
      await tester.pumpWidget(layout(true));
      await tester.pump();
      expect(reads, 2);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'replacing the foreground source stops listening to the old source',
    (tester) async {
      final old = ValueNotifier(true), current = ValueNotifier(false);
      var reads = 0;
      Future<Map<String, dynamic>> read() async {
        reads++;
        return {'status': 'none'};
      }

      await tester.pumpWidget(
        frame('branch', read, foreground: old, now: tester.binding.clock.now),
      );
      await tester.pumpWidget(
        frame(
          'branch',
          read,
          foreground: current,
          now: tester.binding.clock.now,
        ),
      );
      old.value = false;
      old.value = true;
      await tester.pump(const Duration(minutes: 2));
      expect(reads, 1);
      current.value = true;
      await tester.pump();
      expect(reads, 2);
      await tester.pumpWidget(const SizedBox());
      old.dispose();
      current.dispose();
    },
  );
  testWidgets('unavailable stays hidden and recovers on the next refresh', (
    tester,
  ) async {
    var calls = 0;
    await tester.pumpWidget(
      frame('branch', () async {
        calls++;
        if (calls == 1) return {'status': 'unavailable'};
        return {
          'status': 'found',
          'number': 12,
          'state': 'Open',
          'url': 'https://github.com/acme/repo/pull/12',
        };
      }),
    );
    await tester.pump();
    expect(find.byType(TextButton), findsNothing);
    await tester.pump(const Duration(seconds: 60));
    await tester.pump();
    expect(find.text('#12 Open'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'late result from a previous branch cannot overwrite current status',
    (tester) async {
      final old = Completer<Map<String, dynamic>>();
      await tester.pumpWidget(frame('old', () => old.future));
      await tester.pumpWidget(frame('new', () async => {'status': 'none'}));
      await tester.pump();
      old.complete({'status': 'unavailable'});
      await tester.pump();
      expect(find.text('PR unavailable'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
