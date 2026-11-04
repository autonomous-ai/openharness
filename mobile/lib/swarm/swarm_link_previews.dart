import 'package:flutter/material.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_message_link.dart';
import 'swarm_message_reads.dart';
import 'swarm_message_row.dart';
import 'swarm_reader.dart';

/// [message]'s author as a link's preview names them: "You" for the reader's
/// own, else as its Swarm's roster names them, or the name the message was
/// written under while that Swarm is not read.
String swarmLinkAuthor(SwarmReader reader, SuperTabMessage message) {
  if (!message.fromAgent && message.authorId == reader.accountId) return 'You';
  return reader.snapshot?.authorName(message) ??
      (message.fromAgent
          ? message.authorName
          : superTabPersonName(message.authorName));
}

/// The messages [links] point at, each a small quote under the message that
/// says them (the desktop's `SuperTabMessageLinkPreviews`): who wrote it, the
/// chat it is in when that is not [chatId] of [tabId], and the start of its
/// text. A tap opens it. One the reader may not read, or that is gone, or
/// that could not be read, is only "Message unavailable", and opens nothing.
class SwarmLinkPreviews extends StatelessWidget {
  const SwarmLinkPreviews({
    super.key,
    required this.links,
    required this.reads,
    required this.reread,
    required this.readerOf,
    required this.tabId,
    required this.chatId,
    required this.onOpen,
    this.held,
  });

  final List<SwarmMessageLink> links;
  final SwarmMessageReads reads;

  /// Ticks as the chat's Swarm is read ([SwarmReader.reads]): a read that
  /// failed is asked again then, once [SwarmMessageReads.retryAfter] passed.
  final Listenable reread;

  /// The reader of the Swarm a link names, while the account lists it; null
  /// for any other Swarm, whose links are unavailable.
  final SwarmReader? Function(String tabId) readerOf;

  /// Where the message saying [links] is.
  final String tabId, chatId;

  /// A linked message the chat already holds, which needs no read.
  final SuperTabMessage? Function(SwarmMessageLink link)? held;
  final ValueChanged<SwarmMessageLink> onOpen;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([reads, reread]),
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [for (final link in links) _preview(link)],
    ),
  );

  Widget _preview(SwarmMessageLink link) {
    // By the whole link: a message may name two messages of one id in two
    // chats, and keys of one column must differ.
    final key = ValueKey(
      'swarm-link-preview-'
      '${link.tabId}/${link.conversationId}/${link.messageId}',
    );
    final reader = readerOf(link.tabId);
    final kept = held?.call(link);
    final read = reader == null
        ? SwarmMessageRead.gone
        : kept != null
        ? (swarmShowsRead(kept)
              ? SwarmMessageRead.found(kept)
              : SwarmMessageRead.gone)
        : reads.read(reader, link);
    final message = read.message;
    if (reader == null || message == null) {
      return SwarmQuote(
        key: key,
        text: read.state == SwarmReadState.loading
            ? 'Loading message…'
            : 'Message unavailable',
      );
    }
    final here = link.tabId == tabId && link.conversationId == chatId;
    return SwarmQuote(
      key: key,
      author: swarmLinkAuthor(reader, message),
      chat: here
          ? null
          : reader.snapshot?.conversation(link.conversationId)?.label,
      text: message.text.trim().isEmpty
          ? 'Attachment'
          : message.text.trim().replaceAll(RegExp(r'\s+'), ' '),
      label: 'Go to message',
      onTap: () => onOpen(link),
    );
  }
}

/// A reply's quote whose original is not among the messages its chat read:
/// the original read by itself (the desktop's `quoted`). It names its author
/// and text once read; until then, and when it could not be read, the
/// original "isn't loaded"; gone, or not the reader's, it is "no longer in
/// this chat". A read that failed is asked again as the chat's Swarm is read
/// ([SwarmReader.reads]), once [SwarmMessageReads.retryAfter] passed.
class SwarmReadQuote extends StatelessWidget {
  const SwarmReadQuote({
    super.key,
    required this.reads,
    required this.reader,
    required this.link,
    required this.author,
    this.onTap,
  });

  final SwarmMessageReads reads;
  final SwarmReader reader;

  /// The original.
  final SwarmMessageLink link;

  /// How the quote names the original's author.
  final String Function(SuperTabMessage original) author;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([reads, reader.reads]),
    builder: (context, _) {
      final read = reads.read(reader, link);
      final original = read.message;
      return SwarmQuote(
        author: original == null ? null : author(original),
        text:
            original?.text ??
            (read.state == SwarmReadState.gone
                ? 'The original message is no longer in this chat.'
                : null),
        onTap: onTap,
      );
    },
  );
}
