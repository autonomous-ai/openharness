import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/chat/chat_view_store.dart';
import 'package:harness_mobile/core/engine_availability.dart';
import 'package:harness_mobile/phone/terminal_page.dart';

import '../phone_edge/edge_fixture.dart';
import '../voice_fakes.dart';

void main() {
  setUp(() async {
    chatViewStore.storageForTest = MemoryKeyValueStore();
    await chatViewStore.setChatByDefault(true);
  });
  tearDown(() => chatViewStore.setChatByDefault(false));

  // Pixel, 2026-11-26: the machine answered in under a second, and "Checking…" stayed for minutes; once Codex was
  // signed in, Sign in stayed until the page was opened again. The page was not built again when the engines were read.
  testWidgets('Chat UI follows the machine\'s answers about its engine while the page is open', (tester) async {
    setPhone(tester, largePhone);
    final app = edgeApp(agents: [edgeAgent('a', engine: 'codex')]);
    final engines = app.stateOf('m')!.engines;
    final asking = Completer<void>();
    engines
      ..replace([const EngineAvailability(engine: 'codex', installed: true, signedIn: false)])
      ..inFlight = asking.future;
    await tester.pumpWidget(
      phoneApp(
        TerminalPage(notifier: app, machineId: 'm', agentId: 'a', voice: edgeVoice().voice),
      ),
    );
    await frames(tester);
    expect(find.text('Checking Codex on studio…'), findsOneWidget);

    // The machine answers: signed out.
    engines.inFlight = null;
    asking.complete();
    app.notifyListeners();
    await frames(tester);
    expect(find.text('Checking Codex on studio…'), findsNothing);
    expect(find.text("Codex isn't signed in on studio."), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    // Signed in since, as the machine now says.
    engines.replace([const EngineAvailability(engine: 'codex', installed: true, signedIn: true)]);
    app.notifyListeners();
    await frames(tester);
    expect(find.text("Codex isn't signed in on studio."), findsNothing);
    expect(find.text('Sign in'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
