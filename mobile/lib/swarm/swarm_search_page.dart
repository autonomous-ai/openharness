import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_agents.dart';
import 'swarm_buddy.dart';
import 'swarm_conversation_page.dart' show openSwarmConversation;
import 'swarm_home_list.dart' show swarmProjectActivity;
import 'swarm_new_message_sheet.dart' show swarmSearchFold;
import 'swarm_project_page.dart' show openSwarmProject;
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'team_glance.dart' show SwarmAgentState;

/// What Search lists, one kind to a chip (Slack's Search, Tony, 2026-11-03).
/// People have no page of their own in Swarm yet, so Search has none.
enum SwarmSearchKind {
  /// What moved last, before anything is typed; every kind once there is.
  recent('Recent'),
  projects('Projects'),

  /// The person's own Buddy chats.
  chats('Chats'),

  /// The harnesses on their computers ([SwarmAgents]).
  agents('Agents');

  const SwarmSearchKind(this.label);
  final String label;
}

/// One thing Search can open.
@immutable
class SwarmSearchHit {
  const SwarmSearchHit({
    required this.kind,
    required this.key,
    required this.title,
    required this.detail,
    required this.open,
    this.at,
    this.state,
  });

  /// Projects, Chats or Agents: never Recent.
  final SwarmSearchKind kind;

  /// Stable across reads: the row's key.
  final String key;

  /// "#mobile", "Wren · mobile", an agent's name.
  final String title;

  /// Where it is: its Swarm, or the agent's computer and engine.
  final String detail;

  /// When it last moved, where that is known: Recent's order.
  final DateTime? at;

  /// An agent's state, as its dot: working, waiting, or neither.
  final SwarmAgentState? state;

  /// Opens it over [context]'s page.
  final void Function(BuildContext context) open;
}

/// Everything Search can open in [session]'s Swarms, and of [agents]: each
/// project the person reads and their own Buddy chat in it, by Swarm, then
/// the agents. A Swarm not read, or no longer theirs to read, has nothing;
/// [failed] says when one could not be read, so none found is never said for
/// a Swarm that failed.
({List<SwarmSearchHit> hits, bool reading, bool failed}) swarmSearchCatalog(
  SwarmSession session,
  SwarmAgents? agents,
) {
  final inbox = session.inbox;
  final hits = <SwarmSearchHit>[];
  var reading = !inbox.loaded && inbox.error == null && !inbox.noComputer;
  var failed = !inbox.loaded && (inbox.error != null || inbox.noComputer);
  for (final swarm in inbox.swarms) {
    final reader = inbox.reader(swarm.id);
    if (reader == null || reader.accessRevoked) continue;
    final snapshot = reader.snapshot;
    if (snapshot == null) {
      if (reader.error != null && !reader.updateRequired) {
        failed = true;
      } else if (!reader.updateRequired) {
        reading = true;
      }
      continue;
    }
    final activity = swarmProjectActivity(snapshot, reader.buddies);
    final me = snapshot.people
        .where((p) => p.id == reader.accountId)
        .firstOrNull;
    for (final project in snapshot.projects) {
      // As New message reads it: a private project is its owner's and its
      // members'.
      if (project.isPrivate &&
          project.ownerId != reader.accountId &&
          (me == null || !project.hasMember(me))) {
        continue;
      }
      final (swarmId, projectId) = (swarm.id, project.id);
      hits.add(
        SwarmSearchHit(
          kind: SwarmSearchKind.projects,
          key: 'project-$swarmId-$projectId',
          title: '#${project.name}',
          detail: swarm.name,
          at: activity[projectId],
          open: (context) =>
              openSwarmProject(context, swarmId: swarmId, projectId: projectId),
        ),
      );
      final own = swarmBuddyChat(reader, projectId);
      if (own != null &&
          own.projectId == projectId &&
          !own.archived &&
          !swarmIsOldBuddyChat(reader, own.id) &&
          own.buddyOwnerId == reader.accountId) {
        final chatId = own.id;
        hits.add(
          SwarmSearchHit(
            kind: SwarmSearchKind.chats,
            key: 'chat-$swarmId-$chatId',
            title: '${swarmBuddyName(reader, projectId)} · ${project.name}',
            detail: swarm.name,
            at: own.changedAt,
            open: (context) => openSwarmConversation(context, swarmId, chatId),
          ),
        );
      }
    }
  }
  for (final agent in agents?.agents ?? const <SwarmAgentRef>[]) {
    hits.add(
      SwarmSearchHit(
        kind: SwarmSearchKind.agents,
        key: 'agent-${agent.machineId}-${agent.agentId}',
        title: agent.name,
        detail: [agent.machine, ?agent.engine].join(' · '),
        state: agent.waiting
            ? SwarmAgentState.waiting
            : agent.working
            ? SwarmAgentState.working
            : null,
        open: (context) => agents!.open(context, agent),
      ),
    );
  }
  return (hits: hits, reading: reading, failed: failed);
}

