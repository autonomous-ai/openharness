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
