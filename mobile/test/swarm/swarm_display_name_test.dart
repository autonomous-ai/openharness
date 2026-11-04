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
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
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

  group('You and the Name editor', () {
    late FakeSwarm swarm;
    late Map<String, dynamic> mine;
    late SwarmHost host;

    /// What the next command answers instead of the server's rules, once.
    FutureOr<Object?> Function()? answer;

    // The backend's rules (backend/src/superTabs/personNames.ts), in short.
    Object? setName(Map<String, dynamic> command) {
      final input = command['name'] as String?;
      if (input == null) {
        mine = {...mine}..remove('name');
        return {'ok': true};
      }
      final name = input.replaceAll(RegExp(r'\s+'), ' ').trim();
      if (name.isEmpty || name.runes.length > 40) {
        throw const SuperTabFailure(
          'INVALID_NAME',
          'Use 1 to 40 characters, with no hidden ones.',
          statusCode: 400,
        );
      }
      if (name.toLowerCase() == 'dee') {
        throw const SuperTabFailure(
          'NAME_TAKEN',
          'Someone here already goes by that name.',
          statusCode: 409,
        );
      }
      mine = {...mine, 'name': name};
      return {'ok': true};
    }

    Future<void> pump(WidgetTester tester, {String? name}) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      answer = null;
      swarm = FakeSwarm();
      mine = {
        ...person(me),
        'email': 'tony@example.com',
        'username': 'tony',
        'name': ?name,
      };
      var version = 1;
      swarm.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(),
        'members': [part(me, version, mine), part('dee', 1, dee)],
      };
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c${++version}'),
        'members': [part(me, version, mine)],
      };
      swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
        final command = body!['command'] as Map<String, dynamic>;
        if (answer case final once?) {
          answer = null;
          return once();
        }
        return switch (command['type']) {
          'member.name' => setName(command),
          _ => {'ok': true},
        };
      };
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
    TextField field(WidgetTester tester) =>
        tester.widget<TextField>(key('swarm-name-field'));
    bool saveOn(WidgetTester tester) =>
        tester.widget<SwarmButton>(key('swarm-name-save')).onPressed != null;
    String? shownError() => key('swarm-name-error').evaluate().isEmpty
        ? null
        : (key('swarm-name-error').evaluate().single.widget as Text).data;
    SuperTabPerson? stored() =>
        host.session!.inbox.reader(tab)!.snapshot!.person(me);
    List<Map<String, dynamic>> named() => [
      for (final c in swarm.commands)
        if (c['type'] == 'member.name') c,
    ];

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    Future<void> openProfile(WidgetTester tester) async {
      await tester.tap(key('swarm-you-profile'));
      await tester.pumpAndSettle();
      expect(key('swarm-name-field'), findsOneWidget);
    }

    Future<void> type(WidgetTester tester, String text) async {
      await tester.enterText(key('swarm-name-field'), text);
      await tester.pump();
    }

    Future<void> save(WidgetTester tester) async {
      await tester.ensureVisible(key('swarm-name-save'));
      await tester.tap(key('swarm-name-save'));
      await settle(tester);
    }

    testWidgets('with a name: You heads with it, the Profile row above '
        'Username shows it with Change, and Username keeps the handle', (
      tester,
    ) async {
      await pump(tester, name: 'Minh Nguyen');
      expect(inside('swarm-you-me', find.text('Minh Nguyen')), findsOne);
      expect(inside('swarm-you-profile', find.text('Minh Nguyen')), findsOne);
      expect(inside('swarm-you-profile', find.text('Change')), findsOne);
      expect(inside('swarm-you-username', find.text('tony')), findsOne);
      expect(
        tester.getTopLeft(key('swarm-you-profile')).dy,
        lessThan(tester.getTopLeft(key('swarm-you-username')).dy),
      );
    });

    testWidgets('with none: You heads with the username, as today', (
      tester,
    ) async {
      await pump(tester);
      expect(inside('swarm-you-me', find.text('tony')), findsOne);
      expect(inside('swarm-you-username', find.text('tony')), findsOne);
      expect(inside('swarm-you-profile', find.text('Change')), findsOne);
    });

    testWidgets('the Name field sits above Username, and a name saves '
        'trimmed and shows at once', (tester) async {
      await pump(tester);
      await openProfile(tester);
      expect(field(tester).controller!.text, '');
      expect(
        tester.getTopLeft(key('swarm-name-field')).dy,
        lessThan(tester.getTopLeft(key('swarm-username-field')).dy),
      );
      expect(find.text('Leave empty to show your username.'), findsOne);
      // Nothing changed, nothing to save.
      expect(saveOn(tester), isFalse);

      await type(tester, '  Minh Nguyen ');
      expect(saveOn(tester), isTrue);
      await save(tester);

      expect(named(), [
        {'type': 'member.name', 'name': 'Minh Nguyen'},
      ]);
      expect(shownError(), isNull);
      expect(field(tester).controller!.text, 'Minh Nguyen');
      expect(stored()!.name, 'Minh Nguyen');
      await tester.tap(key('swarm-profile-close'));
      await tester.pumpAndSettle();
      expect(inside('swarm-you-me', find.text('Minh Nguyen')), findsOne);
      expect(inside('swarm-you-profile', find.text('Minh Nguyen')), findsOne);
    });

    testWidgets('an emptied field clears it with null, and the username '
        'shows again', (tester) async {
      await pump(tester, name: 'Minh Nguyen');
      await openProfile(tester);
      expect(field(tester).controller!.text, 'Minh Nguyen');

      await type(tester, '   ');
      expect(saveOn(tester), isTrue);
      await save(tester);

      expect(named(), [
        {'type': 'member.name', 'name': null},
      ]);
      expect(shownError(), isNull);
      expect(stored()!.name, isNull);
      await tester.tap(key('swarm-profile-close'));
      await tester.pumpAndSettle();
      expect(inside('swarm-you-me', find.text('tony')), findsOne);
    });

    testWidgets('a name the server refuses says why under its field, and '
        'nothing changes', (tester) async {
      await pump(tester, name: 'Minh Nguyen');
      await openProfile(tester);
      await type(tester, 'Dee');
      await save(tester);

      expect(shownError(), 'Someone here already goes by that name.');
      expect(key('swarm-profile-error'), findsNothing);
      expect(key('swarm-username-error'), findsNothing);
      expect(field(tester).controller!.text, 'Dee');
      expect(stored()!.name, 'Minh Nguyen');
      // Typing again clears it.
      await type(tester, 'Minh');
      expect(shownError(), isNull);
    });

    testWidgets('a call lost on the way says so and never stays Saving', (
      tester,
    ) async {
      await pump(tester);
      await openProfile(tester);
      answer = () => throw TimeoutException('no answer');
      await type(tester, 'Minh');
      await save(tester);
      expect(shownError(), 'Could not reach this Swarm. Try again.');
      expect(find.text('Saving…'), findsNothing);
      expect(saveOn(tester), isTrue);
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
