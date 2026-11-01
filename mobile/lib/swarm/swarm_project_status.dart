import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/app_type.dart';
import 'model.dart';
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_needs_page.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// The decisions waiting on the person in [projectId] of Swarm [swarmId], as
/// Activity lists them ([swarmNeedsOf]): each asked in a conversation of that
/// project the person still reads, so one from another project, or whose
/// conversation they lost, never shows — the desktop's
/// `SuperTabProjectStatusCard.needsYou`.
List<SwarmDecisionNeed> swarmProjectNeedsYou(
  SwarmSession session,
  SwarmReader reader,
  String swarmId,
  String projectId,
) {
  final snapshot = reader.snapshot;
  if (snapshot == null || reader.accessRevoked) return const [];
  return [
    for (final need in swarmNeedsOf(session.inbox, swarmId))
      if (need is SwarmDecisionNeed &&
          need.decision.projectId == projectId &&
          snapshot.conversation(need.conversationId)?.projectId == projectId)
        need,
  ];
}

/// Whether the person reads [project], as the server does (`canReadProject`):
/// a private project is its owner's and its members'. The server sends no
/// other; the card holds to this if it ever did.
bool swarmReadsProject(SwarmReader reader, SuperTabProject project) {
  if (!project.isPrivate || project.ownerId == reader.accountId) return true;
  final me = reader.snapshot?.people
      .where((p) => p.id == reader.accountId)
      .firstOrNull;
  return me != null && project.hasMember(me);
}

/// "16:52" today, "Oct 30, 16:52" before, in this phone's time: the
/// desktop's `SuperTabProjectStatusCard.updatedAt`.
String swarmStatusUpdatedAt(DateTime at, DateTime now) {
  final local = at.toLocal(), today = now.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  final clock = '${two(local.hour)}:${two(local.minute)}';
  if (local.year == today.year &&
      local.month == today.month &&
      local.day == today.day) {
    return clock;
  }
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final year = local.year == today.year ? '' : ' ${local.year}';
  return '${months[local.month - 1]} ${local.day}$year, $clock';
}

/// Opens a link in the status text; tests replace it.
@visibleForTesting
Future<bool> Function(Uri url) swarmOpenStatusLink = (url) =>
    launchUrl(url, mode: LaunchMode.inAppBrowserView);

/// The status card at the top of a project's chat, as the desktop draws it
/// (`desktop/lib/super_tabs/project_status_card.dart`): what the coordinator
/// last reported, replaced in place by each report, and the decisions in this
/// project waiting on the person, each opening Activity at it, where the
/// desktop opens Notifications. Hidden while there is neither; folded to its
/// heading by the person, remembered on this phone
/// ([SwarmHomePrefs.folded]), and while the keyboard is up, so it never
/// pushes the composer.
///
/// It reads nothing of its own: the text comes with the Swarm read, the
/// decisions are Activity's ([swarmProjectNeedsYou]).
class SwarmProjectStatusCard extends StatelessWidget {
  const SwarmProjectStatusCard({
    super.key,
    required this.session,
    required this.reader,
    required this.swarmId,
    required this.projectId,
    this.typing = false,
    this.now = DateTime.now,
  });

  final SwarmSession session;
  final SwarmReader reader;
  final String swarmId, projectId;

  /// The keyboard is up. Told by the page: inside its Scaffold the inset is
  /// taken away, so the card cannot see it.
  final bool typing;
  final DateTime Function() now;

