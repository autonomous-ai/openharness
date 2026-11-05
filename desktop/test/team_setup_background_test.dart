// #3169 (Scholes, 2026-11-05): after the password, Harness Team setup took 5 to 7 minutes and held the whole app. It now
// runs in the background: the lock steps aside once the password is accepted, this Mac's row in Machines says the step
// and the time left, and a notice says when it is ready or failed, with Retry. Nothing here opens a socket, signs the
// CLI in or out, or makes a macOS account: the daemon's answers are a fake's.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/team_account_setup.dart';

import 'support/capture.dart';
import 'support/rename_connection.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// This Mac's daemon for the Harness Team account's actions.
class _Daemon extends RenameConnection {
  final asked = <String>[];
  Map<String, dynamic> check = {'ok': true, 'state': 'wanted'};
  Map<String, dynamic> run = {'ok': true, 'state': 'started'};

  /// `teamSetupStatus`, in turn; the last one repeats.
  final statuses = <Map<String, dynamic>>[
    {'ok': true, 'state': 'running'},
  ];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final action = '${payload['action']}';
    if (type == 'super_tabs' && action.startsWith('teamSetup')) {
      asked.add(action);
      return switch (action) {
        'teamSetupCheck' => check,
        'teamSetup' => run,
        'teamSetupStatus' =>
          statuses.length > 1 ? statuses.removeAt(0) : statuses.single,
        _ => {'ok': true},
      };
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Map<String, dynamic> _running(String step, {int elapsedMs = 20000}) => {
  'ok': true,
  'state': 'running',
  'step': step,
  'elapsedMs': elapsedMs,
};

/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['TEAM_SETUP_SHOTS'];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => loadCaptureFonts(shots));
  late _Daemon daemon;
  late AppNotifier app;

  setUp(() {
    daemon = _Daemon();
    app = createApp(connectionForTest: (_) => daemon, connected: true);
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.machineStates['m']!.localOnly = true;
    app.teamAccountHereForTest = true;
  });
  tearDown(() => app.dispose());

  group('the time left', () {
    test('four steps, from the eight setup says', () {
      expect(
        [
          for (final step in [
            'password',
            'account',
            'home',
            'privacy',
            'runtime',
            'copy-engines',
            'engines',
            'sign-in',
            'daemon',
            'report',
            'something-new',
          ])
            teamSetupPhase(step),
        ],
        [null, 1, 1, 1, 2, 2, 2, 3, 3, 4, null],
      );
    });

    test('from the measured step times, never nothing while it runs', () {
      // The npm download is the long one (4 min 18 s on 2026-11-04); the copy that replaced it takes seconds.
      expect(
        teamSetupLine('engines', Duration.zero),
        'Harness Team: setting up · step 2 of 4 · about 4 min left',
      );
      expect(
        teamSetupLine('copy-engines', Duration.zero),
        'Harness Team: setting up · step 2 of 4 · less than a minute left',
      );
      expect(
        teamSetupLine('account', Duration.zero),
        'Harness Team: setting up · step 1 of 4 · less than a minute left',
      );
      expect(
        teamSetupLine('engines', const Duration(minutes: 2)),
        'Harness Team: setting up · step 2 of 4 · about 2 min left',
      );
      // Past what it usually takes (a slow network), it still says a minute is left, never zero.
      expect(
        teamSetupLine('engines', const Duration(minutes: 9)),
        'Harness Team: setting up · step 2 of 4 · about 1 min left',
      );
      expect(
        teamSetupLine('report', const Duration(minutes: 9)),
        'Harness Team: setting up · step 4 of 4 · less than a minute left',
      );
      // A step this app does not know yet: setting up, without a number it cannot give.
      expect(
        teamSetupLine('something-new', Duration.zero),
        'Harness Team: setting up',
      );
    });
  });

