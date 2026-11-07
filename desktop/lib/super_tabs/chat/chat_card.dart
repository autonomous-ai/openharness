import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import '../swarm_type.dart';
import 'bubble.dart';

/// A compact card in the chat (anh Dee's mockup, 11-07, #4529): a sent brief,
/// a shipped note. A small [label], one [title] line and one blue [action]
/// that shows its [details] in place; never the whole text inline.
class SwarmChatCard extends StatefulWidget {
  const SwarmChatCard({
    super.key,
    required this.label,
    required this.title,
    required this.action,
    required this.details,
  });

  final String label, title, action;
  final Widget details;

  @override
  State<SwarmChatCard> createState() => _SwarmChatCardState();
}

class _SwarmChatCardState extends State<SwarmChatCard> {
  var _open = false;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: const ValueKey('swarm-chat-card'),
    decoration: BoxDecoration(
      color: DesktopChrome.surface,
      borderRadius: const BorderRadius.all(SwarmBubble.radius),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.label, style: SwarmType.time(context)),
          const SizedBox(height: 2),
          Text(
            widget.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: SwarmType.body(context)
                .copyWith(fontWeight: FontWeight.w600),
          ),
          if (_open) ...[const SizedBox(height: 8), widget.details],
          const SizedBox(height: 6),
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => setState(() => _open = !_open),
              child: Semantics(
                button: true,
                child: Text(
                  _open ? 'Hide' : widget.action,
                  style: SwarmType.body(context, color: DesktopChrome.accent),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
