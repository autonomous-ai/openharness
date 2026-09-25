import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/settings/sections/about_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/widgets/update_notice.dart';

// Every request stops in this interceptor. No socket, download, or user file
// is involved; a held response lets two entry points ask at the same time.
class _Manifest {
  final requests = <(RequestOptions, RequestInterceptorHandler)>[];
  late final dio = Dio()
    ..interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add((options, handler));
        },
      ),
    );

  DesktopUpdater updater({bool enabled = true, bool releaseMode = true}) =>
      DesktopUpdater(
        enabled: enabled,
        dio: dio,
        releaseMode: releaseMode,
        isLinux: false,
        architecture: 'x64',
        metadataUrl: 'https://updates.example.test/metadata.json',
      );

  Future<void> waitForRequest(WidgetTester tester) async {
    for (var i = 0; i < 20 && requests.isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 1));
    }
    expect(requests, isNotEmpty);
  }

  void answer({String version = '1.0.4', Map<String, dynamic>? data}) {
    final (options, handler) = requests.removeAt(0);
    handler.resolve(
      Response(
        requestOptions: options,
        data:
            data ??
            <String, dynamic>{
              'desktop-macos': {
                'version': version,
                'url': 'https://updates.example.test/Harness.zip',
                'sha256': 'a' * 64,
                'size': 1024,
              },
            },
      ),
    );
  }

  void fail() {
    final (options, handler) = requests.removeAt(0);
    handler.reject(
      DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      ),
    );
  }
}

class _Installer extends DesktopUpdater {
  _Installer({this.refresh}) : super(enabled: false);

  /// What the manifest says when the install re-reads it. Null leaves the
  /// disabled updater's own answer, which no-ops the refresh — the shape of
  /// every test here that is not about it.
  final DesktopUpdateCheck? refresh;
  int refreshes = 0;
  final staged = Completer<StagedUpdate?>();
  UpdateInfo? requested;

  @override
  Future<DesktopUpdateCheck> check({String? currentVersion}) async {
    refreshes++;
    return refresh ?? await super.check(currentVersion: currentVersion);
  }

  /// The progress hook the real updater calls per chunk; tests drive it by
  /// hand to check what the UI makes of a number arriving mid-download.
  void Function(int received, int total)? progress;

  @override
  Future<StagedUpdate?> downloadAndStage(
    UpdateInfo info, {
    void Function(int received, int total)? onProgress,
  }) {
    requested = info;
    progress = onProgress;
    return staged.future;
  }
}

const _reviewedUpdate = UpdateInfo(
  version: '1.0.4',
  url: 'https://updates.example.test/1.0.4.zip',
  sha256: 'unused',
  size: 1024,
);
const _laterUpdate = UpdateInfo(
  version: '1.0.5',
  url: 'https://updates.example.test/1.0.5.zip',
  sha256: 'unused',
  size: 1024,
);

