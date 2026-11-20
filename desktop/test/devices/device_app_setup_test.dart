import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/devices/device_app_offer.dart';
import 'package:harness/devices/device_app_setup.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/update/update_signature.dart';

import '../support/device_app.dart';

const _bundle = '/t/Harness Device.app';
const _desktop = '/Applications/Harness.app';
const _signer = MacSigner(
  team: '54DJVWMJCC',
  identifier: 'ai.autonomous.harness',
  name: 'Autonomous Inc.',
);

const _setupExe =
    r'C:\Users\Nguyễn Văn A\AppData\Local\Temp\h\Harness-Device-setup.exe';
const _desktopExe =
    r'C:\Users\Nguyễn Văn A\AppData\Local\Programs\Harness\app\1.3.91\harness-desktop.exe';
const _ours = WindowsSigner(
  status: 'Valid',
  subject:
      'CN=AUTONOMOUS INC., O=AUTONOMOUS INC., L=Redlands, S=California, C=US',
  identity: '1.3.6.1.4.1.311.97.585055327.208923272.208213867.148721407',
);
const _unsigned = WindowsSigner(status: 'NotSigned', subject: '', identity: '');

/// The Windows check of [_setupExe] when Desktop is signed by [desktop] and
/// the installer by [installer]; each read is added to [reads].
Future<bool> _windowsCheck({
  required WindowsSigner desktop,
  required WindowsSigner installer,
  List<String>? reads,
}) => deviceAppInstallerSignedLikeDesktop(
  _setupExe,
  runningExe: () => _desktopExe,
  read: ({required file, required runningExe}) async {
    reads?.add('file: $file, runningExe: $runningExe');
    return (running: desktop, file: installer);
  },
);

AppNotifier _app({DeviceAppOffer? offer}) => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
  deviceAppOffer: offer,
);