/// How many Recent lists before anything is typed.
const swarmSearchRecent = 12;

/// What [kind] lists of [hits] for [query]. With nothing typed: Recent, what
/// moved last first; any other kind, all of it in the catalog's order. With
/// something typed, what matches it — case and accents aside, as New
/// message's To: matches ([swarmSearchFold]) — those starting with it first,
/// then those with a word starting with it, then the rest that hold it, its
/// title before where it is; Recent then lists every kind.
List<SwarmSearchHit> swarmSearchFind(
  List<SwarmSearchHit> hits,
  SwarmSearchKind kind,
  String query,
) {
  final q = swarmSearchFold(query.trim());
  final of = kind == SwarmSearchKind.recent
      ? hits
      : [
          for (final hit in hits)
            if (hit.kind == kind) hit,
        ];
  if (q.isEmpty) {
    if (kind != SwarmSearchKind.recent) return of;
    final moved = [
      for (final hit in of)
        if (hit.at != null) hit,
    ]..sort((a, b) => b.at!.compareTo(a.at!));
    return moved.take(swarmSearchRecent).toList();
  }
  int? rank(SwarmSearchHit hit) {
    final title = swarmSearchFold(hit.title);
    final bare = title.startsWith('#') ? title.substring(1) : title;
    if (bare.startsWith(q) || title.startsWith(q)) return 0;
    if (title.split(_wordGap).any((word) => word.startsWith(q))) return 1;
    if (title.contains(q)) return 2;
    if (swarmSearchFold(hit.detail).contains(q)) return 3;
    return null;
  }

  final ranked = [
    for (final (i, hit) in of.indexed)
      if (rank(hit) case final r?) (r, i, hit),
  ]..sort((a, b) => a.$1 != b.$1 ? a.$1 - b.$1 : a.$2 - b.$2);
  return [for (final (_, _, hit) in ranked) hit];
}

final _wordGap = RegExp(r'[\s·_\-./]+');

/// Opens Search over [context]'s page: from Home's search field, or a pull
/// down at the top of Home.
void openSwarmSearch(BuildContext context) => unawaited(
  Navigator.of(context)
      .push(phoneRoute((_) => const SwarmSearchPage(), listensForItself: true)),
);

/// Search (Slack's, Tony 2026-11-03): the field, focused, over chips —
/// Recent · Projects · Chats · Agents — each a page a sideways swipe also
/// turns to; under them what the open chip lists for what is typed
/// ([swarmSearchFind]). A row opens its project, chat or agent over Search,
/// and back comes back to it as it was.
class SwarmSearchPage extends StatefulWidget {
  const SwarmSearchPage({super.key});

  @override
  State<SwarmSearchPage> createState() => _SwarmSearchPageState();
}

class _SwarmSearchPageState extends State<SwarmSearchPage> {
  final _field = TextEditingController();
  final _pages = PageController();
  var _kind = SwarmSearchKind.recent;

  @override
  void initState() {
    super.initState();
    _field.addListener(_typed);
  }

  String _query = '';

  void _typed() {
    if (_field.text == _query) return;
    setState(() => _query = _field.text);
  }

  @override
  void dispose() {
    _field
      ..removeListener(_typed)
      ..dispose();
    _pages.dispose();
    super.dispose();
  }

