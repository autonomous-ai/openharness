import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';

import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/team_account_setup.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// This Mac's daemon for the Harness Team account's actions; no socket is
/// opened, and nothing is set up or signed out.
class _Daemon extends RenameConnection {
  final asked = <String>[];

  /// `teamSetupCheck`: whether the account is wanted here.
  Map<String, dynamic> check = {'ok': true, 'state': 'wanted'};

  /// `teamSetup` (`manual`): what starting it answers.
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

/// Never the real CLI: nothing here may sign this Mac out.
class _FakeCli extends CliLogin {
  @override
  Future<void> logout() async {}

  @override
  Future<CliAuthStatus> checkStatus() async => CliAuthStatus(loggedIn: true);
}

/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['TEAM_ACCOUNT_LOCK_SHOTS'];

const _wrongPassword =
    'The Harness Team account was not finished: The administrator user name or '
    'password was incorrect. (-60005). Run `harness team setup` again; it repairs what is there.';

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

  final navigator = GlobalKey<NavigatorState>();
  var taps = 0, shortcuts = 0;
  late FocusNode behind;

  /// The app's window as app_shell.dart builds it: the lock above the
  /// Navigator, so it covers every route and dialog too.
  Future<void> window(WidgetTester tester, AppNotifier app) async {
    taps = 0;
    shortcuts = 0;
    behind = FocusNode(debugLabel: 'behind');
    addTearDown(behind.dispose);
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        builder: (context, child) => TeamAccountSetupLock(
          app: app,
          operatingSystem: 'macos',
          child: child!,
        ),
        home: Scaffold(
          body: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
                  shortcuts++,
            },
            child: Column(
              children: [
                TextButton(
                  key: const Key('behind-button'),
                  focusNode: behind,
                  autofocus: true,
                  onPressed: () => taps++,
                  child: const Text('Behind'),
                ),
                const TextField(key: Key('behind-field')),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> lock(WidgetTester tester) async {
    await app.offerTeamAccount('join', tabId: 'tab-1');
    await tester.pump();
    expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
  }

  /// Whether the focused widget sits under [finder].
  bool focusedIn(Finder finder) {
    final focused = FocusManager.instance.primaryFocus?.context;
    if (focused == null) return false;
    return finder.evaluate().any(
      (element) =>
          element == focused ||
          (focused as Element).debugGetDiagnosticChain().contains(element),
    );
  }

  /// Every label in the semantics tree a screen reader walks.
  List<String> spoken(WidgetTester tester) {
    final labels = <String>[];
    void walk(SemanticsNode node) {
      if (node.label.isNotEmpty) labels.add(node.label);
      node.visitChildren((child) {
        walk(child);
        return true;
      });
    }

    final root =
        tester.binding.rootPipelineOwner.semanticsOwner?.rootSemanticsNode;
    if (root != null) walk(root);
    for (final view in tester.binding.renderViews) {
      final node = view.owner?.semanticsOwner?.rootSemanticsNode;
      if (node != null) walk(node);
    }
    return labels;
  }

  String outcome(WidgetTester tester) => tester
      .widget<Text>(find.byKey(const Key('team-account-lock-outcome')))
      .data!;

  testWidgets('unlocked, it is not there and the app takes input', (
    tester,
  ) async {
    await window(tester, app);
    expect(find.byKey(const Key('team-account-lock')), findsNothing);
    await tester.tap(find.byKey(const Key('behind-button')));
    expect(taps, 1);
  });

  testWidgets(
    'locked, nothing behind it takes a click, a key or focus, a dialog included',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await window(tester, app);
      // A dialog open before the join, as a menu item's would be.
      var dialogTaps = 0;
      navigator.currentState!.push(
        DialogRoute<void>(
          context: navigator.currentContext!,
          builder: (_) => Dialog(
            child: TextButton(
              key: const Key('dialog-button'),
              onPressed: () => dialogTaps++,
              child: const Text('In a dialog'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await lock(tester);

      await tester.tap(
        find.byKey(const Key('behind-button')),
        warnIfMissed: false,
      );
      await tester.tap(
        find.byKey(const Key('dialog-button')),
        warnIfMissed: false,
      );
      await tester.tap(
        find.byKey(const Key('behind-field')),
        warnIfMissed: false,
      );
      await tester.pump();
      expect(taps, 0);
      expect(dialogTaps, 0);

      for (var i = 0; i < 8; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        expect(focusedIn(find.byKey(const Key('team-account-lock'))), isTrue);
      }
      // Something behind asks for focus by itself (a terminal on output, a
      // dialog opening): it does not get it, and Enter presses nothing there.
      behind.requestFocus();
      await tester.pump();
      expect(focusedIn(find.byKey(const Key('team-account-lock'))), isTrue);
      navigator.currentState!.push(
        DialogRoute<void>(
          context: navigator.currentContext!,
          builder: (_) => Dialog(
            child: TextButton(
              key: const Key('late-dialog-button'),
              autofocus: true,
              onPressed: () => dialogTaps++,
              child: const Text('Opened while locked'),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(focusedIn(find.byKey(const Key('team-account-lock'))), isTrue);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(shortcuts, 0);
      expect(taps, 0);
      expect(dialogTaps, 0);

      // A screen reader reads only the lock.
      final read = spoken(tester);
      expect(read.join('\n'), contains('Set up Harness Team on this Mac'));
      expect(read.join('\n'), isNot(contains('Behind')));
      expect(read.join('\n'), isNot(contains('In a dialog')));
      semantics.dispose();

      // Set up: the app is as it was, its dialogs still open over it.
      await app.teamAccountMade();
      await tester.pump();
      expect(find.byKey(const Key('team-account-lock')), findsNothing);
      await tester.tap(find.byKey(const Key('late-dialog-button')));
      expect(dialogTaps, 1);
    },
  );

  testWidgets('there is no way to close it', (tester) async {
    await window(tester, app);
    await lock(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.tapAt(const Offset(4, 4));
    await tester.pump();
    expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
    for (final label in ['Cancel', 'Not now', 'Close', 'OK']) {
      expect(find.text(label), findsNothing, reason: label);
    }
    expect(find.byKey(const Key('team-account-lock-remove')), findsNothing);
    expect(
      find.textContaining('This Mac joined a Swarm, so it needs Harness Team'),
      findsOneWidget,
    );
  });

  testWidgets('Continue starts setup, and success opens the app', (
    tester,
  ) async {
    daemon.statuses
      ..clear()
      ..addAll([
        {'ok': true, 'state': 'running'},
        {'ok': true, 'state': 'exists'},
      ]);
    await window(tester, app);
    await lock(tester);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pump();
    expect(daemon.asked, ['teamSetupCheck', 'teamSetup']);
    expect(
      outcome(tester),
      'macOS is asking for your password in a window titled “osascript”. '
      'Setup then takes a minute or two, and Harness opens when it is done.',
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.byKey(const Key('team-account-lock')), findsNothing);
    expect(app.teamSetupLocked, isFalse);
    await tester.tap(find.byKey(const Key('behind-button')));
    expect(taps, 1);
  });

  testWidgets('a Mac with the account already opens the app at Continue', (
    tester,
  ) async {
    daemon.run = {'ok': true, 'state': 'exists'};
    await window(tester, app);
    await lock(tester);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('team-account-lock')), findsNothing);
  });

  testWidgets('a wrong password says so, and Try again asks again', (
    tester,
  ) async {
    daemon.statuses
      ..clear()
      ..add({'ok': true, 'state': 'failed', 'detail': _wrongPassword});
    await window(tester, app);
    await lock(tester);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(outcome(tester), 'macOS did not accept that password. Try again.');
    expect(find.byKey(const Key('team-account-lock-remove')), findsNothing);
    daemon.statuses
      ..clear()
      ..add({'ok': true, 'state': 'running'});
    await tester.tap(find.byKey(const Key('team-account-lock-retry')));
    await tester.pump();
    expect(daemon.asked.where((a) => a == 'teamSetup'), hasLength(2));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('another failure says the daemon\'s sentence, with Try again', (
    tester,
  ) async {
    daemon.statuses
      ..clear()
      ..add({'ok': true, 'state': 'failed', 'detail': 'dscl exited 64.'});
    await window(tester, app);
    await lock(tester);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(outcome(tester), 'Setup did not finish: dscl exited 64.');
    expect(find.byKey(const Key('team-account-lock-retry')), findsOneWidget);
  });

  testWidgets(
    'a closed password window offers Try again and, for a Mac without an administrator, the way out',
    (tester) async {
      daemon.statuses
        ..clear()
        ..add({'ok': true, 'state': 'declined'});
      await window(tester, app);
      await lock(tester);
      await tester.tap(find.byKey(const Key('team-account-lock-continue')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(
        outcome(tester),
        'The password window was closed before setup finished.',
      );
      expect(find.byKey(const Key('team-account-lock-retry')), findsOneWidget);
      expect(
        find.text(
          'No administrator password for this Mac? Remove it from the Swarm. '
          'You can add it again from Machines.',
        ),
        findsOneWidget,
      );
      expect(find.text('Remove this Mac from the Swarm'), findsOneWidget);
    },
  );

  testWidgets(
    'where setup can never finish, it says why and offers only the way out',
    (tester) async {
      daemon.run = {'error': 'INVALID_REQUEST'};
      await window(tester, app);
      await lock(tester);
      await tester.tap(find.byKey(const Key('team-account-lock-continue')));
      await tester.pump();
      await tester.pump();
      expect(
        outcome(tester),
        'This Mac\'s Harness is too old to set it up from here. Update Harness, '
        'or run harness team setup in Terminal.',
      );
      expect(find.byKey(const Key('team-account-lock-retry')), findsNothing);
      expect(find.byKey(const Key('team-account-lock-remove')), findsOneWidget);
    },
  );

  testWidgets('Harness unreachable says so, with Try again', (tester) async {
    daemon.run = {'error': 'SERVICE_UNAVAILABLE'};
    await window(tester, app);
    await lock(tester);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('team-account-lock-retry')), findsOneWidget);
    expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
  });

  testWidgets('Remove this Mac from the Swarm removes it and opens the app', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.teamAccountHereForTest = true;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.teamCheck = {'state': 'wanted'};
    f.connection.teamRun = {'state': 'unsupported'};
    await f.app.offerTeamAccount('join', tabId: tabId);
    await window(tester, f.app);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pumpAndSettle();
    expect(
      outcome(tester),
      'Harness Team cannot be set up on this Mac right now.',
    );
    await tester.tap(find.byKey(const Key('team-account-lock-remove')));
    await tester.pumpAndSettle();
    expect(
      f.connection.server.posts.map((p) => p['command']),
      contains(equals({'type': 'machine.remove', 'machineId': 'm'})),
    );
    expect(find.byKey(const Key('team-account-lock')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.app.superTabs.dispose();
    f.dispose();
    await tester.pump();
  });

  testWidgets('a removal the Swarm refuses says why, and the lock stays', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.teamAccountHereForTest = true;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.teamCheck = {'state': 'wanted'};
    f.connection.teamRun = {'state': 'unsupported'};
    await f.app.offerTeamAccount('join', tabId: tabId);
    f.connection.server.refuse = {
      'code': 'FORBIDDEN',
      'message': 'Only the Swarm owner can do that.',
    };
    await window(tester, f.app);
    await tester.tap(find.byKey(const Key('team-account-lock-continue')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('team-account-lock-remove')));
    await tester.pumpAndSettle();
    expect(find.text('Only the Swarm owner can do that.'), findsOneWidget);
    expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    f.app.superTabs.dispose();
    f.dispose();
    await tester.pump();
  });

  testWidgets(
    'the app\'s own window is held, its screen still mounted under it',
    (tester) async {
      final own = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCli(),
        connectionForTest: (_) => daemon,
      );
      addTearDown(own.dispose);
      const machine = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'Test host',
      );
      own.machines = [machine];
      own.machineStates['m'] = MachineState(machine)
        ..localOnly = true
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      own.teamAccountHereForTest = true;
      own.status = AppStatus.authenticated;
      own.currentUser = const CurrentUserProfile(
        id: 'owner',
        email: 'owner@example.com',
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(own)],
          child: HarnessApp(
            authenticatedScreen: (_) => const SizedBox(key: Key('screen')),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('team-account-lock')), findsNothing);
      await own.offerTeamAccount('join', tabId: 'tab-1');
      await tester.pump();
      expect(find.byKey(const Key('team-account-lock')), findsOneWidget);
      expect(find.byKey(const Key('screen')), findsOneWidget);
    },
  );

  // The window as people see it, over a stand-in for the app behind it.
  final scenes = <(String, Future<void> Function(WidgetTester))>[
    ('1-on-join', (_) async {}),
    (
      '2-macos-asking',
      (tester) async {
        await tester.tap(find.byKey(const Key('team-account-lock-continue')));
        await tester.pump();
        // Far enough into the spinner's turn that its arc shows.
        await tester.pump(const Duration(milliseconds: 600));
      },
    ),
    (
      '3-wrong-password',
      (tester) async {
        daemon.statuses
          ..clear()
          ..add({'ok': true, 'state': 'failed', 'detail': _wrongPassword});
        await tester.tap(find.byKey(const Key('team-account-lock-continue')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 2));
      },
    ),
    (
      '4-password-window-closed',
      (tester) async {
        daemon.statuses
          ..clear()
          ..add({'ok': true, 'state': 'declined'});
        await tester.tap(find.byKey(const Key('team-account-lock-continue')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 2));
      },
    ),
    (
      '5-cannot-set-up-here',
      (tester) async {
        daemon.run = {'error': 'INVALID_REQUEST'};
        await tester.tap(find.byKey(const Key('team-account-lock-continue')));
        await tester.pump();
        await tester.pump();
      },
    ),
  ];
  for (final brightness in Brightness.values) {
    for (final (name, arrange) in scenes) {
      testWidgets('picture $name (${brightness.name})', (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
        await tester.binding.setSurfaceSize(const Size(1000, 700));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) => TeamAccountSetupLock(
              app: app,
              operatingSystem: 'macos',
              child: child!,
            ),
            home: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Pilot', style: grid.AppType.title()),
                    const SizedBox(height: 12),
                    for (final line in [
                      'Lead: the plan for the release is in the thread.',
                      'Ken: Looks good, go ahead.',
                      'Builder: PR #2779 is ready for review.',
                    ])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(line, style: grid.AppType.body()),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
        await lock(tester);
        await arrange(tester);
        await captureWindow(tester, shots, '$name-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        debugDefaultTargetPlatformOverride = null;
      }, skip: shots == null);
    }
  }
}
