import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

class _Recorder extends SilentSystemNotices {
  final posted = <({String key, String title, String body})>[];

  @override
  Future<void> showAccountNotice({
    required String key,
    required String title,
    required String body,
  }) async => posted.add((key: key, title: title, body: body));
}

DeviceRemovalNotice _notice({
  bool selfRemoved = false,
  bool signerPending = false,
  String signerLabel = 'Pixel',
}) => DeviceRemovalNotice(
  pub: 'gone-pub',
  label: 'iPad',
  kind: 'viewer',
  fingerprint: 'AAAA·BBBB',
  signer: 'signer-pub',
  signerLabel: signerLabel,
  signerFingerprint: 'E2FB·0DF5',
  signerPending: signerPending,
  selfRemoved: selfRemoved,
  at: 0,
);

/// A device taken out of the account by another device is announced once, and a red one opens the
/// signer, not the removed device.
void main() {
  late _Recorder notices;
  late AppNotifier app;

  setUp(() {
    notices = _Recorder();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      systemNotices: notices,
    );
  });
  tearDown(() => app.dispose());

  test('removed by a known device: its own key, neutral copy', () {
    app.announceDeviceRemoval(_notice());
    expect(app.deviceRemovals, hasLength(1));
    expect(notices.posted.single.key, 'removed:gone-pub');
    expect(notices.posted.single.title, 'Device removed');
    expect(
      notices.posted.single.body,
      'iPad was removed from your account by Pixel.',
    );
  });

  test('signed out', () {
    app.announceDeviceRemoval(_notice(selfRemoved: true));
    expect(notices.posted.single.title, 'Device signed out');
    expect(notices.posted.single.body, 'iPad signed out of your account.');
  });

  test(
    'removed by a new device: red copy, keyed by signer and removed device',
    () {
      app.announceDeviceRemoval(_notice(signerPending: true));
      expect(notices.posted.single.key, 'removedBy:signer-pub:gone-pub');
      expect(notices.posted.single.title, 'Removed by a new device');
      expect(
        notices.posted.single.body,
        'iPad was removed from your account by a new device you haven’t looked at '
        '(Pixel · E2FB·0DF5…).',
      );
    },
  );

  test('a device that signed itself out is never red, though it was new', () {
    app.announceDeviceRemoval(_notice(selfRemoved: true, signerPending: true));
    expect(notices.posted.single.key, 'removed:gone-pub');
    expect(notices.posted.single.title, 'Device signed out');
  });

  test('blank names read as "A device" and "another device"', () {
    app.announceDeviceRemoval(
      DeviceRemovalNotice(
        pub: 'gone-pub',
        label: '  ',
        kind: 'viewer',
        fingerprint: '',
        signer: 'signer-pub',
        signerLabel: '',
        signerFingerprint: '',
        signerPending: false,
        selfRemoved: false,
        at: 0,
      ),
    );
    expect(
      notices.posted.single.body,
      'A device was removed from your account by another device.',
    );
  });

  test('the same removal is announced once; dismissing clears it', () {
    app.announceDeviceRemoval(_notice());
    app.announceDeviceRemoval(_notice());
    expect(notices.posted, hasLength(1));
    var notified = 0;
    app.addListener(() => notified++);
    app.dismissDeviceRemoval('gone-pub');
    expect(app.deviceRemovals, isEmpty);
    expect(notified, 1);
  });

  test('removals by one signer get distinct keys, none equal to the signer’s '
      'new-device key', () {
    app.announceDeviceRemoval(_notice(signerPending: true));
    app.announceDeviceRemoval(
      DeviceRemovalNotice(
        pub: 'gone-2',
        label: 'Mac',
        kind: 'machine',
        fingerprint: '',
        signer: 'signer-pub',
        signerLabel: 'Pixel',
        signerFingerprint: 'E2FB·0DF5',
        signerPending: true,
        selfRemoved: false,
        at: 0,
      ),
    );
    final keys = [for (final p in notices.posted) p.key];
    expect(keys, [
      'removedBy:signer-pub:gone-pub',
      'removedBy:signer-pub:gone-2',
    ]);
    expect(keys, isNot(contains('signer-pub')));
  });

  test('a session lost at runtime drops the account’s device notices', () {
    app.announceDeviceRemoval(_notice());
    app.newDevices.add(
      const DevLogMember(
        pub: 'p',
        kind: 'viewer',
        machineId: '',
        label: 'x',
        addedAt: 0,
        seq: 1,
      ),
    );
    // Only a signed-in app signs out at runtime.
    app.status = AppStatus.authenticated;
    app.authFailureForTest('gone');
    expect(app.deviceRemovals, isEmpty);
    expect(app.newDevices, isEmpty);
  });
}