  /// How tall the open card grows before its text scrolls inside it.
  static const maxBody = 200.0;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // The session tells of answers held for Undo, which the rows say.
    listenable: Listenable.merge([
      reader,
      session.inbox,
      session.home,
      session,
    ]),
    builder: (context, _) {
      AppTheme.watch(context);
      final snapshot = reader.accessRevoked ? null : reader.snapshot;
      final project = snapshot?.projectById(projectId);
      if (project == null || !swarmReadsProject(reader, project)) {
        return const SizedBox.shrink();
      }
      final status = project.status;
      final waiting = swarmProjectNeedsYou(session, reader, swarmId, projectId);
      if (status == null && waiting.isEmpty) return const SizedBox.shrink();
      final chosen = session.home.folded(swarmId, projectId);
      final folded = chosen || typing;
      return Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenInset,
          AppSpace.xs,
          AppSpace.screenInset,
          AppSpace.xs,
        ),
        child: Semantics(
          container: true,
          label: 'Project status',
          child: DecoratedBox(
            key: ValueKey('swarm-project-status-$projectId'),
            decoration: BoxDecoration(
              color: AppPalette.cardBg,
              borderRadius: BorderRadius.circular(AppCard.radius),
              border: Border.all(color: AppGlass.hair),
            ),
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                AppSpace.m,
                0,
                0,
                folded ? 0 : AppSpace.s,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _heading(status?.at, waiting.length, folded, chosen),
                  if (!folded)
                    // A long report, or many decisions, scroll inside the
                    // card, so the chat keeps its room; each keeps a share,
                    // so a long report never hides what waits on the person.
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: maxBody),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (status != null)
                            Flexible(
                              child: SingleChildScrollView(
                                key: ValueKey(
                                  'swarm-project-status-body-$projectId',
                                ),
                                padding: const EdgeInsets.only(
                                  right: AppSpace.m,
                                ),
                                child: _StatusText(status.text),
                              ),
                            ),
                          if (status != null && waiting.isNotEmpty)
                            const SizedBox(height: AppSpace.s),
                          if (waiting.isNotEmpty)
                            Flexible(
                              child: SingleChildScrollView(
                                key: ValueKey(
                                  'swarm-project-status-needs-$projectId',
                                ),
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    for (final need in waiting)
                                      SwarmNeedLine(
                                        key: ValueKey(
                                          'swarm-project-status-need-'
                                          '${need.key}',
                                        ),
                                        session: session,
                                        need: need,
                                        chevron: LucideIcons.chevronRight300,
                                        onTap: () => openSwarmNeeds(
                                          context,
                                          focus: need.key,
                                          swarmId: swarmId,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );

  /// "Status · updated 09:52", with how many wait on the person while
  /// folded, and the fold at its end. While the keyboard folds it, the
  /// button still says what the person chose.
  Widget _heading(DateTime? at, int waiting, bool folded, bool chosen) => Row(
    children: [
      Expanded(
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: 'Status',
                style: AppType.label(color: AppPalette.textPrimary),
              ),
              if (at != null)
                TextSpan(
                  text: ' · updated ${swarmStatusUpdatedAt(at, now())}',
                  style: AppType.caption(color: AppPalette.textSecondary),
                ),
              // Folded, the heading still says something waits.
              if (folded && waiting > 0)
                TextSpan(
                  text: ' · $waiting ${waiting == 1 ? 'needs' : 'need'} you',
                  style: AppType.caption(color: AppPalette.swarmAccent),
                ),
            ],
          ),
          key: ValueKey('swarm-project-status-heading-$projectId'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      SwarmIconButton(
        key: ValueKey('swarm-project-status-fold-$projectId'),
        label: chosen ? 'Show status' : 'Fold status',
        icon: chosen ? LucideIcons.chevronDown300 : LucideIcons.chevronUp300,
        size: 18,
        onPressed: () => session.home.fold(swarmId, projectId, !chosen),
      ),
    ],
  );
}

/// The report as the coordinator wrote it, line for line, with its web links
/// tappable. Not Markdown: the card is a glance, not a message.
class _StatusText extends StatefulWidget {
  const _StatusText(this.text);
  final String text;

  @override
  State<_StatusText> createState() => _StatusTextState();
}

class _StatusTextState extends State<_StatusText> {
  static final _link = RegExp(r'https?://[^\s<>()\[\]]+');

  /// The text cut into plain pieces and links, with one tap per link: made
  /// again only when the text changes, so a rebuild (a theme flip, a Swarm
  /// read) never drops a tap under the finger.
  var _pieces = <(String, TapGestureRecognizer?)>[];

  @override
  void initState() {
    super.initState();
    _cut();
  }

  @override
  void didUpdateWidget(_StatusText old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _cut();
  }

  @override
  void dispose() {
    _release();
    super.dispose();
  }

  void _release() {
    for (final (_, tap) in _pieces) {
      tap?.dispose();
    }
  }

  /// A web address the card opens: http or https with a host, as the
  /// desktop's `SuperTabMessageText.webLink`.
  static Uri? _webLink(String href) {
    final uri = Uri.tryParse(href);
    return uri != null &&
            (uri.scheme == 'https' || uri.scheme == 'http') &&
            uri.host.isNotEmpty
        ? uri
        : null;
  }

  void _cut() {
    _release();
    final text = widget.text.trimRight();
    final pieces = <(String, TapGestureRecognizer?)>[];
    var at = 0;
    for (final match in _link.allMatches(text)) {
      // A sentence's closing punctuation is not part of its link.
      var url = match[0]!;
      while (url.isNotEmpty && '.,;:!?\'"'.contains(url[url.length - 1])) {
        url = url.substring(0, url.length - 1);
      }
      final uri = _webLink(url);
      if (uri == null) continue;
      if (match.start > at) pieces.add((text.substring(at, match.start), null));
      pieces.add((
        url,
        TapGestureRecognizer()
          ..onTap = () => unawaited(swarmOpenStatusLink(uri)),
      ));
      at = match.start + url.length;
    }
    if (at < text.length) pieces.add((text.substring(at), null));
    _pieces = pieces;
  }

  @override
  Widget build(BuildContext context) {
    final link = TextStyle(
      color: AppPalette.swarmAccent,
      decoration: TextDecoration.underline,
      decorationColor: AppPalette.swarmAccent,
    );
    return Text.rich(
      key: const ValueKey('swarm-project-status-text'),
      TextSpan(
        style: AppType.body(color: AppPalette.textPrimary, height: 1.4),
        children: [
          for (final (text, tap) in _pieces)
            tap == null
                ? TextSpan(text: text)
                : TextSpan(text: text, style: link, recognizer: tap),
        ],
      ),
    );
  }
}
