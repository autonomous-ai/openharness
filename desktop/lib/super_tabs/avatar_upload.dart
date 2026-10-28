import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';

import '../api/api_client.dart';
import 'attachment_upload.dart';
import 'controller.dart';

/// What the backend takes as an avatar (superTabs/attachments.ts).
const kSuperTabAvatarMaxBytes = 1024 * 1024;

/// The side of the square picture uploaded: sharp at every avatar size shown.
const kSuperTabAvatarPixels = 256;

/// Sends one avatar picture and returns the backend's answer,
/// `{avatar: {id, url}}`; a command then makes it someone's.
typedef SuperTabAvatarUpload = Future<Map<String, dynamic>> Function({
  required String tabId,
  required Uint8List png,
});

/// The avatar upload of a build that cannot reach the backend with a file.
Future<Map<String, dynamic>> refuseAvatarUpload({
  required String tabId,
  required Uint8List png,
}) => Future.error(
  const SuperTabFailure(
    'UPLOAD_UNAVAILABLE',
    'Pictures can’t be sent from here.',
  ),
);

/// Uploads with [api], as chat files go: straight to the backend in a
/// browser and through the local daemon on a computer.
SuperTabAvatarUpload uploadAvatarWith(ApiClient Function() api) =>
    ({required tabId, required png}) async {
      final response = await api().postForm(
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/avatars',
        FormData.fromMap({
          'file': MultipartFile.fromBytes(
            png,
            filename: 'avatar.png',
            contentType: DioMediaType.parse('image/png'),
          ),
        }),
      );
      final body = response.data;
      if (response.statusCode == 200 &&
          body is Map &&
          body['success'] == true) {
        return Map<String, dynamic>.from(body['data'] as Map);
      }
      throw superTabUploadRefusal(response);
    };

/// [picked] cropped to its middle square and drawn at
/// [kSuperTabAvatarPixels], as a PNG: what any picture a person picks becomes
/// before it leaves this computer. A file that is not a picture is refused.
Future<Uint8List> superTabAvatarPng(Uint8List picked) async {
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
  const pixels = kSuperTabAvatarPixels;
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
