import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/done_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

/// Which notices the phone puts in the system's notification centre (task #3607, Tony 2026-11-06):
/// the real [LocalSystemNotices] and the platform's own centre, on an iOS simulator or an Android
/// emulator, fed what the machine socket would tell.
///
/// Rings: an agent's question. Never: an agent's finished turn.
///
/// Nothing reaches an account, a machine or a backend. The app must be allowed to notify first:
/// Android `pm grant <package> android.permission.POST_NOTIFICATIONS`; on iOS, allowed once by
/// the system prompt once, which the same simulator keeps between installs.
///
///     flutter test -d <simulator or emulator id> integration_test/phone_notification_rules_test.dart
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<List<String>> titles(FlutterLocalNotificationsPlugin plugin) async => [
    for (final n in await plugin.getActiveNotifications()) ?n.title,
  ];

  test('rings for a question, not for a finished turn', () async {
    final plugin = FlutterLocalNotificationsPlugin();
    final notices = LocalSystemNotices(plugin);
    unawaited(notices.requestPermission());
    for (var i = 0; i < 30 && await notices.enabled() != true; i++) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    expect(
      await notices.enabled(),
      isTrue,
      reason: 'the app must be allowed to notify before this runs',
    );
    await plugin.cancelAll();


    final agents = AgentAnnouncer(
      system: notices,
      chime: () async {},
      inFront: () => false,
      questionGrace: Duration.zero,
    );
    const finisher = (
      ref: (machineId: 'm', agentId: 'a'),
      name: 'Finisher',
      machine: 'MacBook',
    );
    const asker = (
      ref: (machineId: 'm', agentId: 'b'),
      name: 'Asker',
      machine: 'MacBook',
    );
    agents.turnEnded(finisher, (
      aborted: false,
      replay: false,
      subagent: false,
      reply: 'Fixed the login screen.',
      tier: NoticeTier.alert,
    ), watching: () => false);
    agents.questionAsked(
      asker,
      requestId: 'q1',
      prompt: 'Approve Bash command: ls',
      watching: () => false,
    );

    // The platform draws them a moment after being asked; wait for the ones
    // that must come, then a little longer for any that must not.
    var shown = <String>[];
    for (var i = 0; i < 20; i++) {
      shown = await titles(plugin);
      if (shown.contains('Asker')) break;
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    await Future<void>.delayed(const Duration(seconds: 2));
    shown = await titles(plugin);
    debugPrint('rules-e2e: in the centre: ${(shown..sort()).join(' | ')}');

    expect(shown, contains('Asker'), reason: "an agent's question rings");
    expect(
      shown,
      isNot(contains('Finisher')),
      reason: "an agent's finished turn",
    );

    await plugin.cancelAll();
  });
}
