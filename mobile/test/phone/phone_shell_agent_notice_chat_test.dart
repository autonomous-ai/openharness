import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';

import '../swarm/swarm_fixture.dart';
import 'devices_fixture.dart';

class NoticeApp extends DevicesApp {
  NoticeApp({super.systemNotices});
  final fake = FakeSwarm();
  @override
  void handleAppResumed() {}
  @override
  Future<Object?> swarmRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) => fake.request(method, path, body: body);
}

void main() {
  late NoticeApp app;
  setUp(() {
    app = NoticeApp()
      ..currentUser = const CurrentUserProfile(id: me, email: 'me@example.com');
    app.fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm'},
      ],
      'next': null,
    };
  });
  tearDown(() {
    experimentalFeaturesStore.value = const {};
    app.dispose();
  });

  for (final destination in ['terminal', 'home', 'page', 'back']) {
    testWidgets(
      'explicit $destination navigation wins over a pending agent notice',
      (tester) async {
        final read = Completer<Object?>();
        app.fake.routes['/api/super-tabs/list'] = (_) => read.future;
        app.fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
          groups: [
            groupData('g1', status: 'working', agentIds: ['agent-builder']),
          ],
        );
        experimentalFeaturesStore.value = {PhoneExperiment.swarm};
        await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
        await tester.pump();
        if (destination == 'back') {
          PhoneShellScope.maybeOf(tester.element(find.byType(SwarmPage)))!
              .onOpenAgent('mac-1', 'harness-agent-builder');
          await tester.pump();
        }
        app.agentNotices.system.opened.value = (
          machineId: 'mac-1',
          agentId: 'harness-agent-builder',
        );
        await tester.pump();
        final context = tester.element(
          find.byType(SwarmPage, skipOffstage: false),
        );
        final shell = PhoneShellScope.maybeOf(context)!;
        if (destination == 'terminal') {
          shell.onOpenAgent('mac-1', 'harness-agent-builder');
        } else if (destination == 'home') {
          shell.onShowSwarm!();
        } else if (destination == 'back') {
          await tester.binding.handlePopRoute();
        } else {
          unawaited(
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const Text('Explicit page'),
              ),
            ),
          );
        }
        await tester.pump();
        read.complete({
          'tabs': [
            {'id': tab, 'name': 'Phone Swarm'},
          ],
          'next': null,
        });
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(find.byType(SwarmConversationPage), findsNothing);
        if (destination == 'terminal') {
          expect(find.byType(AgentHome), findsOneWidget);
        }
        if (destination == 'home' || destination == 'back') {
          expect(find.byType(SwarmPage), findsOneWidget);
        }
        if (destination == 'page') {
          expect(find.text('Explicit page'), findsOneWidget);
        }
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'cold start reads the OS tap without posting or asking permission',
    (tester) async {
      app.dispose();
      final plugin = LaunchPlugin();
      app = NoticeApp(systemNotices: LocalSystemNotices(plugin))
        ..currentUser = const CurrentUserProfile(
          id: me,
          email: 'me@example.com',
        );
      app.fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm'},
        ],
        'next': null,
      };
      app.fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      experimentalFeaturesStore.value = {PhoneExperiment.swarm};
      await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(SwarmConversationPage), findsOneWidget);
      expect(plugin.readLaunch, isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final on in [true, false]) {
    for (final kind in NoticeKind.values) {
      testWidgets('OS ${kind.name} tap from background Swarm=$on', (
        tester,
      ) async {
        app.dispose();
        final plugin = LaunchPlugin()..launchPayload = null;
        final notices = LocalSystemNotices(plugin);
        app = NoticeApp(systemNotices: notices)
          ..currentUser = const CurrentUserProfile(
            id: me,
            email: 'me@example.com',
          );
        app.fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': tab, 'name': 'Phone Swarm'},
          ],
          'next': null,
        };
        app.fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
        experimentalFeaturesStore.value = on ? {PhoneExperiment.swarm} : {};
        await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        for (final state in [
          AppLifecycleState.inactive,
          AppLifecycleState.hidden,
          AppLifecycleState.paused,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        await notices.show((
          agent: (machineId: 'mac-1', agentId: 'harness-agent-builder'),
          kind: kind,
          title: 'Nova',
          machine: 'Mac',
          body: 'News',
        ));
        plugin.onResponse!(
          NotificationResponse(
            notificationResponseType:
                NotificationResponseType.selectedNotification,
            payload: plugin.shownPayload,
          ),
        );
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(
          find.byType(SwarmConversationPage),
          on ? findsOneWidget : findsNothing,
        );
        expect(find.byType(AgentHome), on ? findsNothing : findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      });
    }
  }

  for (final on in [true, false]) {
    for (final cold in [true, false]) {
      for (final assigned in [true, false]) {
        testWidgets('agent notice Swarm=$on cold=$cold assigned=$assigned', (
          tester,
        ) async {
          experimentalFeaturesStore.value = on ? {PhoneExperiment.swarm} : {};
          app.fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
            groups: [
              if (assigned)
                groupData(
                  'g1',
                  status: 'working',
                  workerId: 'agent-builder',
                  agentIds: ['agent-builder'],
                ),
            ],
          );
          void tap() => app.agentNotices.system.opened.value = (
            machineId: 'mac-1',
            agentId: 'harness-agent-builder',
          );
          if (cold) tap();
          await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
          for (var i = 0; i < 10; i++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          if (!cold) {
            tap();
            for (var i = 0; i < 10; i++) {
              await tester.pump(const Duration(milliseconds: 100));
            }
          }
          if (on) {
            final page = tester.widget<SwarmConversationPage>(
              find.byType(SwarmConversationPage),
            );
            expect(page.conversationId, assigned ? 'g1' : leadChat);
            expect(find.byType(AgentHome), findsNothing);
          } else {
            expect(find.byType(AgentHome), findsOneWidget);
            expect(find.byType(SwarmConversationPage), findsNothing);
          }
          expect(app.agentNotices.system.opened.value, isNull);
          await tester.pumpWidget(const SizedBox());
        });
      }
    }
  }
}

class LaunchPlugin implements FlutterLocalNotificationsPlugin {
  bool readLaunch = false;
  String? launchPayload = 'swarm:tab-1/group-lead';
  String? shownPayload;
  DidReceiveNotificationResponseCallback? onResponse;
  @override
  Future<bool?> initialize({
    required InitializationSettings settings,
    DidReceiveNotificationResponseCallback? onDidReceiveNotificationResponse,
    DidReceiveBackgroundNotificationResponseCallback?
    onDidReceiveBackgroundNotificationResponse,
  }) async {
    onResponse = onDidReceiveNotificationResponse;
    return true;
  }

  @override
  Future<NotificationAppLaunchDetails?>
  getNotificationAppLaunchDetails() async {
    readLaunch = true;
    return NotificationAppLaunchDetails(
      launchPayload != null,
      notificationResponse: NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: launchPayload,
      ),
    );
  }

  @override
  Future<void> show({
    required int id,
    String? title,
    String? body,
    NotificationDetails? notificationDetails,
    String? payload,
  }) async {
    shownPayload = payload;
  }

  @override
  T? resolvePlatformSpecificImplementation<
    T extends FlutterLocalNotificationsPlatform
  >() => null;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
