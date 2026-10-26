// A Swarm tab whose first read fails, and one with no projects, behind the
// web's WorkspaceChrome.superTabRecovers. Audit findings S12 and P5. Desktop
// passes no chrome and keeps both as they were.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/web/shell/web_chrome.dart';

import 'support/super_tab_fixture.dart';

final _recovers = WorkspaceChrome(
  leadingWidth: (_) => 0,
  leading: (_, _) => const SizedBox.shrink(),
  superTabRecovers: true,
);

void main() {
  final loading = find.textContaining('Loading conversation');
  final retry = find.widgetWithText(TextButton, 'Retry');
  const error = 'Could not refresh this conversation. Try again.';

  Future<ConversationServer> show(
    WidgetTester tester, {
    required WorkspaceChrome? chrome,
    ConversationServer? server,
    VoidCallback? onNewProject,
  }) async {
    server ??= ConversationServer();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: WorkspaceChromeScope(
          chrome: chrome,
          child: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewProject: onNewProject,
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    return server;
  }

  TextField composer(WidgetTester tester) => tester.widget<TextField>(
    find.byKey(const ValueKey('super-message-composer')),
  );

  group('web (superTabRecovers)', () {
    testWidgets('a failed first read is one error with Retry, never Loading', (
      tester,
    ) async {
      await show(
        tester,
        chrome: _recovers,
        server: ConversationServer()..failReads = true,
      );
      expect(find.text(error), findsOneWidget);
      expect(retry, findsOneWidget);
      expect(loading, findsNothing);
      expect(composer(tester).enabled, isFalse);
      expect(tester.getSize(retry).height, greaterThanOrEqualTo(44));
    });

    testWidgets('Retry shows loading, then the conversation', (tester) async {
      final server = await show(
        tester,
        chrome: _recovers,
        server: ConversationServer()..failReads = true,
      );
      server
        ..failReads = false
        ..holdReads = Completer<void>();
      await tester.tap(retry);
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text(error), findsNothing);
      server.holdReads!.complete();
      server.holdReads = null;
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text(error), findsNothing);
      expect(retry, findsNothing);
      expect(composer(tester).enabled, isTrue);
    });

    testWidgets('no projects: New project under the sentence', (tester) async {
      final server = ConversationServer();
      server.state['projects'] = <dynamic>[];
      var made = 0;
      await show(
        tester,
        chrome: _recovers,
        server: server,
        onNewProject: () => made++,
      );
      final sentence = find.text('Create a project to get started.');
      final button = find.widgetWithText(FilledButton, 'New project');
      expect(sentence, findsOneWidget);
      expect(button, findsOneWidget);
      expect(
        tester.getTopLeft(button).dy,
        greaterThan(tester.getBottomLeft(sentence).dy),
      );
      expect(tester.getSize(button).height, greaterThanOrEqualTo(44));
      await tester.tap(button);
      expect(made, 1);
    });

    testWidgets('no projects and no way to make one: no button', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['projects'] = <dynamic>[];
      await show(tester, chrome: _recovers, server: server);
      expect(find.text('Create a project to get started.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'New project'), findsNothing);
    });
  });

  test(
    'the switch: off with no host chrome (Desktop), on in the web chrome',
    () {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      expect(
        WorkspaceChrome(
          leadingWidth: (_) => 0,
          leading: (_, _) => const SizedBox.shrink(),
        ).superTabRecovers,
        isFalse,
      );
      expect(webWorkspaceChrome(app).superTabRecovers, isTrue);
    },
  );

  group('Desktop (no chrome), as today', () {
    testWidgets('a failed first read keeps the banner over Loading', (
      tester,
    ) async {
      await show(
        tester,
        chrome: null,
        server: ConversationServer()..failReads = true,
      );
      expect(find.text(error), findsOneWidget);
      expect(retry, findsOneWidget);
      expect(loading, findsWidgets);
    });

    testWidgets('no projects: the sentence alone', (tester) async {
      final server = ConversationServer();
      server.state['projects'] = <dynamic>[];
      await show(tester, chrome: null, server: server, onNewProject: () {});
      expect(find.text('Create a project to get started.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'New project'), findsNothing);
    });
  });
}
