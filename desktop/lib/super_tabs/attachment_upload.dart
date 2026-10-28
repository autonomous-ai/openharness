import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../api/api_client.dart';
import 'controller.dart';

/// What the backend allows one message to carry.
const kSuperTabAttachmentMaxBytes = 10 * 1024 * 1024;
const kSuperTabAttachmentMaxFiles = 10;

/// The content type a file of this [name] is sent as: the kinds a chat shows
/// or opens, and `application/octet-stream` for the rest.
String mimeForName(String name) {
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return _mimes[extension] ?? 'application/octet-stream';
}

const _mimes = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'pdf': 'application/pdf',
  'json': 'application/json',
  'zip': 'application/zip',
  'txt': 'text/plain',
  'log': 'text/plain',
  'md': 'text/markdown',
  'csv': 'text/csv',
};

/// Where the backend serves attachments from; the same host as its
/// `SUPER_TAB_ATTACHMENTS_PUBLIC_BASE`.
const kSuperTabAttachmentHost = String.fromEnvironment(
  'SUPER_TAB_ATTACHMENTS_HOST',
  defaultValue: 'cdn.harness.autonomous.ai',
);

/// [url] as a link to open, or null unless it is https on the attachments host:
/// a message's url is whatever its sender's backend row says.
Uri? attachmentLink(String url) {
  final link = Uri.tryParse(url);
  return link != null &&
          link.scheme == 'https' &&
          link.host == kSuperTabAttachmentHost
      ? link
      : null;
}

/// Sends one file to the backend and returns its answer, `{attachment: {...}}`.
/// [onProgress] is told the part sent, from 0 to 1. A refusal throws a
/// [SuperTabFailure] carrying the backend's code.
typedef SuperTabUpload = Future<Map<String, dynamic>> Function({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required Uint8List bytes,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
});

/// The upload of a build that cannot reach the backend with a file.
Future<Map<String, dynamic>> refuseUpload({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required Uint8List bytes,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
}) => Future.error(
  const SuperTabFailure('UPLOAD_UNAVAILABLE', 'Files can’t be sent from here.'),
);

/// Uploads with [api]: one `multipart/form-data` request, straight to the
/// backend in a browser and through the local daemon on a computer.
SuperTabUpload uploadWith(ApiClient Function() api) =>
    ({
      required tabId,
      required conversationId,
      required name,
      required mime,
      required bytes,
      required cancel,
      required onProgress,
    }) async {
      final response = await api().postForm(
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/attachments',
        FormData.fromMap({
          'conversationId': conversationId,
          'file': MultipartFile.fromBytes(
            bytes,
            filename: name,
            contentType: DioMediaType.parse(mime),
          ),
        }),
        cancelToken: cancel,
        onSendProgress: (sent, total) {
          if (total > 0) onProgress(sent / total);
        },
      );
      final body = response.data;
      if (response.statusCode == 200 &&
          body is Map &&
          body['success'] == true) {
        return Map<String, dynamic>.from(body['data'] as Map);
      }
      throw superTabUploadRefusal(response);
    };

/// What a refused upload says. The backend answers `{error: {code, message}}`;
/// the local daemon, a bare code string such as `{error: 'FORBIDDEN'}`.
SuperTabFailure superTabUploadRefusal(Response<dynamic> response) {
  final body = response.data;
  final error = body is Map ? body['error'] : null;
  final code = error is Map
      ? error['code'] as String?
      : error is String
      ? error
      : null;
  final message = error is Map ? error['message'] as String? : null;
  return SuperTabFailure(
    code ?? 'UPLOAD_FAILED',
    message ??
        switch (code) {
          'FORBIDDEN' => 'You can’t send files in this conversation.',
          'ATTACHMENT_TOO_LARGE' => 'That file is over 10 MB.',
          'AVATAR_TOO_LARGE' => 'That picture is over 1 MB.',
          'AVATAR_TYPE' => 'Use a PNG, JPEG or WebP picture.',
          _ => 'Could not upload the file. Try again.',
        },
    statusCode: response.statusCode ?? 0,
  );
}
