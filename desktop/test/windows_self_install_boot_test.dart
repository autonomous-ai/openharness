import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/bootstrap/windows_self_install.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:path/path.dart' as p;

class _NeedsSetup extends EnvironmentProvisioner {
  _NeedsSetup() : super(isMacOS: true);
  var asked = false;

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    asked = true;
    final waiting = EnvironmentReadiness.initial();
    onProgress(waiting);
    return waiting;
  }
}

class _UpdateProbe extends DesktopUpdater {
  _UpdateProbe({this.onStart})
    : super(releaseMode: true, isWindows: true, architecture: 'x64');
  final void Function()? onStart;
  var asked = false;
  var checkCalls = 0;

  @override
  Future<DesktopUpdateCheck> check({String? currentVersion}) async {
    checkCalls++;
    return const DesktopUpdateCheck.upToDate();
  }

  @override
  Timer startChecking({
    Duration interval = DesktopUpdater.checkInterval,
    void Function(UpdateInfo info)? onUpdateAvailable,
    void Function(DesktopUpdateCheck result)? onCheckCompleted,
    String? currentVersion,
  }) {
    asked = true;
    onStart?.call();
    return Timer(const Duration(days: 1), () {});
  }
}

void main() {
  late Directory dir;
  late String exe;
  late String zip;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('self-install-boot-');
    zip = p.join(dir.path, 'Downloads', 'harness-desktop-1.2.3-windows-x64');
    Directory(p.join(zip, 'app', '1.2.3')).createSync(recursive: true);
    exe = p.join(zip, 'app', '1.2.3', 'harness-desktop.exe');
    File(exe).writeAsStringSync('');
    File(p.join(zip, 'Harness.exe')).writeAsStringSync('');
    File(p.join(zip, 'current')).writeAsStringSync('1.2.3\r\n');
  });

  tearDown(() => dir.deleteSync(recursive: true));

  AppNotifier app({
    required _NeedsSetup provisioner,
    required _UpdateProbe updater,
    required List<int> exits,
    Object? failStart,
    String? executablePath,
    Future<void> Function(String)? cleanUp,
  }) => AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    environmentProvisioner: provisioner,
    cliLogin: CliLogin(),
    desktopUpdater: updater,
    windowsSelfInstall: WindowsSelfInstall(
      isWindows: true,
      releaseMode: true,
      executablePath: executablePath ?? exe,
      installRoot: p.join(dir.path, 'Programs', 'Harness'),
      pid: 4242,
      start: (command, args) async {
        if (failStart != null) throw failStart;
      },
      cleanUp: cleanUp ?? (_) async {},
    ),
    exitApp: exits.add,
  );

  test('zip handover exits before updater and provisioning', () async {
    final provisioner = _NeedsSetup();
    final updater = _UpdateProbe();
    final exits = <int>[];
    final notifier = app(
      provisioner: provisioner,
      updater: updater,
      exits: exits,
    );
    addTearDown(notifier.dispose);
    await notifier.bootstrap();
    expect(exits, [0]);
    expect(updater.asked, isFalse);
    expect(provisioner.asked, isFalse);
    expect(notifier.status, AppStatus.bootstrapping);
  });

  test(
    'installed startup snapshots cleanup before polling without waiting',
    () async {
      final install = p.join(dir.path, 'Programs', 'Harness');
      final folder = Directory(p.join(install, 'app', '1.2.3'))
        ..createSync(recursive: true);
      final installedExe = p.join(folder.path, 'harness-desktop.exe');
      File(installedExe).writeAsStringSync('');
      File(p.join(install, 'Harness.exe')).writeAsStringSync('');
      File(p.join(install, 'current')).writeAsStringSync('1.2.3\r\n');
      final events = <String>[];
      final pendingCleanup = Completer<void>();
      final provisioner = _NeedsSetup();
      final updater = _UpdateProbe(onStart: () => events.add('poll'));
      final notifier = app(
        provisioner: provisioner,
        updater: updater,
        exits: <int>[],
        executablePath: installedExe,
        cleanUp: (_) {
          events.add('cleanup');
          return pendingCleanup.future;
        },
      );
      addTearDown(notifier.dispose);
      await notifier.bootstrap();
      expect(events, ['cleanup', 'poll']);
      expect(provisioner.asked, isTrue);
      pendingCleanup.complete();
      await notifier.windowsSelfInstall!.lastCleanUp;
    },
  );

  test('failed spawn continues with setup', () async {
    final provisioner = _NeedsSetup();
    final updater = _UpdateProbe();
    final exits = <int>[];
    final notifier = app(
      provisioner: provisioner,
      updater: updater,
      exits: exits,
      failStart: const ProcessException('Harness.exe', [], 'denied', 5),
    );
    addTearDown(notifier.dispose);
    await notifier.bootstrap();
    expect(exits, isEmpty);
    expect(updater.asked, isFalse);
    expect(provisioner.asked, isTrue);
    expect(notifier.status, isNot(AppStatus.bootstrapping));
  });

  test('failed zip handover cannot check or apply an update', () async {
    final provisioner = _NeedsSetup();
    final updater = _UpdateProbe();
    expect(updater.canCheck, isTrue);
    final exits = <int>[];
    final notifier = app(
      provisioner: provisioner,
      updater: updater,
      exits: exits,
      failStart: const ProcessException('Harness.exe', [], 'denied', 5),
    );
    addTearDown(notifier.dispose);
    await notifier.bootstrap();
    expect(provisioner.asked, isTrue);
    expect(exits, isEmpty);
    expect(updater.asked, isFalse);
    expect(notifier.updateChecksEnabled, isFalse);
    expect(
      (await notifier.checkForUpdates()).check.status,
      DesktopUpdateCheckStatus.disabled,
    );
    const staleOffer = UpdateInfo(
      version: '2.0.0',
      url: 'https://example.invalid/update.zip',
      sha256: '',
      size: 1,
    );
    expect(await notifier.installAvailableUpdate(update: staleOffer), isFalse);
    expect(updater.checkCalls, 0);
  });

  test(
    'installed copy without launcher provisions but cannot update',
    () async {
      final install = p.join(dir.path, 'Programs', 'Harness');
      final folder = Directory(p.join(install, 'app', '1.2.3'))
        ..createSync(recursive: true);
      final installedExe = p.join(folder.path, 'harness-desktop.exe');
      File(installedExe).writeAsStringSync('');
      File(p.join(install, 'current')).writeAsStringSync('1.2.3\r\n');
      final provisioner = _NeedsSetup();
      final updater = _UpdateProbe();
      final exits = <int>[];
      final cleaned = <String>[];
      final notifier = app(
        provisioner: provisioner,
        updater: updater,
        exits: exits,
        executablePath: installedExe,
        cleanUp: (root) async => cleaned.add(root),
      );
      addTearDown(notifier.dispose);

      await notifier.bootstrap();

      expect(provisioner.asked, isTrue);
      expect(exits, isEmpty);
      expect(cleaned, isEmpty);
      expect(updater.asked, isFalse);
      expect(notifier.updateChecksEnabled, isFalse);
      expect(
        (await notifier.checkForUpdates()).check.status,
        DesktopUpdateCheckStatus.disabled,
      );
      const staleOffer = UpdateInfo(
        version: '2.0.0',
        url: 'https://example.invalid/update.zip',
        sha256: '',
        size: 1,
      );
      expect(
        await notifier.installAvailableUpdate(update: staleOffer),
        isFalse,
      );
      expect(updater.checkCalls, 0);
    },
  );

  test('missing pointer also falls through to normal boot', () async {
    File(p.join(zip, 'current')).deleteSync();
    final provisioner = _NeedsSetup();
    final updater = _UpdateProbe();
    final exits = <int>[];
    final notifier = app(
      provisioner: provisioner,
      updater: updater,
      exits: exits,
    );
    addTearDown(notifier.dispose);
    await notifier.bootstrap();
    expect(exits, isEmpty);
    expect(updater.asked, isFalse);
    expect(provisioner.asked, isTrue);
  });
}
