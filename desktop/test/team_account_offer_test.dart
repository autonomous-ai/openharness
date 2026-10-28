import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/team_account_setup.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what this Mac's daemon is asked; no socket is opened.
class _Daemon extends RenameConnection {
  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> answer = {'ok': true, 'state': 'wanted'};
  /// Answers in turn before [answer]; a Completer's future is awaited.
  final queued = <Object>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'super_tabs' &&
        '${payload['action']}'.startsWith('teamSetup')) {
      asked.add(Map.of(payload));
      if (queued.isNotEmpty) {
        final next = queued.removeAt(0);
        return next is Completer<Map<String, dynamic>>
            ? next.future
            : Future.value(next as Map<String, dynamic>);
      }
      return Future.value(answer);
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

/// Waits until [ok] holds, failing after two seconds.
Future<void> until(bool Function() ok) async {
  final deadline = DateTime.now().add(const Duration(seconds: 2));
  while (!ok()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out waiting');
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

const startCheck = {'action': 'teamSetupCheck', 'reason': 'startup'};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Daemon daemon;
  late AppNotifier app;
  /// Which daemon process answers this Mac: a new one after a restart, null
  /// when its status could not be read.
  String? running = 'pid-1';
  AppNotifier make(_Daemon daemon) {
    final app = createApp(connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    app.teamAccountHereForTest = true;
    app.daemonIdentityForTest = () async => running;
    app.teamOfferRetryForTest = const Duration(milliseconds: 1);
    return app;
  }

  setUp(() {
    running = 'pid-1';
    daemon = _Daemon();
    app = make(daemon);
  });
  tearDown(() => app.dispose());

  test('asks this Mac\'s own daemon whether it is wanted, and explains it only then', () async {
    final explained = <String>[];
    final listening = app.teamSetupAsks.listen(explained.add);
    await app.offerTeamAccount('join', tabId: 'tab-1');
    daemon.answer = {'ok': true, 'state': 'declined'};
    await app.offerTeamAccount('contribute');
    await pumpEventQueue();
    expect(daemon.asked, [
      {'action': 'teamSetupCheck', 'reason': 'join', 'tabId': 'tab-1'},
      {'action': 'teamSetupCheck', 'reason': 'contribute'},
    ]);
    expect(explained, ['join']);
    await listening.cancel();
  });

  test('sets it up when the person asks, and remembers "Not now"', () async {
    daemon.answer = {'ok': true, 'state': 'started'};
    expect(await app.setUpTeamAccount(), 'started');
    await app.declineTeamAccount();
    expect(daemon.asked, [
      {'action': 'teamSetup', 'reason': 'manual'},
      {'action': 'teamSetupDecline'},
    ]);
    expect(app.canSetUpTeamAccount, isTrue);
    app.teamAccountHereForTest = false;
    expect(app.canSetUpTeamAccount, isFalse);
    expect(await app.setUpTeamAccount(), 'unsupported');
  });

  test('a daemon too old to set it up from here says so', () async {
    daemon.answer = {'error': 'INVALID_REQUEST'};
    expect(await app.setUpTeamAccount(), 'update');
  });

  test(
    'asks nothing where the account cannot be made, or when the only machine here is another one',
    () async {
      app.teamAccountHereForTest = false;
      await app.offerTeamAccount('join');
      app.teamAccountHereForTest = true;
      app.machineStates['m']!.localOnly = false;
      await app.offerTeamAccount('join');
      expect(daemon.asked, isEmpty);
    },
  );

  // Linux and Windows make the same account a Mac does (plans of 2026-10-28);
  // a phone, a tablet and a browser never do.
  test('the account is offered on a Mac, Linux and Windows, nowhere else', () {
    for (final os in ['macos', 'linux', 'windows']) {
      expect(AppNotifier.teamAccountOn(os), isTrue, reason: os);
    }
    for (final os in ['web', 'ios', 'android', 'fuchsia']) {
      expect(AppNotifier.teamAccountOn(os), isFalse, reason: os);
    }
  });

  test('never for a machine shared with this account, at a join or at start', () async {
    final state = app.machineStates['m']!;
    state.machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Dee\'s computer',
      machineShare: const MachineShare(
        ownerName: 'Dee',
        ownerEmail: 'dee@acme.io',
        via: 'email',
        added: true,
      ),
    );
    expect(app.canSetUpTeamAccount, isFalse);
    await app.offerTeamAccount('join');
    app.onMachineConnectedForTest('m');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(daemon.asked, isEmpty);
  });

  test('a daemon that refuses or cannot say is left alone', () async {
    daemon.answer = {'error': 'UNKNOWN_ACTION'};
    await app.offerTeamAccount('join');
    expect(daemon.asked, hasLength(1));
  });

  test('checks once for each process of this Mac\'s daemon, as it connects', () async {
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.isNotEmpty);
    await pumpEventQueue();
    expect(daemon.asked, [startCheck]);
  });

  // Macs already in a Swarm met no join or contribute moment, and the one ask
  // a launch went to whichever daemon answered first: one still starting, or
  // the version from before an update, so nobody saw the prompt (2026-10-27).
  test('checks again when this Mac\'s daemon has restarted, which decides', () async {
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 1);
    await pumpEventQueue();
    // A new daemon process, after an update for instance: asked again.
    running = 'pid-2';
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 2);
    expect(daemon.asked, everyElement(startCheck));
  });

  // A start check runs for each daemon process, so a restart while the
  // explanation is still open must not show it a second time.
  test('explains at start once a launch, though a restarted daemon still wants it', () async {
    final explained = <String>[];
    final listening = app.teamSetupAsks.listen(explained.add);
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 1);
    await pumpEventQueue();
    running = 'pid-2';
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 2);
    await pumpEventQueue();
    expect(explained, ['startup']);
    // The person asking, by joining, is always explained.
    await app.offerTeamAccount('join');
    await pumpEventQueue();
    expect(explained, ['startup', 'join']);
    await listening.cancel();
  });

  test('checks one at a time', () async {
    final pending = Completer<Map<String, dynamic>>();
    daemon.queued.add(pending);
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.isNotEmpty);
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
    pending.complete({'ok': true, 'state': 'not-shared'});
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
  });

  // Review of #1790: every socket reconnect started a fresh budget, so a
  // daemon that could not answer was asked at the reconnect rate for good.
  test('keeps its budget across reconnects to the same daemon, and asks nothing more once it answered', () async {
    daemon.answer = {'error': 'SERVICE_UNAVAILABLE'};
    for (var i = 0; i < 20; i++) {
      app.onMachineConnectedForTest('m');
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    await until(() => daemon.asked.length == 5);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    // Five tries for one daemon, however often its socket reconnected.
    expect(daemon.asked, hasLength(5));
    // The same daemon, once it answered, is not asked on a reconnect.
    running = 'pid-2';
    daemon.answer = {'ok': true, 'state': 'not-shared'};
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 6);
    for (var i = 0; i < 5; i++) {
      app.onMachineConnectedForTest('m');
      await pumpEventQueue();
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(daemon.asked, hasLength(6));
  });

  // Re-check of #1790: a status read that timed out has no identity, which
  // counted as a new process, so a daemon whose status read now and then
  // timed out was asked without end.
  test('keeps its budget when the daemon\'s identity cannot be read', () async {
    daemon.answer = {'error': 'SERVICE_UNAVAILABLE'};
    for (var i = 0; i < 20; i++) {
      running = i.isEven ? 'pid-1' : null;
      app.onMachineConnectedForTest('m');
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    await until(() => daemon.asked.length == 5);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    // Five tries for the one daemon whose status read timed out in between.
    expect(daemon.asked, hasLength(5));
    // Only a different confirmed process starts over.
    running = 'pid-2';
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 6);
  });

  test('checks again, a few times, a daemon that could not answer yet', () async {
    daemon.queued.addAll([
      {'error': 'SERVICE_UNAVAILABLE'},
      {'error': 'SERVICE_UNAVAILABLE'},
    ]);
    app.onMachineConnectedForTest('m');
    // Two that could not say, then an answer.
    await until(() => daemon.asked.length == 3);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(daemon.asked, hasLength(3));
  });

  // Review of #1790: a request still out at dispose resumed and scheduled a
  // retry on a disposed app.
  test('schedules nothing after it is disposed, though a request was out', () async {
    final own = _Daemon();
    final other = make(own);
    final pending = Completer<Map<String, dynamic>>();
    own.queued.add(pending);
    other.onMachineConnectedForTest('m');
    await until(() => own.asked.isNotEmpty);
    other.dispose();
    pending.complete({'error': 'ACCOUNT_CHANGED'});
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(own.asked, hasLength(1));
  });

  Future<void> open(
    WidgetTester tester, {
    bool asked = false,
    String operatingSystem = 'macos',
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showTeamAccountSetup(
              context,
              app,
              asked: asked,
              operatingSystem: operatingSystem,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// The dialog's title and its three paragraphs, as shown.
  List<String> shown(WidgetTester tester) => [
    for (final text in tester.widgetList<Text>(
      find.descendant(
        of: find.byKey(const Key('team-account-setup')),
        matching: find.byType(Text),
      ),
    ))
      if (!const {'Not now', 'Cancel', 'Continue'}.contains(text.data))
        text.data!,
  ];

  /// What the dialog says once Continue was pressed, the daemon answering
  /// [answer].
  Future<String> outcome(
    WidgetTester tester,
    String operatingSystem,
    Map<String, dynamic> answer,
  ) async {
    daemon.answer = answer;
    await open(tester, operatingSystem: operatingSystem);
    await tester.tap(find.byKey(const Key('team-account-setup-continue')));
    await tester.pumpAndSettle();
    final said = tester
        .widget<Text>(find.byKey(const Key('team-account-setup-outcome')))
        .data!;
    await tester.tap(find.byKey(const Key('team-account-setup-done')));
    await tester.pumpAndSettle();
    return said;
  }

  const paragraph3 =
      'Your home folder becomes private to you. Your own agents work as before. '
      'To remove the account later, run harness team remove.';
  const computerParagraph1 =
      'Teammates\' agents in your Swarms run on this computer in a separate '
      'account, Harness Team. They cannot read your files or use your GitHub login. '
      'They use this computer\'s Claude Code and Codex subscriptions, so nobody signs in again.';

  testWidgets('on a Mac the dialog says what it always said', (tester) async {
    await open(tester);
    expect(shown(tester), [
      'Set up Harness Team on this Mac',
      'Teammates\' agents in your Swarms run on this Mac in a separate macOS '
          'account, Harness Team. They cannot read your files or use your GitHub login. '
          'They use this Mac\'s Claude Code and Codex subscriptions, so nobody signs in again.',
      'macOS asks for your password once, in a window titled “osascript”. '
          'That is the macOS tool Harness uses to ask.',
      paragraph3,
    ]);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(
      await outcome(tester, 'macos', {'ok': true, 'state': 'started'}),
      'macOS is asking for your password in a window titled “osascript”. '
      'Setup then takes a minute or two. This Mac\'s row updates when it is ready.',
    );
    expect(
      await outcome(tester, 'macos', {'ok': true, 'state': 'exists'}),
      'Harness Team is already set up on this Mac.',
    );
    expect(
      await outcome(tester, 'macos', {'error': 'INVALID_REQUEST'}),
      'This Mac\'s Harness is too old to set it up from here. Update Harness, '
      'or run harness team setup in Terminal.',
    );
    expect(
      await outcome(tester, 'macos', {'ok': true, 'state': 'unsupported'}),
      'Harness Team cannot be set up on this Mac right now.',
    );
  });

  testWidgets('on Linux the dialog says this computer, and the system asks for the password', (
    tester,
  ) async {
    await open(tester, operatingSystem: 'linux');
    expect(shown(tester), [
      'Set up Harness Team on this computer',
      computerParagraph1,
      'Your system asks for your password once.',
      paragraph3,
    ]);
    expect(find.text('Continue'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(
      await outcome(tester, 'linux', {'ok': true, 'state': 'started'}),
      'Your system is asking for your password. Setup then takes a minute or two. '
      'This computer\'s row updates when it is ready.',
    );
    // No desktop session to ask in (SSH): the terminal is the way.
    expect(
      await outcome(tester, 'linux', {'error': 'NO_PROMPT', 'detail': 'no polkit agent'}),
      'Run harness team setup in a terminal on this computer.',
    );
    expect(
      await outcome(tester, 'linux', {'ok': true, 'state': 'NO_PROMPT'}),
      'Run harness team setup in a terminal on this computer.',
    );
    expect(
      await outcome(tester, 'linux', {'ok': true, 'state': 'exists'}),
      'Harness Team is already set up on this computer.',
    );
    expect(
      await outcome(tester, 'linux', {'error': 'INVALID_REQUEST'}),
      'This computer\'s Harness is too old to set it up from here. Update Harness, '
      'or run harness team setup in a terminal.',
    );
    expect(
      await outcome(tester, 'linux', {'ok': true, 'state': 'unsupported'}),
      'Harness Team cannot be set up on this computer right now.',
    );
  });

  testWidgets('on Windows the dialog says this computer, and User Account Control asks', (
    tester,
  ) async {
    await open(tester, operatingSystem: 'windows', asked: true);
    expect(shown(tester), [
      'Set up Harness Team on this computer',
      computerParagraph1,
      'Windows asks for permission once (User Account Control).',
      paragraph3,
    ]);
    expect(find.text('Not now'), findsOneWidget);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    daemon.asked.clear();
    expect(
      await outcome(tester, 'windows', {'ok': true, 'state': 'started'}),
      'Windows is asking for permission. Setup then takes a minute or two. '
      'This computer\'s row updates when it is ready.',
    );
    expect(
      await outcome(tester, 'windows', {'ok': true, 'state': 'exists'}),
      'Harness Team is already set up on this computer.',
    );
    // A refusal says the daemon's own sentence, as on a Mac.
    expect(
      await outcome(tester, 'windows', {'error': 'NO_PROMPT', 'detail': 'The daemon\'s sentence.'}),
      'The daemon\'s sentence.',
    );
  });

  testWidgets(
    'explains the account and the "osascript" prompt before macOS asks',
    (tester) async {
      daemon.answer = {'ok': true, 'state': 'started'};
      await open(tester);
      expect(find.textContaining('separate macOS account'), findsOneWidget);
      expect(find.textContaining('titled “osascript”'), findsOneWidget);
      expect(daemon.asked, isEmpty);
      await tester.tap(find.byKey(const Key('team-account-setup-continue')));
      await tester.pumpAndSettle();
      expect(daemon.asked, [
        {'action': 'teamSetup', 'reason': 'manual'},
      ]);
      expect(
        find.byKey(const Key('team-account-setup-outcome')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('team-account-setup-done')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('team-account-setup')), findsNothing);
    },
  );

  testWidgets('"Not now" on an offer is remembered; Cancel on Set up is not', (
    tester,
  ) async {
    await open(tester, asked: true);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    await open(tester);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(daemon.asked, [
      {'action': 'teamSetupDecline'},
    ]);
  });
}
