import 'dart:typed_data';

import 'avatar_upload.dart';
import 'controller.dart';
import 'model.dart';

/// Status, avatars and reactions. Each is safe to send again, so each goes as
/// its own request rather than waiting behind a message being sent; the
/// answer is null when it went through, or what to tell the person.
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
    });
    if (failure == null) await loadMessages(message.conversationId);
    return failure;
  }

  Future<String?> _profile(Map<String, dynamic> command) async {
    final failure = await _send(command);
    if (failure == null) await refresh();
    return failure;
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
