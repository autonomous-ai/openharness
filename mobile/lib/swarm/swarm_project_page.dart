import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_buddy_chat.dart';
import 'swarm_conversation_page.dart';
import 'swarm_home_keeper.dart';
import 'swarm_inbox.dart';
import 'swarm_message_row.dart';
import 'swarm_pm_chat.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

/// The conversations of one project the person may read, as its sheet lists
/// them: its work by latest activity, and the quiet or archived work behind
/// "Older". The project chat is the screen, so it is not here, and neither is
/// a Buddy chat ([buddies]), which has its own row. Nor is any other private
/// chat: Buddies replaced Chat with PM (#2090), so the old history an older
/// server still sends is hidden, as on the desktop (`hiddenByBuddies`).
({List<SuperTabConversation> active, List<SuperTabConversation> older})
swarmProjectWork(
  SuperTabSnapshot snapshot,
  SuperTabProject project, {
  SwarmBuddies buddies = SwarmBuddies.none,
}) {
  final work =
      snapshot.conversations
          .where(
            (g) =>
                g.projectId == project.id &&
                g.id != project.leadConversationId &&
                g.audience == null &&
                !buddies.chatOwners.containsKey(g.id),
          )
          .toList()
        ..sort(
          (a, b) => b.lastMessageSequence.compareTo(a.lastMessageSequence),
        );
  return (
    active: [
      for (final g in work)
        if (!g.closed) g,
    ],
    older: [
      for (final g in work)
        if (g.closed) g,
    ],
  );
}

/// The conversations of [swarmId] whose work waits on the person: those of
/// its Needs you ([SwarmInbox.needs]), so one rule says what waits.
Set<String> swarmWaitingOnYou(SwarmInbox inbox, String swarmId) => {
  for (final need in inbox.needs)
    if (need is SwarmWorkNeed && need.swarmId == swarmId) need.conversationId,
};

/// One project, as prototype B draws it (Tony, 2026-10-28): its project chat
/// (its Product Manager and everyone) is the screen, under the project's name
/// and who is in it, with nothing under the header; and at the header's end a
/// ⋮ menu (Tony, 2026-10-29) with Buddy chat and the team's status in words
/// ([SwarmProjectStatus]), which opens the project's work and team in a sheet
/// ([showSwarmProjectSheet]).
class SwarmProjectPage extends StatefulWidget {
  const SwarmProjectPage({
    super.key,
    required this.swarmId,
    required this.projectId,
    this.mention,
  });

  final String swarmId, projectId;

  /// An agent to @mention in the chat's draft as it opens
  /// ([SwarmConversationPage.mention]).
  final String? mention;

  @override
  State<SwarmProjectPage> createState() => _SwarmProjectPageState();
}

class _SwarmProjectPageState extends State<SwarmProjectPage> {
  SwarmSession? _session;

  /// The person's Buddy chat: being opened, and why the last one did not
  /// open. The menu's button and the line under the header listen; the chat
  /// is not built again for them.
  final _buddy = ValueNotifier<({bool opening, String? error})>((
    opening: false,
    error: null,
  ));

  /// What the page shows of the inbox ([_inboxChanged]): its Swarm's
  /// reader, whether there are several Swarms, why the list was not read.
  SwarmReader? _reader;
  bool _several = false;
  String? _listError;

  /// A read of the Swarm since the page opened has finished ([_readOnOpen]).
  /// Until then, a project the Swarm did not have may be one just made.
  bool _read = false;

