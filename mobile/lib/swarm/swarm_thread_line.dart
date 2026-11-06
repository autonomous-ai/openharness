import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_face.dart';
import 'swarm_message_row.dart';

/// How long ago: "just now", "4s ago", "3 min ago", "2 h ago", "5 d ago" —
/// the desktop's `superTabAgo`, word for word.
String swarmAgo(Duration age) {
  final seconds = age.inSeconds;
  if (seconds < 1) return 'just now';
  if (seconds < 60) return '${seconds}s ago';
  if (age.inMinutes < 60) return '${age.inMinutes} min ago';
  if (age.inHours < 24) return '${age.inHours} h ago';
  return '${age.inDays} d ago';
}

/// One who replied in a thread, as the chat draws its authors.
typedef SwarmThreadFace = ({
  String name,
  String id,
  bool agent,
  bool pm,
  SwarmLook look,
});

/// The newest reply authors of [thread] as [snapshot] names and dresses them:
/// an agent by the Swarm's name for it, a person by the name they show by,
/// part, as the chat names a message's author. The project's coordinator
/// wears manager blue here as on its own messages, whatever its role is
/// called.
List<SwarmThreadFace> swarmThreadFaces(
  SuperTabSnapshot? snapshot,
  SuperTabThread thread,
) => [
  for (final author in thread.authors)
    if (author['id'] case final String id)
      author['kind'] == 'agent'
          ? (
              name:
                  snapshot?.agentName(
                    id,
                    fallback:
                        (author['displayName'] ?? author['name'] ?? 'Agent')
                            as String,
                  ) ??
                  (author['displayName'] ?? author['name'] ?? 'Agent')
                      as String,
              id: id,
              agent: true,
              pm: snapshot?.isLead(id) ?? false,
              look: snapshot?.agentLook(id) ?? (picture: null, status: null),
            )
          : (
              name:
                  snapshot?.people
                      .where((p) => p.id == id)
                      .firstOrNull
                      ?.shownName ??
                  superTabPersonName(author['name'] as String? ?? ''),
              id: id,
              agent: false,
              pm: false,
              look: snapshot?.personLook(id) ?? (picture: null, status: null),
            ),
];

/// The line under a thread's root: who replied, how many replies, and when
/// the last came (the desktop's `SuperTabThreadLine`). A tap opens the
/// thread. The count reads as a link, in a blue that holds 4.5:1 on both
/// grounds ([AppCard.accentStrong]), where the palette's accent is near the
/// text's grey in the dark (anh Dee, 2026-11-06: threads were hidden). While
/// a thread the person follows has replies they have not read ([fresh]), a
/// filled New stands in place of when the last came.
class SwarmThreadLine extends StatelessWidget {
  const SwarmThreadLine({
    super.key,
    required this.thread,
    required this.faces,
    required this.onOpen,
    this.fresh = false,
  });

  final SuperTabThread thread;
  final List<SwarmThreadFace> faces;
  final VoidCallback onOpen;

  /// The person follows it and has not read its newest replies
  /// ([SwarmThreads.hasNewReplies]).
  final bool fresh;

  /// The faces' width: big enough to tell apart at a glance.
  static const double face = 24;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final count = thread.replies == 1 ? '1 reply' : '${thread.replies} replies';
    final last = thread.lastAt;
    final ago = fresh || last == null
        ? null
        : 'Last reply ${swarmAgo(DateTime.now().difference(last))}';
    return Semantics(
      button: true,
      label: fresh
          ? '$count, new replies'
          : ago == null
          ? count
          : '$count, $ago',
      hint: 'Open thread',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: ConstrainedBox(
          // A thumb's height, though the line is shorter.
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(
            children: [
              for (final who in faces) ...[
                SwarmChatAvatar(
                  name: who.name,
                  id: who.id,
                  agent: who.agent,
                  pm: who.pm,
                  picture: who.look.picture,
                  status: who.look.status,
                  diameter: face,
                ),
                const SizedBox(width: AppSpace.xs),
              ],
              Text(
                count,
                key: ValueKey('swarm-thread-count-${thread.id}'),
                style: swarmChatText(
                  14,
                  color: AppCard.accentStrong,
                  weight: FontWeight.w600,
                ),
              ),
              if (fresh) ...[
                const SizedBox(width: AppSpace.s),
                SwarmNewPill(key: ValueKey('swarm-thread-new-${thread.id}')),
              ],
              if (ago != null) ...[
                const SizedBox(width: AppSpace.s),
                Flexible(
                  child: Text(
                    ago,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: swarmChatText(13, color: AppPalette.textFaint),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// "New" in a filled pill, as Home's tags are drawn ([SwarmTags]): a thread
/// line's replies the person has not read.
class SwarmNewPill extends StatelessWidget {
  const SwarmNewPill({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      constraints: const BoxConstraints(minWidth: 22, minHeight: 20),
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
      alignment: Alignment.center,
      decoration: ShapeDecoration(
        color: AppPalette.accent,
        shape: const StadiumBorder(),
      ),
      child: Text(
        'New',
        maxLines: 1,
        style: AppType.caption(
          color: AppInk.onFill,
          fontWeight: AppFont.semibold,
          height: 1,
        ),
      ),
    );
  }
}

/// Over a reply also sent to the chat: where it was written, a tap away
/// (the desktop's "Replied in thread").
class SwarmRepliedInThread extends StatelessWidget {
  const SwarmRepliedInThread({super.key, required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Replied in thread, open thread',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
          child: Text(
            'Replied in thread',
            style: tty.style(color: AppPalette.textFaint, size: 12.5),
          ),
        ),
      ),
    );
  }
}
