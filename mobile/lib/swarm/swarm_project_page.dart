import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_chat_menu.dart';
import 'swarm_conversation_page.dart';
import 'swarm_invites_sheet.dart' show SwarmInvitesSheet;
import 'swarm_leaderboard.dart';
import 'swarm_project_details.dart';
import 'swarm_project_settings.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_terminal_row.dart';
import 'swarm_thread.dart' show SwarmThreadFocus;

/// Opens [projectId] of Swarm [swarmId] over [context]'s page — in its place
/// with [replace] — on its chat: every way into a project goes through here.
void openSwarmProject(
  BuildContext context, {
  required String swarmId,
  required String projectId,
  bool replace = false,
}) {
  final route = phoneRoute(
    (_) => SwarmProjectPage(swarmId: swarmId, projectId: projectId),
    listensForItself: true,
  );
  final navigator = Navigator.of(context);
  unawaited(replace ? navigator.pushReplacement(route) : navigator.push(route));
}

/// A route to chat [conversationId] of Swarm [swarmId], at [messageId], or
/// with [threadId]'s thread open over it at its root, or at [threadFocus],
/// as a notice, a link or a row opens it ([SwarmOpenedChat]).
Route<void> swarmChatRoute({
  required String swarmId,
  required String conversationId,
  String? messageId,
  String? threadId,
  SwarmThreadFocus? threadFocus,
}) => phoneRoute(
  (_) => SwarmOpenedChat(
    swarmId: swarmId,
    conversationId: conversationId,
    messageId: messageId,
    threadId: threadId,
    threadFocus: threadFocus,
  ),
  listensForItself: true,
);

/// A chat opened by its id. A project's own chat is that project, so it
/// opens as the project's page ([SwarmProjectPage], at [messageId]); any
/// other — an agent's chat, a Buddy chat, one not open to the person — as
/// its chat page, which says what it cannot show.
///
/// Which it is, only the Swarm's read knows: in that Swarm alone, so an id
/// from another Swarm names nothing. Until it is read the chat page shows,
/// and the read settles it once: a project's chat then turns into its page;
/// anything else, or access lost, stays the chat page. A copy of the Swarm
/// read before the chat opened may be older than its project, so a chat no
/// project names there is decided only by a read sent after it opened that
/// got through (as [SwarmProjectPage] reads on open). A read that fails
/// decides nothing: the reader's next one that gets through does.
class SwarmOpenedChat extends StatefulWidget {
  const SwarmOpenedChat({
    super.key,
    required this.swarmId,
    required this.conversationId,
    this.messageId,
    this.threadId,
    this.threadFocus,
  });

  final String swarmId, conversationId;
  final String? messageId;

  /// The thread opened over the chat ([SwarmConversationPage.threadId]).
  final String? threadId;

  /// Where that thread lands ([SwarmConversationPage.threadFocus]).
  final SwarmThreadFocus? threadFocus;

  @override
  State<SwarmOpenedChat> createState() => _SwarmOpenedChatState();
}

class _SwarmOpenedChatState extends State<SwarmOpenedChat> {
  SwarmSession? _session;

  /// The Swarm's reader as last seen. What is asked of it, and waited for,
  /// belongs to it: a new one starts again.
  SwarmReader? _reader;

  /// The project whose chat it is, once the read said so.
  String? _projectId;

  /// The read has said what the chat is; nothing more is listened to.
  bool _settled = false;

  /// [_reader] was asked for a read sent after the chat opened ([_ask]).
  bool _asked = false;

