import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'model.dart';
import 'swarm_message_link.dart';
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
      padding: const EdgeInsets.only(top: AppSpace.xs),
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
                padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
                decoration: ShapeDecoration(
                  color: mine
                      ? accent.withValues(alpha: 0.14)
                      : swarmChatCard(tty),
                  shape: StadiumBorder(
                    side: BorderSide(color: mine ? accent : swarmChatHair(tty)),
                  ),
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

/// Opens a message's long-press sheet, with a light tap of the phone: the
/// reactions it can carry (Desktop's seven, the reader's own marked) where
/// the reader may [react], then Copy link to message with its [link], which
/// copies it and says so. Answers the reaction picked, or null when the sheet
/// closed without one.
Future<SuperTabReactionEmoji?> showSwarmReactionPicker(
  BuildContext context, {
  required List<SuperTabReactionCount> reactions,
  required String readerId,
  bool react = true,
  SwarmMessageLink? link,
}) {
  HapticFeedback.lightImpact();
  final mine = {
    for (final r in reactions)
      if (r.includes('person', readerId)) r.emoji,
  };
  return showModalBottomSheet<SuperTabReactionEmoji>(
    context: context,
    backgroundColor: AppGlass.rowFill,
    shape: AppControl.sheetShape,
    builder: (context) => _Picker(mine: mine, react: react, link: link),
  );
}

class _Picker extends StatelessWidget {
  const _Picker({required this.mine, required this.react, this.link});

  final Set<SuperTabReactionEmoji> mine;
  final bool react;
  final SwarmMessageLink? link;

  /// Desktop's Copy link to message: the link on the clipboard, the sheet
  /// closed, and "Link copied".
  Future<void> _copy(BuildContext context, SwarmMessageLink link) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    Navigator.of(context).pop();
    await Clipboard.setData(ClipboardData(text: link.url));
    messenger?.showSnackBar(
      const SnackBar(content: Text('Link copied'), duration: Durations.long4),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.l,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // The grabber: a capsule as wide as the two largest steps.
            Container(
              width: AppSpace.xl + AppSpace.m,
              height: AppSpace.xs,
              margin: const EdgeInsets.only(bottom: AppSpace.m),
              decoration: ShapeDecoration(
                color: AppGlass.hair,
                shape: const StadiumBorder(),
              ),
            ),
            if (react)
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  // Seven at 50 points are wider than a 375-point phone's
                  // sheet: each shares the row, never under a finger's 44.
                  for (final emoji in SuperTabReactionEmoji.values)
                    Flexible(
                      child: Semantics(
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
                            constraints: const BoxConstraints(
                              maxWidth: 50,
                              minHeight: 50,
                              maxHeight: 50,
                            ),
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
                              style: const TextStyle(
                                fontSize: AppIconSize.standalone,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            if (link case final link?)
              SizedBox(
                width: double.infinity,
                child: Semantics(
                  button: true,
                  child: InkWell(
                    key: const ValueKey('swarm-copy-link'),
                    borderRadius: BorderRadius.circular(AppControl.radius),
                    onTap: () => _copy(context, link),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        minHeight: minTouchTarget,
                      ),
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(
                          AppSpace.m,
                          react ? AppSpace.m : AppSpace.s,
                          AppSpace.m,
                          AppSpace.s,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              LucideIcons.link300,
                              size: 20,
                              color: AppPalette.textPrimary,
                            ),
                            const SizedBox(width: AppSpace.m),
                            Text(
                              'Copy link to message',
                              style: AppType.body(
                                color: AppPalette.textPrimary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
