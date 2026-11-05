import 'package:harness/super_tabs/controller.dart';

import 'super_tab_fixture.dart';

/// A server with #2887's voice route (`POST …/attachments/:id/voice`):
/// [voiceAnswers] are given in turn, the last one again; a [SuperTabFailure]
/// in it is thrown.
class VoiceServer extends ConversationServer {
  final voiceReads = <String>[];
  List<Object> voiceAnswers = [
    {
      'voice': {
        'durationMs': 1000,
        'waveform': List.filled(48, 3),
        'transcribed': true,
      },
    },
  ];

  /// The last `message.send` the server was asked for.
  Map<String, dynamic>? lastSend() {
    for (final post in posts.reversed) {
      final command = post['command'];
      if (command is Map && command['type'] == 'message.send') {
        return Map<String, dynamic>.from(command);
      }
    }
    return null;
  }

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'POST' && path.contains('/voice')) {
      voiceReads.add(path);
      final answer =
          voiceAnswers[(voiceReads.length - 1).clamp(
            0,
            voiceAnswers.length - 1,
          )];
      if (answer is SuperTabFailure) throw answer;
      return answer as Map<String, dynamic>;
    }
    return super.request(method, path, body: body);
  }
}
