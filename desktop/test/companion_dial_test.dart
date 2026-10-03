import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/companion_dial.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/state/dial_status.dart';

import 'daemons/zoo_test.dart' show FakeZooTransport;

Map<String, Object?> settings({
  String id = 'tim',
  String uid = 'tim-one',
  String version = '0.1',
  bool follow = true,
  int protocol = 2,
}) => {
  'brightness': 40,
  'character': 0,
  'face': 466,
  'muted': true,
  'quiet': false,
  'straightTitle': false,
  'focusFace': false,
  'scrollReversed': false,
  'round': true,
  'voiceLang': 'en',
  'followCompanion': follow,
  'companion': id,
  if (protocol == 2) ...{
    'companionProtocol': 2,
    'companionDetails': {
      'id': id,
      'uid': uid,
      'version': version,
      'seed': 0,
        'colour': -1,
      'mark': 0,
    },
  },
};

void main() {
  test(
    'modern device acknowledgement is validated without inventing an identity',
    () {
      final parsed = DeviceSettings.fromJson(settings())!;
      expect(parsed.companionProtocol, 2);
      expect(parsed.companionDetails?.uid, 'tim-one');
      expect(parsed.companionDetails?.version, '0.1');
      final malformed = DeviceSettings.fromJson({
        ...settings(),
        'companionDetails': {'id': 'tim', 'uid': 'tim-one'},
      })!;
      expect(malformed.companionProtocol, 2);
      expect(malformed.companionDetails, isNull);
      expect(
        DeviceSettings.fromJson(settings(protocol: 1))!.companionProtocol,
        isNull,
      );
    },
  );

  late ZooController zoo;
  late DialState dial;
  late List<(String, Map<String, Object?>)> patches;
  Future<void> mount(
    WidgetTester tester, {
    String species = 'gnu',
    String uid = 'gnu-one',
  }) async {
    final remote = FakeZooTransport()
      ..zoo = Zoo(
        daemons: [
          ZooDaemon(id: 'tim', uid: 'tim-one', hatched: '', egg: 'first'),
          ZooDaemon(id: 'gnu', uid: 'gnu-one', hatched: '', egg: 'gift'),
        ],
        pair: 'tim-one',
        firstEgg: true,
      );
    zoo = ZooController()..bind('account:fixture', remote: remote);
    dial = DialState()
      ..apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'settings': settings(follow: false),
        }),
      );
    patches = [];
    await tester.pump();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 540,
            child: AnimatedBuilder(
              animation: zoo,
              builder: (context, _) => CompanionDial(
                dial: dial,
                zoo: zoo,
                daemon: zoo.zoo.byUid(uid)!,
                setDeviceSettings: (id, patch) => patches.add((id, patch)),
              ),
            ),
          ),
        ),
      ),
    );
    addTearDown(zoo.dispose);
    addTearDown(dial.dispose);
  }

  testWidgets(
    'choose on desktop and dial, then wait for the exact device acknowledgement',
    (tester) async {
      await mount(tester);
      await tester.tap(find.text('Show GNU on dial'));
      await tester.pump();
      expect(zoo.zoo.pair, 'gnu-one');
      expect(patches, hasLength(1));
      expect(patches.single.$1, 'round-usb');
      expect(patches.single.$2, {'followCompanion': true});
      expect(dial.devices.single.settings!.brightness, 40);
      expect(dial.devices.single.settings!.muted, isTrue);
      expect(find.text('GNU is on your dial'), findsNothing);
      // A different individual of the same species is not an acknowledgement.
      dial.apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'settings': settings(id: 'gnu', uid: 'another-gnu'),
        }),
      );
      await tester.pump();
      expect(find.text('Bringing GNU to your dial…'), findsOneWidget);
      dial.apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'settings': settings(id: 'gnu', uid: 'gnu-one'),
        }),
      );
      await tester.pump();
      expect(find.text('GNU is on your dial'), findsOneWidget);
      expect(find.text('Show GNU on dial'), findsNothing);
      // A stage change remains pending even with the right individual.
      dial.apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'settings': settings(id: 'gnu', uid: 'gnu-one', version: '2.0'),
        }),
      );
      await tester.pump();
      expect(find.text('GNU is on your dial'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'unplugged, updating and older devices never claim a modern sync',
    (tester) async {
      await mount(tester, species: 'tim', uid: 'tim-one');
      dial.apply(
        DialStatus.fromJson({
          'attached': false,
          'id': 'round-usb',
          'settings': settings(),
        }),
      );
      await tester.pump();
      expect(find.text('Your dial is unplugged'), findsOneWidget);
      expect(find.byType(OutlinedButton), findsNothing);
      dial.apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'updating': 'next',
          'settings': settings(),
        }),
      );
      await tester.pump();
      expect(find.text('Your dial is updating'), findsOneWidget);
      expect(find.byType(OutlinedButton), findsNothing);
      dial.apply(
        DialStatus.fromJson({
          'attached': true,
          'id': 'round-usb',
          'settings': settings(protocol: 1),
        }),
      );
      await tester.pump();
      expect(
        find.textContaining('Update the dial firmware to sync growth'),
        findsOneWidget,
      );
      expect(patches, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
