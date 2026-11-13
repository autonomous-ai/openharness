import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';

import 'devices_fixture.dart';

/// A tapped agent notice is the shell's to open: it takes the tap and puts the agent on the home
/// screen, whatever kind of notice it was.
void main() {
  for (final kind in NoticeKind.values) {
    testWidgets('a ${kind.name} notice tapped is taken, and Home shows', (
      tester,
    ) async {
      final plugin = _Plugin();
      final notices = LocalSystemNotices(plugin);
      final app = DevicesApp(systemNotices: notices)
        ..currentUser = const CurrentUserProfile(
          id: 'person-me',
          email: 'me@example.com',
        );
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
      await tester.pump();

      await notices.show((
        agent: (machineId: 'mac-1', agentId: 'builder'),
        kind: kind,
        title: 'Nova',
        machine: 'Mac',
        body: 'News',
        quiet: false,
      ));
      plugin.onResponse!(
        NotificationResponse(
          notificationResponseType:
              NotificationResponseType.selectedNotification,
          payload: plugin.shownPayload,
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(notices.opened.value, isNull, reason: 'the shell took the tap');
      expect(find.byType(AgentHome), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  }
}

class _Plugin implements FlutterLocalNotificationsPlugin {
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
  getNotificationAppLaunchDetails() async => null;

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
