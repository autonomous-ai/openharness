import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'message_link.dart';
import 'model.dart';

/// What a message link points at, for a reader. Anything the reader may not
/// read, or that is gone, is the same [unavailable]: it gives no title, author
/// or text, and does not say which of the two it is.
class SuperTabLinkTarget {
  const SuperTabLinkTarget.unavailable() : message = null, author = null;
  const SuperTabLinkTarget.loading() : message = null, author = '';
  const SuperTabLinkTarget.message(
    SuperTabMessage this.message, {
    required String this.author,
  });

  /// The message, once read; null for [unavailable] and [loading].
  final SuperTabMessage? message;

  /// Who wrote [message]; empty while [loading], null for [unavailable].
  final String? author;

  bool get isUnavailable => author == null;
  bool get isLoading => author == '';
  SuperTabLinkTarget withAuthor(String name) => message == null
      ? this
      : SuperTabLinkTarget.message(message!, author: name);
}

/// The messages a text links to, each as a small quote under it.
class SuperTabMessageLinkPreviews extends StatelessWidget {
  const SuperTabMessageLinkPreviews(
    this.text, {
    super.key,
    required this.resolve,
    required this.onOpen,
  });
  final String text;
  final SuperTabLinkTarget Function(SwarmMessageLink) resolve;
  final ValueChanged<SwarmMessageLink> onOpen;

  @override
  Widget build(BuildContext context) {
    final links = SwarmMessageLink.allIn(text);
    if (links.isEmpty) return const SizedBox.shrink();
    grid.AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: grid.AppDesktop.controlGap,
      children: [
        // The gap above the first quote is the column's own spacing.
        const SizedBox.shrink(),
        for (final link in links)
          _Preview(
            key: ValueKey('super-message-link-preview-${link.messageId}'),
            target: resolve(link),
            onOpen: () => onOpen(link),
          ),
      ],
    );
  }
}

class _Preview extends StatelessWidget {
  const _Preview({super.key, required this.target, required this.onOpen});
  final SuperTabLinkTarget target;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final message = target.message;
    final quote = Container(
      constraints: const BoxConstraints(maxWidth: 560),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: DesktopChrome.muted, width: 2)),
      ),
      child: Row(
        children: [
          const SizedBox(width: grid.AppDesktop.controlGap),
          Flexible(child: _body(message)),
        ],
      ),
    );
    if (message == null) return quote;
    return Semantics(
      container: true,
      button: true,
      hint: 'Go to message',
      child: InkWell(onTap: onOpen, child: quote),
    );
  }

  Widget _body(SuperTabMessage? message) {
    if (message == null) {
      return Text(
        target.isLoading ? 'Loading message…' : 'Message unavailable',
        style: DesktopChrome.metadata(),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          target.author!,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.control(medium: true),
        ),
        const SizedBox(height: 2),
        Text(
          message.text.trim().isEmpty
              ? 'Attachment'
              : message.text.replaceAll(RegExp(r'\s+'), ' '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(),
        ),
      ],
    );
  }
}