  /// The project chat as last built, with what it was built from: a read
  /// that moved none of it builds none of it again ([_chatOf]).
  ({Object inputs, Widget chat})? _chat;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    _session = session?..enter();
    session?.inbox.addListener(_inboxChanged);
    _seeInbox();
    _readOnOpen();
  }

  @override
  void dispose() {
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    _buddy.dispose();
    super.dispose();
  }

  /// The inbox tells of every change of every Swarm, and again when what
  /// waits on the person is read after one; the page is built again only
  /// when what it shows of the inbox moved. Its Swarm's own changes come
  /// from its reader.
  void _inboxChanged() {
    final inbox = _session?.inbox;
    if (inbox == null) return;
    final seen = (
      inbox.reader(widget.swarmId),
      inbox.swarms.length > 1,
      inbox.error,
    );
    if (seen != (_reader, _several, _listError)) setState(_seeInbox);
  }

  void _seeInbox() {
    final inbox = _session?.inbox;
    _reader = inbox?.reader(widget.swarmId);
    _several = (inbox?.swarms.length ?? 0) > 1;
    _listError = inbox?.error;
  }

  /// Reads the Swarm as the page opens: what Home read may be 15 seconds
  /// old, or from before the project was made. Not listed yet, the list is
  /// read with it.
  void _readOnOpen() {
    final session = _session;
    _read = false;
    if (session == null) return;
    final read = _reader?.refresh() ?? session.inbox.refresh();
    unawaited(
      read.whenComplete(() {
        if (mounted && _session == session) setState(() => _read = true);
      }),
    );
  }

  /// A pull: one read of the Swarm, joining one under way.
  Future<void> _pull() =>
      _reader?.refresh() ?? _session?.inbox.refresh() ?? Future.value();

  Future<void> _openBuddy() async {
    final reader = _reader;
    if (reader == null || _buddy.value.opening) return;
    _buddy.value = (opening: true, error: null);
    final error = await openSwarmBuddy(
      context,
      reader,
      widget.swarmId,
      widget.projectId,
    );
    if (!mounted) return;
    _buddy.value = (opening: false, error: error);
  }

  void _openSheet() => unawaited(
    showSwarmProjectSheet(
      context,
      swarmId: widget.swarmId,
      projectId: widget.projectId,
    ),
  );

  /// The header's menu ([showSwarmProjectMenu]), then what was picked in it.
  /// A viewer with no Buddy chat here has none to open, and starts none.
  Future<void> _openMenu() async {
    final reader = _reader;
    if (reader == null || _buddy.value.opening) return;
    final picked = await showSwarmProjectMenu(
      context,
      swarmId: widget.swarmId,
      projectId: widget.projectId,
      buddyChat:
          swarmBuddyChat(reader, widget.projectId) != null ||
          swarmCanWrite(reader),
    );
    if (!mounted) return;
    switch (picked) {
      case SwarmProjectMenuItem.buddyChat:
        await _openBuddy();
      case SwarmProjectMenuItem.status:
        _openSheet();
      case null:
        break;
    }
  }

  /// [project]'s chat as the screen: its name over who is in it — and, with
  /// several Swarms, which one — and its menu at the header's end.
  Widget _chatOf(SuperTabSnapshot snapshot, SuperTabProject project) {
    final who = switch (swarmPmName(snapshot, project)) {
      final name? => '$name and everyone',
      null => 'Everyone in the project',
    };
    final inputs = (
      project.leadConversationId,
      project.name,
      _several ? '$who · ${snapshot.name}' : who,
    );
    if (_chat case final kept? when kept.inputs == inputs) return kept.chat;
    final chat = SwarmConversationPage(
      key: ValueKey('swarm-project-chat-${project.leadConversationId}'),
      swarmId: widget.swarmId,
      conversationId: project.leadConversationId,
      title: inputs.$2,
      subtitle: inputs.$3,
      mention: widget.mention,
      action: ValueListenableBuilder(
        valueListenable: _buddy,
        builder: (context, buddy, _) => _MenuButton(
          opening: buddy.opening,
          onPressed: () => unawaited(_openMenu()),
        ),
      ),
      // Nothing else under the header (Tony, 2026-10-29): the team's status
      // is in the menu.
      below: ValueListenableBuilder(
        valueListenable: _buddy,
        builder: (context, buddy, _) => switch (buddy.error) {
          final error? => Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.screenInset,
              vertical: AppSpace.s,
            ),
            child: SwarmRow.line(
              error,
              key: const ValueKey('swarm-buddy-error'),
              lines: 3,
              color: AppColors.danger,
            ),
          ),
          null => const SizedBox.shrink(),
        },
      ),
    );
    _chat = (inputs: inputs, chat: chat);
    return chat;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    final reader = _reader;
    final back = SwarmBackButton(
      onPressed: () => Navigator.of(context).maybePop(),
    );
    if (session == null) {
      return _Frame(
        top: SwarmTopBar(leading: back, title: ''),
      );
    }
    return ListenableBuilder(
      // Not listed yet: the inbox tells when it is ([_inboxChanged]).
      listenable: reader ?? Listenable.merge(const []),
      builder: (context, _) {
        final snapshot = reader?.snapshot;
        final project = snapshot?.projects
            .where((p) => p.id == widget.projectId)
            .firstOrNull;
        if (snapshot != null && project != null) {
          return _chatOf(snapshot, project);
        }
        // Why there is no project to show: still reading, or a read that
        // failed or finished without it.
        final why = switch (reader) {
          null => _listError ?? (_read ? _gone : null),
          // Taken away: nothing of it stays, and none is read.
          SwarmReader(accessRevoked: true) => reader.error ?? _gone,
          SwarmReader(snapshot: null) => reader.error,
          _ => _read ? reader.error ?? _gone : null,
        };
        if (why == null) {
          return _Frame(
            top: _LoadingTopBar(leading: back),
            body: const _Loading(),
          );
        }
        return _Frame(
          top: SwarmTopBar(leading: back, title: ''),
          body: RefreshIndicator(
            onRefresh: _pull,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(
                AppSpace.screenInset,
                AppSpace.s,
                AppSpace.screenInset,
                0,
              ),
              children: [SwarmRow.line(why, lines: 3)],
            ),
          ),
        );
      },
    );
  }

  static const _gone = 'This project is no longer in the Swarm.';
}

