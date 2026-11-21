import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/about_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/update/tauri_signature.dart';
import 'package:harness/update/update_signature.dart';
import 'package:harness/widgets/update_notice.dart';
import 'package:harness/measurement/product_runtime_health.dart';

import 'support/tauri_test_signer.dart';

class _UpdateHealth extends ProductRuntimeHealth {
  _UpdateHealth(super.measurement);
  String? expected;
  @override
  void expectUpdate(String version) => expected = version;
  @override
  void cancelUpdate() => expected = null;
}

/// A 45 MB build on a slow link used to look like a hang: the band said
/// "Installing…" behind an indeterminate bar. The manifest carries the exact
/// byte count, so the download can be counted — and is, in the one number the
/// banner, the dialog and Settings all read.
class _Installer extends DesktopUpdater {
  _Installer() : super(enabled: false);
  final staged = Completer<StagedUpdate?>();
  void Function(int received, int total)? progress;

  @override
  Future<StagedUpdate?> downloadAndStage(
    UpdateInfo info, {
    void Function(int received, int total)? onProgress,
  }) {
    progress = onProgress;
    return staged.future;
  }
}

/// Serves [bytes] for every request: a bucket holding a build someone else
/// put there.
class _Bucket implements HttpClientAdapter {
  _Bucket(this.bytes);
  final List<int> bytes;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => ResponseBody.fromBytes(bytes, 200);

  @override
  void close({bool force = false}) {}
}

const _update = UpdateInfo(
  version: '1.2.3',
  url: 'https://updates.example.test/1.2.3.zip',
  sha256: 'unused',
  size: 1000,
);

void main() {
  late _Installer installer;
  late AppNotifier app;

  setUp(() {
    installer = _Installer();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: installer,
    )..availableUpdate = _update;
  });
  tearDown(() => app.dispose());

  Future<void> startInstall(WidgetTester tester) async {
    unawaited(app.installAvailableUpdate());
    await tester.pump();
    expect(installer.progress, isNotNull, reason: 'the hook must be passed in');
  }

  test(
    'records the next-version flag during download and clears a failed stage',
    () async {
      app.productRuntimeHealth?.dispose();
      final health = _UpdateHealth(app.productMeasurement);
      app.productRuntimeHealth = health;
      final installing = app.installAvailableUpdate();
      await Future<void>.delayed(Duration.zero);
      expect(installer.progress, isNotNull);
      expect(health.expected, _update.version);
      installer.staged.complete(null);
      await installing;
      expect(health.expected, isNull);
    },
  );

  test('a refused signature reaches the banner in plain words', () async {
    final installing = app.installAvailableUpdate();
    await Future<void>.delayed(Duration.zero);
    installer.staged.completeError(notFromPublisher('Autonomous Inc.'));
    expect(await installing, isFalse);
    expect(
      app.updateError,
      'Could not install Harness 1.2.3: it is not signed by Autonomous Inc., '
      'who made the Harness you are using, so it may not be genuine. You are '
      'still on your current version.',
    );
  });

  // The manifest names the tampered build's sha256, so only the signature can
  // tell, and the person reads why nothing was installed.
  testWidgets('a Linux update Harness did not sign says so in the banner', (
    tester,
  ) async {
    final tampered = utf8.encode('an AppImage someone else built\n');
    final linux = (await tester.runAsync(() async {
      final signer = await TauriTestSigner.generate();
      final genuine = utf8.encode('the AppImage Harness built\n');
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        desktopUpdater: DesktopUpdater(
          isLinux: true,
          isWindows: false,
          enabled: true,
          releaseMode: true,
          architecture: 'x64',
          tauriPublicKey: signer.publicKey,
          dio: Dio()..httpClientAdapter = _Bucket(tampered),
        ),
      );
      notifier.availableUpdate = UpdateInfo(
        version: '1.2.3',
        url: 'https://updates.example.test/Harness-linux-x64.AppImage',
        sha256: await sha256HexOffUiIsolate(tampered),
        size: tampered.length,
        signature: await signer.sign(
          await blake2b512OfBytes(genuine),
          'timestamp:1\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3',
        ),
      );
      return notifier;
    }))!;
    addTearDown(linux.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: ListenableBuilder(
          listenable: linux,
          builder: (_, _) => UpdateNotice(notifier: linux),
        ),
      ),
    );

    // The download and its checks run on real I/O and isolates, which the
    // test clock does not drive.
    await tester.runAsync(() async {
      final failed = Completer<void>();
      void settle() {
        if (linux.updateError != null && !failed.isCompleted) failed.complete();
      }

      linux.addListener(settle);
      await tester.tap(find.byKey(const Key('install-update-button')));
      await failed.future.timeout(const Duration(seconds: 30));
      linux.removeListener(settle);
    });
    await tester.pump();

    expect(
      find.text(
        'Could not install Harness 1.2.3: it is not signed by Harness, so it '
        'may not be genuine. You are still on your current version.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('the banner counts the download, then goes quiet to unpack', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ListenableBuilder(
          listenable: app,
          builder: (_, _) => UpdateNotice(notifier: app),
        ),
      ),
    );
    expect(find.text('· 18 KB'), findsNothing);
    await startInstall(tester);

    LinearProgressIndicator bar() => tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey('update-progress-bar')),
    );
    // Nothing has arrived yet: no number to show, so the bar keeps moving.
    expect(bar().value, isNull);

    installer.progress!(420, 1000);
    await tester.pump();
    expect(find.text('· 42%'), findsOneWidget);
    expect(bar().value, closeTo(0.42, 0.001));
    expect(app.updateDownloadPercent, 42);

    // The bytes are all in; verifying and unpacking cannot be counted.
    installer.progress!(1000, 1000);
    await tester.pump();
    expect(find.textContaining('%'), findsNothing);
    expect(bar().value, isNull);
    expect(app.updateDownloadFraction, isNull);

    installer.staged.complete(null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Settings says the same number as the band', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => AboutSection(notifier: app),
          ),
        ),
      ),
    );
    await startInstall(tester);
    installer.progress!(70, 1000);
    await tester.pump();
    expect(find.text('Installing… 7%'), findsOneWidget);
    installer.staged.complete(null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the dialog counts along with the band behind it', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));
    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(check: DesktopUpdateCheck.available(_update)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Update'));
    await tester.pump();
    expect(installer.progress, isNotNull);

    installer.progress!(330, 1000);
    await tester.pump();
    expect(find.textContaining('Downloading… 33%'), findsOneWidget);
    installer.progress!(660, 1000);
    await tester.pump();
    expect(find.textContaining('Downloading… 66%'), findsOneWidget);
    // Unpacking has no number, so the sentence drops back to the plain one.
    installer.progress!(1000, 1000);
    await tester.pump();
    expect(find.textContaining('Downloading…'), findsNothing);
    expect(
      find.text('Don’t quit Harness. It will restart on its own.'),
      findsOneWidget,
    );

    installer.staged.complete(null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpWidget(const SizedBox());
    unawaited(dialog);
  });

  testWidgets('one repaint per whole percent, not per chunk', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));
    await startInstall(tester);
    var notifications = 0;
    void count() => notifications++;
    app.addListener(count);
    addTearDown(() => app.removeListener(count));
    // Three chunks inside the same percent: the band has nothing new to say.
    for (final received in [10, 12, 15]) {
      installer.progress!(received, 1000);
    }
    expect(notifications, 1);
    installer.progress!(25, 1000);
    expect(notifications, 2);
    installer.staged.complete(null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  });
}