  group('in the background', () {
    final messenger = GlobalKey<ScaffoldMessengerState>();
    var taps = 0;

    /// The window as app_shell.dart builds it, the lock above the Navigator, with this Mac's row in Machines when
    /// [server] is given.
    /// Its Swarm's controller, for [unmount].
    dynamic shown;

    Future<void> window(
      WidgetTester tester, {
      ConversationServer? server,
    }) async {
      taps = 0;
      final c = server?.controller(account: 'owner');
      shown = c;
      if (c != null) await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          scaffoldMessengerKey: messenger,
          builder: (context, child) => TeamAccountSetupLock(
            app: app,
            operatingSystem: 'macos',
            child: child!,
          ),
          home: Scaffold(
            body: Column(
              children: [
                TextButton(
                  key: const Key('behind-button'),
                  onPressed: () => taps++,
                  child: const Text('Behind'),
                ),
                if (c != null)
                  Expanded(
                    child: SuperTabMachines(
                      controller: c,
                      app: app,
                      onAddAgent: (_) {},
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
    }

    ConversationServer swarm() {
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'MacBooks-MacBook-Pro-7',
          'contributorId': 'owner',
          'scope': 'swarm',
          'cwd': '/swarm',
          'engines': ['codex'],
          'maxAgents': 4,
          'paused': false,
          'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
          'teamWork': {
            'allowed': false,
            'code': 'TEAM_ACCOUNT_REQUIRED',
            'reason': 'Refused.',
          },
        },
      ];
      return server;
    }

    Future<void> continueSetup(WidgetTester tester) async {
      await app.offerTeamAccount('join', tabId: 'tab-1');
      await tester.pump();
      await tester.tap(find.byKey(const Key('team-account-lock-continue')));
      await tester.pump();
    }

    testWidgets(
      'once the password is accepted the lock steps aside and the app takes clicks, while setup still runs',
      (tester) async {
        daemon.statuses
          ..clear()
          ..addAll([_running('password'), _running('engines')]);
        await window(tester);
        await continueSetup(tester);
        // While macOS asks for the password, the lock waits with it.
        await tester.pump(const Duration(seconds: 2));
        expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
        await tester.tap(
          find.byKey(const Key('behind-button')),
          warnIfMissed: false,
        );
        expect(taps, 0);
        // The password is in: setup goes on behind, and the app is the person's again.
        await tester.pump(const Duration(seconds: 2));
        expect(find.byKey(const Key('team-account-lock')), findsNothing);
        expect(app.teamSetupLocked, isTrue);
        await tester.tap(find.byKey(const Key('behind-button')));
        expect(taps, 1);
        expect(TeamSetupWatch.of(app)!.running, isTrue);
      },
    );

    testWidgets(
      'this Mac\'s row says the step and the time left, and that the person can keep working',
      (tester) async {
        daemon.statuses
          ..clear()
          ..add(_running('engines'));
        await window(tester, server: swarm());
        await continueSetup(tester);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(
          tester
              .widget<Text>(
                find.byKey(const ValueKey('super-machine-problem-m')),
              )
              .data,
          'Harness Team: setting up · step 2 of 4 · about 4 min left\n'
          'Keep working. We\'ll tell you when it\'s ready.',
        );
        // Nothing to press while it runs: Set up would ask for the password again.
        expect(
          find.byKey(const ValueKey('super-machine-team-setup-m')),
          findsNothing,
        );
        // Past the row's arrival fade, for the picture.
        await tester.pump(const Duration(milliseconds: 1500));
        await captureWindow(tester, shots, 'row-setting-up');
        await tester.pumpWidget(const SizedBox());
        await shown.flush();
        shown.dispose();
      },
    );

    testWidgets(
      'a setup that finishes says so, and the lock is gone for good',
      (tester) async {
        daemon.statuses
          ..clear()
          ..addAll([
            _running('engines'),
            {'ok': true, 'state': 'exists'},
          ]);
        await window(tester);
        await continueSetup(tester);
        await tester.pump(const Duration(seconds: 2));
        expect(find.byKey(const Key('team-account-lock')), findsNothing);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(
          find.text(
            'Harness Team is ready on this Mac. Teammates\' agents can run here now.',
          ),
          findsOneWidget,
        );
        expect(app.teamSetupLocked, isFalse);
        expect(find.byKey(const Key('team-account-lock')), findsNothing);
        await captureWindow(tester, shots, 'notice-ready');
        // Nothing is read once it has ended.
        final reads = daemon.asked.where((a) => a == 'teamSetupStatus').length;
        await tester.pump(const Duration(seconds: 10));
        expect(
          daemon.asked.where((a) => a == 'teamSetupStatus'),
          hasLength(reads),
        );
      },
    );

    testWidgets(
      'a setup that fails after the lock stepped aside brings it back, with the reason and Try again',
      (tester) async {
        daemon.statuses
          ..clear()
          ..addAll([
            _running('engines'),
            {
              'ok': true,
              'state': 'failed',
              'detail': 'launchd would not start the team daemon',
            },
          ]);
        await window(tester);
        await continueSetup(tester);
        await tester.pump(const Duration(seconds: 2));
        expect(find.byKey(const Key('team-account-lock')), findsNothing);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
        expect(
          tester
              .widget<Text>(find.byKey(const Key('team-account-lock-outcome')))
              .data,
          'Setup did not finish: launchd would not start the team daemon.',
        );
        expect(
          find.byKey(const Key('team-account-lock-retry')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'started from this Mac\'s row, a failure is a notice with the reason and Retry, and Retry starts it again',
      (tester) async {
        daemon.statuses
          ..clear()
          ..addAll([
            _running('runtime'),
            {'ok': true, 'state': 'failed', 'detail': 'dscl exited 64.'},
          ]);
        await window(tester);
        expect(app.teamSetupLocked, isFalse);
        // What the row's Set up does once its dialog's Continue has started setup.
        TeamSetupWatch.of(app)!.follow();
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(
          find.text('Harness Team setup did not finish. dscl exited 64.'),
          findsOneWidget,
        );
        await captureWindow(tester, shots, 'notice-failed');
        daemon.statuses
          ..clear()
          ..add(_running('password'));
        await tester.tap(find.byKey(const Key('team-setup-notice-retry')));
        await tester.pump();
        await tester.pump();
        expect(daemon.asked.where((a) => a == 'teamSetup'), hasLength(1));
        expect(TeamSetupWatch.of(app)!.running, isTrue);
        messenger.currentState?.clearSnackBars();
      },
    );

    testWidgets('a closed password window, from the row, says so with Retry', (
      tester,
    ) async {
      daemon.statuses
        ..clear()
        ..add({'ok': true, 'state': 'declined'});
      await window(tester);
      TeamSetupWatch.of(app)!.follow();
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(
        find.text(
          'Harness Team setup did not finish. The password window was closed.',
        ),
        findsOneWidget,
      );
      expect(find.byKey(const Key('team-setup-notice-retry')), findsOneWidget);
      messenger.currentState?.clearSnackBars();
    });
  });
}