  /// The count of [_reader]'s reads that got through ([SwarmReader.reads])
  /// that a read sent after the chat opened brings it to; null until that
  /// read is sent.
  int? _decidedAt;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_look);
    _session = session;
    if (!_settled) session?.inbox.addListener(_look);
    _look();
  }

  @override
  void dispose() {
    _stopListening();
    super.dispose();
  }

  void _follow(SwarmReader? reader) {
    _reader?.removeListener(_look);
    _reader?.reads.removeListener(_look);
    _reader = reader;
    reader?.addListener(_look);
    // A read that got through but changed nothing tells only [reads].
    reader?.reads.addListener(_look);
    _asked = false;
    _decidedAt = null;
  }

  void _stopListening() {
    _session?.inbox.removeListener(_look);
    _follow(null);
  }

  void _look() {
    if (_settled || !mounted) return;
    final reader = _session?.inbox.reader(widget.swarmId);
    if (reader != _reader) _follow(reader);
    if (reader == null) return;
    if (reader.accessRevoked) return _settle(null);
    final snapshot = reader.snapshot;
    if (snapshot == null) return;
    final project = snapshot.projects
        .where((p) => p.leadConversationId == widget.conversationId)
        .firstOrNull;
    if (project != null) return _settle(project.id);
    // Not a project's chat in this copy, which may be older than the
    // project: a read sent since it opened that got through decides.
    if (_decidedAt case final at? when reader.reads.value >= at) {
      return _settle(null);
    }
    if (!_asked) _ask(reader);
  }

  void _settle(String? projectId) {
    _settled = true;
    _stopListening();
    if (projectId == null) return;
    // Called from didChangeDependencies too, where a build follows anyway.
    setState(() => _projectId = projectId);
  }

  /// Asks [reader] for a read sent from now. One under way may have been
  /// sent before the chat opened, so it is let finish and one more is sent
  /// after it: once, never again on a failure — the reader's own reads
  /// carry on from there, so being offline asks nothing in a loop.
  void _ask(SwarmReader reader) {
    _asked = true;
    void send() {
      _decidedAt = reader.reads.value + 1;
      unawaited(reader.refresh());
    }

    if (!reader.refreshing) return send();
    unawaited(
      reader.refresh().whenComplete(() {
        if (!mounted || _settled || !identical(reader, _reader)) return;
        send();
      }),
    );
  }

  @override
  Widget build(BuildContext context) => switch (_projectId) {
    final projectId? => SwarmProjectPage(
      key: const ValueKey('swarm-opened-project'),
      swarmId: widget.swarmId,
      projectId: projectId,
      messageId: widget.messageId,
      threadId: widget.threadId,
      threadFocus: widget.threadFocus,
    ),
    null => SwarmConversationPage(
      key: const ValueKey('swarm-opened-chat'),
      swarmId: widget.swarmId,
      conversationId: widget.conversationId,
      messageId: widget.messageId,
      threadId: widget.threadId,
      threadFocus: widget.threadFocus,
    ),
  };
}

/// One project: its channel, filling the screen under a header with back and
/// its #name, which opens its details, and ⋮ at its end ([_ProjectMenu]). A
/// sheet over the channel counts as out of sight: nothing it gets is read.
class SwarmProjectPage extends StatefulWidget {
  const SwarmProjectPage({
    super.key,
    required this.swarmId,
    required this.projectId,
    this.messageId,
    this.threadId,
    this.threadFocus,
  });

  final String swarmId, projectId;

  /// Where its chat opens, as a notice or a link names it: at that message
  /// ([SwarmConversationPage.messageId]), or with that thread open over it
  /// ([SwarmConversationPage.threadId]). Only the first time the chat shows.
  final String? messageId, threadId;

  /// Where that thread lands ([SwarmConversationPage.threadFocus]).
  final SwarmThreadFocus? threadFocus;

  @override
  State<SwarmProjectPage> createState() => _SwarmProjectPageState();
}

class _SwarmProjectPageState extends State<SwarmProjectPage> {
  SwarmSession? _session;

  /// Find in the chat shown, asked from the project's header (task #2826):
  /// the chat's page under it answers.
  final _findRequests = ValueNotifier(0);
  void _findInChat() => _findRequests.value++;

  /// What the page shows of the inbox ([_inboxChanged]): its Swarm's
  /// reader, and why the list was not read.
  SwarmReader? _reader;
  String? _listError;

  /// A read of the Swarm since the page opened has finished ([_readOnOpen]).
  /// Until then, a project the Swarm did not have may be one just made.
  bool _read = false;

  /// The channel as last built, with what it was built from: a read that
  /// moved none of it builds none of it again ([_bodyOf]). The channel
  /// follows what it shows itself.
  ({Object inputs, Widget body})? _body;

