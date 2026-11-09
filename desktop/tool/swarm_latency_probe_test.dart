// Diagnostic only: synthetic transport gates, never the real CLI or account.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import '../test/support/super_tab_fixture.dart';

void main() {
  testWidgets('baseline send frames and transport boundaries', (tester) async {
    final server = ConversationServer();
    final post = Completer<void>();
    final reads = Completer<void>();
    var gated = false;
    final clock = Stopwatch()..start();
    final events = <Map<String, Object>>[];
    void record(String event) =>
        events.add({'event': event, 'us': clock.elapsedMicroseconds});
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      pollInterval: Duration.zero,
      save: (value) async {
        record('save');
        await server.save(value);
      },
      request: (method, path, {body}) async {
        if (gated) {
          record('$method start');
          await (method == 'POST' ? post.future : reads.future);
        }
        final result = await server.request(method, path, body: body);
        if (gated) record('$method complete');
        return result;
      },
    );
    record('open start');
    await c.refresh();
    record('open read complete');
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
    record('open settled');
    record('switch start');
    await c.select('offline');
    await tester.pump();
    record('switch first frame');
    await tester.pumpAndSettle();
    final field = find.byKey(const ValueKey('super-message-composer'));
    record('typing start');
    await tester.enterText(field, 'Latency probe');
    await tester.pump();
    record('typing frame');
    gated = true;
    record('enter');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(microseconds: 16667));
    record('first frame');
    expect(find.text('Latency probe'), findsWidgets);
    expect(c.outgoing(c.selectedId), hasLength(1));
    record('ack release');
    post.complete();
    await tester.pump();
    record('ack frame');
    final savingAfterAck = c.saving;
    final outgoingAfterAck = c.outgoing(c.selectedId).length;
    final statesAfterAck = c
        .outgoing(c.selectedId)
        .map((m) => m.state.name)
        .toList();
    await tester.enterText(field, 'Second probe');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    final queued = c.outgoing(c.selectedId).length;
    record('refresh release');
    reads.complete();
    await tester.pumpAndSettle();
    record('confirmed frame');
    debugPrint(
      jsonEncode({
        'events': events,
        'savingAfterAck': savingAfterAck,
        'outgoingAfterAck': outgoingAfterAck,
        'statesAfterAck': statesAfterAck,
        'outgoingAfterSecondSend': queued,
        'posted': server.posts.length,
        'secondDraft': c.draft(c.selectedId),
      }),
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });
}
