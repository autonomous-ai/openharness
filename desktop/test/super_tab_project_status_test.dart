import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_status.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_STATUS_SHOTS'];
final _picture = GlobalKey();

/// Today, 16:52 on this computer's clock, as the backend sends it.
final _at = () {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day, 16, 52);
}();

const _report =
    'Memory engine  first PR #4750, waiting on build checks\n'
    'Test bench     docs PR #4752 open, building the month\n'
    'Details: https://github.com/autonomous-ai/openharness/pull/4750.';

Map<String, dynamic> _status(String text, {DateTime? at}) => {
  'text': text,
  'at': (at ?? _at).toUtc().toIso8601String(),
  'by': 'lead-agent',
};

/// The reader is the peer, in a Swarm of two projects: web-project (its chat
/// `lead`, with a report) and Design (its chat `design-lead`).
ConversationServer swarm({Map<String, dynamic>? status}) {
  final server = ConversationServer();
  server.state['projects'] = [
    {
      ...projectFixture('lead', 'web-project', 'lead'),
      'status': status ?? _status(_report),
    },
    projectFixture('design', 'Design', 'design-lead'),
  ];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'dee@example.com', 'role': 'collaborator'},
  ];
  server.state['conversations'] = [
    conversationFixture('lead', 'Lead'),
    {...conversationFixture('design-lead', 'Lead'), 'projectId': 'design'},
  ];
  return server;
}

Future<SuperTabController> showView(
  WidgetTester tester,
  ConversationServer server, {
  Map<String, dynamic>? initial,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller(account: 'peer', initial: initial);
  addTearDown(c.dispose);
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      key: UniqueKey(),
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => RepaintBoundary(key: _picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> shot(WidgetTester tester, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Finder statusText() => find.byKey(const ValueKey('super-project-status-text'));

Future<void> change(
  WidgetTester tester,
  ConversationServer server,
  SuperTabController c,
  void Function() edit,
) async {
  edit();
  server.revision++;
  await c.refresh();
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('the project row\'s status', () {
    test('reads text, time and writer; anything else reads as none', () {
      final status = SuperTabProject.fromJson({
        ...projectFixture('lead', 'web-project', 'lead'),
        'status': _status('Building'),
      }).status!;
      expect(status.text, 'Building');
      expect(status.at, _at.toUtc());
      expect(status.by, 'lead-agent');
      for (final value in <Object?>[
        null,
        'Building',
        {'text': ''},
        {'text': '  \n'},
        {'text': 7},
        {'at': '2026-10-31T09:00:00Z'},
      ]) {
        expect(
          SuperTabProject.fromJson({
            ...projectFixture('lead', 'web-project', 'lead'),
            'status': value,
          }).status,
          isNull,
          reason: '$value',
        );
      }
      // An older backend sends no status at all.
      expect(
        SuperTabProject.fromJson(projectFixture('lead', 'x', 'lead')).status,
        isNull,
      );
    });

    test('text at the limit is kept whole; longer is cut to it', () {
      final at = 'a' * SuperTabProjectStatus.maxText;
      expect(SuperTabProjectStatus.read({'text': at})!.text, at);
      expect(
        SuperTabProjectStatus.read({'text': '${at}bc'})!.text,
        hasLength(SuperTabProjectStatus.maxText),
      );
      // A bad time keeps the text and drops only the time.
      final odd = SuperTabProjectStatus.read({'text': 'x', 'at': 'soon'})!;
      expect(odd.text, 'x');
      expect(odd.at, isNull);
    });
  });

  group('the Status dialog', () {
    Future<void> openStatus(WidgetTester tester) async {
      await tester.tap(find.byTooltip('Project options'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(MenuItemButton, 'Status'));
      await tester.pumpAndSettle();
    }

    testWidgets('shows the report and when it was updated, links clickable', (
      tester,
    ) async {
      await showView(tester, swarm());
      expect(statusText(), findsNothing, reason: 'not over the chat');
      await openStatus(tester);
      expect(find.textContaining('Status · updated '), findsOneWidget);
      final spans = <TextSpan>[];
      tester.widget<Text>(statusText()).textSpan!.visitChildren((span) {
        if (span is TextSpan && span.recognizer != null) spans.add(span);
        return true;
      });
      // The link is its own span, without the sentence's full stop.
      expect(
        spans.single.text,
        'https://github.com/autonomous-ai/openharness/pull/4750',
      );
      expect(spans.single.recognizer, isA<TapGestureRecognizer>());
    });

    testWidgets('a new report replaces the text in place', (tester) async {
      final server = swarm();
      final c = await showView(tester, server);
      await openStatus(tester);
      await change(tester, server, c, () {
        ((server.state['projects'] as List).first as Map)['status'] = _status(
          'All merged.',
        );
      });
      expect(
        tester.widget<Text>(statusText()).textSpan!.toPlainText(),
        'All merged.',
      );
    });

    testWidgets('access lost while it is open closes it at once', (
      tester,
    ) async {
      final c = await showView(tester, swarm());
      await openStatus(tester);
      c.revokeAccess('You no longer have access to this Swarm.');
      await tester.pumpAndSettle();
      expect(statusText(), findsNothing);
    });

    testWidgets('the project going closes it, leaving no text behind', (
      tester,
    ) async {
      final server = swarm();
      final c = await showView(tester, server);
      await openStatus(tester);
      await change(tester, server, c, () {
        (server.state['projects'] as List).removeAt(0);
      });
      expect(statusText(), findsNothing);
    });
  });

  group('the time it says', () {
    final now = DateTime(2026, 11, 2, 21);
    test('today is the clock, on a 12-hour dial', () {
      expect(superTabStatusTime(DateTime(2026, 11, 2, 20, 33), now), '8:33 PM');
      expect(superTabStatusTime(DateTime(2026, 11, 2, 0, 5), now), '12:05 AM');
      expect(superTabStatusTime(DateTime(2026, 11, 2, 12), now), '12:00 PM');
    });
    test('before today says the date', () {
      expect(
        superTabStatusTime(DateTime(2026, 10, 30, 16, 52), now),
        'Oct 30, 4:52 PM',
      );
      expect(
        superTabStatusTime(DateTime(2025, 10, 30, 16, 52), now),
        'Oct 30 2025, 4:52 PM',
      );
    });
  });
}