  /// The sheet the menu opened, while it is up. What it shows is the
  /// project's: it closes with the page, and when the account, the read or
  /// the project is gone ([_closeSheet]).
  ModalRoute<void>? _sheet;

  /// Project settings…'s rows while they are up: they go as [_sheet] does.
  Route<void>? _settings;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _closeSheet();
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    _session = session?..enter();
    session?.inbox.addListener(_inboxChanged);
    _seeInbox();
    _readOnOpen();
  }

  @override
  void dispose() {
    _findRequests.dispose();
    _closeSheet();
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    super.dispose();
  }

  /// The inbox tells of every change of every Swarm, and again when what
  /// waits on the person is read after one; the page is built again only
  /// when what it shows of the inbox moved. Its Swarm's own changes come
  /// from its reader.
  void _inboxChanged() {
    final inbox = _session?.inbox;
    if (inbox == null) return;
    final seen = (inbox.reader(widget.swarmId), inbox.error);
    if (seen != (_reader, _listError)) setState(_seeInbox);
  }

  void _seeInbox() {
    final inbox = _session?.inbox;
    _reader = inbox?.reader(widget.swarmId);
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

  /// Opens one of the menu's sheets, on the page's own navigator, under the
  /// shell's [SwarmScope]: a chat opened from it goes over it, and back comes
  /// back to it. Kept from before it is pushed, so losing the project before
  /// its first frame still closes it.
  void _openSheet(WidgetBuilder builder) {
    if (_sheet != null || !mounted) return;
    final route = swarmSheetRoute<void>(context, builder: builder);
    setState(() => _sheet = route);
    unawaited(
      Navigator.of(context).push(route).whenComplete(() {
        if (mounted && _sheet == route) setState(() => _sheet = null);
      }),
    );
  }

  void _openLeaderboardSheet() => _openSheet(
    (_) => SwarmLeaderboardPage(
      swarmId: widget.swarmId,
      projectId: widget.projectId,
      sheet: true,
    ),
  );

  /// The project's details, from a tap on its name ([SwarmProjectDetailsSheet]),
  /// as the menu's sheets open: what it hands back opens once it is gone.
  void _openDetails(
    SwarmSession session,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
  ) {
    if (_sheet != null || !mounted) return;
    bool allowed() =>
        !reader.accessRevoked &&
        reader.snapshot?.projectById(project.id) != null &&
        swarmCanWrite(reader);
    final chatId = project.leadConversationId;
    final route = swarmSheetRoute<VoidCallback>(
      context,
      builder: (_) => SwarmProjectDetailsSheet(
        reader: reader,
        projectId: project.id,
        // The page's context, not the sheet's: a resume's question is asked
        // once the sheet has gone.
        terminal: (shell, computers) => allowed()
            ? swarmTerminalAction(
                context: context,
                agent: () => swarmProjectPm(reader.snapshot, project.id),
                allowed: allowed,
                shell: shell,
                computers: computers,
                until: reader,
              )
            : null,
        onLeaderboard: _openLeaderboardSheet,
        onNotifications: snapshot.conversation(chatId) == null
            ? null
            : () => unawaited(showSwarmNotifySheet(context, reader, chatId)),
        onInvite: () => _openSheet(
          (_) => SwarmInvitesSheet(session: session, reader: reader),
        ),
      ),
    );
    setState(() => _sheet = route);
    unawaited(
      Navigator.of(context).push(route).then((action) {
        if (!mounted) return;
        if (_sheet == route) setState(() => _sheet = null);
        action?.call();
      }),
    );
  }

  void _openSharingSheet(SwarmReader reader) => _openSheet(
    (_) =>
        SwarmProjectSharingSheet(reader: reader, projectId: widget.projectId),
  );

  /// Project settings…'s Project details ([SwarmProjectInfoSheet]): not the
  /// sheet a tap on its name opens ([_openDetails]).
  void _openInfoSheet(SwarmReader reader) => _openSheet(
    (_) => SwarmProjectInfoSheet(reader: reader, projectId: widget.projectId),
  );

  Future<void> _openSettings(SwarmReader reader) async {
    Route<void>? shown;
    await showSwarmProjectSettings(
      context,
      reader,
      widget.projectId,
      onShown: (route) => _settings = shown = route,
      onDetails: () => _openInfoSheet(reader),
    );
    if (_settings == shown) _settings = null;
  }

  /// Closes the sheet open, if any, and a dialog or sheet over it, with what
  /// it shows (Approve's question): once this frame is done, as a page that
  /// lost its project, or is going away, may not change the navigator while
  /// it does.
  void _closeSheet() {
    final settings = _settings;
    _settings = null;
    if (settings != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (settings.isActive) settings.navigator?.removeRoute(settings);
      });
    }
    final sheet = _sheet;
    _sheet = null;
    if (sheet == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!sheet.isActive) return;
      final navigator = sheet.navigator!;
      navigator.popUntil((top) => top == sheet || top is! PopupRoute);
      navigator.removeRoute(sheet);
    });
  }

  /// The header: back, [project]'s name as a channel's, #name, which opens
  /// its details as Slack's does, and ⋮ at its end.
  Widget _header(
    SwarmSession session,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
    Widget back,
  ) => SwarmTopBar(
    leading: back,
    title: '#${project.name}',
    onTitle: () => _openDetails(session, reader, snapshot, project),
    titleLabel: '#${project.name}, project details',
    trailing: _ProjectMenu(
      reader: reader,
      projectId: project.id,
      onLeaderboard: _openLeaderboardSheet,
      onSharing: swarmManagesProject(reader, project.id)
          ? () => _openSharingSheet(reader)
          : null,
      onSettings: () => unawaited(_openSettings(reader)),
      onFind: _findInChat,
      onNotifications: snapshot.conversation(project.leadConversationId) == null
          ? null
          : () => unawaited(
              showSwarmNotifySheet(context, reader, project.leadConversationId),
            ),
    ),
  );

  /// The channel, built again only when what it is built from moved.
  Widget _bodyOf(SwarmSession session, SuperTabProject project) {
    final inputs = (session, project.leadConversationId);
    if (_body case final kept? when kept.inputs == inputs) return kept.body;
    final body = SwarmConversationPage(
      key: ValueKey('swarm-project-chat-${project.leadConversationId}'),
      swarmId: widget.swarmId,
      conversationId: project.leadConversationId,
      header: false,
      findRequests: _findRequests,
      messageId: widget.messageId,
      threadId: widget.threadId,
      threadFocus: widget.threadFocus,
    );
    _body = (inputs: inputs, body: body);
    return body;
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
      _closeSheet();
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
        if (reader != null && snapshot != null && project != null) {
          // A project the person no longer reads (made private to others)
          // keeps no sheet of its own.
          if (!swarmReadsProject(reader, project)) _closeSheet();
          return _Frame(
            top: _header(session, reader, snapshot, project, back),
            // Under a sheet the chat is not seen, so nothing it gets is read.
            body: TickerMode(
              enabled: _sheet == null,
              child: _bodyOf(session, project),
            ),
          );
        }
        // Nothing of the project to show: no sheet of it stays.
        _closeSheet();
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

/// The page: its [top], the header, and [body] under it.
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

/// [projectId]'s Product Manager as [snapshot] has it now: the Lead of the
/// project's own chat, while that agent is the project's and no Buddy. Null
/// otherwise, never an agent of another project.
SuperTabAgent? swarmProjectPm(SuperTabSnapshot? snapshot, String projectId) {
  final project = snapshot?.projectById(projectId);
  if (project == null) return null;
  final chat = snapshot!.conversation(project.leadConversationId);
  if (chat == null || chat.projectId != projectId) return null;
  final pm = switch (chat.leadId) {
    final id? => snapshot.agent(id),
    null => null,
  };
  return pm == null || pm.projectId != projectId || pm.isBuddy ? null : pm;
}

/// Whether the person reads [project], as the server does (`canReadProject`):
/// a private project is its owner's and its members'.
bool swarmReadsProject(SwarmReader reader, SuperTabProject project) {
  if (!project.isPrivate || project.ownerId == reader.accountId) return true;
  final me = reader.snapshot?.people
      .where((p) => p.id == reader.accountId)
      .firstOrNull;
  return me != null && project.hasMember(me);
}

/// ⋮ at the end of a Swarm Home C project's header: a small menu, on the
/// design system's menu surface (the theme's), of Open terminal first for
/// someone who may write (Tony, 11-01: the PM's terminal on this phone, by
/// the Buddy row's rule and words, [swarmTerminalAction]), its Leaderboard,
/// its Sharing for its owner who may write, its project chat's
/// Notifications ([showSwarmNotifySheet]), while that chat is read, and its
/// Project settings… ([showSwarmProjectSettings]), as the desktop's project
/// menu has them. It goes with the header: losing the project
/// closes it. Open terminal follows the Swarm and the phone's computers
/// while open, and at the tap reads the PM of [projectId] again.
/// Find in chat follows Open terminal while the chat is shown (task #2826).
class _ProjectMenu extends StatelessWidget {
  const _ProjectMenu({
    required this.reader,
    required this.projectId,
    required this.onLeaderboard,
    required this.onSettings,
    this.onSharing,
    this.onNotifications,
    this.onFind,
  });

  final SwarmReader reader;
  final String projectId;
  final VoidCallback onLeaderboard, onSettings;
  final VoidCallback? onSharing, onNotifications, onFind;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shell = PhoneShellScope.maybeOf(context);
    final computers = SwarmScope.computersOf(context);
    Widget row(
      String key,
      String label,
      VoidCallback? onTap, {
      String? value,
    }) => MenuItemButton(
      key: ValueKey(key),
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(
          Size(AppSpace.xl * 6, minTouchTarget),
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.disabled)
              ? AppPalette.textFaint
              : AppPalette.textPrimary,
        ),
        textStyle: WidgetStatePropertyAll(AppType.body()),
      ),
      onPressed: onTap,
      // Dimmed with why it cannot open, as the Buddy row says it.
      trailingIcon: value == null
          ? null
          : Text(value, style: AppType.body(color: AppPalette.textFaint)),
      child: Text(label),
    );
    bool allowed() =>
        !reader.accessRevoked &&
        reader.snapshot?.projectById(projectId) != null &&
        swarmCanWrite(reader);
    // Built again as the Swarm moves (the header's) and as the phone's
    // computers do ([SwarmScope.computersOf] depends on its host).
    final terminal = allowed()
        ? swarmTerminalAction(
            context: context,
            agent: () => swarmProjectPm(reader.snapshot, projectId),
            allowed: allowed,
            shell: shell,
            computers: computers,
            until: reader,
          )
        : null;
    return MenuTheme(
      data: MenuThemeData(
        submenuIcon: MenuTheme.of(context).submenuIcon,
        // Home C sits near the top of the phone. Six rows at their 48-point
        // layout height, panel padding, and a small edge fit without scrolling.
        style: AppMenu.style(
          maxHeight:
              6 * (minTouchTarget + AppSpace.xs) +
              AppMenu.panelPadding.vertical +
              AppSpace.xs,
        ),
      ),
      child: MenuAnchor(
        alignmentOffset: const Offset(0, AppSpace.xs),
        menuChildren: [
          if (terminal != null)
            row(
              'swarm-project-menu-terminal',
              terminal.label,
              terminal.enabled ? terminal.onTap : null,
              value: terminal.value,
            ),
          if (onFind case final onTap?)
            row('swarm-project-menu-find', 'Find in chat', onTap),
          row('swarm-project-menu-leaderboard', 'Leaderboard', onLeaderboard),
          if (onSharing case final onTap?)
            row('swarm-project-menu-sharing', 'Sharing', onTap),
          if (onNotifications case final onTap?)
            row('swarm-project-menu-notifications', 'Notifications', onTap),
          row('swarm-project-menu-settings', 'Project settings…', onSettings),
        ],
        builder: (context, menu, _) => SwarmIconButton(
          key: const ValueKey('swarm-project-menu'),
          icon: LucideIcons.ellipsisVertical300,
          label: 'Menu',
          onPressed: () => menu.isOpen ? menu.close() : menu.open(),
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
