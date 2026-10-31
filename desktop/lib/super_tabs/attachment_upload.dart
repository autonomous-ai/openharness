import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import '../api/api_client.dart';
import '../logging/app_log.dart';
import '../state/harness_attachments.dart';
import 'controller.dart';
import 'model.dart' show superTabMap;

/// What one file of a message may weigh (backend superTabs/attachments.ts).
const kSuperTabAttachmentMaxBytes = 256 * 1024 * 1024;
const kSuperTabAttachmentMaxFiles = 10;

/// What a file sent as one form to the attachments route may weigh. A heavier
/// one goes straight to storage on a link the backend signs: the edge in front
/// of the backend may refuse a large request.
const kSuperTabFormAttachmentMaxBytes = 10 * 1024 * 1024;

/// What a folder dropped into a chat may weigh as a zip. The zip is made and
/// held in memory until it is sent, so it keeps the form's limit.
const kSuperTabFolderZipMaxBytes = kSuperTabFormAttachmentMaxBytes;

/// What a file over [kSuperTabAttachmentMaxBytes] is refused with, before any
/// request; the backend answers the same.
const kSuperTabAttachmentTooLarge = 'Files can be up to 256 MB.';

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
/// [file] may be in memory or on disk; one on disk is read as it goes up.
/// [onProgress] is told the part sent, from 0 to 1. A refusal throws a
/// [SuperTabFailure] carrying the backend's code.
typedef SuperTabUpload = Future<Map<String, dynamic>> Function({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required HarnessAttachment file,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
});

/// The upload of a build that cannot reach the backend with a file.
Future<Map<String, dynamic>> refuseUpload({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required HarnessAttachment file,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
}) => Future.error(
  const SuperTabFailure('UPLOAD_UNAVAILABLE', 'Files can’t be sent from here.'),
);

/// Uploads with [api], straight to the backend in a browser and through the
/// local daemon on a computer. A file up to [kSuperTabFormAttachmentMaxBytes]
/// goes as one `multipart/form-data` request. A heavier one asks for a signed
/// link, goes on it straight to storage from disk with [storage] — a plain
/// client, since the link is the only credential it carries — and is then
/// finished. Either way the answer is `{attachment: {...}}`.
SuperTabUpload uploadWith(
  ApiClient Function() api, {
  Dio Function()? storage,
}) =>
    ({
      required tabId,
      required conversationId,
      required name,
      required mime,
      required file,
      required cancel,
      required onProgress,
    }) async {
      final size = await file.length();
      if (size > kSuperTabAttachmentMaxBytes) {
        throw const SuperTabFailure(
          'ATTACHMENT_TOO_LARGE',
          kSuperTabAttachmentTooLarge,
        );
      }
      final path = '/api/super-tabs/${Uri.encodeComponent(tabId)}/attachments';
      if (size > kSuperTabFormAttachmentMaxBytes) {
        return _uploadDirect(
          api(),
          storage ?? _storageClient,
          path: path,
          conversationId: conversationId,
          name: name,
          mime: mime,
          file: file,
          size: size,
          cancel: cancel,
          onProgress: onProgress,
        );
      }
      final response = await api().postForm(
        path,
        FormData.fromMap({
          'conversationId': conversationId,
          'file': MultipartFile.fromBytes(
            await file.readBytes(),
            filename: name,
            contentType: DioMediaType.parse(mime),
          ),
        }),
        cancelToken: cancel,
        onSendProgress: (sent, total) {
          if (total > 0) onProgress(sent / total);
        },
      );
      return _attachmentOf(response);
    };

/// A client for storage alone: no base address, no token, no request log
/// (a signed link is a credential and is never written down).
Dio _storageClient() => Dio(
  BaseOptions(
    connectTimeout: const Duration(seconds: 15),
    // Storage answers once the last byte is in.
    receiveTimeout: const Duration(minutes: 2),
  ),
);

/// The answer's `data` when the backend took the file, or the refusal.
Map<String, dynamic> _attachmentOf(Response<dynamic> response) {
  final body = response.data;
  if (response.statusCode == 200 && body is Map && body['success'] == true) {
    return Map<String, dynamic>.from(body['data'] as Map);
  }
  throw superTabUploadRefusal(response);
}

