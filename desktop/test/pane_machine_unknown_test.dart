// What a pane says when its machine is not in the list.
//
// "Waiting for this machine to answer…" is only honest while there is something to wait FOR. When the
// machine LIST itself could not be read, the machine is not slow — it is unknown, and a spinner that
// never ends tells the user nothing and offers them nothing. This is the difference between those two.
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  final lists = <Completer<List<Machine>>>[];

  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() {
    final result = Completer<List<Machine>>();
    lists.add(result);
    return result.future;
  }
}

class _Cli extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: true);
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl}) async {}
  @override
  Future<void> logout() async {}
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

class _App extends AppNotifier {
  _App(_Api api)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        cliLogin: _Cli(),
        localCliDiscovery: _Discovery(),
        configStore: null,
      ) {
    this.api = api;
  }
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _waiting = 'Waiting for this machine to answer…';
const _unavailable =
    'This machine isn’t available. Check that it’s still linked to your account.';
const _unconfirmed =
    'Could not confirm this machine’s status. Retry to reconnect.';

/// Run the refresh chain until it has actually asked for the list.
///
/// It must be `pump`, not `await`ing a signal from the stub: inside `testWidgets` the clock is fake, and
/// awaiting a bare future parks the test on a chain that only `pump` can advance — the whole test then
/// hangs until its timeout. Pumping frames is what drives it.
Future<void> _untilRequested(WidgetTester tester, _Api api, int count) async {
  for (var i = 0; i < 20 && api.lists.length < count; i++) {
    await tester.pump(Duration.zero);
  }
  expect(
    api.lists.length,
    greaterThanOrEqualTo(count),
    reason: 'the machine list was never requested',
  );
}

