import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/app_type.dart';
import 'model.dart';
import 'swarm_home_keeper.dart';
import 'swarm_inbox.dart';
import 'swarm_leaderboard.dart' show SwarmProjectSheetFrame;
import 'swarm_need_rows.dart';
import 'swarm_activity_page.dart' show openSwarmActivity;
import 'swarm_needs_page.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';

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

/// What a project's menu opens as Status: the project's report and what waits
/// on the person, in a sheet over its chat (Tony, 2026-11-02: the chat shows
/// no box of its own). The report as the coordinator last wrote it, replaced
/// in place by each report, under "updated 09:52"; then the decisions in this
/// project waiting on the person, each opening Activity at it, where the
/// desktop opens Notifications. Nothing is read here: the text comes with the
/// Swarm read, the decisions are Activity's ([swarmProjectNeedsYou]). The page
/// under it closes it when the read, the access or the project is gone.
class SwarmProjectStatusSheet extends StatelessWidget {
  const SwarmProjectStatusSheet({
    super.key,
    required this.swarmId,
    required this.projectId,
    this.now = DateTime.now,
  });

  final String swarmId, projectId;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    return SwarmProjectSheetFrame(
      title: 'Status',
      closeKey: 'swarm-status-close',
      child: session == null
          ? const SizedBox.shrink()
          : ListenableBuilder(
              listenable: session.inbox,
              builder: (context, _) => switch (session.inbox.reader(swarmId)) {
                final reader? => SwarmProjectStatus(
                  session: session,
                  reader: reader,
                  swarmId: swarmId,
                  projectId: projectId,
                  now: now,
                ),
                null => const SizedBox.shrink(),
              },
            ),
    );
  }
}

/// The body of [SwarmProjectStatusSheet] for [projectId] of [reader]'s Swarm.
/// Nothing at all once the access is revoked, the project is gone or the
/// person no longer reads it: no text, no time, no decision stays.
class SwarmProjectStatus extends StatelessWidget {
  const SwarmProjectStatus({
    super.key,
    required this.session,
    required this.reader,
    required this.swarmId,
    required this.projectId,
    this.now = DateTime.now,
  });

  final SwarmSession session;
  final SwarmReader reader;
  final String swarmId, projectId;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // The session tells of answers held for Undo, which the rows say; the
    // asks, of what waits on the person being read.
    listenable: Listenable.merge([
      reader,
      session.inbox,
      session,
      ?session.inbox.asks(swarmId),
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
      if (status == null && waiting.isEmpty) {
        // "Nothing to report" only once the Swarm was read and what waits on
        // the person with it: the view kept on the phone holds neither, and a
        // read that failed says so rather than "nothing".
        final asks = session.inbox.asks(swarmId);
        final (key, line) = switch ((
          swarmHomeKept(reader),
          reader.error ?? asks?.error,
          asks == null || asks.loading,
        )) {
          (_, final error?, _) => ('error', error),
          (true, _, _) || (_, _, true) => ('updating', 'Updating…'),
          _ => ('empty', 'Nothing to report yet.'),
        };
        return Padding(
          padding: const EdgeInsets.all(AppSpace.screenInset),
          child: Text(
            line,
            key: ValueKey('swarm-project-status-$key-$projectId'),
            style: AppType.body(color: AppPalette.textSecondary),
          ),
        );
      }
      return ListView(
        key: ValueKey('swarm-project-status-$projectId'),
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenInset,
          AppSpace.xs,
          AppSpace.screenInset,
          AppSpace.l,
        ),
        children: [
          if (status != null) ...[
            if (status.at case final at?) ...[
              Text(
                'updated ${swarmStatusUpdatedAt(at, now())}',
                key: ValueKey('swarm-project-status-heading-$projectId'),
                style: AppType.caption(color: AppPalette.textSecondary),
              ),
              const SizedBox(height: AppSpace.s),
            ],
            _StatusText(status.text),
          ],
          if (waiting.isNotEmpty) ...[
            if (status != null) const SizedBox(height: AppSpace.m),
            for (final need in waiting)
              SwarmNeedLine(
                key: ValueKey('swarm-project-status-need-${need.key}'),
                session: session,
                need: need,
                chevron: LucideIcons.chevronRight300,
                onTap: () => openSwarmActivity(
                  context,
                  focus: need.key,
                  swarmId: swarmId,
                  projectId: projectId,
                ),
              ),
          ],
        ],
      );
    },
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
