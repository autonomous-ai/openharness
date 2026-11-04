import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_profile.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// A [width]×[height] PNG, as a photo picked from the library would be.
Future<Uint8List> picture(int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width * 1.0, height * 1.0),
    ui.Paint()..color = const ui.Color(0xFF3366CC),
  );
  final image = await recorder.endRecording().toImage(width, height);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}

Future<({int width, int height})> sizeOf(Uint8List png) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  return (width: image.width, height: image.height);
}

/// The person's own avatar and status, as Desktop sets them
/// (`desktop/lib/super_tabs/profile_actions.dart`): each a command of its
/// own; an uploaded photo first goes up straight from the phone.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeSwarm swarm;
  late SwarmReader reader;
  late List<({String tabId, Uint8List png})> uploads;

  Future<SwarmProfile> rig({
    String role = 'owner',
    bool canUpload = true,
    Future<String> Function()? answer,
  }) async {
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(),
      'members': [part(me, 1, person(me, role: role))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {'ok': true};
    reader = SwarmReader(tabId: tab, accountId: me, request: swarm.request);
    addTearDown(reader.dispose);
    await reader.refresh();
    uploads = [];
    return SwarmProfile(
      reader: reader,
      upload: canUpload
          ? ({required tabId, required png}) async {
              uploads.add((tabId: tabId, png: png));
              return answer == null ? 'upload-1' : await answer();
            }
          : null,
    );
  }

  int reads() => swarm.paths
      .where((path) => path.startsWith('/api/super-tabs/$tab/changes'))
      .length;

  test('a status goes as the person wrote it, and the Swarm is read', () async {
    final profile = await rig();
    final until = DateTime.utc(2026, 10, 28, 12);
    expect(
      await profile.setStatus(
        SuperTabPersonStatus(text: 'Focusing', emoji: '🎯', until: until),
      ),
      isNull,
    );
    expect(swarm.commands, [
      {
        'type': 'member.status',
        'status': {
          'text': 'Focusing',
          'emoji': '🎯',
          'until': '2026-10-28T12:00:00.000Z',
        },
      },
    ]);
    expect(reads(), 1);
  });

  test('a status in their own words, that never clears', () async {
    final profile = await rig();
    await profile.setStatus(const SuperTabPersonStatus(text: 'On a train'));
    expect(swarm.commands, [
      {
        'type': 'member.status',
        'status': {'text': 'On a train'},
      },
    ]);
  });

  test('clearing the status sends none', () async {
    final profile = await rig();
    await profile.setStatus(null);
    expect(swarm.commands, [
      {'type': 'member.status', 'status': null},
    ]);
  });

  test('a built-in picture, and back to the initial', () async {
    final profile = await rig();
    await profile.setAvatar(const SuperTabPresetAvatar('fox'));
    await profile.setAvatar(null);
    expect(swarm.commands, [
      {
        'type': 'member.avatar',
        'avatar': {'kind': 'preset', 'key': 'fox'},
      },
      {'type': 'member.avatar', 'avatar': null},
    ]);
  });

  test('a photo goes up as its middle square at 256 pixels, then becomes the '
      'avatar', () async {
    final profile = await rig();
    expect(await profile.uploadAvatar(await picture(600, 400)), isNull);
    expect(uploads.single.tabId, tab);
    expect(await sizeOf(uploads.single.png), (width: 256, height: 256));
    expect(swarm.commands, [
      {
        'type': 'member.avatar',
        'avatar': {'kind': 'upload', 'id': 'upload-1'},
      },
    ]);
    expect(reads(), 1);
  });

  test('a server with uploads off says so, and nothing is set', () async {
    final profile = await rig(
      answer: () => throw const SuperTabFailure(
        'AVATARS_UNAVAILABLE',
        'Uploading pictures is not set up on this server yet. Pick one of the '
            'pictures instead.',
        statusCode: 503,
      ),
    );
    expect(
      await profile.uploadAvatar(await picture(10, 10)),
      'Uploading pictures is not set up on this server yet. Pick one of the '
      'pictures instead.',
    );
    expect(swarm.commands, isEmpty);
  });

  test('a file that is no picture is refused before it goes up', () async {
    final profile = await rig();
    expect(
      await profile.uploadAvatar(Uint8List.fromList([1, 2, 3])),
      'Use a PNG, JPEG or WebP picture.',
    );
    expect(uploads, isEmpty);
  });

  test('a phone that cannot send pictures offers none', () async {
    final profile = await rig(canUpload: false);
    expect(profile.canUpload, isFalse);
    expect(
      await profile.uploadAvatar(await picture(10, 10)),
      'Pictures can’t be sent from here. Pick one of the pictures instead.',
    );
    expect(swarm.commands, isEmpty);
  });

  test('a refused command comes back as its sentence', () async {
    final profile = await rig();
    swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
        throw const SuperTabFailure(
          'STATUS_EXPIRED',
          'Choose a time that has not passed yet.',
          statusCode: 400,
        );
    expect(
      await profile.setStatus(
        SuperTabPersonStatus(text: 'Away', until: DateTime.utc(2020)),
      ),
      'Choose a time that has not passed yet.',
    );
    expect(reads(), 0);
  });

  test('a viewer changes nothing', () async {
    final profile = await rig(role: 'viewer');
    expect(profile.canEdit, isFalse);
    expect(
      await profile.setAvatar(const SuperTabPresetAvatar('owl')),
      'You have read-only access to this Swarm.',
    );
    expect(swarm.commands, isEmpty);
  });

  group('the phone\'s upload', () {
    Future<Object?> refusal(Object error) async {
      final upload = swarmAvatarUploadVia((tabId, png) async => throw error);
      try {
        await upload(tabId: tab, png: Uint8List(4));
      } catch (caught) {
        return caught;
      }
      return null;
    }

    test('answers the id the backend gave', () async {
      final upload = swarmAvatarUploadVia((tabId, png) async => 'up-$tabId');
      expect(await upload(tabId: tab, png: Uint8List(4)), 'up-$tab');
    });

    test("tells the server's refusal in its words", () async {
      final failure = await refusal(ApiException('Not set up.', status: 503));
      expect(
        failure,
        isA<SuperTabFailure>()
            .having((f) => f.message, 'message', 'Not set up.')
            .having((f) => f.statusCode, 'statusCode', 503),
      );
    });

    test('tells a lost connection in words', () async {
      final failure = await refusal(
        DioException(
          requestOptions: RequestOptions(),
          type: DioExceptionType.connectionError,
        ),
      );
      expect(
        failure,
        isA<SuperTabFailure>().having(
          (f) => f.message,
          'message',
          'The picture was not sent: could not reach Harness. Check your '
              'connection and try again.',
        ),
      );
    });
  });
}
