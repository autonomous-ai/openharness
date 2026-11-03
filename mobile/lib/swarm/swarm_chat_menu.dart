import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_chat_manage.dart';
import 'swarm_chat_notify.dart';
import 'swarm_buddy.dart' show swarmIsOldBuddyChat;
import 'swarm_reader.dart';
import 'swarm_work_details_page.dart';

/// The chat menu's Notifications rows (the desktop's chat menu, Slack's
/// channel notifications): one per [SwarmNotify], the reader's own setting
/// for chat [chatId] ticked (✓), kept on every device of theirs. A tap sets it
/// ([swarmSetNotify]).
PhoneSheetSection swarmNotifySection(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) {
  final now = reader.notifyOf(chatId);
  return PhoneSheetSection(
    caption: 'Notifications',
    actions: [
      for (final level in SwarmNotify.values)
        PhoneSheetAction(
          icon: level == now
              ? LucideIcons.check300
              : switch (level) {
                  SwarmNotify.all => LucideIcons.bellRing300,
                  SwarmNotify.mentions => LucideIcons.atSign300,
                  SwarmNotify.muted => LucideIcons.bellOff300,
                },
          label: level.label,
          // The sheet draws no icons: the one set says so at its end.
          value: level == now ? '✓' : null,
          valueColor: AppPalette.textPrimary,
          onTap: () =>
              unawaited(swarmSetNotify(context, reader, chatId, level)),
        ),
    ],
  );
}

/// Sets [level] for chat [chatId] ([SwarmReader.setNotify]), and says so
/// when the server did not keep it — not once the chat's page is gone or
/// the Swarm can no longer be read.
Future<void> swarmSetNotify(
  BuildContext context,
  SwarmReader reader,
  String chatId,
  SwarmNotify level,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (await reader.setNotify(chatId, level) ||
      !context.mounted ||
      reader.accessRevoked ||
      reader.snapshot?.conversation(chatId) == null) {
    return;
  }
  messenger?.showSnackBar(
    const SnackBar(
      key: ValueKey('swarm-notify-failed'),
      content: Text('Could not change notifications. Try again.'),
    ),
  );
}

/// The sheet of chat [chatId]'s Notifications, titled with its name: from
/// its ⋮, or the project page's for its project chat. [actions], when
/// given, go above them, worked out again as the chat changes. It goes once
/// the chat can no longer be read — access lost, signed out, or the chat
/// gone.
Future<void> showSwarmNotifySheet(
  BuildContext context,
  SwarmReader reader,
  String chatId, {
  void Function(Route<void> route)? onShown,
  List<PhoneSheetAction> Function()? actions,
}) async {
  Route<void>? sheet;
  void moved() {
    final route = sheet;
    if (route == null ||
        (!reader.accessRevoked &&
            reader.snapshot?.conversation(chatId) != null)) {
      return;
    }
    sheet = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (route.isActive) route.navigator?.removeRoute(route);
    });
  }

  reader.addListener(moved);
  try {
    await showPhoneSheet(
      context,
      // An old Buddy chat's stored title is only the Buddy's default name.
      title: swarmIsOldBuddyChat(reader, chatId)
          ? 'Old chat'
          : reader.snapshot?.conversation(chatId)?.title ?? '',
      onShown: (route) {
        sheet = route;
        onShown?.call(route);
      },
      // A setting changed on another device meanwhile ticks here too.
      rebuildOn: reader,
      rows: () => (
        actions: actions?.call() ?? const [],
        sections: [swarmNotifySection(context, reader, chatId)],
      ),
    );
  } finally {
    reader.removeListener(moved);
  }
}

/// At the end of a chat's header: ⋮, whose sheet holds Rename and Archive
/// where the person may ([swarmChatManage]) and the chat's Notifications
/// ([swarmNotifySection]), as the desktop's chat menu does for every chat a
/// person reads, a viewer's too. Nothing while the chat is not
/// known. The sheet goes once the chat can no longer be read — access lost,
/// signed out, or the chat gone — or this header does.
class SwarmChatMenuButton extends StatefulWidget {
  const SwarmChatMenuButton({
    super.key,
    required this.reader,
    required this.chatId,
  });

  final SwarmReader reader;
  final String chatId;

  @override
  State<SwarmChatMenuButton> createState() => _SwarmChatMenuButtonState();
}

class _SwarmChatMenuButtonState extends State<SwarmChatMenuButton> {
  Route<void>? _sheet;

  bool get _readable =>
      !widget.reader.accessRevoked &&
      widget.reader.snapshot?.conversation(widget.chatId) != null;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
  }

  @override
  void didUpdateWidget(SwarmChatMenuButton old) {
    super.didUpdateWidget(old);
    if (old.reader == widget.reader && old.chatId == widget.chatId) return;
    old.reader.removeListener(_moved);
    widget.reader.addListener(_moved);
    _closeSheet();
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    _closeSheet();
    super.dispose();
  }

  void _moved() {
    if (!_readable) _closeSheet();
    if (mounted) setState(() {});
  }

  /// Takes the sheet down, once this frame is done: a header that lost its
  /// chat may not change the navigator while it builds.
  void _closeSheet() {
    final sheet = _sheet;
    _sheet = null;
    if (sheet == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (sheet.isActive) sheet.navigator?.removeRoute(sheet);
    });
  }

  Future<void> _open() => showSwarmNotifySheet(
    context,
    widget.reader,
    widget.chatId,
    onShown: (route) => _sheet = route,
    // Work details, Rename and Archive where the desktop's chat menu has
    // them.
    actions: () => [
      if (swarmHasWorkDetails(widget.reader, widget.chatId))
        PhoneSheetAction(
          icon: LucideIcons.info300,
          label: 'Work details',
          onTap: () => openSwarmWorkDetails(
            context,
            reader: widget.reader,
            chatId: widget.chatId,
          ),
        ),
      ...swarmChatManageActions(context, widget.reader, widget.chatId),
    ],
  ).whenComplete(() => _sheet = null);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (!_readable) return const SizedBox.shrink();
    return Semantics(
      key: const ValueKey('swarm-chat-menu'),
      button: true,
      label: 'Chat options',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          unawaited(_open());
        },
        child: SizedBox.square(
          dimension: minTouchTarget,
          child: Align(
            alignment: AlignmentDirectional.centerEnd,
            child: Icon(
              LucideIcons.ellipsisVertical300,
              size: AppIconSize.standalone,
              color: AppPalette.textPrimary,
            ),
          ),
        ),
      ),
    );
  }
}