  List<SwarmSearchKind> _kinds(SwarmAgents? agents) => [
    for (final kind in SwarmSearchKind.values)
      if (kind != SwarmSearchKind.agents || agents != null) kind,
  ];

  void _choose(List<SwarmSearchKind> kinds, SwarmSearchKind kind) {
    final page = kinds.indexOf(kind);
    if (page < 0 || !_pages.hasClients) return;
    setState(() => _kind = kind);
    if (MediaQuery.disableAnimationsOf(context)) {
      _pages.jumpToPage(page);
    } else {
      unawaited(
        _pages.animateToPage(
          page,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    final agents = swarmAgentsOf(context);
    final kinds = _kinds(agents);
    return Scaffold(
      backgroundColor: Tty.of(context).ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _top(context),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(
                AppSpace.m,
                AppSpace.xs,
                AppSpace.m,
                AppSpace.s,
              ),
              child: Row(
                children: [
                  for (final (i, kind) in kinds.indexed) ...[
                    if (i > 0) const SizedBox(width: AppSpace.s),
                    _Chip(
                      key: ValueKey('swarm-search-kind-${kind.name}'),
                      label: kind == SwarmSearchKind.recent && _query.isNotEmpty
                          ? 'All'
                          : kind.label,
                      selected: kind == _kind,
                      onTap: () => _choose(kinds, kind),
                    ),
                  ],
                ],
              ),
            ),
            Expanded(
              child: session == null
                  ? const SizedBox.shrink()
                  : ListenWhileInSight(
                      listenable: Listenable.merge([
                        session,
                        session.inbox,
                        session.home,
                        ?agents,
                      ]),
                      builder: (context) {
                        final catalog = swarmSearchCatalog(session, agents);
                        return PageView(
                          key: const ValueKey('swarm-search-pages'),
                          controller: _pages,
                          onPageChanged: (page) =>
                              setState(() => _kind = kinds[page]),
                          children: [
                            for (final kind in kinds)
                              _Results(
                                key: ValueKey('swarm-search-page-${kind.name}'),
                                kind: kind,
                                query: _query,
                                hits: swarmSearchFind(
                                  catalog.hits,
                                  kind,
                                  _query,
                                ),
                                reading: catalog.reading,
                                failed: catalog.failed,
                              ),
                          ],
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _top(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      AppSpace.xs,
      AppSpace.xs,
      AppSpace.m,
      AppSpace.xs,
    ),
    child: Row(
      children: [
        SwarmBackButton(onPressed: () => Navigator.of(context).maybePop()),
        Expanded(
          child: Material(
            color: AppPalette.swarmSearchSurface,
            shape: const StadiumBorder(),
            clipBehavior: Clip.antiAlias,
            child: TextField(
              key: const ValueKey('swarm-search-field'),
              controller: _field,
              autofocus: true,
              textInputAction: TextInputAction.search,
              style: AppType.label(color: AppPalette.textPrimary),
              cursorColor: AppPalette.swarmAccent,
              // None of the app's field look: its fill and its outline,
              // accent once focused, would be cut by the pill to two blue
              // arcs at its ends.
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                hintText: 'Search chats, projects, agents',
                hintStyle: AppType.label(color: AppPalette.textFaint),
                prefixIcon: Icon(
                  LucideIcons.search300,
                  size: 18,
                  color: AppPalette.textSecondary,
                ),
                suffixIcon: _query.isEmpty
                    ? null
                    : SwarmIconButton(
                        key: const ValueKey('swarm-search-clear'),
                        icon: LucideIcons.x300,
                        label: 'Clear search',
                        onPressed: _field.clear,
                      ),
                contentPadding: const EdgeInsets.symmetric(
                  vertical: AppSpace.m,
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

/// One chip's page: its hits, or why there are none.
class _Results extends StatelessWidget {
  const _Results({
    super.key,
    required this.kind,
    required this.query,
    required this.hits,
    required this.reading,
    required this.failed,
  });

  final SwarmSearchKind kind;
  final String query;
  final List<SwarmSearchHit> hits;
  final bool reading, failed;

  @override
  Widget build(BuildContext context) {
    final note = AppType.caption(color: AppPalette.textSecondary, height: 1.35);
    final typed = query.trim().isNotEmpty;
    // A drag on the results puts the keyboard away, as Slack's does — a
    // short list too, and on Android, where a list that cannot scroll
    // sends no scroll update for `keyboardDismissBehavior` to hear.
    return NotificationListener<ScrollStartNotification>(
      onNotification: (scroll) {
        if (scroll.dragDetails != null) FocusScope.of(context).unfocus();
        return false;
      },
      child: _list(context, note, typed),
    );
  }

  Widget _list(BuildContext context, TextStyle note, bool typed) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.fromLTRB(
        AppSpace.m,
        AppSpace.xs,
        AppSpace.m,
        MediaQuery.paddingOf(context).bottom + AppSpace.xl,
      ),
      children: [
        if (failed)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              0,
              AppSpace.xs,
              AppSpace.s,
            ),
            child: Text(
              'Some Swarms could not be read.',
              key: const ValueKey('swarm-search-failed'),
              style: note,
            ),
          ),
        if (hits.isEmpty && reading)
          SwarmSkeletonRows(id: 'swarm-search-loading')
        else if (hits.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.xs,
              vertical: AppSpace.s,
            ),
            child: Text(
              typed
                  ? 'Nothing matches “${query.trim()}”.'
                  : switch (kind) {
                      SwarmSearchKind.recent => 'Nothing moved yet.',
                      SwarmSearchKind.projects => 'No project yet.',
                      SwarmSearchKind.chats => 'No Buddy chat yet.',
                      SwarmSearchKind.agents => 'No agent yet.',
                    },
              key: const ValueKey('swarm-search-none'),
              style: note,
            ),
          )
        else
          SwarmGroup(
            children: [
              for (final hit in hits)
                SwarmRow(
                  key: ValueKey('swarm-search-hit-${hit.key}'),
                  leading: _Lead(hit),
                  title: hit.title,
                  detail: SwarmRow.line(hit.detail),
                  onTap: () => hit.open(context),
                ),
            ],
          ),
      ],
    );
  }
}

/// A hit's mark: its kind's glyph, or an agent's state as a dot.
class _Lead extends StatelessWidget {
  const _Lead(this.hit);

  final SwarmSearchHit hit;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox.square(
      dimension: 20,
      child: switch (hit.kind) {
        SwarmSearchKind.agents => Center(
          child: Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: switch (hit.state) {
                final state? => swarmStateColor(state),
                null => AppPalette.textFaint,
              },
            ),
          ),
        ),
        SwarmSearchKind.chats => Icon(
          LucideIcons.messageCircle300,
          size: 18,
          color: AppPalette.textSecondary,
        ),
        _ => Icon(
          LucideIcons.hash300,
          size: 18,
          color: AppPalette.textSecondary,
        ),
      },
    ),
  );
}

/// A chip: its name in a pill a thumb can find, filled while it is open.
/// The row of them scrolls sideways on a narrow phone, as Activity's does:
/// a chip opened by a swipe of the pages scrolls into sight.
class _Chip extends StatefulWidget {
  const _Chip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_Chip> createState() => _ChipState();
}

class _ChipState extends State<_Chip> {
  @override
  void didUpdateWidget(_Chip old) {
    super.didUpdateWidget(old);
    if (widget.selected && !old.selected) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        unawaited(
          Scrollable.ensureVisible(
            context,
            alignment: 0.5,
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 220),
            curve: Curves.easeOutCubic,
          ),
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final (label, selected, onTap) = (
      widget.label,
      widget.selected,
      widget.onTap,
    );
    final ink = selected ? AppPalette.windowBg : AppPalette.textPrimary;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: selected
            ? AppPalette.textPrimary
            : AppPalette.swarmSearchSurface,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: minTouchTarget,
              minWidth: minTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
              child: Center(
                widthFactor: 1,
                child: Text(
                  label,
                  style: AppType.label(
                    color: ink,
                    fontWeight: AppFont.semibold,
                    height: 1,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
