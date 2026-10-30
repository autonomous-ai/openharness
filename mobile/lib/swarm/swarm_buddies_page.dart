import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_buddy_chat.dart' show openSwarmBuddy;
import 'swarm_buddy_list.dart';
import 'swarm_conversation_page.dart' show openSwarmConversation;
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Buddies (Tony's prototype C2): its title in the terminal's face, then a
/// row for each project ([SwarmBuddyRow]), newest first — its tile, its
/// name, how the person's Buddy there stands, and the last message of their
/// Buddy chat — bold with a dot while that chat has something unread. A tap
/// opens that Buddy chat, where the Buddy is started too: Swarm Home C's
/// project has no Buddy tab. The Buddies tab's screen.
///
/// Only while it is in sight ([OutOfSight]) does it read the Buddy chats
/// ([SwarmBuddyList.watch]) and keep the Swarm's notices quiet.
class SwarmBuddiesView extends StatefulWidget {
  const SwarmBuddiesView({super.key, this.leading});

  /// Before the title: a page's back; none on the tab.
  final Widget? leading;

  @override
  State<SwarmBuddiesView> createState() => _SwarmBuddiesViewState();
}

class _SwarmBuddiesViewState extends State<SwarmBuddiesView> {
  SwarmSession? _session;
  bool _seen = false;

  /// The row whose Buddy chat is being opened: a second tap waits for it.
  String? _opening;

  /// Why the last row tapped did not open, while that row is listed.
  ({String row, String text})? _failed;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final seen = session != null && !OutOfSight.of(context);
    if (identical(session, _session) && seen == _seen) return;
    _see(false);
    _session = session;
    _see(seen);
  }

  /// In sight: the Buddy chats are read as they move, the inbox is read now,
  /// and the Swarm's notices keep quiet. Out of sight, none of it.
  void _see(bool seen) {
    final session = _session;
    if (session == null || seen == _seen) return;
    _seen = seen;
    if (seen) {
      session.enter();
      session.buddyList.watch();
      unawaited(session.inbox.refresh());
    } else {
      session.buddyList.unwatch();
      session.leave();
    }
  }

  @override
  void dispose() {
    _see(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    return Material(
      color: AppPalette.windowBg,
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.leading case final leading?)
              SwarmTopBar(leading: leading, title: 'Buddies')
            else
              const SwarmTabHeader('Buddies'),
            if (session != null)
              Expanded(
                child: ListenWhileInSight(
                  listenable: session.buddyList,
                  builder: (context) => _body(context, session),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, SwarmSession session) {
    final list = session.buddyList, inbox = session.inbox;
    final rows = list.rows;
    final now = DateTime.now();
    final note = AppType.caption(color: AppPalette.textSecondary, height: 1.35);
    return ListView(
      padding: EdgeInsets.fromLTRB(
        AppSpace.m,
        AppSpace.xs,
        AppSpace.m,
        MediaQuery.paddingOf(context).bottom + AppSpace.xl,
      ),
      children: [
        if (_failed case final failed?
            when rows.any((row) => row.key == failed.row))
          _Note(
            key: const ValueKey('swarm-buddies-open-failed'),
            text: failed.text,
            action: SwarmButton(
              label: 'OK',
              style: SwarmButtonStyle.link,
              onPressed: () => setState(() => _failed = null),
            ),
          ),
        if (list.unreadChats)
          _Note(
            text: 'Some Buddy chats could not be read.',
            action: SwarmButton(
              key: const ValueKey('swarm-buddies-retry'),
              label: 'Try again',
              style: SwarmButtonStyle.link,
              onPressed: list.retry,
            ),
          ),
        if (!inbox.loaded && inbox.error != null)
          _Note(
            text: inbox.error!,
            action: SwarmButton(
              key: const ValueKey('swarm-buddies-retry-list'),
              label: 'Try again',
              style: SwarmButtonStyle.link,
              onPressed: () => unawaited(inbox.refresh()),
            ),
          )
        else if (rows.isEmpty && !inbox.loaded)
          SwarmSkeletonRows(id: 'swarm-buddies-loading')
        else if (rows.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.xs,
              vertical: AppSpace.s,
            ),
            child: Text(
              'No projects yet.',
              key: const ValueKey('swarm-buddies-none'),
              style: note,
            ),
          )
        else
          SwarmGroup(
            children: [
              for (final row in rows)
                SwarmBuddiesRow(
                  key: ValueKey('swarm-buddies-row-${row.key}'),
                  row: row,
                  line: swarmBuddyLine(row, inbox.reader(row.swarmId)),
                  now: now,
                  onTap: () => _open(context, row),
                ),
            ],
          ),
      ],
    );
  }

  /// Opens [row]'s Buddy chat, made on the server first when there is none
  /// yet ([openSwarmBuddy]); a viewer with none is told so, and nothing is
  /// asked.
  void _open(BuildContext context, SwarmBuddyRow row) {
    if (_opening != null) return;
    setState(() => _failed = null);
    if (row.chat case final chat?) {
      openSwarmConversation(context, row.swarmId, chat.id);
      return;
    }
    final reader = _session?.inbox.reader(row.swarmId);
    if (reader == null || reader.accessRevoked) return;
    if (!swarmCanWrite(reader)) {
      setState(
        () => _failed = (
          row: row.key,
          text: 'You have no Buddy in this project.',
        ),
      );
      return;
    }
    setState(() => _opening = row.key);
    unawaited(
      openSwarmBuddy(context, reader, row.swarmId, row.project.id).then((
        error,
      ) {
        if (!mounted) return;
        setState(() {
          _opening = null;
          if (error != null) _failed = (row: row.key, text: error);
        });
      }),
    );
  }
}

/// A line over the rows, with what to do about it at its end.
class _Note extends StatelessWidget {
  const _Note({super.key, required this.text, required this.action});

  final String text;
  final Widget action;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: AppSpace.xs, bottom: AppSpace.s),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: AppType.caption(
              color: AppPalette.textSecondary,
              height: 1.35,
            ),
          ),
        ),
        action,
      ],
    ),
  );
}

