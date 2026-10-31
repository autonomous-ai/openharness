import 'package:flutter/widgets.dart';

import 'attachment_upload.dart';
import 'controller.dart' show SuperTabFailure;
import 'model.dart';

/// Asks the backend for a fresh link to one file of one message (backend
/// superTabs/fileLinks.ts): answered only while the reader may read that
/// message.
typedef SuperTabFreshFileLink = Future<SuperTabAttachment> Function(
  String conversationId,
  String messageId,
  String attachmentId,
);

/// Said when the reader may no longer open a file: removed from the project
/// or the Swarm, the Swarm deleted, or the message gone.
const kSuperTabFileGone = 'This file is no longer available.';

/// Said when a fresh link could not be had just now; a later click tries
/// again.
const kSuperTabFileRetry = 'Couldn’t open the file. Try again.';

/// A link with less than this left is asked for again before it is opened, so
/// it does not stop opening while the browser or a fetch starts.
const kSuperTabLinkMargin = Duration(seconds: 60);

/// The clock links are judged by; tests set it.
@visibleForTesting
DateTime Function() superTabFileClock = DateTime.now;

/// The Swarm view's way to ask for fresh file links, for the messages under
/// it. A new Swarm or account brings a new one, so an answer asked for under
/// the old one is dropped ([superTabOpenableLink]).
class SuperTabFiles extends InheritedWidget {
  const SuperTabFiles({super.key, required this.fresh, required super.child});

  final SuperTabFreshFileLink fresh;

  /// The fresh-link source over [context], and a rebuild when it changes.
  static SuperTabFreshFileLink? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SuperTabFiles>()?.fresh;

  /// The same without a rebuild, for a check after an answer arrives.
  static SuperTabFreshFileLink? peek(BuildContext context) =>
      context.getInheritedWidgetOfExactType<SuperTabFiles>()?.fresh;

  @override
  bool updateShouldNotify(SuperTabFiles oldWidget) => fresh != oldWidget.fresh;
}

/// Why a file was not opened: [gone] when the reader may no longer open it,
/// else a failure another try may get past.
class SuperTabFileUnavailable implements Exception {
  const SuperTabFileUnavailable({required this.gone});
  final bool gone;
  String get message => gone ? kSuperTabFileGone : kSuperTabFileRetry;
  @override
  String toString() => message;
}

/// One file of one message, and the newest link to it this screen has: the
/// message's own, then any fresh one asked for since.
class SuperTabFileRef {
  SuperTabFileRef(this.file, {this.conversationId, this.messageId, this.fresh})
    : _latest = file;

  final SuperTabAttachment file;
  final String? conversationId, messageId;

  /// Where fresh links come from; null where none can be asked for.
  final SuperTabFreshFileLink? fresh;

  SuperTabAttachment _latest;

  /// The newest link at hand: its signed [SuperTabAttachment.link] while it
  /// opens for more than [kSuperTabLinkMargin], else null; with no signed
  /// link at all (an older server, or none signed this time), the stored
  /// address on the attachments CDN, as ever. A signed link is never passed
  /// over for the stored address.
  Uri? get current {
    if (_latest.link case final signed?) {
      final link = attachmentSignedLink(signed), ends = _latest.expiresAt;
      if (link == null || ends == null) return null;
      final left = ends - superTabFileClock().millisecondsSinceEpoch;
      return left > kSuperTabLinkMargin.inMilliseconds ? link : null;
    }
    return attachmentLink(_latest.url);
  }

  /// Whether the message names the file only by addresses this app refuses
  /// to open: a signed link off [kSuperTabFilesHost] or not https, or, with
  /// none, a stored address off the attachments host. With neither, the file
  /// is only unlinked this time.
  bool get refused => file.link != null
      ? attachmentSignedLink(file.link) == null
      : file.url.isNotEmpty && attachmentLink(file.url) == null;

  /// A link that opens now: [current], or a fresh one. [stale]: the one at
  /// hand just failed to open, so a fresh one is asked for whatever its time.
  /// Throws [SuperTabFileUnavailable].
  Future<Uri> link({bool stale = false}) async {
    if (!stale) {
      if (current case final link?) return link;
    }
    final ask = fresh, conversation = conversationId, message = messageId;
    if (ask == null || conversation == null || message == null) {
      throw const SuperTabFileUnavailable(gone: false);
    }
    final SuperTabAttachment next;
    try {
      next = await ask(conversation, message, file.id);
    } on SuperTabFailure catch (failure) {
      throw SuperTabFileUnavailable(gone: _gone(failure));
    } catch (_) {
      throw const SuperTabFileUnavailable(gone: false);
    }
    final link = next.id == file.id && next.expiresAt != null
        ? attachmentSignedLink(next.link)
        : null;
    if (link == null) throw const SuperTabFileUnavailable(gone: true);
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
/// when none could be had; null and silent when the widget has gone or the
/// Swarm view over it changed while the link was asked for, so a late answer
/// opens nothing and changes nothing.
Future<Uri?> superTabOpenableLink(
  BuildContext context,
  SuperTabFileRef ref, {
  bool stale = false,
  void Function(String message)? onProblem,
}) async {
  final source = SuperTabFiles.peek(context);
  bool still() => context.mounted && SuperTabFiles.peek(context) == source;
  try {
    final link = await ref.link(stale: stale);
    return still() ? link : null;
  } on SuperTabFileUnavailable catch (problem) {
    if (still()) onProblem?.call(problem.message);
    return null;
  }
}
