import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/state/workspace_chrome.dart';

import 'support/super_tab_fixture.dart';

/// A backend that no longer serves this build's reads answers 426
/// UPDATE_REQUIRED: the Swarm says to update Harness and stops asking
/// (docs/design/2026-10-26-swarm-state-parts.md, sections 4.11 and 5.1).
void main() {
  const update = 'Update Harness to keep using this Swarm.';
  late ConversationServer server;
  late List<String> reads;
  var refuse = false;
  Completer<void>? hold;

  SuperTabController open({Duration poll = Duration.zero}) {
    reads = [];
    return SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) async {
        if (method == 'GET') reads.add(path);
        if (refuse) throw superTabUpdateRequired;
        if (hold case final pending?) await pending.future;
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: poll,
    );
  }

  setUp(() {
    server = ConversationServer();
    refuse = false;
    hold = null;
  });

  test('an update answer shows the update message and stops the poll', () {
    fakeAsync((async) {
      final c = open(poll: const Duration(seconds: 3))..start();
      async.flushMicrotasks();
      expect(c.snapshot, isNotNull);
      refuse = true;
      async.elapse(const Duration(seconds: 3));
      expect(c.updateRequired, isTrue);
      expect(c.error, update);
      // The backend answered: it is not unreachable.
      expect(c.backendUnreachable, isFalse);
      final asked = reads.length;
      async.elapse(const Duration(minutes: 1));
      expect(reads, hasLength(asked));
      // Nor does a machine connecting, or a refresh, ask again.
      c.machineAvailable();
      c.refresh();
      async.flushMicrotasks();
      expect(reads, hasLength(asked));
      c.dispose();
    });
  });

  test('a refused message read or command says the same and stops', () async {
    final c = open();
    await c.refresh();
    refuse = true;
    c.setDraft('lead', 'Hello');
    await c.send();
    expect(c.operationError, update);
    expect(c.updateRequired, isTrue);
    expect(c.error, update);
  });

  test('a refused closed-groups read alone says the same and stops', () async {
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) {
        if (method == 'GET') reads.add(path);
        if (path.contains('/groups?dormant=1')) throw superTabUpdateRequired;
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
    reads = [];
    await c.refresh();
    await c.loadDormant('lead');
    expect(c.updateRequired, isTrue);
    expect(c.error, update);
    final asked = reads.length;
    await c.refresh();
    expect(reads, hasLength(asked));
  });

  test('a refused first load says to update Harness', () async {
    refuse = true;
    final c = open();
    await c.refresh();
    expect(c.snapshot, isNull);
    expect(c.error, update);
    expect(c.accessRevoked, isFalse);
  });

  Future<void> show(
    WidgetTester tester,
    SuperTabController c, {
    bool web = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: WorkspaceChromeScope(
          chrome: web ? WorkspaceChrome(superTabRecovers: true) : null,
          child: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  for (final (firstLoad, web) in [
    (true, false),
    (false, false),
    (true, true),
  ]) {
    testWidgets(
      'Retry recovers an update refusal, first load: $firstLoad, web: $web',
      (tester) async {
        final c = open();
        addTearDown(c.dispose);
        if (!firstLoad) await c.refresh();
        refuse = true;
        await c.refresh();
        await show(tester, c, web: web);
        expect(find.text(update), findsOneWidget);
        expect(find.widgetWithText(TextButton, 'Retry'), findsOneWidget);
        refuse = false;
        await tester.tap(find.widgetWithText(TextButton, 'Retry'));
        await tester.pumpAndSettle();
        expect(c.updateRequired, isFalse);
        expect(c.error, isNull);
        expect(c.snapshot, isNotNull);
        expect(find.text(update), findsNothing);
        expect(
          find.byKey(const ValueKey('super-message-composer')),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      },
    );
  }

  testWidgets(
    'Retry preserves a real refusal and keeps automatic reads stopped',
    (tester) async {
      final c = open(poll: const Duration(seconds: 3));
      addTearDown(c.dispose);
      refuse = true;
      c.start();
      await show(tester, c);
      final before = reads.length;
      expect(find.widgetWithText(TextButton, 'Retry'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Retry'));
      await tester.pumpAndSettle();
      expect(reads.length, greaterThan(before));
      expect(c.updateRequired, isTrue);
      expect(find.text(update), findsOneWidget);
      final after = reads.length;
      await tester.pump(const Duration(seconds: 30));
      expect(reads, hasLength(after));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    },
  );

  testWidgets(
    'successful Retry resumes polling and overlapping retries share a read',
    (tester) async {
      final c = open(poll: const Duration(seconds: 3));
      addTearDown(c.dispose);
      c.start();
      await tester.pump();
      refuse = true;
      await c.refresh();
      await show(tester, c);
      refuse = false;
      hold = Completer<void>();
      final before = reads.where((p) => p.contains('/changes?')).length;
      final button = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Retry'),
      );
      button.onPressed!();
      button.onPressed!();
      await tester.pump();
      expect(
        reads.where((p) => p.contains('/changes?')),
        hasLength(before + 1),
      );
      hold!.complete();
      hold = null;
      await tester.pumpAndSettle();
      expect(c.updateRequired, isFalse);
      expect(c.error, isNull);
      final recovered = c.stateReads;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(c.stateReads, greaterThan(recovered));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    },
  );
}
