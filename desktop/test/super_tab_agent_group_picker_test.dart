import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_dialog.dart';
import 'package:harness/super_tabs/agent_group_picker.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/dialog_scope.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

void main() {
  final captures = Platform.environment['HARNESS_AGENT_GROUP_CAPTURE_DIR'];
  setUpAll(() => loadCaptureFonts(captures));

  late ConversationServer server;
  late SuperTabController controller;
  String? opened;
  var dismissed = false;

  setUp(() {
    server = ConversationServer();
    server.state['projects'] = [
      projectFixture('lead', 'sample-project', 'lead'),
    ];
    server.state['agents'] = [
      {
        'id': 'agent',
        'projectId': 'lead',
        'name': 'Lead',
        'displayName': 'Nova',
        'machineId': 'm',
        'harnessId': 'native',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    for (final group in server.state['conversations'] as List) {
      group['agentIds'] = ['agent'];
    }
    (server.state['conversations'] as List)[1]['number'] = 12;
    opened = null;
    dismissed = false;
  });

  Future<void> show(
    WidgetTester tester, {
    Brightness brightness = Brightness.dark,
    double scale = 1,
    Size size = const Size(900, 700),
    String initialGroup = 'lead',
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    controller = server.controller();
    await controller.refresh();
    controller.select(initialGroup);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: TextScaler.linear(scale),
            disableAnimations: true,
          ),
          child: child!,
        ),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                opened = await showAppDialog<String>(
                  context: context,
                  builder: (_) => SuperTabDialogScope(
                    controller: controller,
                    requireWrite: false,
                    projectId: 'lead',
                    child: SuperTabAgentGroupPicker(
                      controller: controller,
                      agentId: 'agent',
                    ),
                  ),
                );
                dismissed = true;
              },
              child: const Text('Choose agent'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Choose agent'));
    await tester.pumpAndSettle();
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
    await tester.pump();
  }

  Finder row(String id) => find.byKey(ValueKey('super-agent-group-$id'));
  final open = find.byKey(const ValueKey('super-agent-group-open'));
  final cancel = find.byKey(const ValueKey('super-agent-group-cancel'));
  bool selected(WidgetTester tester, String id) =>
      tester
          .widget<Semantics>(
            find.ancestor(of: row(id), matching: find.byType(Semantics)).first,
          )
          .properties
          .selected ==
      true;

  testWidgets('selection waits for Open and uses the current group initially', (
    tester,
  ) async {
    await show(tester, initialGroup: 'offline');
    expect(find.text('Open Nova'), findsOneWidget);
    expect(selected(tester, 'offline'), isTrue);
    expect(find.text('#12 Offline editing'), findsOneWidget);
    expect(find.text('Product Manager'), findsOneWidget);
    await tester.tap(row('lead'));
    await tester.pump();
    expect(selected(tester, 'lead'), isTrue);
    expect(controller.selectedId, 'offline');
    expect(opened, isNull);
    expect(dismissed, isFalse);
    await tester.tap(open);
    await tester.pumpAndSettle();
    expect(opened, 'lead');
    expect(server.posts, isEmpty);
    await close(tester);
  });

  testWidgets('arrow keys select, Enter opens and Tab reaches the actions', (
    tester,
  ) async {
    await show(tester);
    expect(selected(tester, 'lead'), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(selected(tester, 'offline'), isTrue);
    expect(dismissed, isFalse);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(selected(tester, 'lead'), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(
      Focus.of(
        tester.element(
          find.descendant(of: cancel, matching: find.text('Cancel')),
        ),
      ).hasFocus,
      isTrue,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(
      Focus.of(
        tester.element(find.descendant(of: open, matching: find.text('Open'))),
      ).hasFocus,
      isTrue,
    );
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(opened, 'offline');
    await close(tester);
  });

  testWidgets('double-click opens; Cancel leaves navigation alone', (
    tester,
  ) async {
    await show(tester);
    await tester.tap(row('offline'));
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tap(row('offline'));
    await tester.pumpAndSettle();
    expect(opened, 'offline');
    opened = null;
    await tester.tap(find.text('Choose agent'));
    await tester.pumpAndSettle();
    await tester.tap(cancel);
    await tester.pumpAndSettle();
    expect(opened, isNull);
    expect(controller.selectedId, 'lead');
    expect(server.posts, isEmpty);
    await close(tester);
  });

  testWidgets(
    'removed selection disables Open without choosing another group',
    (tester) async {
      await show(tester);
      (server.state['conversations'] as List)[0]['agentIds'] = <String>[];
      server.revision++;
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(row('lead'), findsNothing);
      expect(selected(tester, 'offline'), isFalse);
      expect(tester.widget<FilledButton>(open).onPressed, isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(dismissed, isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
      expect(selected(tester, 'offline'), isTrue);
      await tester.tap(open);
      await tester.pumpAndSettle();
      expect(opened, 'offline');
      await close(tester);
    },
  );

  testWidgets('removed agents and archived groups cannot be opened', (
    tester,
  ) async {
    await show(tester);
    for (final group in server.state['conversations'] as List) {
      group['archived'] = true;
    }
    server.revision++;
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(
      find.text('No available workgroups for this agent.'),
      findsOneWidget,
    );
    expect(tester.widget<FilledButton>(open).onPressed, isNull);
    for (final group in server.state['conversations'] as List) {
      group['archived'] = false;
    }
    server.state['agents'] = <Object>[];
    server.revision++;
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(row('lead'), findsNothing);
    expect(tester.widget<FilledButton>(open).onPressed, isNull);
    expect(opened, isNull);
    await close(tester);
  });

  testWidgets('revocation removes the captured choices and confirmation', (
    tester,
  ) async {
    await show(tester);
    controller.revokeAccess('Signed out');
    await tester.pumpAndSettle();
    expect(find.text('Open Nova'), findsNothing);
    expect(open, findsNothing);
    expect(find.text('This action is no longer available.'), findsOneWidget);
    expect(opened, isNull);
    await close(tester);
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('chooser fits ${brightness.name} at ${scale}x', (
        tester,
      ) async {
        (server.state['conversations'] as List).add({
          ...conversationFixture(
            'long',
            'Verify offline recovery and restore the shared workspace',
          ),
          'agentIds': ['agent'],
          'number': 123,
        });
        await show(tester, brightness: brightness, scale: scale);
        await captureWindow(
          tester,
          captures,
          'agent-groups-${brightness.name}-${scale}x',
        );
        expect(tester.takeException(), isNull);
        expect(open.hitTestable(), findsOneWidget);
        expect(
          tester.getSize(find.byType(DesktopDialogSurface)).height,
          lessThan(600),
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
        expect(row('long').hitTestable(), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(opened, 'long');
        await close(tester);
      });
    }
  }
}
