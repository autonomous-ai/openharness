import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';

import 'swarm_buddy_sessions.dart';
import 'swarm_conversation.dart';
import 'swarm_message_row.dart' show swarmChatText;
import 'swarm_thread.dart';

// Buddy thread sessions on the phone (task #2118; Desktop's New session in the
// chat composer and the thread's reply box, `buddy_sessions.dart`): the pieces
// the chat's composer and the thread page put together. What each shows is
// worked out by SwarmConversation and SwarmThread; these only draw it.

/// New session in the chat composer's toolbar, beside @ Tag: on in the
/// accent. Disabled while the chat [blocked] it, a tap saying why through
/// [onBlocked] (a phone has no hover).
class SwarmNewSessionChip extends StatelessWidget {
  const SwarmNewSessionChip({
    super.key,
    required this.on,
    required this.blocked,
    required this.onChanged,
    this.onBlocked,
  });

  final bool on;

  /// Why a session cannot start now; null when it can.
  final String? blocked;
  final ValueChanged<bool> onChanged;

  /// The chip was tapped while [blocked].
  final VoidCallback? onBlocked;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final disabled = blocked != null;
    final ink = disabled
        ? AppPalette.textFaint
        : on
        ? AppPalette.accentOnSurface
        : AppPalette.textSecondary;
    void tap() => disabled ? onBlocked?.call() : onChanged(!on);
    return Semantics(
      button: true,
      checked: on && !disabled,
      enabled: !disabled,
      label: 'New session',
      hint: blocked ?? 'Starts a separate Buddy session for this message',
      excludeSemantics: true,
      onTap: tap,
      child: GestureDetector(
        key: const ValueKey('swarm-new-session'),
        behavior: HitTestBehavior.opaque,
        onTap: tap,
        child: SizedBox(
          height: 44,
          // Only as wide as the chip: in a roomy row a plain Center would
          // fill it and put the chip in the middle.
          child: Center(
            widthFactor: 1,
            child: Container(
              height: 36,
              padding: SwarmComposer.tagPadding,
              decoration: BoxDecoration(
                color: on && !disabled
                    ? AppPalette.accentOnSurface.withValues(alpha: 0.16)
                    : tty.text.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(SwarmComposer.tagRadius),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(LucideIcons.messageSquarePlus, size: 17, color: ink),
                  const SizedBox(width: 5),
                  Flexible(
                    child: Text(
                      'New session',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: swarmChatText(
                        14,
                        color: ink,
                        weight: FontWeight.w500,
                        height: 1.2,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "Works in: All projects ⌄" over the composer while New session is on:
/// where the session works. A tap opens [showSwarmSessionProjects].
class SwarmSessionProjectRow extends StatelessWidget {
  const SwarmSessionProjectRow({
    super.key,
    required this.chat,
    required this.onTap,
  });

  final SwarmConversation chat;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final chosen = chat.sessionProjectId;
    final name = chat.reader.snapshot?.projects
        .where((p) => p.id == chosen)
        .firstOrNull
        ?.name;
    return Semantics(
      button: true,
      label: 'Where this session works: ${name ?? 'All projects'}',
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: Row(
              children: [
                Text(
                  'Works in:',
                  style: swarmChatText(13.5, color: AppPalette.textSecondary),
                ),
                const SizedBox(width: AppSpace.xs),
                Flexible(
                  child: Text(
                    name ?? 'All projects',
                    key: const ValueKey('swarm-session-project-name'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: swarmChatText(
                      14,
                      color: AppPalette.textPrimary,
                      weight: FontWeight.w500,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.xs),
                Icon(
                  LucideIcons.chevronDown,
                  size: 16,
                  color: AppPalette.textSecondary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The sheet that picks where a New session works: every project the person
/// reads, sending no work to a PM, or one project, whose PM it alone can hand
/// work to (Desktop's words).
Future<void> showSwarmSessionProjects(
  BuildContext context,
  SwarmConversation chat,
) {
  final chosen = chat.sessionProjectId;
  PhoneSheetAction row(String label, String? projectId) => PhoneSheetAction(
    icon: projectId == chosen
        ? LucideIcons.check300
        : LucideIcons.folderOpen300,
    label: label,
    value: projectId == chosen ? '✓' : null,
    valueColor: AppPalette.textPrimary,
    onTap: () => chat.sessionProjectId = projectId,
  );
  return showPhoneSheet(
    context,
    title: 'Where this session works',
    actions: [
      row('All projects · ask anything', null),
      for (final project in chat.reader.snapshot?.projects ?? const [])
        row('${project.name} · ask and hand off work', project.id),
    ],
  );
}

/// New session in the thread's reply box: a check beside its words. On and
/// locked once the thread's session ended, the reply starting a new one;
/// disabled with its reason while the chat cannot start one.
class SwarmNewSessionCheck extends StatelessWidget {
  const SwarmNewSessionCheck({super.key, required this.thread});

  final SwarmThread thread;

  @override
  Widget build(BuildContext context) {
    final blocked = thread.sessionBlocked;
    final locked = thread.sessionLocked;
    final on = thread.newSession;
    final enabled = !locked && blocked == null;
    final note =
        blocked ??
        (locked
            ? 'This thread\'s session ended. Your reply starts a new one.'
            : null);
    void tap() => thread.newSession = !on;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          key: const ValueKey('swarm-thread-new-session'),
          checked: on,
          enabled: enabled,
          label: 'New session',
          hint: note ?? 'Starts a separate Buddy session for this thread',
          excludeSemantics: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: enabled ? tap : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Checkbox(
                    value: on,
                    visualDensity: VisualDensity.compact,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    onChanged: enabled ? (_) => tap() : null,
                  ),
                  const SizedBox(width: AppSpace.s),
                  Text(
                    'New session',
                    style: swarmChatText(
                      14,
                      color: enabled
                          ? AppPalette.textPrimary
                          : AppPalette.textFaint,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (note != null)
          Padding(
            padding: const EdgeInsets.only(
              left: AppSpace.xs,
              bottom: AppSpace.s,
            ),
            child: Text(
              note,
              key: const ValueKey('swarm-thread-new-session-note'),
              style: swarmChatText(13, color: AppPalette.textSecondary),
            ),
          ),
      ],
    );
  }
}

/// Under the thread page's header: which session answers the thread and how
/// it stands, with End session as a quiet text action; or why its last
/// session ended. Nothing for a thread with neither.
class SwarmThreadSessionLine extends StatelessWidget {
  const SwarmThreadSessionLine({super.key, required this.thread});

  final SwarmThread thread;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final chat = thread.chat.conversation;
    final session = thread.session;
    final Widget line;
    if (chat != null && session != null) {
      final ending = thread.endingSession;
      line = Row(
        children: [
          Expanded(
            child: Text(
              swarmSessionWords(thread.reader, chat, session),
              key: const ValueKey('swarm-thread-session-state'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: swarmChatText(13.5, color: AppPalette.textSecondary),
            ),
          ),
          if (thread.canPost)
            TtyTap(
              semanticsLabel: ending ? 'Ending session' : 'End session',
              onTap: ending ? null : () => unawaited(thread.endSession()),
              child: Padding(
                key: const ValueKey('swarm-thread-session-end'),
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpace.s,
                  vertical: AppSpace.m,
                ),
                child: Text(
                  ending ? 'Ending…' : 'End session',
                  style: swarmChatText(
                    14,
                    color: ending
                        ? AppPalette.textFaint
                        : AppPalette.accentOnSurface,
                  ),
                ),
              ),
            ),
        ],
      );
    } else if (thread.sessionEndedRow case final ended?) {
      line = Text(
        swarmSessionEndedWords(ended.sessionEndReason),
        key: const ValueKey('swarm-thread-session-ended'),
        style: swarmChatText(13.5, color: AppPalette.textFaint),
      );
    } else {
      return const SizedBox.shrink();
    }
    return Container(
      key: const ValueKey('swarm-thread-session-line'),
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.screenInset),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: tty.text.withValues(alpha: 0.08)),
        ),
      ),
      child: line,
    );
  }
}