/// One project on Buddies, as prototype C2 draws it: its tile; its name —
/// bold and bright while its Buddy chat has something unread, quiet
/// otherwise — with how its Buddy stands after it and when the chat last
/// moved at the end; under them the chat's last message ([line]), and a dot
/// at its end while unread.
class SwarmBuddiesRow extends StatelessWidget {
  const SwarmBuddiesRow({
    super.key,
    required this.row,
    required this.line,
    required this.now,
    required this.onTap,
  });

  final SwarmBuddyRow row;
  final String line;
  final DateTime now;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final unread = row.unread;
    final state = row.note ?? 'running';
    final age = switch (row.at) {
      final at? => fzfAge(at.toLocal(), now.toLocal()),
      null => '',
    };
    return Semantics(
      button: true,
      label: [
        row.project.name,
        '${row.name} $state',
        if (line.isNotEmpty) line,
        if (unread) 'Unread messages',
      ].join(', '),
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: SwarmRow.height),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.m,
              ),
              child: Row(
                children: [
                  SwarmProjectTile(row.project.name),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Expanded(
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.baseline,
                                textBaseline: TextBaseline.alphabetic,
                                children: [
                                  Flexible(
                                    child: Text(
                                      row.project.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: AppType.label(
                                        color: unread
                                            ? AppPalette.textPrimary
                                            : AppPalette.textSecondary,
                                        height: 1.3,
                                        fontWeight: unread
                                            ? AppFont.semibold
                                            : null,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: AppSpace.s),
                                  Text(
                                    state,
                                    style: AppType.caption(
                                      color: row.note == null
                                          ? AppColors.success
                                          : AppPalette.textFaint,
                                      height: 1.3,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            if (age.isNotEmpty) ...[
                              const SizedBox(width: AppSpace.s),
                              Text(
                                age,
                                key: ValueKey('swarm-buddies-age-${row.key}'),
                                style: AppType.caption(
                                  color: AppPalette.textFaint,
                                  height: 1.3,
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                line,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppType.caption(
                                  color: unread
                                      ? AppPalette.textPrimary
                                      : AppPalette.textSecondary,
                                  height: 1.35,
                                ),
                              ),
                            ),
                            if (unread) ...[
                              const SizedBox(width: AppSpace.s),
                              Container(
                                key: ValueKey(
                                  'swarm-buddies-unread-${row.key}',
                                ),
                                width: 7,
                                height: 7,
                                decoration: BoxDecoration(
                                  color: AppPalette.textPrimary,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ],
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