/// The page before its project chat is: its [top] bar, and [body] under it.
class _Frame extends StatelessWidget {
  const _Frame({required this.top, this.body});

  final Widget top;
  final Widget? body;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            top,
            if (body case final body?) Expanded(child: body),
          ],
        ),
      ),
    );
  }
}

/// The header's ⋮: 44 points square, its glyph's end on the screen's side
/// margin, as the header's words are. While Buddy chat opens ([opening]), a
/// spinner in its place, and taps do nothing.
class _MenuButton extends StatelessWidget {
  const _MenuButton({required this.opening, required this.onPressed});

  final bool opening;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = AppPalette.textPrimary;
    return Semantics(
      key: const ValueKey('swarm-project-menu'),
      button: true,
      enabled: !opening,
      label: opening ? 'Opening Buddy chat…' : 'Project menu',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: opening
            ? null
            : () {
                HapticFeedback.selectionClick();
                onPressed();
              },
        child: SizedBox.square(
          dimension: minTouchTarget,
          child: Align(
            alignment: AlignmentDirectional.centerEnd,
            child: opening
                ? SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: ink,
                      backgroundColor: ink.withValues(alpha: .35),
                    ),
                  )
                : Icon(LucideIcons.ellipsisVertical300, size: 22, color: ink),
          ),
        ),
      ),
    );
  }
}

/// What the project's menu ([showSwarmProjectMenu]) was closed with.
enum SwarmProjectMenuItem { buddyChat, status }

/// The project's ⋮ menu, as Tony asked for it (2026-10-29): Buddy chat, where
/// Chat with PM was (#2090) — none for a viewer without one ([buddyChat]) —
/// then the team's status in words
/// ([SwarmProjectStatus]), which opens the project's work and team. Its rows
/// are a thumb's height at least, on the sheet the composer's + opens.
/// Answers the row picked, or null when the person closes it.
Future<SwarmProjectMenuItem?> showSwarmProjectMenu(
  BuildContext context, {
  required String swarmId,
  required String projectId,
  required bool buddyChat,
}) => showModalBottomSheet<SwarmProjectMenuItem>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (_) => _ProjectMenu(
    swarmId: swarmId,
    projectId: projectId,
    buddyChat: buddyChat,
  ),
);

class _ProjectMenu extends StatelessWidget {
  const _ProjectMenu({
    required this.swarmId,
    required this.projectId,
    required this.buddyChat,
  });

  final String swarmId, projectId;
  final bool buddyChat;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    void pick(SwarmProjectMenuItem item) => Navigator.of(context).pop(item);
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
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The grabber: a capsule as wide as the two largest steps.
            Center(
              child: Container(
                width: AppSpace.xl + AppSpace.m,
                height: AppSpace.xs,
                margin: const EdgeInsets.only(bottom: AppSpace.s),
                decoration: ShapeDecoration(
                  color: AppGlass.hair,
                  shape: const StadiumBorder(),
                ),
              ),
            ),
            if (buddyChat)
              _MenuRow(
                key: const ValueKey('swarm-project-menu-buddy-chat'),
                onTap: () => pick(SwarmProjectMenuItem.buddyChat),
                child: Text(
                  'Buddy chat',
                  style: AppType.body(color: AppPalette.textPrimary),
                ),
              ),
            SwarmProjectStatus(
              swarmId: swarmId,
              projectId: projectId,
              onTap: () => pick(SwarmProjectMenuItem.status),
            ),
          ],
        ),
      ),
    );
  }
}

/// One row of the project's menu: its words, then maybe a mark at its end,
/// at least [minTouchTarget] tall.
class _MenuRow extends StatelessWidget {
  const _MenuRow({
    super.key,
    required this.onTap,
    required this.child,
    this.trailing,
  });

