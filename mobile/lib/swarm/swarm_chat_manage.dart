import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_buddy.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_style.dart';

/// What the reader may do to chat [chatId] from its ⋮, as the desktop's chat
/// menu offers it (`view.dart` `_options`): Rename and Archive in an ordinary
/// project chat, for someone who may write; never in a project's own chat
/// or a Buddy chat. Archive waits while the chat's task still runs; an
/// archived chat offers Reopen alone, since the server changes nothing else
/// of one (`ARCHIVED`). Null when there is nothing to offer, or the chat can
/// no longer be read.
({bool archived, bool archiveOn})? swarmChatManage(
  SwarmReader reader,
  String chatId,
) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return null;
  final chat = snapshot.conversation(chatId);
  if (chat == null ||
      snapshot.isProjectLead(chatId) ||
      chat.isBuddyChat ||
      reader.buddies.chatOwners.containsKey(chatId) ||
      !swarmCanWrite(reader)) {
    return null;
  }
  final status = chat.assignment?['status'];
  return (
    archived: chat.archived,
    archiveOn:
        chat.archived ||
        chat.assignment == null ||
        const {'done', 'stopped', 'cancelled'}.contains(status),
  );
}

/// The ⋮ sheet's rows for chat [chatId] ([swarmChatManage]): Rename and
/// Archive, or Reopen. Each runs once the sheet has closed.
List<PhoneSheetAction> swarmChatManageActions(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) {
  final manage = swarmChatManage(reader, chatId);
  if (manage == null) return const [];
  return [
    if (!manage.archived)
      PhoneSheetAction(
        icon: LucideIcons.pencil300,
        label: 'Rename',
        onTap: () => unawaited(showSwarmRenameChat(context, reader, chatId)),
      ),
    PhoneSheetAction(
      icon: manage.archived
          ? LucideIcons.archiveRestore300
          : LucideIcons.archive300,
      label: manage.archived ? 'Reopen' : 'Archive',
      enabled: manage.archiveOn,
      onTap: () => unawaited(
        manage.archived
            ? _reopen(context, reader, chatId)
            : confirmSwarmArchiveChat(context, reader, chatId),
      ),
    ),
  ];
}

/// Renames chat [chatId] to [title], trimmed; null once the server kept it
/// and the Swarm is read again, else the sentence to show.
Future<String?> swarmRenameChat(
  SwarmReader reader,
  String chatId,
  String title,
) => _send(reader, chatId, {
  'type': 'conversation.rename',
  'conversationId': chatId,
  'title': title.trim(),
});

/// Archives chat [chatId], or reopens it when [archived] is false; null once
/// the server kept it and the Swarm is read again, else the sentence to show.
Future<String?> swarmArchiveChat(
  SwarmReader reader,
  String chatId, {
  required bool archived,
}) => _send(reader, chatId, {
  'type': 'conversation.archive',
  'conversationId': chatId,
  'archived': archived,
});

Future<String?> _send(
  SwarmReader reader,
  String chatId,
  Map<String, dynamic> command,
) async {
  if (swarmChatManage(reader, chatId) == null) return _notAllowed;
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return _notSent;
  }
  await reader.refresh();
  return null;
}

const _notAllowed = 'You can’t change this chat.';
const _notSent = 'Could not reach this Swarm. Try again.';

/// Says [error] at the foot of the screen, unless the screen is gone or
/// the Swarm can no longer be read.
void _tell(BuildContext context, SwarmReader reader, String? error) {
  if (error == null || !context.mounted || reader.accessRevoked) return;
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
    SnackBar(
      key: const ValueKey('swarm-chat-manage-failed'),
      content: Text(error),
    ),
  );
}

Future<void> _reopen(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) async {
  final error = await swarmArchiveChat(reader, chatId, archived: false);
  if (context.mounted) _tell(context, reader, error);
}

