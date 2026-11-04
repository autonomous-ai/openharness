import 'dart:typed_data';

import 'avatar_upload.dart';
import 'controller.dart';
import 'model.dart';

/// Status, avatars and reactions, and edits and deletes of the reader's own
/// messages. Each goes as its own request rather than waiting behind a
/// message being sent (the first three are safe to send again); the answer
/// is null when it went through, or what to tell the person.
extension SuperTabProfileActions on SuperTabController {
  Future<String?> setStatus(SuperTabPersonStatus? status) => _profile({
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

  /// The reader's own username, trimmed (the server lowercases it), or back
  /// to their default when null. A taken name comes back in words. A viewer
  /// may change theirs too, though nothing else.
  Future<String?> setUsername(String? username) => _profile({
    'type': 'member.username',
    'username': username?.trim(),
  }, viewer: true);

  /// The name the Swarm shows for the reader, trimmed (the server keeps one
  /// space between words), or back to their username when null. A taken name
  /// comes back in words. A viewer may change theirs too.
  Future<String?> setName(String? name) =>
      _profile({'type': 'member.name', 'name': name?.trim()}, viewer: true);

  /// [agentId]'s avatar when given (its contributor's or Lead's to change),
  /// else the reader's own: [preset], or back to the default when null.
  /// An upload goes through [uploadAvatar].
  Future<String?> setAvatar(SuperTabPresetAvatar? preset, {String? agentId}) =>
      _profile({
        'type': agentId == null ? 'member.avatar' : 'agent.avatar',
        'agentId': ?agentId,
        'avatar': preset == null ? null : {'kind': 'preset', 'key': preset.key},
      });

  /// Resizes [picked] here, uploads it and makes it the avatar.
  Future<String?> uploadAvatar(Uint8List picked, {String? agentId}) async {
    if (!canWrite) return _readOnly;
    try {
      final png = await superTabAvatarPng(picked);
      if (png.length > kSuperTabAvatarMaxBytes) {
        return 'That picture is over 1 MB.';
      }
      final answer = await avatarUpload(tabId: tabId, png: png);
      final id = superTabMap(answer['avatar'])['id'] as String;
      return await _profile({
        'type': agentId == null ? 'member.avatar' : 'agent.avatar',
        'agentId': ?agentId,
        'avatar': {'kind': 'upload', 'id': id},
      });
    } on SuperTabFailure catch (failure) {
      return failure.message;
    }
  }

  /// Adds the reader's [emoji] to [message], or takes it back when it is
  /// already theirs.
  Future<String?> react(
    SuperTabMessage message,
    SuperTabReactionEmoji emoji,
  ) async {
    final mine = message.reactions.any(
      (r) => r.emoji == emoji && r.includes('person', accountId),
    );
    final failure = await _send({
      'type': 'message.react',
      'conversationId': message.conversationId,
      'messageId': message.id,
      'emoji': emoji.key,
      'on': !mine,
      // An app that knows one Buddy per Swarm says so: the server then
      // refuses it in an older Buddy chat (security review 1 of #2435).
      if (oneBuddy) 'oneBuddy': true,
    });
    if (failure == null) await loadMessages(message.conversationId);
    return failure;
  }

  /// Whether the reader may edit or delete [message]: their own plain post
  /// (no `source`: no task line, route or note the server wrote in their
  /// name), not deleted, in a conversation they may write in. The server
  /// decides (backend messageEdits.ts); this only offers the choices.
  bool canChange(SuperTabMessage message) {
    final group = snapshot?.conversation(message.conversationId);
    return canWrite &&
        group != null &&
        !group.archived &&
        !isEarlierBuddyChat(group) &&
        message.author['kind'] == 'person' &&
        message.authorId == accountId &&
        message.source.isEmpty &&
        !message.deleted;
  }

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

  Future<String?> _profile(
    Map<String, dynamic> command, {
    bool viewer = false,
  }) async {
    final failure = await _send(command, viewer: viewer);
    if (failure == null) await refresh();
    return failure;
  }

  Future<String?> _send(
    Map<String, dynamic> command, {
    bool viewer = false,
  }) async {
    final member =
        !accessRevoked &&
        snapshot?.people.any((p) => p.id == accountId) == true;
    if (!(viewer ? member : canWrite)) return _readOnly;
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
