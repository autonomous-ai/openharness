import 'controller.dart';
import 'model.dart';

/// Edits and deletes of the reader's own messages. Each goes as its own
/// request rather than waiting behind a message being sent; the answer is
/// null when it went through, or what to tell the person.
extension SuperTabProfileActions on SuperTabController {
  /// Whether the reader may edit [message]: their own plain post
  /// (no `source`: no task line, route or note the server wrote in their
  /// name), not deleted, in a conversation they may write in. The server
  /// decides (backend messageEdits.ts); this only offers the choices.
  bool canChange(SuperTabMessage message) {
    final group = snapshot?.conversation(message.conversationId);
    return canWrite &&
        group != null &&
        !group.archived &&
        message.author['kind'] == 'person' &&
        message.authorId == accountId &&
        message.source.isEmpty &&
        !message.deleted;
  }

  /// Whether the reader may delete [message]: as [canChange].
  bool canDelete(SuperTabMessage message) => canChange(message);

  /// Replaces [message]'s text with [text], trimmed. The same text sends
  /// nothing; empty text only goes for a message with files.
  Future<String?> editMessage(SuperTabMessage message, String text) async {
    final words = text.trim();
    if (words == message.text) return null;
    if (words.isEmpty && message.attachments.isEmpty) {
      return 'A message needs words or a file.';
    }
    return _changeMessage(message, {
      'type': 'message.edit',
      'conversationId': message.conversationId,
      'messageId': message.id,
      'text': words,
    });
  }

  /// Deletes [message]: one with replies stays as "This message was
  /// deleted.", any other goes.
  Future<String?> deleteMessage(SuperTabMessage message) =>
      _changeMessage(message, {
        'type': 'message.delete',
        'conversationId': message.conversationId,
        'messageId': message.id,
      });

  /// Sends an edit or delete, then reads the page shown, and the open thread
  /// when it is in that conversation, so the change shows at once.
  Future<String?> _changeMessage(
    SuperTabMessage message,
    Map<String, dynamic> command,
  ) async {
    final failure = await _send(command);
    if (failure != null) return failure;
    await loadMessages(message.conversationId);
    if (openedThread?.conversationId == message.conversationId) {
      await loadThread();
    }
    return null;
  }

  Future<String?> _send(Map<String, dynamic> command) async {
    if (!canWrite) return _readOnly;
    try {
      await request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/commands',
        body: {'operationId': superTabOperationId(), 'command': command},
      );
      return null;
    } on SuperTabFailure catch (failure) {
      return failure.message;
    }
  }
}

const _readOnly = 'You have read-only access to this Swarm.';
