/// A link to one message of a Swarm: `harness://swarm/<tab>/<conversation>/<message>`,
/// the link Desktop copies (desktop/lib/super_tabs/message_link.dart). It
/// names ids only, so it grants nothing: whoever opens it sees the message
/// only if the Swarm already lets them read that conversation. The message id
/// alone places it, so the link still works for a message in a thread.
class SwarmMessageLink {
  const SwarmMessageLink({
    required this.tabId,
    required this.conversationId,
    required this.messageId,
  });

  final String tabId, conversationId, messageId;

  String get url => 'harness://swarm/$tabId/$conversationId/$messageId';
}