/// Asks before archiving chat [chatId] (Tony's list; the desktop archives at
/// once), then archives it: it leaves the lists for "Older". Nothing when
/// they cancel, or when the chat could no longer be archived meanwhile.
Future<void> confirmSwarmArchiveChat(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) async {
  if (!context.mounted) return;
  final title = reader.snapshot?.conversation(chatId)?.title ?? '';
  final archive = await showDialog<bool>(
    context: context,
    builder: (_) => _GoesWithChat(
      reader: reader,
      chatId: chatId,
      child: Builder(
        builder: (context) => AlertDialog(
          title: Text(
            'Archive “$title”?',
            key: const ValueKey('swarm-archive-title'),
            style: AppType.heading(color: AppPalette.textPrimary),
          ),
          content: Text(
            'It leaves your chat lists. You can reopen it from Older.',
            style: AppType.body(color: AppPalette.textSecondary),
          ),
          actions: [
            SwarmButton(
              key: const ValueKey('swarm-archive-cancel'),
              label: 'Cancel',
              style: SwarmButtonStyle.link,
              onPressed: () => Navigator.of(context).pop(false),
            ),
            SwarmButton(
              key: const ValueKey('swarm-archive-confirm'),
              label: 'Archive',
              style: SwarmButtonStyle.fill,
              onPressed: () => Navigator.of(context).pop(true),
            ),
          ],
        ),
      ),
    ),
  );
  if (archive != true || !context.mounted) return;
  final error = await swarmArchiveChat(reader, chatId, archived: true);
  if (context.mounted) _tell(context, reader, error);
}

/// Renames chat [chatId] in a dialog: its title to edit, Save, and the
/// server's refusal under the field. It goes once the chat can no longer be
/// renamed — access lost, archived elsewhere, or gone.
Future<void> showSwarmRenameChat(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) async {
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (_) => _GoesWithChat(
      reader: reader,
      chatId: chatId,
      rename: true,
      child: SwarmRenameChatDialog(reader: reader, chatId: chatId),
    ),
  );
}

/// Closes the dialog it holds once chat [chatId] can no longer be changed
/// that way: access lost, the chat gone, or (for [rename]) archived.
class _GoesWithChat extends StatefulWidget {
  const _GoesWithChat({
    required this.reader,
    required this.chatId,
    required this.child,
    this.rename = false,
  });

  final SwarmReader reader;
  final String chatId;
  final bool rename;
  final Widget child;

  @override
  State<_GoesWithChat> createState() => _GoesWithChatState();
}

class _GoesWithChatState extends State<_GoesWithChat> {
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    super.dispose();
  }

  void _moved() {
    final manage = swarmChatManage(widget.reader, widget.chatId);
    final still = manage != null && !(widget.rename && manage.archived);
    if (still || _closed || !mounted) return;
    _closed = true;
    // Not while the reader tells its listeners: once this frame is done.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// What [showSwarmRenameChat] shows.
class SwarmRenameChatDialog extends StatefulWidget {
  const SwarmRenameChatDialog({
    super.key,
    required this.reader,
    required this.chatId,
  });

  final SwarmReader reader;
  final String chatId;

  @override
  State<SwarmRenameChatDialog> createState() => _SwarmRenameChatDialogState();
}

class _SwarmRenameChatDialogState extends State<SwarmRenameChatDialog> {
  /// The backend's limit (commands.ts `title`).
  static const _maxLength = 160;

  late final _title = TextEditingController(
    text: widget.reader.snapshot?.conversation(widget.chatId)?.title ?? '',
  );
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving || _title.text.trim().isEmpty) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final error = await swarmRenameChat(
      widget.reader,
      widget.chatId,
      _title.text,
    );
    // Closed meanwhile (access lost, the chat gone): the answer is for nobody.
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final empty = _title.text.trim().isEmpty;
    return AlertDialog(
      title: Text(
        'Rename chat',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('swarm-chat-title'),
            controller: _title,
            autofocus: true,
            enabled: !_saving,
            maxLength: _maxLength,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.done,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              counterText: '',
              filled: true,
              fillColor: AppPalette.swarmField,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppControl.radius),
                borderSide: BorderSide.none,
              ),
            ),
            onChanged: (_) => setState(() => _error = null),
            onSubmitted: (_) => unawaited(_save()),
          ),
          if (_error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.s),
              child: Text(
                error,
                key: const ValueKey('swarm-chat-title-error'),
                style: AppType.caption(color: AppColors.danger),
              ),
            ),
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-chat-title-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
        ),
        SwarmButton(
          key: const ValueKey('swarm-chat-title-save'),
          label: 'Save',
          style: SwarmButtonStyle.fill,
          busy: _saving,
          busyLabel: 'Saving…',
          onPressed: _saving || empty ? null : () => unawaited(_save()),
        ),
      ],
    );
  }
}
