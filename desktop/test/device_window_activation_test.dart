import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

AppNotifier deviceWindowApp() {
  final app = createApp();
  app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
    computerId: 'fixture',
    wsUri: Uri.parse('ws://127.0.0.1:1'),
    protocolVersion: 1,
    terminalProtocolVersion: 3,
  );
  app.adoptSessionForTest(terminal('a0', []));
  return app;
}

Future<void> deviceEvent(
  AppNotifier app,
  String type, [
  Map<String, dynamic> payload = const {},
]) => app.handleEventForTest('m', {'type': type, 'payload': payload});

void main() {
  test(
    'local navigation, notification taps and scroll starts request the window',
    () async {
      final app = deviceWindowApp();
      addTearDown(app.dispose);
      var requests = 0;
      final subscription = app.deviceWindowRequests.listen((_) => requests++);
      addTearDown(subscription.cancel);

      await deviceEvent(app, 'dial_focus', {'machineId': 'm', 'agentId': 'a0'});
      await deviceEvent(app, 'dial_swarm', {'swarmId': app.activeSwarmId});
      await deviceEvent(app, 'dial_scroll', {'phase': 'down', 'dy': 0});
      await deviceEvent(app, 'dial_open', {'machineId': 'm', 'agentId': 'a0'});
      expect(requests, 4);
      expect(
        app.paneFocusByUser,
        isFalse,
        reason: 'activation must not retake terminals',
      );
      expect(app.allPanes, hasLength(1));
    },
  );

  test(
    'automatic updates, invalid targets and scroll tails stay quiet',
    () async {
      final app = deviceWindowApp();
      addTearDown(app.dispose);
      var requests = 0;
      final subscription = app.deviceWindowRequests.listen((_) => requests++);
      addTearDown(subscription.cancel);

      await deviceEvent(app, 'dial_status');
      await deviceEvent(app, 'dial_open', {
        'agentId': 'a0',
        'reason': 'question',
      });
      await deviceEvent(app, 'dial_focus', {'agentId': 'missing'});
      await deviceEvent(app, 'dial_open', {'agentId': 'missing'});
      await deviceEvent(app, 'dial_swarm', {'swarmId': 'missing'});
      await deviceEvent(app, 'dial_scroll', {'phase': 'move', 'dy': 4});
      await deviceEvent(app, 'dial_scroll', {'phase': 'up', 'velocity': 120});
      expect(requests, 0);
    },
  );

  test('a remote connection cannot request this computer’s window', () async {
    final app = deviceWindowApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.localEndpoint = null;
    var requests = 0;
    final subscription = app.deviceWindowRequests.listen((_) => requests++);
    addTearDown(subscription.cancel);
    await deviceEvent(app, 'dial_focus', {'agentId': 'a0'});
    await deviceEvent(app, 'dial_open', {'agentId': 'a0'});
    await deviceEvent(app, 'dial_swarm', {'swarmId': app.activeSwarmId});
    await deviceEvent(app, 'dial_scroll', {'phase': 'down'});
    expect(requests, 0);
  });

  testWidgets(
    'Mac device input restores and focuses once per burst, respecting native pickers',
    (tester) async {
      const window = MethodChannel('window_manager');
      final calls = <String>[];
      var minimized = true;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(window, (
        call,
      ) async {
        if (call.method == 'isMinimized') return minimized;
        calls.add(call.method);
        if (call.method == 'restore') minimized = false;
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          window,
          null,
        ),
      );
      final app = deviceWindowApp();
      await mount(tester, app);
      app.foreground.value = false;

      Future<void> focus() async {
        await deviceEvent(app, 'dial_focus', {'agentId': 'a0'});
        await tester.pump();
      }

      try {
        await focus();
        expect(calls, ['restore', 'show', 'focus']);
        expect(minimized, isFalse);
        calls.clear();
        await focus();
        await deviceEvent(app, 'dial_scroll', {'phase': 'down'});
        await tester.pump();
        expect(calls, isEmpty);

        await tester.pump(const Duration(milliseconds: 500));
        final picker = Completer<void>();
        final picking = whileNativePicker(() => picker.future);
        await focus();
        expect(calls, isEmpty);
        picker.complete();
        await picking;
        await focus();
        expect(calls, ['show', 'focus']);

        calls.clear();
        await tester.pump(const Duration(milliseconds: 500));
        app.foreground.value = true;
        await focus();
        expect(calls, isEmpty, reason: 'the app already has focus');
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
    skip: !RuntimePlatform.isMacOS,
  );
}
