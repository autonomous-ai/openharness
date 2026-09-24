import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/about_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/widgets/update_notice.dart';

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