  final VoidCallback onTap;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppControl.radius),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.m,
              vertical: AppSpace.s,
            ),
            child: Row(
              children: [
                Expanded(child: child),
                if (trailing case final trailing?) ...[
                  const SizedBox(width: AppSpace.s),
                  trailing,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The team of a project in its menu: its status in words
/// ([SwarmStatusText]) and a chevron, opening the project's work and team
/// ([onTap]). Counted from the Home kept, it reads "Updating…" until its
/// Swarm is read again ([swarmHomeKept]), and nothing waits yet.
///
/// It follows its Swarm and the inbox itself while the menu is open, and is
/// built again only when what it shows moved.
class SwarmProjectStatus extends StatefulWidget {
  const SwarmProjectStatus({
    super.key,
    required this.swarmId,
    required this.projectId,
    required this.onTap,
  });

  final String swarmId, projectId;
  final VoidCallback onTap;

  @override
  State<SwarmProjectStatus> createState() => _SwarmProjectStatusState();
}

/// What [SwarmProjectStatus] shows: its team, how much work waits on the
/// person, and whether it is counted from the Home kept.
typedef _Status = ({SwarmTeamGlance glance, int waiting, bool kept});

class _SwarmProjectStatusState extends State<SwarmProjectStatus> {
  SwarmSession? _session;
  SwarmReader? _reader;
  _Status? _status;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_changed);
    _session = session?..inbox.addListener(_changed);
    _follow();
    _status = _see();
  }

  @override
  void dispose() {
    _session?.inbox.removeListener(_changed);
    _reader?.removeListener(_changed);
    super.dispose();
  }

  /// Listens to the Swarm's reader the inbox has now.
  void _follow() {
    final reader = _session?.inbox.reader(widget.swarmId);
    if (reader == _reader) return;
    _reader?.removeListener(_changed);
    _reader = reader?..addListener(_changed);
  }

  void _changed() {
    _follow();
    final status = _see();
    if (status != _status) setState(() => _status = status);
  }

  _Status? _see() {
    final session = _session, reader = _reader;
    final snapshot = reader?.snapshot;
    final project = snapshot?.projects
        .where((p) => p.id == widget.projectId)
        .firstOrNull;
    if (session == null || snapshot == null || project == null) return null;
    final kept = swarmHomeKept(reader);
    final waits = swarmWaitingOnYou(session.inbox, widget.swarmId);
    final work = swarmProjectWork(snapshot, project, buddies: reader!.buddies);
    return (
      glance: swarmTeamGlance(snapshot, projectId: project.id),
      // What was kept is not now, what waits on the person least of all.
      waiting: kept ? 0 : work.active.where((g) => waits.contains(g.id)).length,
      kept: kept,
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final status = _status;
    return _MenuRow(
      key: const ValueKey('swarm-project-menu-status'),
      onTap: widget.onTap,
      trailing: Icon(
        LucideIcons.chevronRight300,
        size: AppIconSize.besideText,
        color: AppPalette.textFaint,
      ),
      child: status == null
          ? Text(
              'Updating…',
              style: AppType.body(color: AppPalette.textSecondary),
            )
          : SwarmStatusText(
              status.glance,
              waiting: status.waiting,
              kept: status.kept,
            ),
    );
  }
}

/// A project's team in words, as its menu says it (Tony, 2026-10-29): "17
/// working · 3 down", no faces — or, while work waits on the person
/// ([waiting]), how much does, in the warning colour, with only who is down
/// of the team. Who is down is red. Counted from the Home kept ([kept]), it
/// reads "Updating…".
class SwarmStatusText extends StatelessWidget {
  const SwarmStatusText(
    this.glance, {
    super.key,
    this.waiting = 0,
    this.kept = false,
  });

  final SwarmTeamGlance glance;
  final int waiting;
  final bool kept;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final down = swarmStateColor(SwarmAgentState.down);
    final List<({String text, Color? color})> parts = kept
        ? const []
        : waiting > 0
        ? [
            (text: '$waiting waiting on you', color: AppColors.warning),
            if (glance.down > 0) (text: '${glance.down} down', color: down),
          ]
        : [
            for (final part in glance.parts)
              (
                text: part.text,
                color: part.state == SwarmAgentState.down ? down : null,
              ),
          ];
    if (parts.isEmpty) {
      return Text(
        kept ? 'Updating…' : glance.line,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppType.body(
          color: kept ? AppPalette.textSecondary : AppPalette.textPrimary,
        ),
      );
    }
    return Text.rich(
      TextSpan(
        children: [
          for (final (i, part) in parts.indexed) ...[
            if (i > 0) const TextSpan(text: ' · '),
            TextSpan(
              text: part.text,
              style: part.color == null ? null : TextStyle(color: part.color),
            ),
          ],
        ],
      ),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: AppType.body(color: AppPalette.textPrimary),
    );
  }
}

/// The project's work and team in a sheet over its chat: its work — what
/// waits on the person, then what the team is working on, by latest activity,
/// and older work folded under "Older", read from the Swarm's closed work
/// when opened, as no first load has it ([SwarmReader.loadDormant]) — or its
/// team: each agent with its avatar, its name and its role in a tag (PM, Dev
/// or Rev), and its state in a word with the work it holds; the Product
/// Manager first, then who needs a person.
Future<void> showSwarmProjectSheet(
  BuildContext context, {
  required String swarmId,
  required String projectId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  // On the page's own navigator, under the shell's [SwarmScope]: a chat
  // opened from it goes over it, and back comes back to it.
  builder: (_) => SwarmProjectSheet(swarmId: swarmId, projectId: projectId),
);

/// What [showSwarmProjectSheet] shows.
class SwarmProjectSheet extends StatefulWidget {
  const SwarmProjectSheet({
    super.key,
    required this.swarmId,
    required this.projectId,
  });

  final String swarmId, projectId;

  @override
  State<SwarmProjectSheet> createState() => _SwarmProjectSheetState();
}

class _SwarmProjectSheetState extends State<SwarmProjectSheet> {
  /// The team shows, not the work.
  bool _team = false;
  bool _older = false;
  String? _olderError;

  void _toggleOlder(SwarmReader reader) {
    setState(() => _older = !_older);
    if (_older) unawaited(_readOlder(reader));
  }

  /// The project's closed work: its first page, or [earlier] the next.
  Future<void> _readOlder(SwarmReader reader, {bool earlier = false}) async {
    setState(() => _olderError = null);
    try {
      await reader.loadDormant(widget.projectId, earlier: earlier);
    } catch (_) {
      if (mounted) {
        setState(() => _olderError = 'Could not load older work. Try again.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    final inbox = session?.inbox;
    return SizedBox(
      // As tall whichever part shows, and its work built as it comes into
      // view: a sheet the size of its rows would build every row.
      height: MediaQuery.sizeOf(context).height * .82,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.l,
            AppSpace.s,
            AppSpace.l,
            0,
          ),
          child: session == null || inbox == null
              ? const SizedBox.shrink()
              // Not listed yet, the inbox tells when it is; then the Swarm's
              // reader tells what changes.
              : ListenableBuilder(
                  listenable: inbox,
                  builder: (context, _) =>
                      switch (inbox.reader(widget.swarmId)) {
                        final reader? => ListenableBuilder(
                          listenable: reader,
                          builder: (context, _) =>
                              _sheet(context, session, reader),
                        ),
                        null => _sheet(context, session, null),
                      },
                ),
        ),
      ),
    );
  }

  Widget _sheet(
    BuildContext context,
    SwarmSession session,
    SwarmReader? reader,
  ) {
    final snapshot = reader?.snapshot;
    final project = snapshot?.projects
        .where((p) => p.id == widget.projectId)
        .firstOrNull;
    final glance = snapshot == null
        ? null
        : swarmTeamGlance(snapshot, projectId: widget.projectId);
    final pmId = snapshot == null || project == null
        ? null
        : swarmPmId(snapshot, project);
    final work = snapshot == null || project == null
        ? null
        : swarmProjectWork(snapshot, project, buddies: reader!.buddies);
    final waits = swarmWaitingOnYou(session.inbox, widget.swarmId);
    final waiting = [
      for (final g in work?.active ?? const <SuperTabConversation>[])
        if (waits.contains(g.id)) g,
    ];
    final Widget body;
    if (snapshot == null) {
      body = switch (reader?.error) {
        final error? => Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.xs,
            vertical: AppSpace.s,
          ),
          child: SwarmRow.line(error, lines: 3),
        ),
        null => _team ? const _MatesLoading() : const _WorkLoading(),
      };
    } else if (_team) {
      body = _mates(glance!, pmId);
    } else if (work == null) {
      body = const SizedBox.shrink();
    } else {
      body = RefreshIndicator(
        onRefresh: reader!.refresh,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: _work(snapshot, reader, work, waiting),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The grabber: a capsule as wide as the two largest steps.
        Center(
          child: Container(
            width: AppSpace.xl + AppSpace.m,
            height: AppSpace.xs,
            margin: const EdgeInsets.only(bottom: AppSpace.s),
            decoration: ShapeDecoration(
              color: AppGlass.hair,
              shape: const StadiumBorder(),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            0,
            AppSpace.xs,
            AppSpace.s,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  project?.name ?? 'Team',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.heading(color: AppPalette.textPrimary),
                ),
              ),
              SwarmIconButton(
                key: const ValueKey('swarm-team-close'),
                icon: LucideIcons.x300,
                label: 'Close',
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
        ),
        _Parts(
          team: _team,
          work: switch ((work, waiting.length)) {
            (_, > 0 && final n) => (text: '$n waiting', waits: true),
            (final work?, _) => (text: '${work.active.length}', waits: false),
            (null, _) => null,
          },
          mates: glance == null ? null : '${glance.agents.length}',
          onTeam: (team) => setState(() => _team = team),
        ),
        const SizedBox(height: AppSpace.xs),
        Expanded(child: body),
      ],
    );
  }

  /// The work part's slivers: what waits on the person, then what the team
  /// works on, then "Older" — each card built row by row as it comes into
  /// view.
  List<Widget> _work(
    SuperTabSnapshot snapshot,
    SwarmReader reader,
    ({List<SuperTabConversation> active, List<SuperTabConversation> older})
    work,
    List<SuperTabConversation> waiting,
  ) {
    final working = [
      for (final g in work.active)
        if (!waiting.contains(g)) g,
    ];
    final projectId = widget.projectId;
    final olderRead = reader.dormantLoaded(projectId);
    final olderReading = reader.dormantLoading(projectId);
    final older = _older ? work.older : const <SuperTabConversation>[];
    final earlier = _older && reader.hasEarlierDormant(projectId);
    SwarmRow row(SuperTabConversation g) {
      final agentId = g.assignment?['agentId'] as String?;
      return SwarmRow(
        key: ValueKey('swarm-conversation-${g.id}'),
        // Nobody holds it: its number still lines up with the others'.
        leading: agentId == null
            ? const SizedBox(width: 24)
            : SwarmAvatar(
                id: agentId,
                name: snapshot.agentName(agentId),
                size: 24,
                picture: snapshot.agent(agentId)?.avatar,
              ),
        number: g.number == null ? null : '#${g.number}',
        title: g.title,
        detail: switch (_statusOf(snapshot, g)) {
          final status? => SwarmRow.line(status),
          null => null,
        },
        onTap: () => openSwarmConversation(context, widget.swarmId, g.id),
      );
    }

    Widget box(Widget child) => SliverToBoxAdapter(child: child);
    // A card whose rows are built only as they come into view.
    Widget card(int count, Widget Function(int i) build) => SliverList.builder(
      itemCount: count,
      itemBuilder: (context, i) =>
          _CardRow(first: i == 0, last: i == count - 1, child: build(i)),
    );

    return [
      if (waiting.isNotEmpty) ...[
        box(const SwarmCaption('Waiting on you', first: true)),
        card(waiting.length, (i) => row(waiting[i])),
      ],
      box(SwarmCaption('Working on', first: waiting.isEmpty)),
      if (working.isEmpty)
        box(
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: SwarmRow.line('No work going on.'),
          ),
        )
      else
        card(working.length, (i) => row(working[i])),
      box(const SizedBox(height: 32)),
      card(1 + older.length + (earlier ? 1 : 0), (i) {
        if (i == 0) {
          return SwarmRow(
            key: const ValueKey('swarm-older'),
            title: _older
                ? 'Hide older'
                : olderRead
                ? 'Older (${work.older.length})'
                : 'Older',
            trailing: olderReading ? SwarmRow.line('Loading…') : null,
            chevron: _older
                ? LucideIcons.chevronDown300
                : LucideIcons.chevronRight300,
            onTap: () => _toggleOlder(reader),
          );
        }
        if (i <= older.length) return row(older[i - 1]);
        return SwarmRow(
          key: const ValueKey('swarm-older-earlier'),
          title: 'Show earlier',
          trailing: olderReading ? SwarmRow.line('Loading…') : null,
          onTap: olderReading
              ? null
              : () => unawaited(_readOlder(reader, earlier: true)),
        );
      }),
      if (_older && _olderError != null)
        box(
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.s),
            child: SwarmRow.line(
              _olderError!,
              lines: 2,
              color: AppColors.danger,
            ),
          ),
        )
      else if (_older && olderRead && work.older.isEmpty)
        box(
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.s,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line('No older work.'),
          ),
        ),
      SliverToBoxAdapter(
        child: SizedBox(height: MediaQuery.paddingOf(context).bottom + 28),
      ),
    ];
  }

  /// The team part: each agent, the Product Manager first.
  Widget _mates(SwarmTeamGlance glance, String? pmId) {
    if (glance.agents.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpace.xs,
          vertical: AppSpace.s,
        ),
        child: Align(
          alignment: Alignment.topLeft,
          child: SwarmRow.line(glance.line),
        ),
      );
    }
    final agents = _pmFirst(glance, pmId);
    return ListView.separated(
      itemCount: agents.length,
      separatorBuilder: (_, _) =>
          Divider(height: 1, thickness: 1, color: AppGlass.hair),
      itemBuilder: (context, i) => _Mate(
        glance: agents[i],
        role: agents[i].agent.id == pmId
            ? 'PM'
            : agents[i].agent.isReviewer
            ? 'Rev'
            : 'Dev',
      ),
    );
  }

  /// "Nova · Needs you"-like, from the work it holds; null when nobody holds
  /// it.
  static String? _statusOf(SuperTabSnapshot snapshot, SuperTabConversation g) {
    final assignment = g.assignment;
    final status = assignment?['status'];
    if (assignment == null || status is! String) return null;
    final agent = snapshot.agentName(assignment['agentId'] as String? ?? '');
    final label = superTabWorkStatusLabel(status);
    return label.isEmpty
        ? agent
        : '$agent · ${label[0].toUpperCase()}${label.substring(1)}';
  }
}

