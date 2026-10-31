/// The sign-in page names this computer (Scholes's end-to-end test of Desktop
/// 1.3.44, finding 5): every relaunch showed the bare page, with nothing about
/// a computer the app already knows. The bottom bar's line now says which
/// computer this is, and that Harness is set up on it when it was there before
/// this launch. Only this computer's own name is ever shown: no account, no
/// other machine. `HARNESS_SIGN_IN_CAPTURE_DIR` writes the three lines in both
/// themes.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/sign_in_step.dart';

import 'support/capture.dart';

final _line = find.byKey(const Key('sign-in-step-ready-line'));
final _boundary = GlobalKey();

String _lineText(WidgetTester tester) => tester.widget<Text>(_line).data!;

Machine _machine(String id, String? name) => Machine(
  machineId: id,
  name: name,
  computerId: 'computer-$id',
  authMode: MachineAuthMode.remote,
  status: 'online',
);

AppNotifier _app() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
)..status = AppStatus.authenticated;

void _thisComputer(AppNotifier app, String? name) {
  final machine = _machine('local', name);
  app.machines = [...app.machines, machine];
  app.machineStates['local'] = MachineState(machine)..localOnly = true;
}

void _otherMachine(AppNotifier app, String name) {
  final machine = _machine('other', name);
  app.machines = [...app.machines, machine];
  app.machineStates['other'] = MachineState(machine);
}

Future<void> _mountPage(
  WidgetTester tester, {
  required String readyLine,
  Brightness brightness = Brightness.dark,
  bool finishing = false,
  bool sessionExpired = false,
  bool signingOut = false,
}) async {
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: RepaintBoundary(
        key: _boundary,
        child: SignInStep(
          onSignIn: (_) {},
          onApprove: (_) {},
          readyLine: readyLine,
          finishing: finishing,
          sessionExpired: sessionExpired,
          signingOut: signingOut,
        ),
      ),
    ),
  );
  await tester.pump();
}

Future<void> _mountScreen(WidgetTester tester, AppNotifier app) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SignInStepScreen(app: app),
    ),
  );
  await tester.pump();
}

void main() {
  setUpAll(
    () => loadCaptureFonts(Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR']),
  );

  group('the line', () {
    test('a computer Harness was on before: set up, and its name', () {
      expect(
        signInStepReadyLine(computerName: 'Studio', setUp: true),
        'This Mac (Studio) is set up. Sign in to continue.',
      );
    });

    test('a first run: its name', () {
      expect(
        signInStepReadyLine(computerName: 'Studio'),
        'This Mac: Studio. Sign in to continue.',
      );
    });

    test('no name known yet', () {
      expect(signInStepReadyLine(), 'Sign in to continue.');
      expect(signInStepReadyLine(computerName: '  '), 'Sign in to continue.');
      expect(
        signInStepReadyLine(setUp: true),
        'This Mac is set up. Sign in to continue.',
      );
    });

    test('Linux and Windows say computer', () {
      expect(
        signInStepReadyLine(computerName: 'box', setUp: true, mac: false),
        'This computer (box) is set up. Sign in to continue.',
      );
      expect(
        signInStepReadyLine(computerName: 'box', mac: false),
        'This computer: box. Sign in to continue.',
      );
    });
  });

  group('the page', () {
    testWidgets('shows the line in its bottom bar', (tester) async {
      const line = 'This Mac (Studio) is set up. Sign in to continue.';
      await _mountPage(tester, readyLine: line);
      expect(_lineText(tester), line);
      expect(tester.takeException(), isNull);
    });

    testWidgets('what is under way still wins over it', (tester) async {
      const line = 'This Mac: Studio. Sign in to continue.';
      await _mountPage(tester, readyLine: line, finishing: true);
      expect(_lineText(tester), 'Signing in…');
      await _mountPage(tester, readyLine: line, signingOut: true);
      expect(_lineText(tester), 'Signing out…');
      await _mountPage(tester, readyLine: line, sessionExpired: true);
      expect(
        _lineText(tester),
        'Your session ended. Sign in again to continue.',
      );
    });

    for (final brightness in Brightness.values) {
      for (final (name, line) in [
        ('set-up', signInStepReadyLine(computerName: 'Studio', setUp: true)),
        ('first-run', signInStepReadyLine(computerName: 'Studio')),
        ('no-name', signInStepReadyLine()),
      ]) {
        testWidgets('draws the $name line in ${brightness.name}', (
          tester,
        ) async {
          await _mountPage(tester, readyLine: line, brightness: brightness);
          expect(tester.takeException(), isNull);
          expect(_lineText(tester), line);
          await captureBoundary(
            tester,
            _boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR'],
            'sign-in-machine-$name-${brightness.name}',
          );
        });
      }
    }
  });

  group('on the app', () {
    String expected(String? name, {required bool setUp}) => signInStepReadyLine(
      computerName: name,
      setUp: setUp,
      mac: RuntimePlatform.isMacOS,
    );

    testWidgets('names this computer by its own row, without .local', (
      tester,
    ) async {
      final app = _app();
      addTearDown(app.dispose);
      _thisComputer(app, 'Studio.local');
      expect(app.thisComputerName, 'Studio');
      await _mountScreen(tester, app);
      // Nothing installed Harness on this launch in a test: it was set up.
      expect(_lineText(tester), expected('Studio', setUp: true));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a name a person chose stays as it is', (tester) async {
      final app = _app();
      addTearDown(app.dispose);
      _thisComputer(app, 'Ken’s Studio');
      expect(app.thisComputerName, 'Ken’s Studio');
    });

    testWidgets('never another machine’s name', (tester) async {
      final app = _app();
      addTearDown(app.dispose);
      _otherMachine(app, 'Someone else’s laptop');
      _thisComputer(app, 'Studio');
      await _mountScreen(tester, app);
      expect(_lineText(tester), isNot(contains('laptop')));
      expect(_lineText(tester), expected('Studio', setUp: true));

      // With no row of its own yet, the host name stands in — still never
      // the other machine.
      app.machineStates.remove('local');
      app.machines = [app.machines.first];
      expect(app.thisComputerName, isNot(contains('laptop')));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('follows this computer’s row as it arrives and changes', (
      tester,
    ) async {
      final app = _app();
      addTearDown(app.dispose);
      await _mountScreen(tester, app);
      final before = _lineText(tester);
      expect(before, isNot(contains('Studio-2')));

      _thisComputer(app, 'Studio-2');
      app.notifyListeners();
      await tester.pump();
      expect(_lineText(tester), expected('Studio-2', setUp: true));

      // A sign-out clears the rows: the old row's name goes with them.
      app.machineStates.clear();
      app.machines = [];
      app.notifyListeners();
      await tester.pump();
      expect(_lineText(tester), isNot(contains('Studio-2')));
      await tester.pumpWidget(const SizedBox());
    });
  });
}