Future<void> _pump(
  WidgetTester tester,
  AppNotifier app, {
  Brightness brightness = Brightness.dark,
  double scale = 1,
  GlobalKey? boundary,
}) async {
  grid.AppTheme.brightness.value = brightness;
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => PaneGrid(notifier: app, swarmMode: false),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  late _Api api;
  late _App app;
  late bool disposed;
  late Brightness previousBrightness;

  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  setUp(() {
    previousBrightness = grid.AppTheme.brightness.value;
    api = _Api();
    app = _App(api);
    disposed = false;
    app.status = AppStatus.authenticated;
    // A pane restored from the saved layout: it knows its machineId, and nothing else does yet.
    app.panes.add(TerminalPane(id: 0, machineId: 'm', agentId: 'a0'));
  });

  tearDown(() {
    if (!disposed) app.dispose();
    grid.AppTheme.brightness.value = previousBrightness;
  });

  // A failed load leaves the automatic recovery timer armed (by design — it is what gets the list back).
  // The widget-test binding checks for pending timers when the BODY ends, before tearDown runs, so a test
  // that deliberately ends in the failed state has to close the notifier itself.
  void end() {
    app.dispose();
    disposed = true;
  }

  testWidgets('keeps waiting while the list has simply not arrived', (
    tester,
  ) async {
    await _pump(tester, app);
    expect(find.text(_waiting), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    end();
  });

  testWidgets(
    'says the machine is unknown, and offers a retry, once the list fails',
    (tester) async {
      final retry = app.retryMachines();
      await _untilRequested(tester, api, 1);
      api.lists.single.completeError(
        ApiException('Could not reach the Harness backend', status: 502),
      );
      await retry;
      await _pump(tester, app);

      expect(find.text(_waiting), findsNothing);
      expect(
        find.text('Could not load machines. Retry to reconnect.'),
        findsOneWidget,
      );
      expect(find.byIcon(Icons.cloud_off), findsOneWidget);

      // And the button reaches the same reload the error strip's RETRY does.
      expect(api.lists, hasLength(1));
      await tester.tap(find.text('Retry'));
      await _untilRequested(tester, api, 2);
      end();
    },
  );

  testWidgets('explains when a recovered list does not contain the machine', (
    tester,
  ) async {
    final failed = app.retryMachines();
    await _untilRequested(tester, api, 1);
    api.lists.single.completeError(ApiException('boom', status: 502));
    await failed;
    await _pump(tester, app);
    expect(find.byIcon(Icons.cloud_off), findsOneWidget);

    final ok = app.retryMachines();
    await _untilRequested(tester, api, 2);
    api.lists.last.complete(const []);
    await ok;
    await _pump(tester, app);

    // A completed list with no matching machine cannot promise an answer.
    expect(find.text(_unavailable), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text(kUntitledPane), findsOneWidget);
    expect(find.text('a0'), findsNothing);
    end();
  });

  testWidgets('a fresh empty inventory ends the indefinite waiting state', (
    tester,
  ) async {
    final refresh = app.refreshMachines();
    await _untilRequested(tester, api, 1);
    await _pump(tester, app);
    expect(find.text(_waiting), findsOneWidget);
    api.lists.single.complete(const []);
    await refresh;
    await tester.pump();

    expect(find.text(_unavailable), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
    end();
  });

  testWidgets(
    'a cached empty inventory does not claim the machine is missing',
    (tester) async {
      final refresh = app.refreshMachines();
      await _untilRequested(tester, api, 1);
      api.lists.single.complete(MachineInventory([], isStale: true));
      await refresh;
      await _pump(tester, app);

      expect(find.text(_unconfirmed), findsOneWidget);
      expect(find.text(_unavailable), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Retry'), findsOneWidget);
      end();
    },
  );

  testWidgets('Retry keeps keyboard focus during and after a refresh', (
    tester,
  ) async {
    final refresh = app.refreshMachines();
    await _untilRequested(tester, api, 1);
    api.lists.single.complete(const []);
    await refresh;
    await _pump(tester, app);
    final resting = tester.getRect(find.widgetWithText(TextButton, 'Retry'));

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _untilRequested(tester, api, 2);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text(_unavailable), findsOneWidget);
    expect(tester.getRect(find.widgetWithText(TextButton, 'Retry')), resting);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(api.lists, hasLength(2), reason: 'a pending retry is coalesced');

    api.lists.last.complete(const []);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _untilRequested(tester, api, 3);
    expect(find.text('Retry'), findsOneWidget);
    end();
  });

  testWidgets('an account change clears the completed inventory state', (
    tester,
  ) async {
    final refresh = app.refreshMachines();
    await _untilRequested(tester, api, 1);
    api.lists.single.complete(const []);
    await refresh;
    await app.logout();
    app.status = AppStatus.authenticated;
    app.panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0'));
    await _pump(tester, app);

    expect(find.text(_waiting), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    end();
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      for (final state in ['missing', 'cached', 'failed']) {
        testWidgets('small pane recovery $state in $brightness at $scale', (
          tester,
        ) async {
          tester.view.physicalSize = const Size(440, 240);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          final retry = app.retryMachines();
          await _untilRequested(tester, api, 1);
          if (state == 'failed') {
            api.lists.single.completeError(
              ApiException('fixture outage', status: 502),
            );
          } else {
            api.lists.single.complete(
              MachineInventory([], isStale: state == 'cached'),
            );
          }
          await retry;
          final boundary = GlobalKey();
          await _pump(
            tester,
            app,
            brightness: brightness,
            scale: scale,
            boundary: boundary,
          );
          expect(tester.takeException(), isNull);
          final action = find.widgetWithText(TextButton, 'Retry');
          expect(action, findsOneWidget);
          expect(tester.getRect(action).bottom, lessThanOrEqualTo(240));
          final output = Platform.environment['HARNESS_PANE_CAPTURE_DIR'];
          if (output != null) {
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            await tester.runAsync(() async {
              final image = await render.toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(output).create(recursive: true);
              await File('$output/$state-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }
          end();
        });
      }
    }
  }
}
