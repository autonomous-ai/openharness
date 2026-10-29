import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_profile_sheet.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../theme/sheet_shape.dart';
import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's own profile in a Swarm, in a sheet from the foot of the
/// screen: a built-in picture or a photo of theirs, and a status that clears
/// when they say.
void main() {
  late FakeSwarm swarm;
  late Map<String, dynamic> mine;
  late List<Uint8List> uploads;

  Future<Uint8List> photo() async {
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawRect(
      const ui.Rect.fromLTWH(0, 0, 40, 30),
      ui.Paint()..color = const ui.Color(0xFF22AA66),
    );
    final image = await recorder.endRecording().toImage(40, 30);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    return bytes!.buffer.asUint8List();
  }

  /// The sheet open over a page, for a member with [role]; [canUpload] off
  /// is a phone that cannot send a picture.
  Future<void> open(
    WidgetTester tester, {
    String role = 'owner',
    Map<String, dynamic> extra = const {},
    bool canUpload = true,
    Future<String> Function()? answer,
    Uint8List? picked,
  }) async {
    swarm = FakeSwarm();
    mine = {...person(me, role: role), ...extra};
    var version = 1;
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(),
      'members': [part(me, version, mine)],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c${++version}'),
      'members': [part(me, version, mine)],
    };
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      switch (command['type']) {
        case 'member.avatar':
          final avatar = command['avatar'] as Map<String, dynamic>?;
          mine = {
            ...mine..remove('avatar'),
            if (avatar != null)
              'avatar': avatar['kind'] == 'upload'
                  ? {'kind': 'upload'}
                  : avatar,
          };
        case 'member.status':
          mine = {...mine..remove('status'), 'status': ?command['status']};
      }
      return {'ok': true};
    };
    uploads = [];
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      uploadAvatar: canUpload
          ? ({required tabId, required png}) async {
              uploads.add(png);
              return answer == null ? 'upload-1' : await answer();
            }
          : null,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => showSwarmProfile(
                  context,
                  swarmId: tab,
                  pickPhoto: () async => picked,
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    // The Swarm read first, as the shell would have.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(sheetTopRadius(tester), 12);
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// Taps [finder], then lets the command and the read after it answer.
  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets('it shows their face and the eight pictures, each a thumb '
      'wide', (tester) async {
    await open(
      tester,
      extra: {
        'avatar': {'kind': 'preset', 'key': 'fox'},
      },
    );
    expect(find.text('Your profile'), findsOneWidget);
    expect(
      find.descendant(of: key('swarm-profile-face'), matching: find.text('🦊')),
      findsOneWidget,
    );
    for (final name in [
      'fox',
      'owl',
      'cat',
      'panda',
      'octopus',
      'cactus',
      'rocket',
      'sun',
    ]) {
      final size = tester.getSize(key('swarm-avatar-preset-$name'));
      expect(size.width, greaterThanOrEqualTo(44), reason: name);
      expect(size.height, greaterThanOrEqualTo(44), reason: name);
    }
  });

  testWidgets('a picture tapped is theirs at once', (tester) async {
    await open(tester);
    await tap(tester, key('swarm-avatar-preset-owl'));
    expect(swarm.commands, [
      {
        'type': 'member.avatar',
        'avatar': {'kind': 'preset', 'key': 'owl'},
      },
    ]);
    expect(
      find.descendant(of: key('swarm-profile-face'), matching: find.text('🦉')),
      findsOneWidget,
    );
  });

  testWidgets('back to the initial, offered only when they wear something', (
    tester,
  ) async {
    await open(tester);
    expect(key('swarm-avatar-default'), findsNothing);
    await tap(tester, key('swarm-avatar-preset-cat'));
    await tap(tester, key('swarm-avatar-default'));
    expect(swarm.commands.last, {'type': 'member.avatar', 'avatar': null});
    expect(key('swarm-avatar-default'), findsNothing);
  });

  testWidgets('a photo from the library goes up and becomes theirs', (
    tester,
  ) async {
    final picked = await tester.runAsync(photo);
    await open(tester, picked: picked);
    await tester.ensureVisible(key('swarm-avatar-photo'));
    await tester.tap(key('swarm-avatar-photo'));
    // Resized outside the test's fake time.
    for (var i = 0; i < 100 && swarm.commands.isEmpty; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(uploads, hasLength(1));
    expect(swarm.commands, [
      {
        'type': 'member.avatar',
        'avatar': {'kind': 'upload', 'id': 'upload-1'},
      },
    ]);
  });

  testWidgets('a photo the server refuses says why, and nothing changes', (
    tester,
  ) async {
    final picked = await tester.runAsync(photo);
    await open(
      tester,
      picked: picked,
      answer: () => throw const SuperTabFailure(
        'AVATARS_UNAVAILABLE',
        'Uploading pictures is not set up on this server yet. Pick one of '
            'the pictures instead.',
        statusCode: 503,
      ),
    );
    await tester.ensureVisible(key('swarm-avatar-photo'));
    await tester.tap(key('swarm-avatar-photo'));
    final error = key('swarm-profile-error');
    for (var i = 0; i < 100 && error.evaluate().isEmpty; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(
      tester.widget<Text>(error).data,
      'Uploading pictures is not set up on this server yet. Pick one of '
      'the pictures instead.',
    );
    expect(swarm.commands, isEmpty);
  });

  testWidgets('a phone that cannot send photos offers the pictures and '
      'says so', (tester) async {
    await open(tester, canUpload: false);
    expect(key('swarm-avatar-photo'), findsNothing);
    expect(
      find.text('Photos can’t be sent from this phone yet. Pick a picture.'),
      findsOneWidget,
    );
    expect(key('swarm-avatar-preset-fox'), findsOneWidget);
  });

  testWidgets('a status from the presets, clearing in an hour', (tester) async {
    await open(tester);
    await tap(tester, key('swarm-status-☕'));
    expect(
      tester.widget<TextField>(key('swarm-status-text')).controller!.text,
      'Coffee break',
    );
    await tap(tester, key('swarm-status-clears-hour'));
    final sent = clock.now();
    await tap(tester, key('swarm-status-save'));
    final command = swarm.commands.single;
    expect(command['type'], 'member.status');
    final status = command['status'] as Map<String, dynamic>;
    expect(status['text'], 'Coffee break');
    expect(status['emoji'], '☕');
    expect(
      DateTime.parse(status['until'] as String).difference(sent).inMinutes,
      60,
    );
  });

  testWidgets('a status in their own words, then cleared', (tester) async {
    await open(tester);
    await tester.ensureVisible(key('swarm-status-text'));
    await tester.enterText(key('swarm-status-text'), 'On a train');
    await tap(tester, key('swarm-status-save'));
    expect(swarm.commands.single, {
      'type': 'member.status',
      'status': {'text': 'On a train'},
    });
    await tap(tester, key('swarm-status-clear'));
    expect(swarm.commands.last, {'type': 'member.status', 'status': null});
  });

  testWidgets('no words, no status to save', (tester) async {
    await open(tester);
    await tap(tester, key('swarm-status-save'));
    expect(swarm.commands, isEmpty);
  });

  testWidgets('their status shows in the editor while it lasts', (
    tester,
  ) async {
    await open(
      tester,
      extra: {
        'status': {'text': 'At lunch', 'emoji': '🍽️', 'until': null},
      },
    );
    expect(
      tester.widget<TextField>(key('swarm-status-text')).controller!.text,
      'At lunch',
    );
    expect(key('swarm-status-clear'), findsOneWidget);
  });

  testWidgets('a viewer sees their profile and changes nothing', (
    tester,
  ) async {
    await open(tester, role: 'viewer');
    expect(
      find.text('You have read-only access to this Swarm.'),
      findsOneWidget,
    );
    await tap(tester, key('swarm-avatar-preset-owl'));
    expect(swarm.commands, isEmpty);
  });

  testWidgets('a status that ends keeps its end when saved again', (
    tester,
  ) async {
    final until = clock.now().toUtc().add(const Duration(hours: 2));
    await open(
      tester,
      extra: {
        'status': {
          'text': 'Focusing',
          'emoji': '🎯',
          'until': until.toIso8601String(),
        },
      },
    );
    expect(key('swarm-status-clears-kept'), findsOneWidget);
    await tester.ensureVisible(key('swarm-status-text'));
    await tester.enterText(key('swarm-status-text'), 'Deep focus');
    await tap(tester, key('swarm-status-save'));
    final status = swarm.commands.single['status'] as Map<String, dynamic>;
    expect(DateTime.parse(status['until'] as String), until);
  });

  test('a picked photo is read, and its copy on the phone deleted', () async {
    final dir = await Directory.systemTemp.createTemp('swarm-photo');
    addTearDown(() => dir.delete(recursive: true));
    final copy = File('${dir.path}/image_picker_1.jpg');
    await copy.writeAsBytes([1, 2, 3]);

    final bytes = await readPickedSwarmPhoto(XFile(copy.path));

    expect(bytes, [1, 2, 3]);
    expect(copy.existsSync(), isFalse);
    expect(await readPickedSwarmPhoto(null), isNull);
  });
}
