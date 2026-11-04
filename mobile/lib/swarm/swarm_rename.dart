import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_inbox.dart';
import 'swarm_style.dart';

/// The longest name a Swarm takes here: the desktop's Rename Tab's
/// (`swarm_dialogs.dart` `showSwarmRenameDialog`). The server takes 160.
const swarmNameMaxLength = 80;

/// What is wrong with [name] as a Swarm's name, in the desktop's words
/// (`TerminalNamePrompt`); null when nothing is.
String? swarmNameProblem(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty) return 'Name cannot be empty';
  if (trimmed.characters.length > swarmNameMaxLength) {
    return 'Use at most $swarmNameMaxLength characters.';
  }
  return null;
}

/// Whether the person may rename Swarm [swarmId]: it is listed, read, and
/// theirs to write in, as the server allows (backend `tab.rename`: every
/// writable person; never a viewer).
bool swarmMayRename(SwarmInbox inbox, String swarmId) {
  final reader = inbox.reader(swarmId);
  return reader != null &&
      !reader.accessRevoked &&
      inbox.swarms.any((swarm) => swarm.id == swarmId) &&
      swarmCanWrite(reader);
}

/// Whether Swarm [swarmId] has a menu for the person ([showSwarmMenu]):
/// something in it they may do. Each item of the menu adds its own check
/// here and its row in [_swarmMenuActions].
bool swarmHasMenu(SwarmInbox inbox, String swarmId) =>
    swarmMayRename(inbox, swarmId);

/// The rows of Swarm [swarmId]'s menu, each where the person may.
List<PhoneSheetAction> _swarmMenuActions(
  BuildContext context,
  SwarmInbox inbox,
  String swarmId,
) => [
  if (swarmMayRename(inbox, swarmId))
    PhoneSheetAction(
      icon: LucideIcons.pencil300,
      label: 'Rename Swarm',
      onTap: () => unawaited(showSwarmRename(context, inbox, swarmId)),
    ),
];

/// Swarm [swarmId]'s menu, from its row's ⋮ in the switcher, or by holding
/// the row: the desktop's menu on a Swarm's tab, as a chat's ⋮ opens its.
/// Rename Swarm, for someone who may write there. It goes once nothing in
/// it is the person's to do ([swarmHasMenu]): access lost, the Swarm gone.
Future<void> showSwarmMenu(
  BuildContext context,
  SwarmInbox inbox,
  String swarmId,
) async {
  final name = inbox.swarms
      .where((swarm) => swarm.id == swarmId)
      .firstOrNull
      ?.name;
  if (name == null || !swarmHasMenu(inbox, swarmId)) return;
  Route<void>? sheet;
  void moved() {
    final route = sheet;
    if (route == null || swarmHasMenu(inbox, swarmId)) return;
    sheet = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (route.isActive) route.navigator?.removeRoute(route);
    });
  }

  inbox.addListener(moved);
  try {
    await showPhoneSheet(
      context,
      title: name,
      onShown: (route) => sheet = route,
      actions: _swarmMenuActions(context, inbox, swarmId),
    );
  } finally {
    inbox.removeListener(moved);
  }
}

/// Renames Swarm [swarmId] in a dialog: its name to edit, then Save. The new
/// name shows at once and the dialog closes; the server's refusal brings
/// the old name back and says why at the foot of the screen. It goes once
/// the Swarm can no longer be renamed — access lost, or gone.
Future<void> showSwarmRename(
  BuildContext context,
  SwarmInbox inbox,
  String swarmId,
) async {
  if (!context.mounted || !swarmMayRename(inbox, swarmId)) return;
  await showDialog<void>(
    context: context,
    builder: (_) => SwarmRenameDialog(inbox: inbox, swarmId: swarmId),
  );
}

/// What [showSwarmRename] shows.
class SwarmRenameDialog extends StatefulWidget {
  const SwarmRenameDialog({
    super.key,
    required this.inbox,
    required this.swarmId,
  });

  final SwarmInbox inbox;
  final String swarmId;

  @override
  State<SwarmRenameDialog> createState() => _SwarmRenameDialogState();
}

class _SwarmRenameDialogState extends State<SwarmRenameDialog> {
  /// Opens with the whole name selected, as the desktop's does: the first
  /// key replaces it.
  late final _name = () {
    final name =
        widget.inbox.swarms
            .where((swarm) => swarm.id == widget.swarmId)
            .firstOrNull
            ?.name ??
        '';
    return TextEditingController(text: name)
      ..selection = TextSelection(baseOffset: 0, extentOffset: name.length);
  }();
  bool _closed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.inbox.addListener(_moved);
  }

  @override
  void dispose() {
    widget.inbox.removeListener(_moved);
    _name.dispose();
    super.dispose();
  }

  void _moved() {
    if (_closed || !mounted || swarmMayRename(widget.inbox, widget.swarmId)) {
      return;
    }
    _closed = true;
    // Not while the inbox tells its listeners: once this frame is done.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  void _close() {
    if (_closed) return;
    _closed = true;
    Navigator.of(context).pop();
  }

  void _save() {
    if (_closed) return;
    if (swarmNameProblem(_name.text) case final problem?) {
      setState(() => _error = problem);
      return;
    }
    final inbox = widget.inbox, swarmId = widget.swarmId;
    // The screen under the dialog says a refusal, once it has closed.
    final messenger = ScaffoldMessenger.maybeOf(context);
    final name = _name.text;
    _close();
    unawaited(() async {
      final error = await inbox.rename(swarmId, name);
      if (error == null || messenger == null || !messenger.mounted) return;
      messenger.showSnackBar(
        SnackBar(
          key: const ValueKey('swarm-rename-failed'),
          content: Text(error),
        ),
      );
    }());
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final empty = _name.text.trim().isEmpty;
    return AlertDialog(
      title: Text(
        'Rename Swarm',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('swarm-rename-name'),
            controller: _name,
            autofocus: true,
            maxLength: swarmNameMaxLength,
            textInputAction: TextInputAction.done,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              // Named for a screen reader as well as seen, as the
              // desktop's Tab name is.
              labelText: 'Swarm name',
              counterText: '',
              filled: true,
              fillColor: AppPalette.swarmField,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppControl.radius),
                borderSide: BorderSide.none,
              ),
            ),
            onChanged: (_) => setState(() => _error = null),
            onSubmitted: (_) => _save(),
          ),
          if (_error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.s),
              child: Text(
                error,
                key: const ValueKey('swarm-rename-error'),
                style: AppType.caption(color: AppColors.danger),
              ),
            ),
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-rename-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: _close,
        ),
        SwarmButton(
          key: const ValueKey('swarm-rename-save'),
          label: 'Save',
          style: SwarmButtonStyle.fill,
          onPressed: empty ? null : _save,
        ),
      ],
    );
  }
}
