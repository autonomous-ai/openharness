import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';

import 'package:harness_mobile/api/api_client.dart';

import 'model.dart';
import 'swarm_face.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What the backend takes as an avatar (superTabs/attachments.ts).
const kSwarmAvatarMaxBytes = 1024 * 1024;

/// The side of the square picture uploaded: sharp at every size it is shown.
const kSwarmAvatarPixels = 256;

/// Sends one avatar picture of the Swarm [tabId] and returns its upload's id
/// (`POST /api/super-tabs/:tabId/avatars`); a command then makes it someone's.
/// Straight to the backend with the phone's own sign-in: the computer a
/// Swarm call goes through carries text only.
typedef SwarmAvatarUpload = Future<String> Function({
  required String tabId,
  required Uint8List png,
});

/// [send] — `ApiClient.uploadSwarmAvatar` — as a [SwarmAvatarUpload] whose
/// failures read as the Swarm's do.
SwarmAvatarUpload swarmAvatarUploadVia(
  Future<String> Function(String tabId, Uint8List png) send,
) => ({required tabId, required png}) async {
  try {
    return await send(tabId, png);
  } on ApiException catch (refusal) {
    throw SuperTabFailure(
      'AVATAR_REFUSED',
      refusal.message,
      statusCode: refusal.status ?? 0,
    );
  } on DioException catch (failure) {
    throw SuperTabFailure(
      'AVATAR_NOT_SENT',
      'The picture was not sent: ${describeApiError(failure)}',
    );
  }
};

/// The reader's own avatar and status in one Swarm, as the desktop sets them
/// (`desktop/lib/super_tabs/profile_actions.dart`). Each is its own command,
/// safe to send again; the answer is null when it went through, and the
/// Swarm is read at once, or else the sentence to show.
class SwarmProfile {
  SwarmProfile({required this.reader, this.upload});

  final SwarmReader reader;

  /// Null where this build cannot send a picture: only the built-in ones.
  final SwarmAvatarUpload? upload;

  bool get canUpload => upload != null;

  /// Only a member who may write changes how they show.
  bool get canEdit =>
      reader.snapshot?.person(reader.accountId)?.canWrite ?? false;

  Future<String?> setStatus(SuperTabPersonStatus? status) => _send({
    'type': 'member.status',
    'status': status == null
        ? null
        : {
            'text': status.text,
            'emoji': ?status.emoji,
            if (status.until case final until?)
              'until': until.toUtc().toIso8601String(),
          },
  });

  /// [preset], or back to the initial when null.
  Future<String?> setAvatar(SuperTabPresetAvatar? preset) => _send({
    'type': 'member.avatar',
    'avatar': preset == null ? null : {'kind': 'preset', 'key': preset.key},
  });

  /// [picked] as its middle square at [kSwarmAvatarPixels], uploaded, then
  /// made the avatar.
  Future<String?> uploadAvatar(Uint8List picked) async {
    if (!canEdit) return _readOnly;
    final upload = this.upload;
    if (upload == null) {
      return 'Pictures can’t be sent from here. Pick one of the pictures '
          'instead.';
    }
    try {
      final png = await swarmAvatarPng(picked);
      if (png.length > kSwarmAvatarMaxBytes) {
        return 'That picture is over 1 MB.';
      }
      final id = await upload(tabId: reader.tabId, png: png);
      return await _send({
        'type': 'member.avatar',
        'avatar': {'kind': 'upload', 'id': id},
      });
    } on SuperTabFailure catch (failure) {
      return failure.message;
    }
  }

  Future<String?> _send(Map<String, dynamic> command) async {
    if (!canEdit) return _readOnly;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {'operationId': superTabOperationId(), 'command': command},
      );
    } on SuperTabFailure catch (failure) {
      return failure.message;
    }
    await reader.refresh();
    return null;
  }
}

const _readOnly = 'You have read-only access to this Swarm.';

/// [picked] cropped to its middle square and drawn at [kSwarmAvatarPixels],
/// as a PNG: what any picture a person picks becomes before it leaves the
/// phone, as on the desktop (`superTabAvatarPng`). A file that is not a
/// picture is refused.
Future<Uint8List> swarmAvatarPng(Uint8List picked) async {
  final ui.Image source;
  try {
    final codec = await ui.instantiateImageCodec(picked);
    source = (await codec.getNextFrame()).image;
    codec.dispose();
  } catch (_) {
    throw const SuperTabFailure(
      'AVATAR_TYPE',
      'Use a PNG, JPEG or WebP picture.',
    );
  }
  final side = source.width < source.height ? source.width : source.height;
  final crop = ui.Rect.fromLTWH(
    (source.width - side) / 2,
    (source.height - side) / 2,
    side.toDouble(),
    side.toDouble(),
  );
  const pixels = kSwarmAvatarPixels;
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawImageRect(
    source,
    crop,
    const ui.Rect.fromLTWH(0, 0, pixels * 1.0, pixels * 1.0),
    ui.Paint()..filterQuality = ui.FilterQuality.high,
  );
  final drawn = await recorder.endRecording().toImage(pixels, pixels);
  source.dispose();
  final bytes = await drawn.toByteData(format: ui.ImageByteFormat.png);
  drawn.dispose();
  return bytes!.buffer.asUint8List();
}
