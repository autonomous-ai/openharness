// The full New Harness dialog (Split pane's) on a phone: every control a
// finger presses is 44x44 at least (audit finding S1), measured as the
// web_ux tap-size check measures it, on the accessibility tree. The dialog
// is its own route, so it carries the workspace's chrome to know it is on a
// phone; a computer's browser keeps the mouse's sizes.

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

import '../tool/web_ux_seed.dart';

import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

Future<void> _open(WidgetTester tester, Size size) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final app = createApp();
  seedMixedAgents(app);
  addTearDown(app.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: WorkspaceChromeScope(
        chrome: WorkspaceChrome(
          leadingWidth: (_) => 0,
          leading: (_, _) => const SizedBox.shrink(),
          compactBelow: 720,
          showsKeyHints: false,
        ),
        child: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () =>
                  showNewAgentDialog(context, app, 'm', source: 'test'),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

/// Each pressable node on screen, by its label, with its size on screen.
List<(String, Size)> _pressable(WidgetTester tester) {
  final root = tester
      .binding
      .renderViews
      .first
      .owner!
      .semanticsOwner!
      .rootSemanticsNode!;
  final screen = Offset.zero & tester.view.physicalSize;
  final out = <(String, Size)>[];
  void visit(SemanticsNode node, Matrix4 parent) {
    final transform = node.transform == null
        ? parent
        : (parent.clone()..multiply(node.transform!));
    final rect = MatrixUtils.transformRect(transform, node.rect);
    final data = node.getSemanticsData();
    // A row partly scrolled out of its list is measured by what shows of it;
    // its size is the one it has when scrolled in.
    final clip = node.parentPaintClipRect;
    final clipped =
        clip != null &&
        (node.rect.top <= clip.top + .5 ||
            node.rect.bottom >= clip.bottom - .5);
    if (data.hasAction(SemanticsAction.tap) &&
        !node.isInvisible &&
        !clipped &&
        rect.overlaps(screen)) {
      out.add((data.label.isEmpty ? data.tooltip : data.label, rect.size));
    }
    node.visitChildren((child) {
      visit(child, transform);
      return true;
    });
  }

  visit(root, Matrix4.identity());
  return out;
}

void main() {
  testWidgets('a phone\'s dialog is pressed with a finger', (tester) async {
    await _open(tester, const Size(390, 844));
    final small = [
      for (final (label, size) in _pressable(tester))
        if (label != 'open' && (size.width < 44 || size.height < 44))
          '$label ${size.width.round()}x${size.height.round()}',
    ];
    expect(small, isEmpty);
  });

  testWidgets('a phone\'s dialog names no keys', (tester) async {
    await _open(tester, const Size(390, 844));
    expect(find.textContaining('ctrl-enter', findRichText: true), findsNothing);
    expect(find.textContaining('shift-tab', findRichText: true), findsNothing);
  });

  testWidgets(
    'Split pane from the web workspace\'s menu opens it phone-sized',
    (tester) async {
      final app = withPanes(signedIn(), 2);
      addTearDown(app.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            chrome: webWorkspaceChrome(app),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const ValueKey('web-menu:pane.split_right')));
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.byKey(const Key('create-agent-submit')), findsOneWidget);
      expect(
        find.textContaining('ctrl-enter', findRichText: true),
        findsNothing,
      );
      expect(
        tester.getSize(find.byKey(const Key('create-agent-submit'))).height,
        greaterThanOrEqualTo(44),
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
