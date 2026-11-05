import 'package:flutter/material.dart';

import '../core/runtime_platform.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';

/// The same informed choice for link joins, invitations and discovered joins.
class SwarmJoinAccountChoice extends StatelessWidget {
  const SwarmJoinAccountChoice({
    super.key,
    required this.ownAccount,
    required this.onChanged,
    this.operatingSystem,
  });

  final bool ownAccount;
  final ValueChanged<bool>? onChanged;
  final String? operatingSystem;

  @override
  Widget build(BuildContext context) {
    final system = operatingSystem ?? RuntimePlatform.operatingSystem;
    final here = system == 'macos' ? 'this Mac' : 'this computer';
    final permission = system == 'windows'
        ? 'One-time setup asks for Windows administrator permission.'
        : 'One-time setup asks for your ${system == 'macos' ? 'Mac' : 'computer'} password.';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          "Where should teammates' agents run on $here?",
          style: DesktopChrome.text(),
        ),
        const SizedBox(height: 8),
        RadioGroup<bool>(
          groupValue: ownAccount,
          onChanged: (value) {
            if (value != null) onChanged?.call(value);
          },
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              RadioListTile<bool>(
                value: false,
                enabled: onChanged != null,
                contentPadding: EdgeInsets.zero,
                title: Text(
                  'Separate Harness Team account',
                  style: DesktopChrome.text(),
                ),
                subtitle: Text(
                  "Teammates' agents cannot read your files or use your personal sign-ins. "
                  "Uses $here's Claude Code and Codex subscriptions. $permission",
                  style: DesktopChrome.metadata(),
                ),
              ),
              RadioListTile<bool>(
                value: true,
                enabled: onChanged != null,
                contentPadding: EdgeInsets.zero,
                title: Text('My account', style: DesktopChrome.text()),
                subtitle: Text(
                  "No Team setup. Teammates' agents in this Swarm run as you and can access "
                  'your files, tools, keychain and signed-in apps. Your other Swarms keep their own choice.',
                  style: DesktopChrome.metadata(),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Text(
          "You can change this later in this machine's settings.",
          style: DesktopChrome.metadata(),
        ),
      ],
    );
  }
}

/// Joins without a link dialog (invitation acceptance or discovery) still ask
/// before preparing this computer or asking for administrator permission.
class SwarmJoinAccountDialog extends StatefulWidget {
  const SwarmJoinAccountDialog({super.key, required this.swarmName});
  final String swarmName;

  @override
  State<SwarmJoinAccountDialog> createState() => _SwarmJoinAccountDialogState();
}

class _SwarmJoinAccountDialogState extends State<SwarmJoinAccountDialog> {
  bool _ownAccount = false;

  @override
  Widget build(BuildContext context) => DesktopPromptSurface(
    body: DesktopPromptScrollBody(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopDialogHeader(
            title: 'Join Swarm',
            padding: EdgeInsets.zero,
            onClose: () => Navigator.pop(context),
          ),
          const SizedBox(height: 16),
          Text(widget.swarmName, style: DesktopChrome.heading()),
          const SizedBox(height: 12),
          SwarmJoinAccountChoice(
            ownAccount: _ownAccount,
            onChanged: (value) => setState(() => _ownAccount = value),
          ),
        ],
      ),
    ),
    actions: [
      FilledButton(
        key: const Key('swarm-join-account-continue'),
        onPressed: () => Navigator.pop(context, _ownAccount),
        child: const Text('Continue'),
      ),
    ],
  );
}
