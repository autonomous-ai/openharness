import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_chat_menu.dart' show swarmNotifySection;
import 'swarm_conversation_page.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_session.dart' show SwarmScope;
import 'swarm_start.dart' show SwarmOwnComputer;
import 'swarm_terminal_row.dart';
import 'swarm_style.dart';

/// The Swarm a Buddy chat shows in the Buddy tab, by name, and how to pick
/// another from its menu.
typedef SwarmBuddySwitch = ({String name, VoidCallback open});

/// Opens the person's Buddy chat in [projectId] over [context]'s page, on the
/// server first when the read holds none ([openSwarmBuddyChat]). Answers what
/// went wrong as a sentence to show, or null once it is open — or once there
/// is nothing to open: the page gone, or the Swarm taken away meanwhile.
Future<String?> openSwarmBuddy(
  BuildContext context,
  SwarmReader reader,
  String swarmId,
  String projectId,
) async {
  final String? id;
  try {
    id = await openSwarmBuddyChat(reader, projectId);
  } on SuperTabFailure catch (failure) {
    return reader.accessRevoked ? null : failure.message;
  } catch (_) {
    return reader.accessRevoked
        ? null
        : 'Could not open your Buddy chat. Try again.';
  }
  if (reader.accessRevoked || !context.mounted) return null;
  if (id == null) return 'Your Buddy chat is not ready yet. Try again.';
  openSwarmConversation(context, swarmId, id);
  return null;
}

/// Under the person's Buddy chat's header (#2090; the desktop's
/// `SuperTabBuddyBar`): who else can see their Buddy's terminal, when someone
/// can, and, while it is down, Start again. With no Buddy, how its start
/// is going, or — with none under way — Start your Buddy, for a person who
/// may write: the chat is there before any Buddy. Under all of it, what went
/// wrong with the last start or removal. Nothing for a viewer with no Buddy,
/// nor while a Buddy runs on the person's own machine: the chat is the
/// screen, and its messages start under the header (Tony, 10-29).
class SwarmBuddyBar extends StatelessWidget {
  const SwarmBuddyBar({super.key, required this.actions});

  final SwarmBuddyActions actions;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([actions.reader, actions]),
      builder: (context, _) {
        final reader = actions.reader;
        final canWrite = swarmCanWrite(reader);
        final error = actions.error;
        final body = switch (swarmBuddy(reader, actions.projectId)) {
          final agent? => _running(reader, agent, canWrite),
          null => _starting(
            reader,
            canWrite,
            SwarmScope.computersOf(context)?.own ?? const [],
          ),
        };
        if (body == null && error == null) return const SizedBox.shrink();
        return DecoratedBox(
          key: const ValueKey('swarm-buddy-bar'),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: AppGlass.hair)),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.screenInset,
              AppSpace.xs,
              AppSpace.screenInset,
              AppSpace.s,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                ?body,
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpace.xs),
                    child: SwarmRow.line(
                      error,
                      key: const ValueKey('swarm-buddy-error'),
                      lines: 3,
                      color: AppColors.danger,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// On someone else's machine, "Claude on Dee Studio · dee can see its
  /// terminal" (a Buddy from before the server kept Buddies to their owner's
  /// machines, 10-28); and, while it is down, that it is offline with Start
  /// again. Null on the person's own machine while it runs.
  Widget? _running(SwarmReader reader, SuperTabAgent agent, bool canWrite) {
    final shared = agent.machineOwnerId != reader.accountId;
    if (!shared && agent.downSince == null) return null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (shared)
          SwarmRow.line(
            '${swarmBuddyEngineName(agent.engine)} on '
            '${swarmBuddyMachineName(reader, agent.machineId)} · '
            '${swarmBuddyPersonName(reader, agent.machineOwnerId)} can see '
            'its terminal',
            key: const ValueKey('swarm-buddy-where'),
            lines: 2,
          ),
        if (agent.downSince != null)
          _Line(
            key: const ValueKey('swarm-buddy-offline'),
            text:
                '${swarmBuddyName(reader, actions.projectId)} is offline. '
                'Your chat stays.',
            again: canWrite
                ? () => unawaited(
                    actions.start(
                      machineId: agent.machineId,
                      engine: agent.engine,
                    ),
                  )
                : null,
            busy: actions.busy,
          ),
      ],
    );
  }

  /// A start under way, or one that failed with Start again; with none,
  /// Start your Buddy. Null for a viewer, who starts none.
  Widget? _starting(
    SwarmReader reader,
    bool canWrite,
    List<SwarmOwnComputer> own,
  ) {
    final start = swarmBuddyStart(reader, actions.projectId);
    final error = start?['error'];
    if (start == null || (error is! String && start['harnessId'] != null)) {
      return canWrite ? _BuddyStart(actions: actions) : null;
    }
    final request = start['request'] as Map;
    final engine = request['engine'] as String? ?? '';
    final machineId = request['machineId'] as String? ?? '';
    if (error is String) {
      return _Line(
        key: const ValueKey('swarm-buddy-failed'),
        text: "Couldn't start: $error",
        again: canWrite && machineId.isNotEmpty
            ? () => unawaited(
                actions.start(
                  machineId: machineId,
                  engine: engine,
                ),
              )
            : null,
        busy: actions.busy,
      );
    }
    return SwarmRow.line(
      'Starting ${swarmBuddyEngineName(engine)} on '
      '${swarmBuddyMachineName(reader, machineId, computers: own)}…',
      key: const ValueKey('swarm-buddy-starting'),
      lines: 2,
    );
  }
}

