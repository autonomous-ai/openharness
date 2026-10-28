import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart'
    show swarmChatCard, swarmChatHair, swarmChatText;

/// Who gave a reaction, as the chat names them: never by email.
typedef SwarmReactorName = String Function(String kind, String id);

/// The counts under a message, as Desktop draws them (`reactions.dart`): each
/// emoji and how many gave it, the reader's own marked. A tap takes theirs
/// back or adds it; holding one names who gave it. Without [onReact] (a
/// reader who cannot post) the counts only show.
class SwarmReactionBar extends StatelessWidget {
  const SwarmReactionBar({
    super.key,
    required this.messageId,
    required this.reactions,
    required this.readerId,
    required this.nameOf,
    this.onReact,
  });

  final String messageId;
  final List<SuperTabReactionCount> reactions;
  final String readerId;
  final SwarmReactorName nameOf;
  final ValueChanged<SuperTabReactionEmoji>? onReact;

  @override
  Widget build(BuildContext context) {
    if (reactions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Wrap(
        spacing: 6,
        children: [
          for (final reaction in reactions)
            _Count(
              key: ValueKey('swarm-reaction-$messageId-${reaction.emoji.key}'),
              reaction: reaction,
              mine: reaction.includes('person', readerId),
              names: _names(reaction),
              onTap: switch (onReact) {
                final react? => () => react(reaction.emoji),
                null => null,
              },
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

/// One emoji's count: a finger's size to tap, though drawn smaller.
class _Count extends StatelessWidget {
  const _Count({
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
    final tty = Tty.of(context);
    final accent = AppPalette.accentOnSurface;
    return Semantics(
      button: true,
      selected: mine,
      enabled: onTap != null,
      label: '${reaction.emoji.glyph} ${reaction.count}, $names',
      excludeSemantics: true,
      onTap: onTap,
      child: Tooltip(
        message: names,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            child: Center(
              widthFactor: 1,
              child: Container(
                height: 30,
                padding: const EdgeInsets.symmetric(horizontal: 9),
                decoration: BoxDecoration(
                  color: mine
                      ? accent.withValues(alpha: 0.14)
                      : swarmChatCard(tty),
                  border: Border.all(color: mine ? accent : swarmChatHair(tty)),
                  borderRadius: BorderRadius.circular(15),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(reaction.emoji.glyph, style: swarmChatText(15)),
                    const SizedBox(width: 5),
                    Text(
                      '${reaction.count}',
                      style: swarmChatText(
                        13.5,
                        color: mine ? accent : AppPalette.textSecondary,
                        weight: FontWeight.w600,
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

/// Opens the reactions a message can carry in a sheet, with a light tap of
/// the phone as a long-press gives: Desktop's six, the reader's own marked.
/// Answers the one picked, or null when the sheet closed without one.
Future<SuperTabReactionEmoji?> showSwarmReactionPicker(
  BuildContext context, {
  required List<SuperTabReactionCount> reactions,
  required String readerId,
}) {
  HapticFeedback.lightImpact();
  final mine = {
    for (final r in reactions)
      if (r.includes('person', readerId)) r.emoji,
  };
  return showModalBottomSheet<SuperTabReactionEmoji>(
    context: context,
    backgroundColor: AppGlass.rowFill,
    barrierColor: Colors.black.withValues(alpha: .55),
    shape: AppControl.sheetShape,
    builder: (context) => _Picker(mine: mine),
  );
}

class _Picker extends StatelessWidget {
  const _Picker({required this.mine});

  final Set<SuperTabReactionEmoji> mine;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 36,
              height: 5,
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: AppGlass.hair,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                for (final emoji in SuperTabReactionEmoji.values)
                  Semantics(
                    button: true,
                    selected: mine.contains(emoji),
                    label:
                        '${emoji.key.replaceAll('_', ' ')}'
                        '${mine.contains(emoji) ? ', yours' : ''}',
                    excludeSemantics: true,
                    onTap: () => Navigator.of(context).pop(emoji),
                    child: GestureDetector(
                      key: ValueKey('swarm-react-${emoji.key}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () => Navigator.of(context).pop(emoji),
                      child: Container(
                        width: 50,
                        height: 50,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: mine.contains(emoji)
                              ? accent.withValues(alpha: 0.18)
                              : null,
                          border: mine.contains(emoji)
                              ? Border.all(color: accent)
                              : null,
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          emoji.glyph,
                          style: const TextStyle(fontSize: 26),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