/// The sheet's two parts, side by side: Work, with how much there is or how
/// much waits on the person ([work]), and Team, with how many ([mates]).
class _Parts extends StatelessWidget {
  const _Parts({
    required this.team,
    required this.work,
    required this.mates,
    required this.onTeam,
  });

  final bool team;
  final ({String text, bool waits})? work;
  final String? mates;
  final ValueChanged<bool> onTeam;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    Widget part(String label, ({String text, bool waits})? count, bool on) =>
        Expanded(
          child: Semantics(
            button: true,
            selected: on,
            child: Material(
              key: ValueKey('swarm-sheet-${label.toLowerCase()}'),
              color: on ? AppPalette.windowBg : Colors.transparent,
              borderRadius: BorderRadius.circular(AppControl.rowRadius),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => onTeam(label == 'Team'),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minHeight: AppControl.heightField,
                  ),
                  child: Center(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: label),
                          if (count case final count?)
                            TextSpan(
                              text: '  ${count.text}',
                              style: tty.style(
                                size: AppType.monoLabelSize,
                                color: count.waits
                                    ? AppColors.warning
                                    : AppPalette.textFaint,
                              ),
                            ),
                        ],
                      ),
                      maxLines: 1,
                      style: swarmChatText(
                        15,
                        color: on
                            ? AppPalette.textPrimary
                            : AppPalette.textSecondary,
                        weight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppPalette.swarmSearchSurface,
        borderRadius: BorderRadius.circular(AppControl.radius),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.xs / 2),
        child: Row(
          children: [
            part('Work', work, !team),
            part(
              'Team',
              mates == null ? null : (text: mates!, waits: false),
              team,
            ),
          ],
        ),
      ),
    );
  }
}