/// What happened to the Buddy, in a line, and Start again at its end for a
/// person who may write.
class _Line extends StatelessWidget {
  const _Line({
    super.key,
    required this.text,
    required this.again,
    required this.busy,
  });

  final String text;
  final VoidCallback? again;
  final bool busy;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(text, style: AppType.body(color: AppPalette.textPrimary)),
      ),
      if (again != null)
        SwarmButton(
          key: const ValueKey('swarm-buddy-start-again'),
          label: 'Start again',
          style: SwarmButtonStyle.link,
          busy: busy,
          busyLabel: 'Starting…',
          onPressed: again,
        ),
    ],
  );
}

/// A Buddy chat with no Buddy: one tap on Start starts one, on the person's
/// own machine and with Claude unless they pick otherwise (mockup, Tony
/// 10-29). With no machine of theirs in the Swarm, it says to add one.
class _BuddyStart extends StatefulWidget {
  const _BuddyStart({required this.actions});

  final SwarmBuddyActions actions;

  @override
  State<_BuddyStart> createState() => _BuddyStartState();
}

class _BuddyStartState extends State<_BuddyStart> {
  String? _machine;
  String _engine = 'claude';

  /// The machines under their one heading, each by its name; an offline or
  /// paused one says so and cannot be picked (Dee, 10-29: no notes).
  Future<void> _pickMachine(List<SwarmBuddyMachine> machines, String? chosen) =>
      showPhoneSheet(
        context,
        title: 'Machine',
        sections: [
          PhoneSheetSection(
            caption: swarmBuddyOwnMachines,
            actions: [
              for (final m in machines)
                PhoneSheetAction(
                  icon: m.id == chosen ? LucideIcons.check : LucideIcons.laptop,
                  label: m.name,
                  value: swarmBuddyMachineBlock(m),
                  enabled: swarmBuddyMachineBlock(m) == null,
                  onTap: () {
                    if (mounted) setState(() => _machine = m.id);
                  },
                ),
            ],
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final actions = widget.actions;
    final computers = SwarmScope.computersOf(context);
    final machines = swarmBuddyMachines(
      actions.reader,
      computers: computers?.own ?? const [],
    );
    final open = machines.where((m) => swarmBuddyMachineBlock(m) == null);
    final machine =
        open.where((m) => m.id == _machine).firstOrNull ?? open.firstOrNull;
    final busy = actions.busy;
    return Column(
      key: const ValueKey('swarm-buddy-start'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'Start your Buddy to brainstorm here',
          style: AppType.body(
            color: AppPalette.textPrimary,
            fontWeight: FontWeight.w600,
          ),
        ),
        if (machine == null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.xs),
            child: SwarmRow.line(
              machines.isEmpty
                  ? swarmBuddyNoMachine
                  : machines.any((m) => m.paused && !m.away)
                  ? swarmBuddyAllPaused
                  : swarmBuddyAllOffline,
              key: const ValueKey('swarm-buddy-no-machine'),
              lines: 3,
            ),
          ),
        if (machine == null && machines.isNotEmpty)
          _Field(
            label: 'Machine',
            child: TextButton(
              key: const ValueKey('swarm-buddy-machine'),
              onPressed: () => unawaited(_pickMachine(machines, null)),
              child: const Align(
                alignment: Alignment.centerLeft,
                child: Text('Choose a machine'),
              ),
            ),
          ),
        if (machine != null) ...[
          _Field(
            label: 'Machine',
            child: Semantics(
              button: true,
              label: 'Machine, ${machine.name}',
              excludeSemantics: true,
              child: InkWell(
                key: const ValueKey('swarm-buddy-machine'),
                borderRadius: BorderRadius.circular(AppControl.radius),
                onTap: busy
                    ? null
                    : () => unawaited(_pickMachine(machines, machine.id)),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: minTouchTarget),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          machine.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.body(color: AppPalette.textPrimary),
                        ),
                      ),
                      Icon(
                        LucideIcons.chevronDown,
                        size: AppIconSize.besideText,
                        color: AppPalette.textSecondary,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          _Field(
            label: 'Agent',
            child: Wrap(
              spacing: AppSpace.s,
              runSpacing: AppSpace.xs,
              children: [
                for (final MapEntry(:key, :value) in swarmBuddyEngines.entries)
                  Semantics(
                    selected: key == _engine,
                    child: SwarmButton(
                      key: ValueKey('swarm-buddy-engine-$key'),
                      label: value,
                      icon: key == _engine ? LucideIcons.check : null,
                      onPressed: busy
                          ? null
                          : () => setState(() => _engine = key),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AppSpace.s),
          SwarmButton(
            key: const ValueKey('swarm-buddy-start-button'),
            label: 'Start',
            style: SwarmButtonStyle.fill,
            wide: true,
            busy: busy,
            busyLabel: 'Starting…',
            onPressed: () => unawaited(
              actions.start(
                machineId: machine.id,
                engine: _engine,
                machine: machine,
                computers: computers,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// One choice of Start your Buddy: its name, then what is chosen.
class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: AppSpace.xs),
    child: Row(
      children: [
        SizedBox(
          width: _labelWidth,
          child: Text(
            label,
            style: AppType.body(color: AppPalette.textSecondary),
          ),
        ),
        Expanded(child: child),
      ],
    ),
  );

  /// Wide enough for "Machine" at the largest text the chat allows.
  static const _labelWidth = AppSpace.xl * 3;
}

/// At the end of the person's own Buddy chat's header: ⋮. While they may
/// write, with Open terminal first (Tony, 11-01: the Buddy's terminal on this
/// phone, as Team's agent rows open theirs; dimmed with why while it cannot
/// be, [swarmTerminalAction]), Rename Buddy, and Remove Buddy while one runs,
/// which asks first, then stops it; the chat stays (the desktop's Buddy
/// options); and the chat's Notifications, as its menu on the desktop has.
/// In their one chat for the Swarm, for a viewer too, Old chats with their
/// older Buddy chats, and the Swarm to switch from in the Buddy tab. Nothing
/// in anyone else's Buddy chat, or for a viewer with nothing to offer.
class SwarmBuddyMenuButton extends StatelessWidget {
  const SwarmBuddyMenuButton({
    super.key,
    required this.actions,
    required this.chatId,
    this.swarmId,
    this.swarmSwitch,
    this.onFind,
  });

  final SwarmBuddyActions actions;

  /// Find in chat, where the page holding the chat offers it (task #2826).
  final VoidCallback? onFind;

  /// The Buddy chat it is on: what Rename names the Buddy of, by its id
  /// rather than its project. Null while that chat is not known yet.
  final String? chatId;

  /// The Swarm the chat is in, for what Old chats opens; none offers no Old
  /// chats.
  final String? swarmId;

  /// The Swarm row, in the Buddy tab with others to pick; null for none.
  final SwarmBuddySwitch? swarmSwitch;

  /// Old chats and the Swarm row: rows a viewer has too.
  bool _hasOthers(SwarmReader reader) =>
      swarmSwitch != null || _oldChats(reader).isNotEmpty;

  /// The older Buddy chats to offer, from the person's one chat alone.
  List<({SuperTabProject project, SuperTabConversation chat})> _oldChats(
    SwarmReader reader,
  ) => swarmId != null && actions.projectId == swarmBuddyKey
      ? swarmOldBuddyChats(reader)
      : const [];

  /// Old chats, by project, newest first: each opens read only. The sheet goes
  /// with access to the Swarm, and a project lost meanwhile leaves its rows.
  Future<void> _openOldChats(BuildContext context) async {
    final reader = actions.reader;
    Route<void>? sheet;
    void moved() {
      final route = sheet;
      if (route == null || !reader.accessRevoked) return;
      sheet = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (route.isActive) route.navigator?.removeRoute(route);
      });
    }

    reader.addListener(moved);
    try {
      await showPhoneSheet(
        context,
        title: 'Old chats',
        onShown: (route) => sheet = route,
        rebuildOn: reader,
        rows: () => (
          actions: [
            for (final (:project, :chat) in _oldChats(reader))
              PhoneSheetAction(
                icon: LucideIcons.messageCircle,
                label: project.name,
                value: switch (chat.changedAt) {
                  final at? => fzfAge(at.toLocal(), DateTime.now()),
                  null => null,
                },
                chevron: true,
                onTap: () {
                  if (context.mounted &&
                      !reader.accessRevoked &&
                      swarmIsOldBuddyChat(reader, chat.id)) {
                    openSwarmConversation(context, swarmId!, chat.id);
                  }
                },
              ),
          ],
          sections: const <PhoneSheetSection>[],
        ),
      );
    } finally {
      reader.removeListener(moved);
    }
  }

  /// The sheet, with the chat's Notifications under the Buddy's own rows
  /// ([swarmNotifySection]). It goes once the chat is no longer the
  /// person's own Buddy chat to read (access lost, or signed out), they may
  /// no longer write there (a viewer now), or the Buddy it opened on is no
  /// longer theirs there (removed or being stopped). Its Open
  /// terminal row follows the Swarm and the phone's computers while open.
  Future<void> _open(BuildContext context, String chatId) async {
    final reader = actions.reader;
    final computers = SwarmScope.computersOf(context);
    final shell = PhoneShellScope.maybeOf(context);
    // The running Buddy the sheet has shown: one that starts while it is
    // open is taken up; one removed or being stopped closes it.
    String? running() => switch (swarmBuddy(reader, actions.projectId)) {
      final b? when b.workDecision != 'stop' => b.id,
      _ => null,
    };
    var buddyId = running();
    final wrote = swarmCanWrite(reader);
    Route<void>? sheet;
    void moved() {
      final route = sheet;
      final now = running();
      buddyId ??= now;
      if (route == null ||
          (!reader.accessRevoked &&
              swarmIsOwnBuddyChat(reader, chatId) &&
              swarmCanWrite(reader) == wrote &&
              now == buddyId)) {
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
        title: swarmBuddyName(reader, actions.projectId),
        onShown: (route) => sheet = route,
        rebuildOn: Listenable.merge([reader, ?computers]),
        rows: () {
          final buddy = swarmBuddy(reader, actions.projectId);
          return (
            actions: [
              if (wrote) ...[
                swarmTerminalAction(
                  context: context,
                  agent: () => swarmBuddy(reader, actions.projectId),
                  allowed: () =>
                      !reader.accessRevoked &&
                      swarmIsOwnBuddyChat(reader, chatId) &&
                      swarmCanWrite(reader),
                  shell: shell,
                  computers: computers,
                  until: reader,
                ),
                PhoneSheetAction(
                  icon: LucideIcons.pencil,
                  label: 'Rename Buddy',
                  onTap: () => unawaited(_rename(context, chatId)),
                ),
              ],
              if (onFind case final find?)
                PhoneSheetAction(
                  icon: LucideIcons.search300,
                  label: 'Find in chat',
                  onTap: find,
                ),
              if (_oldChats(reader).isNotEmpty)
                PhoneSheetAction(
                  icon: LucideIcons.history,
                  label: 'Old chats',
                  chevron: true,
                  onTap: () {
                    if (context.mounted && !reader.accessRevoked) {
                      unawaited(_openOldChats(context));
                    }
                  },
                ),
              if (swarmSwitch case final swarm?)
                PhoneSheetAction(
                  icon: LucideIcons.hexagon,
                  label: 'Swarm',
                  value: swarm.name,
                  chevron: true,
                  onTap: swarm.open,
                ),
              if (wrote && buddy != null)
                PhoneSheetAction(
                  icon: LucideIcons.userMinus,
                  label: 'Remove Buddy',
                  destructive: true,
                  onTap: () => unawaited(_confirmRemove(context)),
                ),
            ],
            sections: [swarmNotifySection(context, reader, chatId)],
          );
        },
      );
    } finally {
      reader.removeListener(moved);
    }
  }

  Future<void> _rename(BuildContext context, String chatId) async {
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => SwarmRenameBuddyDialog(actions: actions, chatId: chatId),
    );
  }

  Future<void> _confirmRemove(BuildContext context) async {
    if (!context.mounted) return;
    final remove = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          'Remove Buddy?',
          style: AppType.heading(color: AppPalette.textPrimary),
        ),
        content: Text(
          'Its session stops. Your chat stays, and adding a Buddy here again '
          'picks it up.',
          style: AppType.body(color: AppPalette.textSecondary),
        ),
        actions: [
          SwarmButton(
            key: const ValueKey('swarm-buddy-remove-cancel'),
            label: 'Cancel',
            style: SwarmButtonStyle.link,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          SwarmButton(
            key: const ValueKey('swarm-buddy-remove-confirm'),
            label: 'Remove',
            style: SwarmButtonStyle.fill,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (remove == true) await actions.remove();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([actions.reader, actions]),
      builder: (context, _) {
        final reader = actions.reader;
        final chat = chatId;
        if (chat == null ||
            !swarmIsOwnBuddyChat(reader, chat) ||
            (!swarmCanWrite(reader) && !_hasOthers(reader))) {
          return const SizedBox.shrink();
        }
        final busy = actions.busy;
        final ink = AppPalette.textPrimary;
        return Semantics(
          key: const ValueKey('swarm-buddy-menu'),
          button: true,
          enabled: !busy,
          label: busy ? 'Working on your Buddy…' : 'Buddy options',
          excludeSemantics: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: busy
                ? null
                : () {
                    HapticFeedback.selectionClick();
                    unawaited(_open(context, chat));
                  },
            child: SizedBox.square(
              dimension: minTouchTarget,
              child: Align(
                alignment: AlignmentDirectional.centerEnd,
                child: busy
                    ? SizedBox.square(
                        dimension: AppIconSize.besideText,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: ink,
                          backgroundColor: ink.withValues(alpha: .35),
                        ),
                      )
                    : Icon(
                        LucideIcons.ellipsisVertical300,
                        size: AppIconSize.standalone,
                        color: ink,
                      ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Rename your Buddy (the desktop's, mockup confirmed by Diego, 10-29;
/// without its explanatory lines, Tony's design language): the name everyone
/// in the Swarm sees, empty for the default the field's hint shows. The
/// backend checks it and its words show here. It closes once the chat is no
/// longer the person's to rename in: access lost, signed out, or no longer
/// allowed to write.
class SwarmRenameBuddyDialog extends StatefulWidget {
  const SwarmRenameBuddyDialog({
    super.key,
    required this.actions,
    required this.chatId,
  });

  final SwarmBuddyActions actions;
  final String chatId;

  @override
  State<SwarmRenameBuddyDialog> createState() => _SwarmRenameBuddyDialogState();
}

class _SwarmRenameBuddyDialogState extends State<SwarmRenameBuddyDialog> {
  /// The backend's limit: a longer name is refused there anyway.
  static const _maxLength = 32;

  late final _name = TextEditingController(
    text: swarmBuddyChosenName(widget.actions.reader, widget.chatId) ?? '',
  );
  late final Listenable _source = Listenable.merge([
    widget.actions.reader,
    widget.actions,
  ]);
  bool _saving = false, _closed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _source.addListener(_changed);
  }

  @override
  void dispose() {
    _source.removeListener(_changed);
    _name.dispose();
    super.dispose();
  }

  bool get _allowed {
    final reader = widget.actions.reader;
    return !reader.accessRevoked &&
        swarmCanWrite(reader) &&
        swarmIsOwnBuddyChat(reader, widget.chatId);
  }

  void _changed() {
    if (!mounted) return;
    if (!_allowed) {
      _close();
    } else {
      setState(() {});
    }
  }

  void _close() {
    if (_closed || !mounted) return;
    _closed = true;
    Navigator.of(context).pop();
  }

  Future<void> _save() async {
    if (_saving || widget.actions.busy || !_allowed) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final answer = await widget.actions.rename(widget.chatId, _name.text);
    if (!mounted || _closed) return;
    if (answer.renamed) {
      _close();
      return;
    }
    setState(() {
      _saving = false;
      _error = answer.error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final busy = _saving || widget.actions.busy;
    return AlertDialog(
      title: Text(
        'Rename your Buddy',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('swarm-buddy-name'),
            controller: _name,
            autofocus: true,
            enabled: !busy,
            maxLength: _maxLength,
            textInputAction: TextInputAction.done,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              hintText: swarmBuddyDefaultName(widget.actions.reader),
              hintStyle: TextStyle(color: AppPalette.textFaint),
              counterText: '',
              filled: true,
              fillColor: AppPalette.swarmField,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppControl.radius),
                borderSide: BorderSide.none,
              ),
            ),
            onSubmitted: (_) => unawaited(_save()),
          ),
          if (_error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.s),
              child: Text(
                error,
                key: const ValueKey('swarm-buddy-name-error'),
                style: AppType.caption(color: AppColors.danger),
              ),
            ),
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-buddy-name-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: busy ? null : _close,
        ),
        SwarmButton(
          key: const ValueKey('swarm-buddy-name-save'),
          label: 'Save',
          style: SwarmButtonStyle.fill,
          busy: busy,
          busyLabel: 'Saving…',
          onPressed: busy ? null : () => unawaited(_save()),
        ),
      ],
    );
  }
}