void main() {
  group('the signature check', () {
    test('a Desktop with no signer keeps the sha256 check alone', () async {
      var verified = 0;
      final signed = await deviceAppSignedLikeDesktop(
        _bundle,
        runningBundle: () => _desktop,
        readSigner: (_) async => null,
        verify: ({required bundle, required team, required identifier}) async {
          verified++;
          return false;
        },
      );
      expect(signed, isTrue);
      expect(verified, 0);
    });

    test(
      "a signed Desktop asks for its own team and Harness Device's identifier",
      () async {
        final read = <String>[];
        final calls = <String>[];
        var answer = true;
        Future<bool> check() => deviceAppSignedLikeDesktop(
          _bundle,
          runningBundle: () => _desktop,
          readSigner: (bundle) async {
            read.add(bundle);
            return _signer;
          },
          verify:
              ({required bundle, required team, required identifier}) async {
                calls.add(
                  'bundle: $bundle, team: $team, '
                  'identifier: $identifier',
                );
                return answer;
              },
        );

        expect(await check(), isTrue);
        answer = false;
        expect(await check(), isFalse);
        expect(read, [_desktop, _desktop], reason: 'the running Desktop');
        expect(calls, [
          for (var i = 0; i < 2; i++)
            'bundle: /t/Harness Device.app, team: 54DJVWMJCC, '
                'identifier: ai.autonomous.harness.device',
        ]);
      },
    );

    test('a Desktop whose bundle or signer cannot be read refuses', () async {
      var read = 0, verified = 0;
      Future<bool> neverVerify({
        required String bundle,
        required String team,
        required String identifier,
      }) async {
        verified++;
        return true;
      }

      expect(
        await deviceAppSignedLikeDesktop(
          _bundle,
          runningBundle: () => null,
          readSigner: (_) async {
            read++;
            return _signer;
          },
          verify: neverVerify,
        ),
        isFalse,
      );
      expect(read, 0);
      expect(
        await deviceAppSignedLikeDesktop(
          _bundle,
          runningBundle: () => _desktop,
          readSigner: (_) async => throw cannotCheckSignature,
          verify: neverVerify,
        ),
        isFalse,
      );
      expect(verified, 0);
    });

    test(
      'windows: a Desktop with no signature keeps the sha256 check alone',
      () async {
        expect(
          await _windowsCheck(desktop: _unsigned, installer: _unsigned),
          isTrue,
        );
      },
    );

    test('windows: an installer signed by Desktop\'s signer passes', () async {
      final reads = <String>[];
      expect(
        await _windowsCheck(desktop: _ours, installer: _ours, reads: reads),
        isTrue,
      );
      expect(reads, ['file: $_setupExe, runningExe: $_desktopExe']);
    });

    // A manifest someone else wrote can name any installer with a matching
    // sha256; on Windows Desktop runs it, so only our signer may have made it.
    test(
      'windows: an installer signed by someone else, or not at all, is refused',
      () async {
        const lookalike = WindowsSigner(
          status: 'Valid',
          subject: 'CN=AUTONOMOUS INC., O=AUTONOMOUS INC., L=Redlands, S=California, C=US',
          identity: '1.3.6.1.4.1.311.97.1.2.3.4',
        );
        const changed = WindowsSigner(
          status: 'HashMismatch',
          subject: 'CN=AUTONOMOUS INC., O=AUTONOMOUS INC., L=Redlands, S=California, C=US',
          identity:
              '1.3.6.1.4.1.311.97.585055327.208923272.208213867.148721407',
        );
        for (final installer in [lookalike, _unsigned, changed]) {
          expect(
            await _windowsCheck(desktop: _ours, installer: installer),
            isFalse,
            reason: installer.status,
          );
        }
      },
    );

    test('windows: a Desktop whose signature is broken refuses', () async {
      for (final status in ['HashMismatch', 'Unreadable']) {
        expect(
          await _windowsCheck(
            desktop: WindowsSigner(
              status: status,
              subject: _ours.subject,
              identity: _ours.identity,
            ),
            installer: _ours,
          ),
          isFalse,
          reason: status,
        );
      }
    });

    test('windows: a signature that cannot be read refuses', () async {
      expect(
        await deviceAppInstallerSignedLikeDesktop(
          _setupExe,
          runningExe: () => _desktopExe,
          read: ({required file, required runningExe}) async =>
              throw cannotCheckSignature,
        ),
        isFalse,
      );
    });
  });

  group('the app owns the offer', () {
    testWidgets('the app feeds the offer the dial and the window', (
      tester,
    ) async {
      final fixture = DeviceAppFixture();
      final app = _app(offer: fixture.offer);
      addTearDown(app.dispose);

      app.dial.apply(const DialStatus(attached: true));
      await tester.pump();
      expect(fixture.probe.lookups, 1);
      expect(app.deviceAppOffer.state, DeviceAppOfferState.offer);

      // A later status frame of the same dial is not a dial coming.
      app.dial.apply(const DialStatus(attached: true));
      await tester.pump();
      expect(fixture.probe.lookups, 1);

      app.appLifecycleChanged(AppLifecycleState.inactive);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(fixture.probe.lookups, 2);

      app.dial.disconnect();
      expect(app.deviceAppOffer.state, DeviceAppOfferState.hidden);
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

    testWidgets(
      "under test the app's own offer shows nothing and never looks",
      (tester) async {
        const channel = MethodChannel('harness/device_app');
        final messenger = tester.binding.defaultBinaryMessenger;
        var calls = 0;
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls++;
          return {'paths': <String>[], 'running': false};
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = _app();
        addTearDown(app.dispose);

        app.dial.apply(const DialStatus(attached: true));
        app.appLifecycleChanged(AppLifecycleState.inactive);
        app.appLifecycleChanged(AppLifecycleState.resumed);
        await app.deviceAppOffer.refresh();
        await tester.pump();
        expect(app.deviceAppOffer.state, DeviceAppOfferState.hidden);
        expect(calls, 0);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    test('disposing the app disposes the offer', () async {
      final fixture = DeviceAppFixture();
      final app = _app(offer: fixture.offer);
      app.dial.apply(const DialStatus(attached: true));
      await pumpEventQueue();
      expect(fixture.offer.state, DeviceAppOfferState.offer);

      app.dispose();
      expect(() => fixture.offer.addListener(() {}), throwsFlutterError);
      expect(app.dial.disconnect, returnsNormally);
      expect(
        fixture.offer.state,
        DeviceAppOfferState.offer,
        reason: 'the app tells a disposed offer nothing',
      );
      expect(
        () => app.dial.apply(const DialStatus(attached: true)),
        returnsNormally,
      );
      await pumpEventQueue();
      expect(fixture.probe.lookups, 1);
    });
  });
}
