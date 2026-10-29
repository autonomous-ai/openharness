import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_buddy.dart';
import 'swarm_conversation_page.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';
import 'swarm_unread.dart';

/// A project's tabs, as B2 draws them (Tony, 2026-10-29): its chat with
/// everyone, the person's Buddy chat, its tasks and its leaderboard.
enum SwarmProjectTab {
  chat('Chat'),
  buddy('Buddy'),
  tasks('Tasks'),
  leaderboard('Leaderboard');

  const SwarmProjectTab(this.label);

  final String label;
}

/// The row of a project's tabs under its header: each a quarter of the
/// width, the one shown bright over a line, the others quiet. The chat's
/// says what is new in it as a project's Home row does: the Lead's tags
/// waiting there in a filled "@N", else a dot while it is unread
/// ([chatNews]).
class SwarmProjectTabBar extends StatelessWidget {
  const SwarmProjectTabBar({
    super.key,
    required this.selected,
    required this.onSelect,
    this.chatNews = swarmNoNews,
  });

  final SwarmProjectTab selected;
  final ValueChanged<SwarmProjectTab> onSelect;
  final SwarmRowNews chatNews;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: AppGlass.hair)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
        child: Row(
          children: [
            for (final tab in SwarmProjectTab.values)
              Expanded(
                child: _Tab(
                  tab: tab,
                  selected: tab == selected,
                  news: tab == SwarmProjectTab.chat ? chatNews : swarmNoNews,
                  onTap: () => onSelect(tab),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({
    required this.tab,
    required this.selected,
    required this.news,
    required this.onTap,
  });

  final SwarmProjectTab tab;
  final bool selected;
  final SwarmRowNews news;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = selected ? AppPalette.textPrimary : AppPalette.textSecondary;
    final mark = news.tags > 0
        ? SwarmTags(news.tags, filled: true)
        : news.bold
        ? Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              color: AppPalette.textPrimary,
              shape: BoxShape.circle,
            ),
          )
        : null;
    return Semantics(
      key: ValueKey('swarm-project-tab-${tab.name}'),
      button: true,
      selected: selected,
      label: [
        tab.label,
        if (news.tags > 0)
          news.tags == 1 ? '1 mention' : '${news.tags} mentions'
        else if (news.bold)
          'unread messages',
      ].join(', '),
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: selected
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(vertical: AppSpace.s),
                // A narrow phone shrinks the words rather than cut them.
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        tab.label,
                        maxLines: 1,
                        style: AppType.label(
                          color: ink,
                          fontWeight: selected ? AppFont.semibold : null,
                        ),
                      ),
                      if (mark != null) ...[
                        const SizedBox(width: AppSpace.xs + 2),
                        mark,
                      ],
                    ],
                  ),
                ),
              ),
              Container(
                height: 2,
                margin: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                decoration: ShapeDecoration(
                  color: selected ? AppPalette.textPrimary : Colors.transparent,
                  shape: const StadiumBorder(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The Buddy tab: the person's own Buddy chat in [projectId], under the
/// project's header ([SwarmConversationPage.header] off), with [actions] for
/// the header's Remove Buddy. A person with none yet gets one as the tab
/// opens — the server keeps one per person and project, so a second tap or
/// another device gets the same chat ([openSwarmBuddyChat]) — and a viewer
/// with none starts none.
class SwarmProjectBuddy extends StatefulWidget {
  const SwarmProjectBuddy({
    super.key,
    required this.reader,
    required this.swarmId,
    required this.projectId,
    required this.actions,
  });

  final SwarmReader reader;
  final String swarmId, projectId;
  final SwarmBuddyActions actions;

  @override
  State<SwarmProjectBuddy> createState() => _SwarmProjectBuddyState();
}

class _SwarmProjectBuddyState extends State<SwarmProjectBuddy> {
  /// The chat the server named, while the read does not hold it yet.
  String? _opened;
  bool _opening = false;
  String? _error;

  /// Moves on with the read or the project: an answer for an earlier one
  /// is dropped.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _openIfNone();
  }

  @override
  void didUpdateWidget(SwarmProjectBuddy old) {
    super.didUpdateWidget(old);
    if (old.reader != widget.reader || old.projectId != widget.projectId) {
      // Another Swarm's read or project: nothing named for the last one
      // stays.
      _generation++;
      _opened = null;
      _opening = false;
      _error = null;
      _openIfNone();
    }
  }

  void _openIfNone() {
    final reader = widget.reader;
    if (swarmBuddyChat(reader, widget.projectId) != null ||
        !swarmCanWrite(reader)) {
      return;
    }
    unawaited(_open());
  }

  Future<void> _open() async {
    if (_opening) return;
    final reader = widget.reader, projectId = widget.projectId;
    final generation = _generation;
    setState(() {
      _opening = true;
      _error = null;
    });
    String? id, error;
    try {
      id = await openSwarmBuddyChat(reader, projectId);
      if (id == null) error = 'Your Buddy chat is not ready yet. Try again.';
    } on SuperTabFailure catch (failure) {
      error = failure.message;
    } catch (_) {
      error = 'Could not open your Buddy chat. Try again.';
    }
    // Moved on meanwhile, or taken away: the answer is for no chat shown.
    if (!mounted || generation != _generation || reader.accessRevoked) return;
    setState(() {
      _opening = false;
      _opened = id;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.reader,
      builder: (context, _) {
        final reader = widget.reader;
        final id = swarmBuddyChat(reader, widget.projectId)?.id ?? _opened;
        if (id != null) {
          return SwarmConversationPage(
            key: ValueKey('swarm-project-buddy-$id'),
            swarmId: widget.swarmId,
            conversationId: id,
            header: false,
            buddy: widget.actions,
          );
        }
        final Widget body;
        if (!swarmCanWrite(reader)) {
          body = SwarmRow.line(
            'You have no Buddy in this project.',
            key: const ValueKey('swarm-buddy-none'),
            lines: 2,
          );
        } else if (_error case final error?) {
          body = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              SwarmRow.line(
                error,
                key: const ValueKey('swarm-buddy-error'),
                lines: 3,
                color: AppColors.danger,
              ),
              const SizedBox(height: AppSpace.s),
              SwarmButton(
                key: const ValueKey('swarm-buddy-again'),
                label: 'Try again',
                onPressed: () => unawaited(_open()),
              ),
            ],
          );
        } else {
          body = SwarmRow.line(
            'Opening your Buddy chat…',
            key: const ValueKey('swarm-buddy-opening'),
          );
        }
        return Align(
          alignment: Alignment.topLeft,
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.screenInset),
            child: body,
          ),
        );
      },
    );
  }
}
