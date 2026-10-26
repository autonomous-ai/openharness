import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A backend that no longer serves this build's reads answers 426
/// UPDATE_REQUIRED: the Swarm says to update Harness and stops asking
/// (docs/design/2026-10-26-swarm-state-parts.md, sections 4.11 and 5.1).
void main() {
  const update = 'Update Harness to keep using this Swarm.';
  late ConversationServer server;
  late List<String> reads;
  var refuse = false;

  SuperTabController open({Duration poll = Duration.zero}) {
    reads = [];
    return SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) {
        if (method == 'GET') reads.add(path);
        if (refuse) throw superTabUpdateRequired;
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: poll,
    );
  }

  setUp(() {
    server = ConversationServer();
    refuse = false;
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

  test('a refused first load says to update Harness', () async {
    refuse = true;
    final c = open();
    await c.refresh();
    expect(c.snapshot, isNull);
    expect(c.error, update);
    expect(c.accessRevoked, isFalse);
  });

  testWidgets('the update message offers no Retry', (tester) async {
    final c = open();
    await c.refresh();
    refuse = true;
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(update), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });
}