/// One row of a card built row by row: a [SwarmGroup] drawn a row at a time,
/// its corners rounded at its [first] and [last] row and a hairline above
/// every row but the first.
class _CardRow extends StatelessWidget {
  const _CardRow({
    required this.first,
    required this.last,
    required this.child,
  });

  final bool first, last;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ClipRRect(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(first ? 14 : 0),
        bottom: Radius.circular(last ? 14 : 0),
      ),
      child: ColoredBox(
        // A step from the sheet it is on.
        color: AppPalette.windowBg,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!first) Divider(height: 1, thickness: 1, color: AppGlass.hair),
            child,
          ],
        ),
      ),
    );
  }
}

/// The top bar while the project is read: its back, and its name on its way
/// in the title's place, the height of [SwarmTopBar].
class _LoadingTopBar extends StatelessWidget {
  const _LoadingTopBar({required this.leading});

  final Widget leading;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.xs,
          AppSpace.xs,
          AppSpace.s,
          AppSpace.xs,
        ),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 4),
            Expanded(
              child: Align(
                alignment: Alignment.centerLeft,
                child: SkeletonText(
                  key: const ValueKey('swarm-project-title-loading'),
                  style: Tty.of(context)
                      .style(size: 17, weight: FontWeight.w600)
                      .copyWith(height: 1.25),
                  width: 120,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The page on its way: nothing under its header, as nothing is there once
/// its chat is.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) =>
      const SizedBox.expand(key: ValueKey('swarm-project-loading'));
}

/// The sheet's work on its way: three rows, the shape of its cards'.
class _WorkLoading extends StatelessWidget {
  const _WorkLoading();

  @override
  Widget build(BuildContext context) => SkeletonBlock(
    key: const ValueKey('swarm-work-loading'),
    child: ListView(
      physics: const NeverScrollableScrollPhysics(),
      children: [
        const SwarmCaption('Working on', first: true),
        SwarmGroup(
          children: [
            for (var i = 0; i < 3; i++)
              Opacity(
                opacity: skeletonFade(i, 3, depth: .4),
                child: _SkeletonRow(width: i.isEven ? .45 : .6),
              ),
          ],
        ),
      ],
    ),
  );
}

/// A row on its way, the shape of a [SwarmRow] with a 24-point avatar and a
/// line under its title.
class _SkeletonRow extends StatelessWidget {
  const _SkeletonRow({this.width = .45});

  final double width;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: SwarmRow.height),
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.l,
        vertical: AppSpace.m,
      ),
      child: Row(
        children: [
          const Skeleton(width: 24, height: 24, radius: 12),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                SkeletonText(
                  style: AppType.label(height: 1.3),
                  widthFactor: width,
                ),
                const SizedBox(height: 3),
                SkeletonText(
                  style: AppType.caption(height: 1.35),
                  widthFactor: width + .25,
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// The team with its Product Manager first, as the prototype lists it; the
/// rest as [swarmTeamGlance] orders them, who needs the person first.
List<SwarmAgentGlance> _pmFirst(SwarmTeamGlance glance, String? pmId) => [
  ...glance.agents.where((a) => a.agent.id == pmId),
  ...glance.agents.where((a) => a.agent.id != pmId),
];

/// The team part's agents on their way: three, the shape of [_Mate].
class _MatesLoading extends StatelessWidget {
  const _MatesLoading();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SkeletonBlock(
      key: const ValueKey('swarm-team-loading'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) Divider(height: 1, thickness: 1, color: AppGlass.hair),
            Opacity(
              opacity: skeletonFade(i, 3, depth: .4),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpace.xs,
                  vertical: AppSpace.m,
                ),
                child: Row(
                  children: [
                    const Skeleton(
                      width: 32,
                      height: 32,
                      shape: BoxShape.circle,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SkeletonText(
                            style: AppType.label(),
                            widthFactor: i.isEven ? .35 : .5,
                          ),
                          const SizedBox(height: 3),
                          SkeletonText(
                            style: AppType.caption(height: 1.4),
                            widthFactor: .7,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// One agent of the team part.
class _Mate extends StatelessWidget {
  const _Mate({required this.glance, required this.role});

  final SwarmAgentGlance glance;

  /// Its role in a tag: PM, Dev (a Builder) or Rev (a Reviewer).
  final String role;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final down = glance.state == SwarmAgentState.down;
    final shell = PhoneShellScope.maybeOf(context);
    return Padding(
      key: ValueKey('swarm-agent-${glance.agent.id}'),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.xs,
        vertical: AppSpace.m,
      ),
      child: Row(
        children: [
          SwarmAvatar(
            id: glance.agent.id,
            name: glance.name,
            picture: glance.agent.avatar,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        glance.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.label(color: AppPalette.textPrimary),
                      ),
                    ),
                    const SizedBox(width: 6),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border.all(color: AppGlass.hair),
                        borderRadius: BorderRadius.circular(
                          AppCard.insetRadius,
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpace.xs,
                        ),
                        child: Text(
                          role,
                          style: tty
                              .style(
                                size: 11,
                                weight: FontWeight.w600,
                                color: AppPalette.textSecondary,
                              )
                              .copyWith(height: 16 / 11),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '● ',
                        style: TextStyle(color: swarmStateColor(glance.state)),
                      ),
                      TextSpan(
                        text: glance.label,
                        style: down
                            ? TextStyle(color: swarmStateColor(glance.state))
                            : null,
                      ),
                      if (glance.task case final task?)
                        TextSpan(text: ' · ${task.label}'),
                    ],
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.caption(
                    color: AppPalette.textSecondary,
                    height: 1.4,
                  ),
                ),
                if (shell != null && glance.agent.harnessId.isNotEmpty)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: SwarmButton(
                      key: ValueKey('swarm-open-terminal-${glance.agent.id}'),
                      label: 'Open terminal',
                      style: SwarmButtonStyle.link,
                      onPressed: () => shell.onOpenAgent(
                        glance.agent.machineId,
                        glance.agent.harnessId,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
