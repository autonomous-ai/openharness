import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart' show CurrentUserProfile;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_link_host.dart';

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

    test('a Swarm the account does not list is neither loaded nor loading', () {
      final app = appInSwarm();
      final swarms = AppLinkSwarms(app);
      final source = swarms.controllerFor('someone-elses', () {});
      expect(source.controller, isNull);
      expect(source.loading, isFalse);
    });
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
