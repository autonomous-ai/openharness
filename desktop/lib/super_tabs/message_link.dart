import 'package:flutter/foundation.dart';

/// A link to one message of a Swarm: `harness://swarm/<tab>/<conversation>/<message>`.
/// It names ids only, so it grants nothing: whoever opens it sees the message
/// only if the Swarm already lets them read that conversation. The message id
/// alone places it, so the link still works for a message that lives in a thread.
class SwarmMessageLink {
  const SwarmMessageLink({
    required this.tabId,
    required this.conversationId,
    required this.messageId,
  });

  final String tabId, conversationId, messageId;

  static final _id = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
  static final _candidate = RegExp(
    r'harness://swarm/[A-Za-z0-9_/-]+(?![A-Za-z0-9_/?#%.-])',
  );
  static final _code = RegExp(r'```[\s\S]*?(?:```|$)|`[^`\n]*`');

  /// Links a message previews; the rest stay text.
  static const previewLimit = 4;

  String get url => 'harness://swarm/$tabId/$conversationId/$messageId';

  static SwarmMessageLink? parse(String value) {
    // Match the native URL-open limit, including cold-start delivery.
    if (value.length > 240) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'harness' ||
        uri.host != 'swarm' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        uri.pathSegments.length != 3 ||
        !uri.pathSegments.every(_id.hasMatch)) {
      return null;
    }
    final [tab, conversation, message] = uri.pathSegments;
    return SwarmMessageLink(
      tabId: tab,
      conversationId: conversation,
      messageId: message,
    );
  }

  /// The message links [text] says outside code, each once, in order.
  static List<SwarmMessageLink> allIn(String text) {
    final seen = <String>{};
    return [
      for (final match in _candidate.allMatches(text.replaceAll(_code, ' ')))
        if (parse(match[0]!) case final link? when seen.add(link.url)) link,
    ].take(previewLimit).toList();
  }
}

/// Links arriving before sign-in wait here, in memory only, until the Swarm
/// they name is on screen.
class SwarmMessageLinkInbox extends ChangeNotifier {
  static const _limit = 20;
  final List<SwarmMessageLink> _pending = [];
  List<SwarmMessageLink> get pending => List.unmodifiable(_pending);

  Future<void> accept(String value) async {
    final link = SwarmMessageLink.parse(value);
    if (link == null ||
        _pending.length >= _limit ||
        _pending.any((item) => item.url == link.url)) {
      return;
    }
    _pending.add(link);
    notifyListeners();
  }

  void complete(SwarmMessageLink link) {
    _pending.removeWhere((item) => item.url == link.url);
    notifyListeners();
  }
}

final swarmMessageLinkInbox = SwarmMessageLinkInbox();
