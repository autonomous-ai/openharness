import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// Who gave a reaction, as the view names them.
typedef SuperTabReactorName = String Function(String kind, String id);

/// The counts under a message. A chip is the reader's own when they gave it;
/// tapping it takes theirs back or adds it. Without [onReact] (a reader who
/// cannot write) the counts only show.
class SuperTabReactionBar extends StatelessWidget {
  const SuperTabReactionBar({
    super.key,
    required this.message,
    required this.readerId,
    required this.nameOf,
    this.onReact,
  });
  final SuperTabMessage message;
  final String readerId;
  final SuperTabReactorName nameOf;
  final ValueChanged<SuperTabReactionEmoji>? onReact;

  @override
  Widget build(BuildContext context) {
    if (message.reactions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 4,
        children: [
          for (final reaction in message.reactions)
            _Chip(
              key: ValueKey(
                'super-reaction-${message.id}-${reaction.emoji.key}',
              ),
              reaction: reaction,
              mine: reaction.includes('person', readerId),
              names: _names(reaction),
              onTap: onReact == null ? null : () => onReact!(reaction.emoji),
            ),
        ],
      ),
    );
  }

  String _names(SuperTabReactionCount reaction) {
    final names = [for (final who in reaction.by) nameOf(who.kind, who.id)];
    return names.length < 2
        ? names.join()
        : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    super.key,
    required this.reaction,
    required this.mine,
    required this.names,
    required this.onTap,
  });
  final SuperTabReactionCount reaction;
  final bool mine;
  final String names;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
      side: BorderSide(color: mine ? DesktopChrome.accent : DesktopChrome.rim),
    );
    return Tooltip(
      message: names,
      excludeFromSemantics: true,
      child: Semantics(
        button: true,
        selected: mine,
        enabled: onTap != null,
        label: '${reaction.emoji.glyph} ${reaction.count}, $names',
        child: Material(
          color: mine ? DesktopChrome.selection : grid.AppSurface.recess,
          shape: shape,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ExcludeSemantics(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(reaction.emoji.glyph),
                    const SizedBox(width: 4),
                    Text(
                      '${reaction.count}',
                      style: DesktopChrome.metadata(
                        color: mine ? DesktopChrome.accent : null,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The message action that adds a reaction: the small set, one tap each.
class SuperTabReactionPicker extends StatefulWidget {
  const SuperTabReactionPicker({super.key, required this.onReact});
  final ValueChanged<SuperTabReactionEmoji> onReact;

  @override
  State<SuperTabReactionPicker> createState() => _SuperTabReactionPickerState();
}

class _SuperTabReactionPickerState extends State<SuperTabReactionPicker> {
  final _menu = MenuController();

  @override
  Widget build(BuildContext context) => MenuAnchor(
    controller: _menu,
    menuChildren: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final emoji in SuperTabReactionEmoji.values)
              IconButton(
                tooltip: emoji.key.replaceAll('_', ' '),
                onPressed: () {
                  _menu.close();
                  widget.onReact(emoji);
                },
                icon: Text(emoji.glyph, style: const TextStyle(fontSize: 18)),
              ),
          ],
        ),
      ),
    ],
    builder: (context, menu, _) => IconButton(
      tooltip: 'Add reaction',
      iconSize: 16,
      visualDensity: VisualDensity.compact,
      onPressed: () => menu.isOpen ? menu.close() : menu.open(),
      icon: const Text('🙂', style: TextStyle(fontSize: 14)),
    ),
  );
}
