import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart' show CurrentUserProfile;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_link_host.dart';
import 'package:harness/super_tabs/message_link_swarms.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  const link = SwarmMessageLink(
    tabId: 'tab',
    conversationId: 'lead',
    messageId: 'message-1',
  );

  AppNotifier appInSwarm({String? tabId = 'tab'}) {
    final app = createApp();
    addTearDown(app.dispose);
    if (tabId != null) app.bindSuperTab(app.activeSwarmId, tabId, 'Pilot');
    return app;
  }

  group('openSwarmMessageLink', () {
    test(
      'opens the Swarm the account lists, and asks it for the message',
      () async {
        final app = appInSwarm();
        app.newSwarm();
        expect(app.activeSwarm.superTabId, isNull);
        final controller = ConversationServer().controller();
        addTearDown(controller.dispose);
        String? asked;
        final opened = await openSwarmMessageLink(
          app,
          link,
          controllerFor: (id) async {
            asked = id;
            return controller;
          },
        );
        expect(opened, isTrue);
        expect(asked, 'tab');
        expect(app.activeSwarm.superTabId, 'tab');
        expect(controller.messageRequest, (
          conversationId: 'lead',
          messageId: 'message-1',
        ));
      },
    );

    test('a Swarm the account does not list is never opened or read', () async {
      final app = appInSwarm();
      var read = false;
      final opened = await openSwarmMessageLink(
        app,
        const SwarmMessageLink(
          tabId: 'someone-elses',
          conversationId: 'lead',
          messageId: 'message-1',
        ),
        controllerFor: (_) async {
          read = true;
          throw StateError('must not be read');
        },
      );
      expect(opened, isFalse);
      expect(read, isFalse);
      expect(app.swarms.any((s) => s.superTabId == 'someone-elses'), isFalse);
    });

    test(
      'a Swarm that cannot be read now is unavailable, not an error',
      () async {
        final app = appInSwarm();
        expect(
          await openSwarmMessageLink(
            app,
            link,
            controllerFor: (_) async => throw StateError('offline'),
          ),
          isFalse,
        );
      },
    );
  });

  group('AppLinkSwarms', () {
    test('lists the Swarms the account has, and no others', () {
      final app = appInSwarm();
      expect(swarmListed(app, 'tab'), isTrue);
      expect(swarmListed(app, 'someone-elses'), isFalse);
    });

    Map<String, dynamic> row({String author = 'other'}) => {
      'messages': [
        {
          'id': 'message-1',
          'conversationId': 'lead',
          'sequence': 1,
          'text': 'Closed note',
          'attachments': <dynamic>[],
          'createdAt': '2026-10-18T00:00:00Z',
          'author': {
            'kind': 'person',
            'id': author,
            'name': 'dee.tran@example.com',
          },
          'deliveries': <dynamic>[],
        },
      ],
    };

    AppNotifier signedIn() => appInSwarm()
      ..currentUser = const CurrentUserProfile(id: 'me', email: 'me@x.test');

    test('a Swarm the account does not list is unavailable, and not asked', () {
      final paths = <String>[];
      final swarms = AppLinkSwarms(
        signedIn(),
        get: (path) async {
          paths.add(path);
          return row();
        },
      );
      final target = swarms.read(
        const SwarmMessageLink(
          tabId: 'someone-elses',
          conversationId: 'lead',
          messageId: 'message-1',
        ),
        () {},
      );
      expect(target.isUnavailable, isTrue);
      expect(paths, isEmpty);
    });

    test(
      'a Swarm not loaded is read as that one message, and none is opened',
      () async {
        final app = signedIn();
        final paths = <String>[];
        var told = 0;
        final swarms = AppLinkSwarms(
          app,
          get: (path) async {
            paths.add(path);
            return row();
          },
        );
        expect(swarms.read(link, () => told++).isLoading, isTrue);
        await Future<void>.delayed(Duration.zero);
        final target = swarms.read(link, () => told++);
        expect(target.message?.text, 'Closed note');
        expect(target.author, 'dee.tran');
        expect(told, 1);
        expect(paths, [
          '/api/super-tabs/tab/conversations/lead/messages?messageId=message-1',
        ]);
        // Nothing was opened for the preview, so nothing polls or badges.
        expect(app.superTabs.loadedControllers, isEmpty);
        expect(app.superTabs.peek('tab'), isNull);
      },
    );

    test('your own message reads You', () async {
      final swarms = AppLinkSwarms(
        signedIn(),
        get: (_) async => row(author: 'me'),
      );
      swarms.read(link, () {});
      await Future<void>.delayed(Duration.zero);
      expect(swarms.read(link, () {}).author, 'You');
    });

    test(
      'a refused read is unavailable, asked again only after a minute',
      () async {
        var asked = 0;
        var now = DateTime(2026, 10, 29, 9);
        final swarms = AppLinkSwarms(
          signedIn(),
          get: (_) async {
            asked++;
            throw const SuperTabFailure('FORBIDDEN', 'No.', statusCode: 403);
          },
        );
        await withClock(Clock(() => now), () async {
          swarms.read(link, () {});
          await Future<void>.delayed(Duration.zero);
          expect(swarms.read(link, () {}).isUnavailable, isTrue);
          expect(asked, 1);
          now = now.add(const Duration(seconds: 30));
          swarms.read(link, () {});
          expect(asked, 1);
          now = now.add(const Duration(minutes: 1));
          swarms.read(link, () {});
          await Future<void>.delayed(Duration.zero);
          expect(asked, 2);
        });
      },
    );

    test(
      'a message from another conversation is not taken as the link’s',
      () async {
        final swarms = AppLinkSwarms(
          signedIn(),
          get: (_) async {
            final answer = row();
            ((answer['messages'] as List).single as Map)['conversationId'] =
                'elsewhere';
            return answer;
          },
        );
        swarms.read(link, () {});
        await Future<void>.delayed(Duration.zero);
        expect(swarms.read(link, () {}).isUnavailable, isTrue);
      },
    );
  });

  group('SwarmMessageLinkHost', () {
    tearDown(() {
      for (final pending in swarmMessageLinkInbox.pending) {
        swarmMessageLinkInbox.complete(pending);
      }
    });

    Future<AppNotifier> mount(
      WidgetTester tester,
      Future<bool> Function(AppNotifier, SwarmMessageLink) open,
    ) async {
      final app = appInSwarm()
        ..status = AppStatus.authenticated
        ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@x.test');
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmMessageLinkHost(
            app: app,
            open: open,
            child: const Scaffold(body: Text('workspace')),
          ),
        ),
      );
      return app;
    }

    testWidgets('opens a queued link once signed in, then forgets it', (
      tester,
    ) async {
      final opened = <String>[];
      await mount(tester, (app, link) async {
        opened.add(link.url);
        return true;
      });
      await swarmMessageLinkInbox.accept(link.url);
      await tester.pumpAndSettle();
      expect(opened, [link.url]);
      expect(swarmMessageLinkInbox.pending, isEmpty);
      expect(find.text('Message unavailable'), findsNothing);
    });

    testWidgets('a link that cannot be opened says only Message unavailable', (
      tester,
    ) async {
      await mount(tester, (app, link) async => false);
      await swarmMessageLinkInbox.accept(link.url);
      await tester.pumpAndSettle();
      expect(find.text('Message unavailable'), findsOneWidget);
      expect(swarmMessageLinkInbox.pending, isEmpty);
    });

    testWidgets('waits while signed out', (tester) async {
      var opened = false;
      final app = await mount(tester, (app, link) async {
        opened = true;
        return true;
      });
      app.status = AppStatus.unauthenticated;
      await swarmMessageLinkInbox.accept(link.url);
      await tester.pumpAndSettle();
      expect(opened, isFalse);
      expect(swarmMessageLinkInbox.pending, hasLength(1));
    });
  });
}