void main() {
  setUp(() {
    PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.0.0',
      buildNumber: '1',
      buildSignature: '',
    );
  });

  AppNotifier appFor(_Manifest manifest) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: manifest.updater(),
    );
    addTearDown(app.dispose);
    return app;
  }

  testWidgets('viewer builds never contact the desktop update service', (
    tester,
  ) async {
    final manifest = _Manifest();
    final session = AuthSession();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      viewer: ViewerServices(config: AppConfig.dev, session: session),
      desktopUpdater: manifest.updater(),
    );
    addTearDown(app.dispose);
    expect(app.updateChecksEnabled, isFalse);
    expect(
      (await app.checkForUpdates()).status,
      DesktopUpdateCheckStatus.disabled,
    );
    expect(manifest.requests, isEmpty);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AboutSection(notifier: app)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Updates off'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('two manual checks wait for the same answer', (tester) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    final first = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    var secondFinished = false;
    final second = app.checkForUpdates().then((result) {
      secondFinished = true;
      return result;
    });
    await tester.pump();
    final answeredEarly = secondFinished;
    expect(manifest.requests, hasLength(1));
    manifest.answer();
    await tester.pump();
    expect(
      answeredEarly,
      isFalse,
      reason: 'A second entry point must not report a stale answer.',
    );
    expect((await first).update?.version, '1.0.4');
    expect((await second).update?.version, '1.0.4');
  });

  testWidgets('an unreachable update service is not up to date', (
    tester,
  ) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    final check = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.fail();
    await tester.pump();
    final result = await check;
    expect(result.isUpToDate, isFalse);
  });

  testWidgets('the manual result explains a failed check', (tester) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: const Scaffold(body: Placeholder()),
      ),
    );
    final check = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.fail();
    await tester.pump();
    final result = await check;
    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      result,
    );
    await tester.pumpAndSettle();
    expect(find.text('Couldn’t check for updates'), findsOneWidget);
    expect(find.text('You’re up to date'), findsNothing);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    await dialog;
  });

  testWidgets(
    'About can retry a failed check and report the recovered result',
    (tester) async {
      final manifest = _Manifest();
      final app = appFor(manifest);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(body: AboutSection(notifier: app)),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Not checked'), findsOneWidget);
      expect(find.text('Up to date'), findsNothing);
      final button = find.byKey(const Key('settings-check-updates-button'));
      await tester.tap(button);
      await manifest.waitForRequest(tester);
      final menuCheck = checkForUpdatesAndShowResult(
        tester.element(find.byType(AboutSection)),
        app,
      );
      await tester.pump(const Duration(milliseconds: 1));
      expect(manifest.requests, hasLength(1));
      expect(app.isCheckingForUpdate, isTrue);
      manifest.fail();
      await tester.pumpAndSettle();
      expect(find.text('Check failed'), findsOneWidget);
      expect(find.text('Couldn’t check for updates'), findsOneWidget);
      expect(find.byType(Dialog), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await manifest.waitForRequest(tester);
      expect(find.text('Checking for updates…'), findsOneWidget);
      manifest.answer(version: '1.0.0');
      await tester.pumpAndSettle();
      expect(find.text('You’re up to date'), findsOneWidget);
      expect(find.text('Up to date'), findsOneWidget);
      expect(app.isCheckingForUpdate, isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await menuCheck;
      expect(find.byType(Dialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('closing a retry leaves no late dialog behind', (tester) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));
    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(check: DesktopUpdateCheck.failed()),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry'));
    await manifest.waitForRequest(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await dialog;
    manifest.answer();
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsNothing);
    expect(app.availableUpdate?.version, '1.0.4');
    expect(tester.takeException(), isNull);
  });

  testWidgets('manual and background checks share the request', (tester) async {
    final manifest = _Manifest();
    final updater = manifest.updater();
    final observed = <DesktopUpdateCheck>[];
    final timer = updater.startChecking(onCheckCompleted: observed.add);
    addTearDown(timer.cancel);
    await manifest.waitForRequest(tester);
    final manual = updater.check();
    await tester.pump(const Duration(milliseconds: 1));
    expect(manifest.requests, hasLength(1));
    manifest.answer();
    await tester.pump();
    expect((await manual).update?.version, '1.0.4');
    expect(observed.single.update?.version, '1.0.4');
    timer.cancel();
  });

  testWidgets(
    'background checks wait five minutes, avoid overlap, and stop after cancellation',
    (tester) async {
      final manifest = _Manifest();
      final observed = <DesktopUpdateCheck>[];
      final timer = manifest.updater().startChecking(
        onCheckCompleted: observed.add,
      );
      addTearDown(timer.cancel);
      await manifest.waitForRequest(tester);
      manifest.answer(version: '1.0.0');
      await tester.pump();
      expect(observed, hasLength(1));
      await tester.pump(const Duration(minutes: 4, seconds: 59));
      expect(manifest.requests, isEmpty);
      await tester.pump(const Duration(seconds: 1));
      await manifest.waitForRequest(tester);
      await tester.pump(const Duration(hours: 12));
      expect(manifest.requests, hasLength(1));
      expect(observed, hasLength(1));
      timer.cancel();
      manifest.answer();
      await tester.pump();
      expect(
        observed,
        hasLength(1),
        reason: 'Cancelled pollers cannot publish late replies.',
      );
    },
  );

  for (final disabled in [true, false]) {
    testWidgets(
      '${disabled ? 'Disabled' : 'Development'} builds do not claim to be current',
      (tester) async {
        final manifest = _Manifest();
        final result = await manifest
            .updater(enabled: !disabled, releaseMode: disabled)
            .check(currentVersion: '1.0.0');
        expect(result.status, DesktopUpdateCheckStatus.disabled);
        expect(manifest.requests, isEmpty);
        expect(ManualUpdateCheck(check: result).isUpToDate, isFalse);
      },
    );
  }

  for (final invalid in ['missing platform', 'invalid version']) {
    testWidgets('a manifest with $invalid is not an all-clear', (tester) async {
      final manifest = _Manifest();
      final check = manifest.updater().check(currentVersion: '1.0.0');
      await manifest.waitForRequest(tester);
      manifest.answer(
        data: invalid == 'missing platform' ? {} : null,
        version: 'not-a-version',
      );
      await tester.pump();
      expect((await check).status, DesktopUpdateCheckStatus.failed);
    });
  }

  testWidgets('manual checks can offer a skipped version again', (
    tester,
  ) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    final first = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.answer();
    await tester.pump();
    expect((await first).isSkipped, isFalse);
    await app.skipAvailableUpdate();
    expect(app.availableUpdate, isNull);
    final again = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.answer();
    await tester.pump();
    expect((await again).isSkipped, isTrue);
    expect(app.availableUpdate?.version, '1.0.4');
  });

  testWidgets('a failed recheck keeps the known offer and install error', (
    tester,
  ) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    final first = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.answer();
    await tester.pump();
    await first;
    app.updateError = 'Could not download this version.';
    final next = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.fail();
    await tester.pump();
    expect((await next).status, DesktopUpdateCheckStatus.failed);
    expect(app.availableUpdate?.version, '1.0.4');
    expect(app.updateError, 'Could not download this version.');
  });

  testWidgets('a valid current manifest clears a withdrawn offer', (
    tester,
  ) async {
    final manifest = _Manifest();
    final app = appFor(manifest);
    final first = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.answer();
    await tester.pump();
    await first;
    final next = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    manifest.answer(version: '1.0.0');
    await tester.pump();
    expect((await next).isUpToDate, isTrue);
    expect(app.availableUpdate, isNull);
  });

  testWidgets('a disposed app ignores an in-flight update result', (
    tester,
  ) async {
    final manifest = _Manifest();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: manifest.updater(),
    );
    final check = app.checkForUpdates();
    await manifest.waitForRequest(tester);
    app.dispose();
    manifest.answer();
    await tester.pump();
    await check;
    expect(app.availableUpdate, isNull);
    expect(app.lastUpdateCheck, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Update installs the newest build, not the one that was on screen',
    (tester) async {
      // One press has to be enough. Installing what the dialog opened on, and
      // then being offered the next version on the way back, is two updates for
      // one thing — which is what this used to do on purpose.
      final installer = _Installer(
        refresh: const DesktopUpdateCheck.available(_laterUpdate),
      );
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        desktopUpdater: installer,
      )..availableUpdate = _reviewedUpdate;
      addTearDown(app.dispose);
      await tester.pumpWidget(const MaterialApp(home: Placeholder()));
      final dialog = showUpdateCheckDialog(
        tester.element(find.byType(Placeholder)),
        app,
        const ManualUpdateCheck(
          check: DesktopUpdateCheck.available(_reviewedUpdate),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Update'));
      await tester.pump();
      // The dialog names the build going in, not the one that was reviewed.
      expect(find.textContaining('Installing Harness 1.0.5'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 200));
      final stayedOpen = find.byType(Dialog).evaluate().length == 1;
      installer.staged.complete(null);
      await tester.pumpAndSettle();
      await dialog;
      expect(stayedOpen, isTrue);
      expect(installer.requested?.version, '1.0.5');
      expect(app.updateError, contains('1.0.5'));
      expect(app.availableUpdate?.version, '1.0.5');
      expect(find.byType(Dialog), findsNothing);
    },
  );

  testWidgets('a manifest that cannot be read installs what was offered', (
    tester,
  ) async {
    // Refusing an update because the network blinked would be worse than
    // installing bytes that still have to match their own sha256.
    final installer = _Installer(refresh: const DesktopUpdateCheck.failed());
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _reviewedUpdate;
    addTearDown(app.dispose);
    final install = app.installAvailableUpdate();
    await tester.pump();
    installer.staged.complete(null);
    expect(await install, isFalse);
    expect(installer.refreshes, 1);
    expect(installer.requested?.version, '1.0.4');
    expect(app.availableUpdate?.version, '1.0.4');
  });

  testWidgets('a build pulled from the channel is not installed', (
    tester,
  ) async {
    final installer = _Installer(refresh: const DesktopUpdateCheck.upToDate());
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _reviewedUpdate;
    addTearDown(app.dispose);
    expect(await app.installAvailableUpdate(), isFalse);
    expect(installer.requested, isNull, reason: 'nothing was downloaded');
    expect(app.availableUpdate, isNull);
    // Nothing failed, and there is no offer left for a banner to carry an
    // error on; the dialog below is what tells the person.
    expect(app.updateError, isNull);
  });

  testWidgets('the dialog says you are up to date when the build was pulled', (
    tester,
  ) async {
    final installer = _Installer(refresh: const DesktopUpdateCheck.upToDate());
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _reviewedUpdate;
    addTearDown(app.dispose);
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));
    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(
        check: DesktopUpdateCheck.available(_reviewedUpdate),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Update'));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget, reason: 'it does not vanish');
    expect(find.textContaining('up to date'), findsWidgets);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await dialog;
  });

  testWidgets('Update does not jump to a version the person skipped', (
    tester,
  ) async {
    // Pressing Update on 1.0.4 is not consent to 1.0.5, which they said no to.
    final installer = _Installer(
      refresh: const DesktopUpdateCheck.available(_laterUpdate),
    );
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _laterUpdate;
    addTearDown(app.dispose);
    await app.skipAvailableUpdate(update: _laterUpdate);
    app.availableUpdate = _reviewedUpdate;
    final install = app.installAvailableUpdate();
    await tester.pump();
    installer.staged.complete(null);
    expect(await install, isFalse);
    expect(installer.requested?.version, '1.0.4');
  });

  testWidgets('a manifest that went backwards cannot downgrade the offer', (
    tester,
  ) async {
    final installer = _Installer(
      refresh: const DesktopUpdateCheck.available(
        UpdateInfo(
          version: '1.0.3',
          url: 'https://updates.example.test/1.0.3.zip',
          sha256: 'unused',
          size: 1024,
        ),
      ),
    );
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _reviewedUpdate;
    addTearDown(app.dispose);
    final install = app.installAvailableUpdate();
    await tester.pump();
    installer.staged.complete(null);
    expect(await install, isFalse);
    expect(installer.requested?.version, '1.0.4');
  });

  testWidgets('Skip uses the reviewed version without hiding a newer offer', (
    tester,
  ) async {
    final app = appFor(_Manifest())..availableUpdate = _reviewedUpdate;
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));
    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(
        check: DesktopUpdateCheck.available(_reviewedUpdate),
      ),
    );
    await tester.pumpAndSettle();
    app.availableUpdate = _laterUpdate;
    await tester.tap(find.text('Skip 1.0.4'));
    await tester.pumpAndSettle();
    await dialog;
    expect(app.availableUpdate?.version, '1.0.5');
  });
}
