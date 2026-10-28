import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/morning_card.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// The stand-up card every morning and the shipped-together recap every Monday
/// (v2 J), as the backend posts them with the morning digest (backend
/// superTabs/morning.ts): a card in the project chat, pinned at its top on the
/// day it was posted until dismissed.
void main() {
  final captureDir = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  const hour = 3600000;
  setUpAll(() => loadCaptureFonts(captureDir));

  Map<String, dynamic> standup = {
    'kind': 'standup',
    'projectId': 'lead',
    'on': '2026-10-27',
    'card': {
      'kind': 'standup',
      'on': '2026-10-27',
      'shipped': [
        {
          'number': 1,
          'title': 'Night shift',
          'pullRequestUrl': 'https://github.com/example/lampos/pull/12',
          'askedBy': 'dee',
          'builtBy': 'nico',
          'reviewedBy': ['rae'],
        },
        {
          'number': 10,
          'title': 'Release notes',
          'pullRequestUrl': null,
          'askedBy': null,
          'builtBy': 'bo',
          'reviewedBy': <String>[],
        },
      ],
      'inProgress': [
        {
          'number': 3,
          'title': 'Lexer',
          'status': 'working',
          'agentId': 'ana',
          'note': null,
        },
        {
          'number': 4,
          'title': 'Docs',
          'status': 'review',
          'agentId': 'bo',
          'note': null,
        },
      ],
      'blocked': [
        {
          'number': 5,
          'title': 'Deploy',
          'status': 'blocked',
          'agentId': 'cy',
          'note': 'No access to staging.',
        },
      ],
      'waiting': [
        {
          'number': 7,
          'title': 'Pricing',
          'status': 'needs_human',
          'agentId': 'ed',
          'note': 'Which plan do we launch with?',
          'personId': 'dee',
        },
      ],
    },
  };
  Map<String, dynamic> recap = {
    'kind': 'recap',
    'projectId': 'lead',
    'on': '2026-11-02',
    'card': {
      'kind': 'recap',
      'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
      'shipped': (standup['card'] as Map)['shipped'],
      'askToShipMs': {'lastWeek': 4 * hour, 'weekBefore': 10 * hour},
      'top': [
        {'personId': 'dee', 'medal': 'gold', 'points': 3},
        {'personId': 'owner', 'medal': 'silver', 'points': 1},
      ],
      'thanks': {
        'personIds': ['dee', 'owner'],
        'agentIds': ['nico', 'rae', 'bo'],
      },
    },
  };
  const agents = {
    'nico': 'Nico',
    'rae': 'Rae',
    'bo': 'Bo',
    'ana': 'Ana',
    'cy': 'Cy',
    'ed': 'Ed',
  };
  String person(String id) => id == 'dee' ? 'dee' : 'owner';
  String agent(String id) => agents[id]!;

  SuperTabMessage message(Map<String, dynamic> source, {String? at}) =>
      SuperTabMessage.fromJson({
        'id': 'card-${source['kind']}',
        'conversationId': 'lead',
        'sequence': 1,
        'text': 'Stand-up',
        'createdAt': at ?? '2026-10-27T01:00:00Z',
        'author': {'kind': 'agent', 'id': 'lead', 'name': 'Lead'},
        'source': source,
      });

  Future<void> card(WidgetTester tester, Map<String, dynamic> source) async {
    await tester.binding.setSurfaceSize(const Size(560, 560));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: SuperTabMorningCard(
              message: message(source),
              personName: person,
              agentName: agent,
              onDismiss: () {},
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('the stand-up lists what shipped with who asked, built and '
      'reviewed it, and what is moving, blocked and waiting on people', (
    tester,
  ) async {
    await card(tester, standup);
    expect(find.text('Stand-up · Tuesday 27 October'), findsOneWidget);
    expect(find.text('Shipped'), findsOneWidget);
    expect(find.text('#1 Night shift'), findsOneWidget);
    expect(
      find.text('asked by dee · built by Nico · reviewed by Rae'),
      findsOneWidget,
    );
    // Nobody named as asking: the line leaves it out rather than guess.
    expect(find.text('built by Bo'), findsOneWidget);
    expect(find.text('In progress'), findsOneWidget);
    expect(find.text('#3 Lexer'), findsOneWidget);
    expect(find.text('Ana · working'), findsOneWidget);
    expect(find.text('Bo · ready for review'), findsOneWidget);
    expect(find.text('Blocked'), findsOneWidget);
    expect(find.text('Cy · stuck: No access to staging.'), findsOneWidget);
    expect(find.text('Waiting on people'), findsOneWidget);
    expect(
      find.text('Ed waits for dee: Which plan do we launch with?'),
      findsOneWidget,
    );
    await captureWindow(tester, captureDir, 'standup-card');
  });

  testWidgets('a quiet day says so instead of showing empty parts', (
    tester,
  ) async {
    await card(tester, {
      ...standup,
      'card': {
        'kind': 'standup',
        'on': '2026-10-27',
        'shipped': <dynamic>[],
        'inProgress': <dynamic>[],
        'blocked': <dynamic>[],
        'waiting': <dynamic>[],
      },
    });
    expect(
      find.text('A quiet night: nothing shipped, moving or blocked.'),
      findsOneWidget,
    );
    expect(find.text('Shipped'), findsNothing);
  });

  testWidgets('the recap sums the week: what shipped, ask-to-shipped against '
      'the week before, medals and a thank-you naming everyone', (
    tester,
  ) async {
    await card(tester, recap);
    expect(find.text('Shipped together · week of 26 October'), findsOneWidget);
    expect(find.text('2 shipped'), findsOneWidget);
    expect(find.text('#1 Night shift'), findsOneWidget);
    expect(
      find.text('Ask to shipped: 4 h, from 10 h the week before'),
      findsOneWidget,
    );
    expect(find.text('🏆 dee · 3 points'), findsOneWidget);
    expect(find.text('🥈 owner · 1 point'), findsOneWidget);
    expect(
      find.text('Thank you, dee, owner, Nico, Rae and Bo!'),
      findsOneWidget,
    );
    await captureWindow(tester, captureDir, 'recap-card');
  });

  group('in the project chat', () {
    Future<void> show(
      WidgetTester tester,
      ConversationServer server, {
      Map<String, dynamic>? initial,
    }) async {
      await tester.binding.setSurfaceSize(const Size(1100, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = server.controller(
        account: 'owner',
        initial:
            initial ??
            {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    void post(
      ConversationServer server,
      Map<String, dynamic> source,
      DateTime at,
    ) {
      server.append('Stand-up for ${source['on']}.');
      server.messages.last
        ..['id'] = 'card-${source['kind']}-${source['on']}'
        ..['author'] = {'kind': 'agent', 'id': 'lead', 'name': 'Lead'}
        ..['source'] = source
        ..['createdAt'] = at.toUtc().toIso8601String();
    }

    final pinned = find.byKey(const ValueKey('super-pinned-cards'));

    testWidgets('today\'s card sits at the top until dismissed, and stays in '
        'the transcript', (tester) async {
      final server = ConversationServer();
      (server.state['agents'] as List).addAll([
        for (final MapEntry(:key, :value) in agents.entries)
          {
            'id': key,
            'name': 'Builder',
            'displayName': value,
            'machineId': 'm',
            'harnessId': 'native-$key',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
          },
      ]);
      (server.state['people'] as List).add({
        'id': 'dee',
        'email': 'dee@example.com',
        'role': 'collaborator',
      });
      post(server, standup, DateTime.now());
      await show(tester, server);
      expect(
        find.descendant(of: pinned, matching: find.text('#1 Night shift')),
        findsOneWidget,
      );
      // Pinned, the transcript keeps only its one line, so it is never shown twice.
      expect(find.text('#1 Night shift'), findsOneWidget);
      expect(find.text('Stand-up for 2026-10-27.'), findsOneWidget);
      await captureWindow(tester, captureDir, 'standup-pinned');
      await tester.tap(
        find.descendant(
          of: pinned,
          matching: find.byKey(const ValueKey('super-card-dismiss')),
        ),
      );
      await tester.pumpAndSettle();
      expect(pinned, findsNothing);
      expect(find.text('#1 Night shift'), findsOneWidget);
      expect(find.text('Stand-up for 2026-10-27.'), findsNothing);
    });

    testWidgets('a dismissed card stays dismissed after a restart that day, '
        'and the next day\'s card is pinned again', (tester) async {
      final server = ConversationServer();
      post(server, standup, DateTime.now());
      await show(tester, server);
      await tester.tap(
        find.descendant(
          of: pinned,
          matching: find.byKey(const ValueKey('super-card-dismiss')),
        ),
      );
      // The tab's local state is saved shortly after a change.
      await tester.pump(const Duration(milliseconds: 300));
      final saved = Map<String, dynamic>.of(server.saved!);

      // Closed and opened again the same day: still dismissed.
      await tester.pumpWidget(const SizedBox());
      await show(tester, server, initial: saved);
      expect(pinned, findsNothing);
      expect(find.text('#1 Night shift'), findsOneWidget);

      // A dismissal kept from an earlier day is not today's.
      await tester.pumpWidget(const SizedBox());
      final yesterday = DateTime.now().subtract(const Duration(days: 1));
      await show(
        tester,
        server,
        initial: {
          ...saved,
          'dismissedCards': {
            ...(saved['dismissedCards'] as Map),
            'on': DateUtils.dateOnly(yesterday)
                .toIso8601String()
                .substring(0, 10),
          },
        },
      );
      expect(pinned, findsOneWidget);

      // The next day's card is a card of its own, pinned until dismissed.
      await tester.pumpWidget(const SizedBox());
      post(server, {...standup, 'on': '2026-10-28'}, DateTime.now());
      await show(tester, server, initial: saved);
      expect(
        find.descendant(
          of: pinned,
          matching: find.text('Stand-up for 2026-10-28.'),
        ),
        findsNothing,
      );
      expect(
        find.descendant(of: pinned, matching: find.text('#1 Night shift')),
        findsOneWidget,
      );
    });

    testWidgets('an earlier day\'s card is only in the transcript', (
      tester,
    ) async {
      final server = ConversationServer();
      post(server, standup, DateTime.now().subtract(const Duration(days: 1)));
      await show(tester, server);
      expect(pinned, findsNothing);
      expect(find.text('#1 Night shift'), findsOneWidget);
    });
  });
}
