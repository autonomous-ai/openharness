import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/app_theme.dart'
    show AppPalette, AppSurface;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_line.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The name a person sets for the Swarm to show (plan
/// 2026-11-03-person-display-name, Task 6): wherever the phone shows a person
/// it reads `name ?? username`; wherever a tag is typed or matched it keeps
/// `@username`. With no name set, every place reads exactly as before.
void main() {
  // Ken set a name; Dee keeps the username her email makes.
  final ken = {
    ...person('ken', role: 'collaborator'),
    'username': 'kenji',
    'name': 'Minh Nguyen',
  };
  final dee = person('dee', role: 'collaborator');

  group('the model', () {
    SuperTabPerson member(Map<String, dynamic> row) =>
        SuperTabPerson.fromJson(row);

    test('reads the name, and shows it over the username', () {
      final person = member(ken);
      expect(person.name, 'Minh Nguyen');
      expect(person.username, 'kenji');
      expect(person.shownName, 'Minh Nguyen');
    });

    test('without one, shows the username, as today', () {
      final person = member(dee);
      expect(person.name, isNull);
      expect(person.shownName, 'dee');
    });

    test('a name stays with the default username an older server leaves to '
        'the phone', () {
      final [named] = superTabUsernames([
        member({...person('p1'), 'name': 'Minh Nguyen'}),
      ]);
      expect(named.username, 'p1');
      expect(named.name, 'Minh Nguyen');
      expect(named.shownName, 'Minh Nguyen');
    });
  });

  SuperTabSnapshot snapshotOf(List<Map<String, dynamic>> members) {
    final load = firstLoad();
    for (final m in members) {
      (load['members'] as List).add(part(m['id'] as String, 1, m));
    }
    return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(load).state);
  }

  SuperTabMessage byPerson(String id) => SuperTabMessage.fromJson({
    'id': 'm-$id',
    'conversationId': 'g1',
    'text': 'hello',
    'sequence': 1,
    'author': {'kind': 'person', 'id': id, 'name': '$id@example.com'},
    'createdAt': DateTime.utc(2026, 11, 3, 9).toIso8601String(),
  });

  test('a chat author reads by their name; one without, by username', () {
    final snapshot = snapshotOf([ken, dee]);
    expect(snapshot.authorName(byPerson('ken')), 'Minh Nguyen');
    expect(snapshot.authorName(byPerson('dee')), 'dee');
  });

  test('a thread\'s reply line names its people by name, else username', () {
    final thread = SuperTabThread.fromJson({
      'id': 'm1',
      'replies': 2,
      'lastSequence': 3,
      'authors': [
        {'kind': 'person', 'id': 'ken', 'name': 'ken@example.com'},
        {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'},
      ],
      'people': ['ken', 'dee'],
    });
    final faces = swarmThreadFaces(snapshotOf([ken, dee]), thread);
    expect([for (final face in faces) face.name], ['Minh Nguyen', 'dee']);
  });

  group('the chat', () {
    const messages = '/api/super-tabs/$tab/conversations/g1/messages';
    const commands = '/api/super-tabs/$tab/commands';

    FakeSwarm backend(List<Map<String, dynamic>> page) {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            groupData(
              'g1',
              title: 'Fix login',
              agentIds: ['agent-lead', 'agent-builder'],
              status: 'working',
              lastMessageSequence: page.length,
            ),
          ],
        ),
        'members': [
          for (final member in [person(me), ken, dee])
            part(member['id'] as String, 1, member),
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes[messages] = (_) => {
        'messages': page.reversed.toList(),
        'next': null,
        'threads': <Object>[],
      };
      fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
      return fake;
    }

    Map<String, dynamic> said(
      String id,
      int sequence,
      String author,
      String text, {
      List<String> mentions = const [],
    }) => {
      'id': id,
      'conversationId': 'g1',
      'text': text,
      'sequence': sequence,
      'mentions': mentions,
      'author': {'kind': 'person', 'id': author, 'name': '$author@example.com'},
      'attachments': <Object>[],
      'reactions': <Object>[],
      'createdAt': DateTime.utc(2026, 11, 3, 1, sequence).toIso8601String(),
    };

    Future<FakeSwarm> pump(
      WidgetTester tester,
      List<Map<String, dynamic>> page,
    ) async {
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = const Size(393 * 3, 852 * 3);
      addTearDown(tester.view.reset);
      final fake = backend(page);
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      );
      await tester.pumpAndSettle();
      return fake;
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder inside(String k, Finder matching) =>
        find.descendant(of: key(k), matching: matching);

    /// The texts drawn as tag pills inside [k], in order.
    List<String> pills(WidgetTester tester, String k) => [
      for (final rich in tester.widgetList<RichText>(
        inside(k, find.byType(RichText)),
      ))
        ..._pills(rich.text, null),
    ];

    testWidgets('an author shows by their name; one without, by username', (
      tester,
    ) async {
      await pump(tester, [
        said('m1', 1, 'ken', 'on it'),
        said('m2', 2, 'dee', 'thanks'),
      ]);
      expect(inside('swarm-message-m1', find.text('Minh Nguyen')), findsOne);
      expect(inside('swarm-message-m1', find.text('kenji')), findsNothing);
      // The face's initial comes from the name too.
      final face = tester.widget<SwarmChatAvatar>(
        inside('swarm-message-m1', find.byType(SwarmChatAvatar)),
      );
      expect(face.name, 'Minh Nguyen');
      expect(inside('swarm-message-m2', find.text('dee')), findsOne);
    });

    testWidgets('a tag reads as the name it shows, and as the username for '
        'one without; the text keeps @username', (tester) async {
      await pump(tester, [
        said(
          'm1',
          1,
          'dee',
          'ask @kenji and @dee to look',
          mentions: ['ken', 'dee'],
        ),
      ]);
      expect(pills(tester, 'swarm-message-m1'), ['@Minh Nguyen', '@dee']);
    });

    testWidgets('@ suggests a named person by their name with @username '
        'beside it, found by either, and puts in @username', (tester) async {
      final fake = await pump(tester, [said('m1', 1, 'dee', 'hi')]);
      final field = find.descendant(
        of: key('swarm-field'),
        matching: find.byType(TextField),
      );
      Future<void> type(String text) async {
        await tester.enterText(field, text);
        await tester.pump();
      }

      await type('@');
      expect(
        inside('swarm-pick-person-ken', find.text('Minh Nguyen')),
        findsOne,
      );
      expect(inside('swarm-pick-person-ken', find.text('@kenji')), findsOne);
      // One without a name reads as today: the username alone.
      expect(inside('swarm-pick-person-dee', find.text('dee')), findsOne);
      expect(inside('swarm-pick-person-dee', find.text('@dee')), findsNothing);

      // By the name, any case, and by the username.
      await type('ask @MINH');
      expect(key('swarm-pick-person-ken'), findsOneWidget);
      expect(key('swarm-pick-person-dee'), findsNothing);
      await type('ask @nguy');
      expect(key('swarm-pick-person-ken'), findsOneWidget);
      await type('ask @kenj');
      expect(key('swarm-pick-person-ken'), findsOneWidget);
      expect(key('swarm-pick-person-dee'), findsNothing);

      await type('ask @minh');
      await tester.tap(key('swarm-pick-person-ken'));
      await tester.pump();
      expect(tester.widget<TextField>(field).controller!.text, 'ask @kenji ');

      await type('ask @kenji to look');
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['text'], 'ask @kenji to look');
      expect(fake.commands.single['mentions'], ['ken']);
    });
  });

  group('You shows the name a person set, and nothing sets one', () {
    late FakeSwarm swarm;
    late SwarmHost host;

    Future<void> pump(WidgetTester tester, {String? name}) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      swarm = FakeSwarm();
      final mine = {
        ...person(me),
        'email': 'tony@example.com',
        'username': 'tony',
        'name': ?name,
      };
      swarm.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(),
        'members': [part(me, 1, mine), part('dee', 1, dee)],
      };
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {'ok': true};
      final account = ValueNotifier<String?>(me);
      host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: swarm.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmYouPage(),
        ),
      );
      unawaited(host.session!.inbox.refresh());
      await tester.pumpAndSettle();
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder inside(String k, Finder matching) =>
        find.descendant(of: key(k), matching: matching);

    testWidgets('with a name: You heads with it, once, and no field offers to '
        'change it', (tester) async {
      await pump(tester, name: 'Minh Nguyen');
      expect(inside('swarm-you-me', find.text('Minh Nguyen')), findsOne);
      expect(find.text('Minh Nguyen'), findsOne, reason: 'no row repeats it');
      expect(find.text('tony'), findsNothing);
      await tester.tap(key('swarm-you-me'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(key('swarm-name-field'), findsNothing);
      expect(key('swarm-username-field'), findsNothing);
      expect(
        swarm.commands.where((c) => '${c['type']}'.startsWith('member.')),
        isEmpty,
        reason: 'nothing is sent',
      );
    });

    testWidgets('with none: You heads with the username, as today', (
      tester,
    ) async {
      await pump(tester);
      expect(inside('swarm-you-me', find.text('tony')), findsOne);
      expect(find.text('tony'), findsOne, reason: 'no row repeats it');
    });
  });
}

Iterable<String> _pills(InlineSpan span, TextStyle? inherited) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text case final text?
      when style?.backgroundColor == AppSurface.accentWash &&
          style?.color == AppPalette.accentOnSurface) {
    yield text;
  }
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _pills(child, style);
  }
}
