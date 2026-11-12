import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_style.dart';
import 'swarm_team.dart' show swarmAgentIsMine;

/// The agent whose own chat [chatId] is, when the reader may rename it from
/// there, as Desktop's agent chat offers it (`view.dart` `_agentTitle` and
/// `_options`): their own agent, in a Swarm they may write in. The backend
/// lets its machine's owner rename it too, but only its person reads its
/// chat. Null for any other chat, or once the Swarm can no longer be read.
SuperTabAgent? swarmAgentToRename(SwarmReader reader, String chatId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked ||
      snapshot == null ||
      snapshot.isProjectLead(chatId) ||
      !swarmCanWrite(reader)) {
    return null;
  }
  final agent = snapshot.agents.where((a) => a.chatId == chatId).firstOrNull;
  return agent != null && swarmAgentIsMine(agent, reader.accountId)
      ? agent
      : null;
}

/// Renames agent [agentId] to [name], trimmed, for everyone in the Swarm
/// (backend `agent.rename`, Desktop's `renameAgent`); null once the server
/// kept it and the Swarm is read again, else the sentence to show. The
/// server says what is wrong with a name: taken, too long, an engine's.
Future<String?> swarmRenameAgent(
  SwarmReader reader,
  String agentId,
  String name,
) async {
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'agent.rename',
          'agentId': agentId,
          'name': name.trim(),
        },
      },
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return 'Could not reach this Swarm. Try again.';
  }
  await reader.refresh();
  return null;
}

/// Renames the agent of its own chat [chatId] in a dialog: its name to edit,
/// Save, and the server's refusal under the field. Nothing when the reader
/// may not ([swarmAgentToRename]); it goes once they no longer may.
Future<void> showSwarmRenameAgent(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) async {
  if (!context.mounted || swarmAgentToRename(reader, chatId) == null) return;
  await showDialog<void>(
    context: context,
    builder: (_) => SwarmRenameAgentDialog(reader: reader, chatId: chatId),
  );
}

/// What [showSwarmRenameAgent] shows: Desktop's Rename agent, in the phone's
/// rename dialog.
class SwarmRenameAgentDialog extends StatefulWidget {
  const SwarmRenameAgentDialog({
    super.key,
    required this.reader,
    required this.chatId,
  });

  final SwarmReader reader;
  final String chatId;

  @override
  State<SwarmRenameAgentDialog> createState() => _SwarmRenameAgentDialogState();
}

class _SwarmRenameAgentDialogState extends State<SwarmRenameAgentDialog> {
  /// The backend's limit (agentRename.ts `AGENT_NAME_LENGTH`).
  static const _maxLength = 60;

  /// The name it opens with, wholly selected as Desktop's is: the first key
  /// replaces it.
  late final String _before = switch (swarmAgentToRename(
    widget.reader,
    widget.chatId,
  )) {
    final agent? => widget.reader.snapshot!.agentName(
      agent.id,
      fallback: agent.name,
    ),
    null => '',
  };
  late final _name = TextEditingController(text: _before)
    ..selection = TextSelection(baseOffset: 0, extentOffset: _before.length);
  bool _saving = false, _closed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    _name.dispose();
    super.dispose();
  }

  /// Closes once the agent is no longer the reader's to rename here: access
  /// lost, the agent gone, no longer allowed to write.
  void _moved() {
    if (_closed ||
        !mounted ||
        swarmAgentToRename(widget.reader, widget.chatId) != null) {
      return;
    }
    _closed = true;
    // Not while the reader tells its listeners: once this frame is done.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  void _close() {
    if (_closed || !mounted) return;
    _closed = true;
    Navigator.of(context).pop();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (_saving || _closed || name.isEmpty) return;
    final agent = swarmAgentToRename(widget.reader, widget.chatId);
    // Its name already: nothing to send.
    if (agent == null || name == _before) {
      _close();
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final error = await swarmRenameAgent(widget.reader, agent.id, name);
    // Closed meanwhile (access lost, the agent gone): the answer is for
    // nobody.
    if (!mounted || _closed) return;
    if (error == null) {
      _close();
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
    final empty = _name.text.trim().isEmpty;
    return AlertDialog(
      title: Text(
        'Rename agent',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('swarm-agent-name-field'),
            controller: _name,
            autofocus: true,
            enabled: !_saving,
            maxLength: _maxLength,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.done,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              // Named for a screen reader as well as seen, as Desktop's
              // Agent name is.
              labelText: 'Agent name',
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
                key: const ValueKey('swarm-agent-name-error'),
                style: AppType.caption(color: AppColors.danger),
              ),
            ),
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-agent-name-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: _saving ? null : _close,
        ),
        SwarmButton(
          key: const ValueKey('swarm-agent-name-save'),
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
