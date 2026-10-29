import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;
import 'package:harness_mobile/swarm/swarm_buddies_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

import '../voice_fakes.dart';
import 'swarm_buddies_fixture.dart';
import 'swarm_fixture.dart';

/// The Buddies screen (Tony's prototype C2): a row per project, its tile and
/// name, how the person's Buddy there stands and the last message of their
/// Buddy chat; unread ones bold; a tap opens that chat. It reads only while
/// on screen, says what it could not read, and shows nothing of a Swarm the
/// person can no longer read.
void main() {
  const mobile = 'swarm-buddies-row-$tab/$project';
  const web = 'swarm-buddies-row-$tab/$buddiesWeb';
  const docs = 'swarm-buddies-row-$tab/$buddiesDocs';

  /// [home] under a signed-in shell's Swarm, Swarm on, on a 390-point phone.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    Widget home = const SwarmBuddiesView(),
  }) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Finder inside(String row, Finder finder) =>
      find.descendant(of: key(row), matching: finder);

  int chatReads(FakeSwarm fake) =>
      fake.paths.where((p) => p.contains('/messages')).length;

  FontWeight? weightOf(WidgetTester tester, String row, String text) =>
      tester.widget<Text>(inside(row, find.text(text))).style?.fontWeight;

  testWidgets("its title, then a row per project, newest first: its tile and "
      "name, its Buddy's state and the last message", (tester) async {
    await pump(tester, buddiesBackend());

    expect(find.text('Buddies'), findsOneWidget);
    expect(inside(mobile, find.byType(SwarmProjectTile)), findsOneWidget);
    expect(inside(mobile, find.text('Mobile')), findsOneWidget);
    expect(inside(mobile, find.text('running')), findsOneWidget);
    expect(inside(mobile, find.text('Done: the build is up.')), findsOneWidget);
    expect(inside(web, find.text('offline')), findsOneWidget);
    expect(inside(web, find.text('You: Is 0.9 out yet?')), findsOneWidget);
    expect(inside(docs, find.text('not started')), findsOneWidget);
    expect(inside(docs, find.text('No Buddy yet')), findsOneWidget);
    double y(String row) => tester.getTopLeft(key(row)).dy;
    expect(y(mobile), lessThan(y(web)));
    expect(y(web), lessThan(y(docs)));
    expect(
      find.text("person-ann's Buddy"),
      findsNothing,
      reason: "someone else's Buddy chat is not listed",
    );
  });

  testWidgets('a chat with something unread is bold, with a dot; a read one '
      'is quiet', (tester) async {
    await pump(tester, buddiesBackend());

    expect(weightOf(tester, mobile, 'Mobile'), AppFont.semibold);
    expect(key('swarm-buddies-unread-$tab/$project'), findsOneWidget);
    expect(weightOf(tester, web, 'Web'), isNot(AppFont.semibold));
    expect(key('swarm-buddies-unread-$tab/$buddiesWeb'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('Unread messages')), findsOneWidget);
  });

  testWidgets('every row is a thumb tall, and a tap opens its Buddy chat', (
    tester,
  ) async {
    await pump(tester, buddiesBackend());

    for (final row in [mobile, web, docs]) {
      expect(tester.getSize(key(row)).height, greaterThanOrEqualTo(44));
    }
    await tester.tap(key(mobile));
    await tester.pumpAndSettle();

    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.swarmId, page.conversationId), (tab, buddiesMobileChat));
  });

  testWidgets('a project with no Buddy chat opens one on a tap', (
    tester,
  ) async {
    final fake = buddiesBackend();
    await pump(tester, fake);

    await tester.tap(key(docs));
    await tester.pumpAndSettle();

    expect(fake.commands.single, {
      'type': 'buddy.chat',
      'projectId': buddiesDocs,
    });
    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.swarmId, page.conversationId), (tab, 'buddy-docs'));
  });

  testWidgets('out of sight, it reads no chat; in sight again, it does', (
    tester,
  ) async {
    final fake = buddiesBackend();
    final hidden = ValueNotifier(true);
    addTearDown(hidden.dispose);
    await pump(
      tester,
      fake,
      home: ValueListenableBuilder<bool>(
        valueListenable: hidden,
        builder: (context, out, _) =>
            OutOfSight(hidden: out, child: const SwarmBuddiesView()),
      ),
    );
    expect(chatReads(fake), 0);

    hidden.value = false;
    await tester.pumpAndSettle();
    expect(chatReads(fake), 2);
    expect(find.text('Done: the build is up.'), findsOneWidget);
  });

  testWidgets('a chat that could not be read says so; Try again reads it; '
      'none waits on a stuck Loading', (tester) async {
    final fake = buddiesBackend();
    var fail = true;
    final answer = fake.routes[buddiesChatPath(buddiesMobileChat)]!;
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (body) => fail
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : answer(body);
    await pump(tester, fake);

    expect(find.text('Some Buddy chats could not be read.'), findsOneWidget);
    expect(inside(web, find.text('You: Is 0.9 out yet?')), findsOneWidget);
    expect(key('swarm-buddies-loading'), findsNothing);
    expect(
      tester.getSize(key('swarm-buddies-retry')).height,
      greaterThanOrEqualTo(44),
    );

    fail = false;
    await tester.tap(key('swarm-buddies-retry'));
    await tester.pumpAndSettle();

    expect(find.text('Some Buddy chats could not be read.'), findsNothing);
    expect(inside(mobile, find.text('Done: the build is up.')), findsOneWidget);
  });

  testWidgets('the rows show while their chats are read, their last line '
      'filling as each answers', (tester) async {
    final fake = buddiesBackend();
    final gate = Completer<void>();
    final answer = fake.routes[buddiesChatPath(buddiesMobileChat)]!;
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (body) async {
      await gate.future;
      return answer(body);
    };
    await pump(tester, fake);

    expect(key(mobile), findsOneWidget);
    expect(inside(mobile, find.text('Done: the build is up.')), findsNothing);
    expect(inside(web, find.text('You: Is 0.9 out yet?')), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    expect(inside(mobile, find.text('Done: the build is up.')), findsOneWidget);
  });

  testWidgets('access lost while it is open: every row of that Swarm goes', (
    tester,
  ) async {
    final host = await pump(tester, buddiesBackend());
    expect(key(mobile), findsOneWidget);

    host.session!.inbox.reader(tab)!.revoke();
    await tester.pumpAndSettle();

    for (final row in [mobile, web, docs]) {
      expect(key(row), findsNothing);
    }
    expect(find.text('Done: the build is up.'), findsNothing);
    expect(find.text('Mobile'), findsNothing);
  });

  testWidgets('a Swarm with no project says so', (tester) async {
    final fake = buddiesBackend();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(head: headData(projects: const []));
    await pump(tester, fake);

    expect(key('swarm-buddies-none'), findsOneWidget);
    expect(find.text('No projects yet.'), findsOneWidget);
  });
}
