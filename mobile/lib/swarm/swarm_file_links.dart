import 'package:flutter/widgets.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// The host the backend serves message files' stored addresses from: a link
/// anywhere else is not opened (the desktop's `attachmentLink`).
const swarmAttachmentHost = String.fromEnvironment(
  'SUPER_TAB_ATTACHMENTS_HOST',
  defaultValue: 'cdn.harness.autonomous.ai',
);

/// [url] as a link to open, or null unless it is https, with no sign-in in
/// it, on [swarmAttachmentHost]: a message's url is whatever its sender's row
/// says.
Uri? swarmAttachmentLink(String url) {
  final link = Uri.tryParse(url);
  return link != null &&
          link.scheme == 'https' &&
          link.userInfo.isEmpty &&
          link.host == swarmAttachmentHost
      ? link
      : null;
}

/// Where the backend's short-lived signed links to chat files point (backend
/// superTabs/fileLinks.ts): Cloud Storage's own host. The desktop's
/// `kSuperTabFilesHost`.
const swarmFilesHost = String.fromEnvironment(
  'SUPER_TAB_FILES_HOST',
  defaultValue: 'storage.googleapis.com',
);

/// A file's signed link (its `link`) as a link to open, or null unless it is
/// https, with no sign-in in it, on [swarmFilesHost].
Uri? swarmSignedLink(String? link) {
  final url = link == null ? null : Uri.tryParse(link);
  return url != null &&
          url.scheme == 'https' &&
          url.userInfo.isEmpty &&
          url.host == swarmFilesHost
      ? url
      : null;
}

/// Said when the reader may no longer open a file: removed from the project
/// or the Swarm, the Swarm deleted, or the message gone.
const swarmFileGone = 'This file is no longer available.';

/// Said when a fresh link could not be had just now; a later tap tries again.
const swarmFileRetry = 'Couldn’t open the file. Try again.';

/// A link with less than this left is asked for again before it is opened.
const swarmLinkMargin = Duration(seconds: 60);

/// The clock links are judged by; tests set it.
@visibleForTesting
DateTime Function() swarmFileClock = DateTime.now;

/// The Swarm whose chat is on screen, for its messages' files: fresh links
/// are asked of [reader], and an answer is used only while it is still the
/// reader on screen and has not been read again from nothing or lost
/// ([SwarmReader.generation]).
class SwarmFiles extends InheritedWidget {
  const SwarmFiles({super.key, required this.reader, required super.child});

  final SwarmReader reader;

  static SwarmReader? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SwarmFiles>()?.reader;

  static SwarmReader? peek(BuildContext context) =>
      context.getInheritedWidgetOfExactType<SwarmFiles>()?.reader;

  @override
  bool updateShouldNotify(SwarmFiles oldWidget) =>
      !identical(reader, oldWidget.reader);
}

/// Why a file was not opened: [gone] when the reader may no longer open it.
class SwarmFileUnavailable implements Exception {
  const SwarmFileUnavailable({required this.gone});
  final bool gone;
  String get message => gone ? swarmFileGone : swarmFileRetry;
  @override
  String toString() => message;
}

/// One file of one message, and the newest link to it the chat has.
class SwarmFileRef {
  SwarmFileRef(this.file, {this.conversationId, this.messageId, this.reader})
    : _latest = file;

  final SuperTabAttachment file;
  final String? conversationId, messageId;

  /// Where fresh links are asked; null where none can be.
  final SwarmReader? reader;

  SuperTabAttachment _latest;

  /// The newest link at hand: its signed link while it opens for more than
  /// [swarmLinkMargin], else null; with no signed link at all (an older
  /// server, or none signed this time), the stored address on the
  /// attachments CDN. A signed link is never passed over for
  /// the stored address.
  Uri? get current {
    if (_latest.link case final signed?) {
      final link = swarmSignedLink(signed), ends = _latest.expiresAt;
      if (link == null || ends == null) return null;
      final left = ends - swarmFileClock().millisecondsSinceEpoch;
      return left > swarmLinkMargin.inMilliseconds ? link : null;
    }
    return swarmAttachmentLink(_latest.url);
  }

  /// Whether the message names the file only by addresses this app refuses.
  bool get refused => file.link != null
      ? swarmSignedLink(file.link) == null
      : file.url.isNotEmpty && swarmAttachmentLink(file.url) == null;

  /// A link that opens now: [current], or a fresh one; [stale] asks for a
  /// fresh one whatever the time. Throws [SwarmFileUnavailable].
  Future<Uri> link({bool stale = false}) async {
    if (!stale) {
      if (current case final link?) return link;
    }
    final ask = reader, conversation = conversationId, message = messageId;
    if (ask == null || conversation == null || message == null) {
      throw const SwarmFileUnavailable(gone: false);
    }
    final SuperTabAttachment next;
    try {
      next = SuperTabAttachment.fromJson(
        superTabMap(
          superTabMap(
            await ask.request(
              'GET',
              '/api/super-tabs/${Uri.encodeComponent(ask.tabId)}'
                  '/conversations/${Uri.encodeComponent(conversation)}'
                  '/messages/${Uri.encodeComponent(message)}'
                  '/attachments/${Uri.encodeComponent(file.id)}',
            ),
          )['attachment'],
        ),
      );
    } on SuperTabFailure catch (failure) {
      throw SwarmFileUnavailable(gone: _gone(failure));
    } catch (_) {
      throw const SwarmFileUnavailable(gone: false);
    }
    final link = next.id == file.id && next.expiresAt != null
        ? swarmSignedLink(next.link)
        : null;
    if (link == null) throw const SwarmFileUnavailable(gone: true);
    _latest = next;
    return link;
  }

  static bool _gone(SuperTabFailure failure) =>
      const {401, 403, 404}.contains(failure.statusCode) ||
      const {
        'FILE_UNAVAILABLE',
        'NOT_FOUND',
        'FORBIDDEN',
        'SIGNED_OUT',
        'ACCOUNT_CHANGED',
      }.contains(failure.code);
}

/// [ref]'s link for a widget at [context]: null, with [onProblem] told why,
/// when none could be had; null and silent when the widget went, the chat's
/// reader changed, or it was read again from nothing or lost access while the
/// link was asked for, so a late answer opens nothing.
Future<Uri?> swarmOpenableLink(
  BuildContext context,
  SwarmFileRef ref, {
  bool stale = false,
  void Function(String message)? onProblem,
}) async {
  final reader = SwarmFiles.peek(context) ?? ref.reader;
  final generation = reader?.generation;
  bool still() =>
      context.mounted &&
      identical(SwarmFiles.peek(context) ?? ref.reader, reader) &&
      reader?.generation == generation &&
      reader?.accessRevoked != true;
  try {
    final link = await ref.link(stale: stale);
    return still() ? link : null;
  } on SwarmFileUnavailable catch (problem) {
    if (still()) onProblem?.call(problem.message);
    return null;
  }
}
