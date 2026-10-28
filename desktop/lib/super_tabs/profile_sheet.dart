import 'package:clock/clock.dart';

import 'dart:async';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';
import 'profile_actions.dart';
import 'status_editor.dart';

/// Picks one picture from this computer, or null when the person cancels.
Future<Uint8List?> pickSuperTabPicture() async {
  final file = await openFile(
    acceptedTypeGroups: const [
      XTypeGroup(label: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp']),
    ],
  );
  return file?.readAsBytes();
}

/// The reader's own profile, or [agentId]'s avatar for its contributor or
/// Lead: a picture to pick or upload and, for the reader, a status.
Future<void> showSuperTabProfile(
  BuildContext context,
  SuperTabController controller, {
  String? agentId,
  Future<Uint8List?> Function() pickPicture = pickSuperTabPicture,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => _ProfileSheet(
    controller: controller,
    agentId: agentId,
    pickPicture: pickPicture,
  ),
);

class _ProfileSheet extends StatefulWidget {
  const _ProfileSheet({
    required this.controller,
    required this.agentId,
    required this.pickPicture,
  });
  final SuperTabController controller;
  final String? agentId;
  final Future<Uint8List?> Function() pickPicture;

  @override
  State<_ProfileSheet> createState() => _ProfileSheetState();
}

class _ProfileSheetState extends State<_ProfileSheet> {
  bool _busy = false;
  String? _error;

  SuperTabController get c => widget.controller;

  Future<void> _run(Future<String?> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await action();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  Future<void> _upload() async {
    final picked = await widget.pickPicture();
    if (picked == null) return;
    await _run(() => c.uploadAvatar(picked, agentId: widget.agentId));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final agent = widget.agentId == null
          ? null
          : c.snapshot?.agent(widget.agentId!);
      final person = c.snapshot?.people
          .where((p) => p.id == c.accountId)
          .firstOrNull;
      final avatar = agent != null
          ? SuperTabAvatar.agent(agent, size: 56)
          : person != null
          ? SuperTabAvatar.person(person, size: 56)
          : null;
      final current = agent?.avatar ?? (agent == null ? person?.avatar : null);
      return AlertDialog(
        title: Text(
          agent == null
              ? 'Your profile'
              : '${c.snapshot!.agentName(agent.id)}’s avatar',
        ),
        content: SizedBox(
          width: 380,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ?avatar,
                const SizedBox(height: 16),
                Text('Picture', style: DesktopChrome.control(medium: true)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final MapEntry(:key, :value)
                        in superTabAvatarPresets.entries)
                      IconButton(
                        key: ValueKey('super-avatar-preset-$key'),
                        tooltip: key,
                        isSelected:
                            current is SuperTabPresetAvatar &&
                            current.key == key,
                        onPressed: _busy
                            ? null
                            : () => _run(
                                () => c.setAvatar(
                                  SuperTabPresetAvatar(key),
                                  agentId: widget.agentId,
                                ),
                              ),
                        icon: Text(value, style: const TextStyle(fontSize: 22)),
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: _busy ? null : () => unawaited(_upload()),
                      child: const Text('Upload picture…'),
                    ),
                    if (current != null)
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => _run(
                                () =>
                                    c.setAvatar(null, agentId: widget.agentId),
                              ),
                        child: const Text('Use default'),
                      ),
                  ],
                ),
                if (agent == null && person != null) ...[
                  const SizedBox(height: 20),
                  SuperTabStatusEditor(
                    status: person.statusAt(clock.now()),
                    busy: _busy,
                    onSave: (status) => _run(() => c.setStatus(status)),
                  ),
                ],
                if (_error case final error?) ...[
                  const SizedBox(height: 12),
                  Text(
                    error,
                    style: DesktopChrome.control(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      );
    },
  );
}
