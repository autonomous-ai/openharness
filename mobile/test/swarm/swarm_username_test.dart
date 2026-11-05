import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's own username, changed from the phone as on the desktop: a
/// Username row on You opens their profile, whose field saves through
/// `member.username`; the server's refusal is said under the field, and the
/// name it keeps shows at once.
void main() {
  late FakeSwarm swarm;
  late SwarmHost host;
  late ValueNotifier<String?> account;
  late Map<String, dynamic> mine;

  /// What the next command answers instead of the server's rules, once.
  FutureOr<Object?> Function()? answer;

  /// The parts read fails while this is set.
  SuperTabFailure? partsFail;

  // The backend's rules (backend/src/superTabs/usernames.ts).
  final shape = RegExp(r'^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){0,30}[a-z0-9_-]$');
  const shapeWords =
      'Use 2 to 32 letters, digits, dots, dashes or underscores, starting '
      'with a letter or digit, with no dot at the end or two in a row.';
  final dee = {...person('person-dee'), 'username': 'dee'};

  Object? setName(Map<String, dynamic> command) {
    final name = (command['username'] as String).trim().toLowerCase();
    if (!shape.hasMatch(name)) {
      throw const SuperTabFailure(
        'INVALID_USERNAME',
        shapeWords,
        statusCode: 400,
      );
    }
    if (name == 'dee' || name == 'river') {
      throw SuperTabFailure(
        'USERNAME_TAKEN',
        '$name is taken.',
        statusCode: 409,
      );
    }
    mine = {...mine, 'username': name};
    return {'ok': true};
  }

  /// You, for a member with [role] named [username], on an iPhone's screen.
  Future<void> pump(
    WidgetTester tester, {
    String role = 'owner',
    String username = 'tony',
    bool firstLoadFails = false,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    answer = null;
    partsFail = firstLoadFails
        ? const SuperTabFailure(
            'UNAVAILABLE',
            'Swarm is busy.',
            statusCode: 503,
          )
        : null;
    swarm = FakeSwarm();
    mine = {
      ...person(me, role: role),
      'email': 'tony@example.com',
      'username': username,
    };
    var version = 1;
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Autonomous', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) {
      if (partsFail case final failure?) throw failure;
      return {
        ...firstLoad(),
        'members': [part(me, version, mine), part('person-dee', 1, dee)],
      };
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c${++version}'),
      'members': [part(me, version, mine)],
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (answer case final once?) {
        answer = null;
        return once();
      }
      return switch (command['type']) {
        'member.username' => setName(command),
        _ => {'ok': true},
      };
    };
    account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmYouPage(),
      ),
    );
    unawaited(host.session!.inbox.refresh());
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);

  /// The chevron that says You's header opens the profile.
  final chevron = find.byIcon(LucideIcons.chevronRight300);
  TextField field(WidgetTester tester) =>
      tester.widget<TextField>(key('swarm-username-field'));
  bool saveOn(WidgetTester tester) =>
      tester.widget<SwarmButton>(key('swarm-username-save')).onPressed != null;
  String? shownError() => key('swarm-username-error').evaluate().isEmpty
      ? null
      : (key('swarm-username-error').evaluate().single.widget as Text).data;

  /// Lets a command and the read after it answer.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<void> openProfile(WidgetTester tester) async {
    await tester.tap(key('swarm-you-me'));
    await tester.pumpAndSettle();
    expect(key('swarm-username-field'), findsOneWidget);
  }

  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(key('swarm-username-field'), text);
    await tester.pump();
  }

  Future<void> save(WidgetTester tester) async {
    await tester.ensureVisible(key('swarm-username-save'));
    await tester.tap(key('swarm-username-save'));
    await settle(tester);
  }

  List<Map<String, dynamic>> renames() => [
    for (final c in swarm.commands)
      if (c['type'] == 'member.username') c,
  ];

  testWidgets('You heads with the username, and a tap there opens the '
      'profile with it in its field', (tester) async {
    await pump(tester);
    expect(inside('swarm-you-me', find.text('tony')), findsOneWidget);
    expect(inside('swarm-you-me', chevron), findsOneWidget);
    await openProfile(tester);
    expect(field(tester).controller!.text, 'tony');
    expect(find.text('How people see and tag you in this Swarm.'), findsOne);
    // Nothing changed, nothing to save.
    expect(saveOn(tester), isFalse);
  });

  testWidgets('a name saved is the server\'s at once: in the field, on You '
      'and in what every screen reads', (tester) async {
    await pump(tester);
    await openProfile(tester);
    await type(tester, ' Tony.B ');
    expect(saveOn(tester), isTrue);
    await save(tester);

    expect(renames(), [
      {'type': 'member.username', 'username': 'Tony.B'},
    ]);
    // Lowercased as the server keeps it.
    expect(field(tester).controller!.text, 'tony.b');
    expect(shownError(), isNull);
    expect(
      host.session!.inbox.reader(tab)!.snapshot!.person(me)!.username,
      'tony.b',
    );
    await tester.tap(key('swarm-profile-close'));
    await tester.pumpAndSettle();
    expect(inside('swarm-you-me', find.text('tony.b')), findsOneWidget);
  });

  testWidgets('a name the server refuses says why under its field, and '
      'nothing changes', (tester) async {
    await pump(tester);
    await openProfile(tester);
    await type(tester, 'tony.');
    await save(tester);

    expect(shownError(), shapeWords);
    // Under the field, not at the foot of the sheet.
    expect(key('swarm-profile-error'), findsNothing);
    expect(field(tester).controller!.text, 'tony.');
    expect(
      host.session!.inbox.reader(tab)!.snapshot!.person(me)!.username,
      'tony',
    );
    // Typing again clears it.
    await type(tester, 'tony.c');
    expect(shownError(), isNull);
  });

  testWidgets('a taken name says so, and the name stays theirs', (
    tester,
  ) async {
    await pump(tester);
    await openProfile(tester);
    await type(tester, 'Dee');
    await save(tester);

    expect(shownError(), 'dee is taken.');
    expect(
      host.session!.inbox.reader(tab)!.snapshot!.person(me)!.username,
      'tony',
    );
    expect(saveOn(tester), isTrue);
  });

  testWidgets('offline: a call lost on the way says so, never stays Saving, '
      'and the next try goes through', (tester) async {
    await pump(tester);
    await openProfile(tester);
    answer = () => throw TimeoutException('no answer');
    await type(tester, 'tony.b');
    await save(tester);

    expect(shownError(), 'Could not reach this Swarm. Try again.');
    expect(find.text('Saving…'), findsNothing);
    expect(saveOn(tester), isTrue);

    await save(tester);
    expect(shownError(), isNull);
    expect(field(tester).controller!.text, 'tony.b');
  });

  testWidgets('a viewer changes their own name, and nothing else', (
    tester,
  ) async {
    await pump(tester, role: 'viewer');
    await openProfile(tester);
    expect(
      find.text('You have read-only access to this Swarm.'),
      findsOneWidget,
    );
    await type(tester, 'tony.v');
    await save(tester);
    expect(renames(), hasLength(1));
    expect(field(tester).controller!.text, 'tony.v');

    await tester.ensureVisible(key('swarm-avatar-preset-owl'));
    await tester.tap(key('swarm-avatar-preset-owl'));
    await settle(tester);
    expect(swarm.commands.where((c) => c['type'] == 'member.avatar'), isEmpty);
  });

  testWidgets('access taken away while the profile is open: the field and '
      'the name go, with no rows left loading', (tester) async {
    await pump(tester);
    await openProfile(tester);
    host.session!.inbox.reader(tab)!.revoke();
    await tester.pumpAndSettle();

    expect(key('swarm-username-field'), findsNothing);
    expect(key('swarm-profile-loading'), findsNothing);
    expect(find.text('You can no longer see this Swarm.'), findsOneWidget);
    await tester.tap(key('swarm-profile-close'));
    await tester.pumpAndSettle();
    // You keeps nothing of them, and offers no way in.
    expect(find.text('tony'), findsNothing);
    expect(inside('swarm-you-me', chevron), findsNothing);
  });

  testWidgets('an answer that lands after access was taken away changes '
      'nothing and reads nothing', (tester) async {
    await pump(tester);
    await openProfile(tester);
    final held = Completer<Object?>();
    answer = () => held.future;
    await type(tester, 'tony.b');
    await tester.tap(key('swarm-username-save'));
    await tester.pump();
    expect(find.text('Saving…'), findsOneWidget);

    host.session!.inbox.reader(tab)!.revoke();
    await tester.pump();
    final reads = swarm.calls.length;
    held.completeError(
      const SuperTabFailure('USERNAME_TAKEN', 'tony.b is taken.'),
    );
    await settle(tester);

    expect(find.text('tony.b is taken.'), findsNothing);
    expect(key('swarm-username-field'), findsNothing);
    expect(swarm.calls.length, reads);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an answer that lands after the account changed never shows '
      'in what is open now', (tester) async {
    await pump(tester);
    await openProfile(tester);
    final held = Completer<Object?>();
    answer = () => held.future;
    await type(tester, 'tony.b');
    await tester.tap(key('swarm-username-save'));
    await tester.pump();

    account.value = 'person-other';
    await tester.pump();
    held.completeError(
      const SuperTabFailure('USERNAME_TAKEN', 'tony.b is taken.'),
    );
    await settle(tester);

    expect(find.text('tony.b is taken.'), findsNothing);
    expect(find.text('tony.b'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a first read that failed and then recovers still lets them '
      'change it', (tester) async {
    await pump(tester, firstLoadFails: true);
    expect(inside('swarm-you-me', chevron), findsNothing);
    await tester.tap(key('swarm-you-me'));
    await tester.pumpAndSettle();
    expect(key('swarm-username-field'), findsNothing);

    partsFail = null;
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();
    expect(inside('swarm-you-me', find.text('tony')), findsOneWidget);
    await openProfile(tester);
    await type(tester, 'tony.b');
    await save(tester);
    expect(field(tester).controller!.text, 'tony.b');
  });

  testWidgets('a name at the 32-character limit saves, reads back, and '
      'saves again; one longer is cut to fit', (tester) async {
    final longest = 'a' * 31 + 'z';
    await pump(tester, username: longest);
    await openProfile(tester);
    expect(field(tester).controller!.text, longest);

    final other = 'b' * 32;
    // From empty: a field already at its limit keeps what it has.
    await type(tester, '');
    await type(tester, '${other}x');
    // The field takes 32, as a username does.
    expect(field(tester).controller!.text, other);
    await save(tester);
    expect(shownError(), isNull);
    expect(field(tester).controller!.text, other);
    expect(
      host.session!.inbox.reader(tab)!.snapshot!.person(me)!.username,
      other,
    );
  });

  testWidgets('a newer edit typed while a save is on its way is kept', (
    tester,
  ) async {
    await pump(tester);
    await openProfile(tester);
    final held = Completer<Object?>();
    answer = () => held.future;
    await type(tester, 'tony.b');
    await tester.tap(key('swarm-username-save'));
    await tester.pump();
    await type(tester, 'tony.c');

    mine = {...mine, 'username': 'tony.b'};
    held.complete({'ok': true});
    await settle(tester);
    expect(field(tester).controller!.text, 'tony.c');
    expect(saveOn(tester), isTrue);
  });
}