/// A file over the form's limit: a link for it, the bytes straight to storage
/// on it, then the backend told to finish. Any failure on the way leaves
/// nothing to resume: a link writes once, so a retry starts over.
Future<Map<String, dynamic>> _uploadDirect(
  ApiClient api,
  Dio Function() storage, {
  required String path,
  required String conversationId,
  required String name,
  required String mime,
  required HarnessAttachment file,
  required int size,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
}) async {
  final asked = await api.postJson('$path/uploads', {
    'conversationId': conversationId,
    'name': name,
    'mime': mime,
    'size': size,
  }, cancelToken: cancel);
  // A CLI that does not pass the route on answers its own 404, a bare code.
  final askedBody = asked.data;
  if (asked.statusCode == 404 &&
      askedBody is Map &&
      askedBody['error'] is! Map) {
    throw const SuperTabFailure(
      'UPDATE_HARNESS',
      'Update Harness on this computer to send files over 10 MB.',
      statusCode: 404,
    );
  }
  final link = superTabMap(_attachmentOf(asked)['upload']);
  final id = link['id'], url = link['url'], headers = link['headers'];
  if (id is! String || url is! String || headers is! Map) {
    appLog.warn('super-tabs', 'upload link unreadable');
    throw SuperTabFailure(
      'UPLOAD_FAILED',
      'Could not upload $name. Try again.',
    );
  }
  await _put(
    storage(),
    url,
    {
      for (final MapEntry(:key, :value) in headers.entries) '$key': '$value',
      Headers.contentLengthHeader: '$size',
    },
    name: name,
    file: file,
    size: size,
    cancel: cancel,
    onProgress: onProgress,
  );
  final done = await api.postJson(
    '$path/uploads/${Uri.encodeComponent(id)}/complete',
    const {},
    cancelToken: cancel,
  );
  return _attachmentOf(done);
}

/// Sends [file]'s [size] bytes to [url] with [headers], read as they go.
/// Neither the link nor what storage says reaches a log or an error: the link
/// is a credential, and storage's refusal can quote it.
Future<void> _put(
  Dio storage,
  String url,
  Map<String, String> headers, {
  required String name,
  required HarnessAttachment file,
  required int size,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
}) async {
  final failed = SuperTabFailure(
    'UPLOAD_FAILED',
    'Could not upload $name. Try again.',
  );
  // A token of its own, so the one handed in never holds the link's request
  // (its cancel error carries the request, URL and all).
  final put = CancelToken();
  if (cancel.isCancelled) throw cancel.cancelError!;
  unawaited(cancel.whenCancel.then((_) => put.cancel('given up')));
  try {
    final response = await storage.put<dynamic>(
      url,
      data: file.openRead(size),
      cancelToken: put,
      onSendProgress: (sent, _) => onProgress(sent / size),
      options: Options(
        headers: headers,
        responseType: ResponseType.plain,
        validateStatus: (_) => true,
        followRedirects: false,
      ),
    );
    final status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      appLog.warn('super-tabs', 'upload to storage refused (status $status)');
      throw failed;
    }
  } on DioException catch (failure) {
    if (cancel.isCancelled) throw cancel.cancelError!;
    appLog.warn(
      'super-tabs',
      'upload to storage failed (${failure.type.name})',
    );
    throw failed;
  }
}

/// What a refused upload says. The backend answers `{error: {code, message}}`;
/// the local daemon, a bare code string such as `{error: 'FORBIDDEN'}`. Either
/// may reach here as a String Dio did not decode.
SuperTabFailure superTabUploadRefusal(Response<dynamic> response) {
  var body = response.data;
  if (body is String) {
    try {
      body = jsonDecode(body);
    } catch (_) {}
  }
  final error = body is Map ? body['error'] : null;
  final code = error is Map
      ? error['code'] as String?
      : error is String
      ? error
      : null;
  final message = error is Map ? error['message'] as String? : null;
  // The code and status only, never the message: a refusal can quote what was sent.
  appLog.warn(
    'super-tabs',
    'upload refused: ${code ?? 'no code'} (status ${response.statusCode})',
  );
  return SuperTabFailure(
    code ?? 'UPLOAD_FAILED',
    message ??
        switch (code) {
          'FORBIDDEN' => 'You can’t send files in this conversation.',
          'ATTACHMENT_TOO_LARGE' => kSuperTabAttachmentTooLarge,
          'AVATAR_TOO_LARGE' => 'That picture is over 1 MB.',
          'AVATAR_TYPE' => 'Use a PNG, JPEG or WebP picture.',
          null => 'Could not upload the file. Try again.',
          _ => 'Could not upload the file ($code). Try again.',
        },
    statusCode: response.statusCode ?? 0,
  );
}
