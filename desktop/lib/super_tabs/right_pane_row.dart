import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import 'avatar_art.dart';
import 'buddy_list.dart';
import 'controller.dart';
import 'model.dart';

/// Conversations beside the Board. Buddies are pinned; closing a card only
/// removes its local tab, never the conversation or its messages.
class SuperTabRightPaneRow extends StatefulWidget {
  const SuperTabRightPaneRow({super.key, required this.controller, this.app});
  final SuperTabController controller;
  final AppNotifier? app;

  @override
  State<SuperTabRightPaneRow> createState() => _SuperTabRightPaneRowState();
}

class _SuperTabRightPaneRowState extends State<SuperTabRightPaneRow> {
  SuperTabController get c => widget.controller;
  final _cards = <String>[];
  String? _selected;

  @override
  void initState() {
    super.initState();
    _remember();
    c.addListener(_changed);
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    super.dispose();
  }

  void _remember() {
    final group = c.selected;
    if (group == null || group.id == _selected) return;
    _selected = group.id;
    if (!group.isBuddyChat && !_cards.contains(group.id)) {
      _cards.add(group.id);
    }
  }

  void _changed() {
    _remember();
    if (mounted) setState(() {});
  }

  void _close(String id) {
    setState(() => _cards.remove(id));
    if (c.selectedId == id) {
      final next = c.buddies().firstOrNull?.id ?? _cards.firstOrNull;
      if (next != null) unawaited(c.select(next));
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final buddies = c.buddies();
    final cards = [
      for (final id in _cards)
        if (c.snapshot?.conversation(id) case final group? when !group.archived)
          group,
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          key: const ValueKey('super-right-pane-row'),
          height: 48,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final all = [...buddies, ...cards];
              // Leave room for New Buddy, overflow and the section divider.
              final count = math.min(
                8,
                math.max(0, ((constraints.maxWidth - 92) / 42).floor()),
              );
              final shown = all.take(count).toList();
              final rest = all.skip(count).toList();
              return Row(
                children: [
                  for (final (i, group) in shown.indexed) ...[
                    if (i == buddies.length && i > 0)
                      const SizedBox(
                        key: ValueKey('super-chat-divider'),
                        height: 24,
                        child: VerticalDivider(width: 12),
                      ),
                    _avatar(group, buddy: group.isBuddyChat),
                  ],
                  if (rest.isNotEmpty)
                    AppDropdown(
                      width: 260,
                      children: [
                        for (final group in rest)
                          AppMenuItem(
                            key: ValueKey('super-chat-overflow-${group.id}'),
                            label: group.buddyName ?? group.label,
                            selected: group.id == c.selectedId,
                            note: c.unread(group) ? 'Unread' : null,
                            onPressed: () => unawaited(c.select(group.id)),
                            trailing: group.isBuddyChat
                                ? null
                                : IconButton(
                                    tooltip: 'Close ${group.label}',
                                    iconSize: 14,
                                    onPressed: () => _close(group.id),
                                    icon: const Icon(AppIcons.close),
                                  ),
                          ),
                      ],
                      builder: (context, menu, _) => TextButton(
                        key: const ValueKey('super-chat-overflow'),
                        onPressed: () =>
                            menu.isOpen ? menu.close() : menu.open(),
                        child: Text('+${rest.length}'),
                      ),
                    ),
                  AppIconButton(
                    key: const ValueKey('super-buddy-new'),
                    icon: AppIcons.plus,
                    tooltip: 'New Buddy',
                    onPressed: c.canWrite
                        ? () => unawaited(
                            showNewBuddy(context, c, app: widget.app),
                          )
                        : null,
                  ),
                ],
              );
            },
          ),
        ),
        if (c.selected?.isBuddyChat == true && c.canWrite)
          SuperTabBuddyMenu(controller: c, app: widget.app),
      ],
    );
  }

  Widget _avatar(SuperTabConversation group, {required bool buddy}) =>
      _ConversationAvatar(
        key: ValueKey(
          '${buddy ? 'super-buddy-tab' : 'super-chat-tab'}-${group.id}',
        ),
        group: group,
        selected: c.selectedId == group.id,
        unread: c.unread(group),
        onSelect: () => unawaited(c.select(group.id)),
        onClose: buddy ? null : () => _close(group.id),
      );
}

class _ConversationAvatar extends StatefulWidget {
  const _ConversationAvatar({
    super.key,
    required this.group,
    required this.selected,
    required this.unread,
    required this.onSelect,
    this.onClose,
  });
  final SuperTabConversation group;
  final bool selected, unread;
  final VoidCallback onSelect;
  final VoidCallback? onClose;

  @override
  State<_ConversationAvatar> createState() => _ConversationAvatarState();
}

class _ConversationAvatarState extends State<_ConversationAvatar> {
  bool _hover = false, _focus = false;

  @override
  Widget build(BuildContext context) {
    final group = widget.group;
    final name = group.buddyName ?? group.label;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: Tooltip(
        message: name,
        child: SizedBox(
          width: 42,
          height: 44,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Positioned.fill(
                child: Semantics(
                  label: name,
                  selected: widget.selected,
                  child: InkWell(
                    onTap: widget.onSelect,
                    onFocusChange: (v) => setState(() => _focus = v),
                    borderRadius: BorderRadius.circular(24),
                    child: Center(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            width: 2,
                            color: widget.selected
                                ? Theme.of(context).colorScheme.primary
                                : Colors.transparent,
                          ),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(2),
                          child: SuperTabAvatarFace(
                            identity: group.id,
                            name: name,
                            size: 28,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (widget.unread)
                Positioned(
                  right: 3,
                  bottom: 4,
                  child: Semantics(
                    label: 'Unread',
                    child: Container(
                      key: ValueKey('super-chat-unread-${group.id}'),
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                  ),
                ),
              if (widget.onClose != null && (_hover || _focus))
                Positioned(
                  right: -3,
                  top: -2,
                  child: SizedBox(
                    width: 22,
                    height: 22,
                    child: IconButton(
                      key: ValueKey('super-chat-close-${group.id}'),
                      padding: EdgeInsets.zero,
                      iconSize: 14,
                      tooltip: 'Close $name',
                      onPressed: widget.onClose,
                      icon: const Icon(AppIcons.close),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
