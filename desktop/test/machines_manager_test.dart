import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'keymap_runtime_test.dart' show native;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _MachineApi extends ApiClient {
  _MachineApi() : super(config: AppConfig.dev, session: AuthSession());
  final calls = <(String, String)>[];
  String? error;

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    calls.add((machineId, name));
    if (error != null) throw ApiException(error!);
    return null;
  }
}

void main() {
  for (final fail in [false, true]) {
    testWidgets(
      'Machines menu opens Rename and updates names (failure=$fail)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        final updates = <Map>[];
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'machinesState') {
              updates.add(call.arguments as Map);
            }
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp();
        app.stateOf('m')!.nodeOnline = true;
        final api = _MachineApi();
        app.api = api;
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', input));
        await mount(tester, app, nativeTabs: true);
        // 'manageMachines' now opens the Machines harness; the plain list is 'machineList'.
        final opened = native(tester, 'machineList');
        await tester.pumpAndSettle();
        await opened;
        expect(find.text('Machines Manager'), findsOneWidget);
        await tester.tap(find.text('Rename'));
        await tester.pumpAndSettle();
        expect(find.text('Rename Machine'), findsOneWidget);
        final field = find.byType(TextField);
        await tester.enterText(field, '   ');
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        expect(find.text('Name cannot be empty'), findsOneWidget);
        expect(api.calls, isEmpty);
        await tester.enterText(field, '  Office Mac  ');
        if (fail) api.error = 'Connection unavailable';
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        expect(api.calls, [('m', 'Office Mac')]);
        if (fail) {
          expect(find.textContaining('Connection unavailable'), findsOneWidget);
          expect(app.stateOf('m')!.machine.displayName, isNot('Office Mac'));
          api.error = null;
          await tester.tap(find.text('Save'));
          await tester.pumpAndSettle();
        }
        expect(find.text('Rename Machine'), findsNothing);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('managed-machine-m')),
            matching: find.text('Office Mac'),
          ),
          findsOneWidget,
        );
        expect(app.machines.single.displayName, 'Office Mac');
        expect((updates.last['machines'] as List).single['name'], 'Office Mac');
        await tester.tap(find.text('Done'));
        await tester.pumpAndSettle();
        expect(find.text('Machines Manager'), findsNothing);
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        tester.testTextInput.enterText('x');
        await tester.idle();
        expect(String.fromCharCodes(input.single.bytes), 'x');
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
