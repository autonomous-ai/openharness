import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Task #3846 (Tony, 11-06, Desktop 1.3.83): with the Buddy pane hidden, Show your Buddy sat in the middle of the
/// Board's top bar. It belongs at the far right, lined up with the Board below it.

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('with the Buddy pane hidden, Show your Buddy sits at the '
        "Board's right edge (${brightness.name})", (tester) async {
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      await tester.binding.setSurfaceSize(const Size(1500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = swarm();
      (server.state['conversations'] as List).add({
        ...conversationFixture('buddy-owner-lead', 'Buddy'),
        'kind': 'buddy',
        'projectId': 'lead',
        'buddyOwnerId': 'owner',
        'agentIds': <String>[],
      });
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              paneStore: _Memory(),
              board: true,
            ),
          ),
        ),
      );
      await _settle(tester);
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      await tester.tap(_key('super-pane-right-toggle'));
      await _settle(tester);

      final icon = tester.getRect(_key('super-pane-right-toggle'));
      final board = tester.getRect(_key('super-tasks-lead'));
      // Lined up with the Board below: its right edge within the Board's own margin.
      expect(
        board.right - icon.right,
        lessThanOrEqualTo(grid.AppDesktop.groupGap),
      );
      expect(board.right - icon.right, greaterThanOrEqualTo(0));
      expect(tester.takeException(), isNull);
      await captureWindow(
        tester,
        shots,
        'board-buddy-hidden-${brightness.name}',
      );

      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });
  }
}
