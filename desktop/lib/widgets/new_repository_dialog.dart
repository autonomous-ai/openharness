import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../super_tabs/new_repository.dart';
import 'desktop_chrome.dart';

/// New Project's New Repository prompt (task #3374; design
/// docs/plans/2026-11-05-new-repository-design.md, Desktop mockups): an
/// organization the Swarm uses, a name with its github.com path under it, and
/// Private on. Gives the ask, or null when the person cancels.
Future<NewRepositoryAsk?> showNewRepositoryDialog(
  BuildContext context, {
  required List<String> owners,
  required Future<NewRepositoryOwnerCheck> Function(String owner) check,
  NewRepositoryAsk? initial,
}) => showAppDialog<NewRepositoryAsk>(
  context: context,
  builder: (context) => Dialog(
    key: const ValueKey('new-repository-dialog'),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 480),
      child: NewRepositoryPrompt(
        owners: owners,
        check: check,
        initial: initial,
        onDone: (ask) => Navigator.of(context).pop(ask),
      ),
    ),
  ),
);

class NewRepositoryPrompt extends StatefulWidget {
  const NewRepositoryPrompt({
    super.key,
    required this.owners,
    required this.check,
    required this.onDone,
    this.initial,
  });
  final List<String> owners;
  final Future<NewRepositoryOwnerCheck> Function(String owner) check;
  final ValueChanged<NewRepositoryAsk?> onDone;
  final NewRepositoryAsk? initial;

  @override
  State<NewRepositoryPrompt> createState() => _NewRepositoryPromptState();
}

class _NewRepositoryPromptState extends State<NewRepositoryPrompt> {
  late final _owner = TextEditingController(
    text: widget.initial?.owner ?? widget.owners.firstOrNull ?? '',
  );
  late final _name = TextEditingController(text: widget.initial?.name ?? '');
  late bool _private = widget.initial?.private ?? true;
  final _ownerFocus = FocusNode();

  /// The last organization check, and the owner it was asked for.
  NewRepositoryOwnerCheck? _checked;
  String? _asking;
  bool _unanswered = false;

  String get _ownerText => _owner.text.trim();
  String get _nameText => _name.text.trim();

  @override
  void initState() {
    super.initState();
    // One check per organization chosen, not per key: the server allows a
    // person 30 a minute.
    _ownerFocus.addListener(() {
      if (!_ownerFocus.hasFocus) _checkOwner();
    });
    if (_ownerText.isNotEmpty) _checkOwner();
  }

  @override
  void dispose() {
    _owner.dispose();
    _name.dispose();
    _ownerFocus.dispose();
    super.dispose();
  }

  Future<void> _checkOwner() async {
    final owner = _ownerText;
    if (!newRepositoryOwnerPattern.hasMatch(owner) ||
        _checked?.owner == owner ||
        _asking == owner) {
      return;
    }
    setState(() {
      _asking = owner;
      _unanswered = false;
    });
    try {
      final answer = await widget.check(owner);
      if (!mounted || _asking != owner) return;
      setState(() {
        _checked = answer;
        _asking = null;
      });
    } catch (_) {
      if (!mounted || _asking != owner) return;
      setState(() {
        _asking = null;
        _unanswered = true;
      });
    }
  }

  void _chooseOwner(String owner) {
    _owner.text = owner;
    setState(() {});
    _checkOwner();
  }

  NewRepositoryOwnerCheck? get _ownerCheck =>
      _checked?.owner == _ownerText ? _checked : null;

  /// The one line that says what stops it, or null.
  String? get _problem {
    if (newRepositoryNameProblem(_nameText) case final problem?) return problem;
    if (_ownerText.isNotEmpty &&
        !newRepositoryOwnerPattern.hasMatch(_ownerText)) {
      return 'Use letters, numbers and - for the organization.';
    }
    if (_unanswered) {
      return 'Couldn’t check $_ownerText on GitHub. Choose it again.';
    }
    return _ownerCheck?.problem;
  }

  bool get _usable =>
      newRepositoryNameUsable(_nameText) &&
      _ownerCheck?.state == 'ready' &&
      _asking == null;

  void _use() {
    if (!_usable) return;
    widget.onDone(
      NewRepositoryAsk(owner: _ownerText, name: _nameText, private: _private),
    );
  }

  Future<void> _copyMessage() async {
    final check = _ownerCheck;
    if (check == null) return;
    await Clipboard.setData(
      ClipboardData(
        text: newRepositoryOwnerMessage(
          check.owner,
          installUrl: check.installUrl,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final check = _ownerCheck;
    final problem = _problem;
    final label = DesktopChrome.control(medium: true);
    final muted = DesktopChrome.text(size: 12, color: DesktopChrome.muted);
    // Scrolls rather than clipping F4's buttons in a short window.
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopDialogHeader(
            title: 'New repository',
            onClose: () => widget.onDone(null),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Owner', style: label),
                const SizedBox(height: 4),
                TextField(
                  key: const ValueKey('new-repository-owner'),
                  controller: _owner,
                  focusNode: _ownerFocus,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                  onChanged: (_) => setState(() => _unanswered = false),
                  onSubmitted: (_) => _checkOwner(),
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: 'organization',
                    suffixIcon: widget.owners.length < 2
                        ? null
                        : PopupMenuButton<String>(
                            key: const ValueKey('new-repository-owners'),
                            tooltip: 'The Swarm’s organizations',
                            icon: const Icon(AppIcons.chevronDown, size: 16),
                            onSelected: _chooseOwner,
                            itemBuilder: (_) => [
                              for (final owner in widget.owners)
                                PopupMenuItem(value: owner, child: Text(owner)),
                            ],
                          ),
                  ),
                ),
                const SizedBox(height: 16),
                Text('Name', style: label),
                const SizedBox(height: 4),
                TextField(
                  key: const ValueKey('new-repository-name'),
                  controller: _name,
                  autofocus: true,
                  autocorrect: false,
                  onChanged: (_) => setState(() {}),
                  onSubmitted: (_) => _use(),
                  decoration: const InputDecoration(
                    isDense: true,
                    hintText: 'notes-app',
                  ),
                ),
                if (_nameText.isNotEmpty && _ownerText.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    'github.com/$_ownerText/$_nameText',
                    key: const ValueKey('new-repository-path'),
                    style: muted,
                  ),
                ],
                const SizedBox(height: 12),
                Row(
                  key: const ValueKey('new-repository-private'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: _private,
                      onChanged: (value) =>
                          setState(() => _private = value ?? true),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Private', style: label),
                            Text(
                              'Only people with access on GitHub see it',
                              style: muted,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                if (problem != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    problem,
                    key: const ValueKey('new-repository-problem'),
                    style: DesktopChrome.text(
                      size: 13,
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                  if (newRepositoryNameProblem(_nameText) == null &&
                      (check?.state == 'not-installed' ||
                          check?.state == 'not-accepted')) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      children: [
                        if (check?.installUrl case final url?)
                          OutlinedButton(
                            key: const ValueKey('new-repository-install'),
                            onPressed: () => launchUrl(
                              Uri.parse(url),
                              mode: LaunchMode.externalApplication,
                            ),
                            child: const Text('Install on GitHub'),
                          ),
                        OutlinedButton(
                          key: const ValueKey('new-repository-copy'),
                          onPressed: _copyMessage,
                          child: const Text('Copy message'),
                        ),
                      ],
                    ),
                  ],
                ] else if (_asking != null) ...[
                  const SizedBox(height: 12),
                  Text('Checking $_asking on GitHub…', style: muted),
                ],
                const SizedBox(height: 16),
                Text(
                  'GitHub asks you to confirm, then Harness creates it with you '
                  'as its admin.',
                  style: muted,
                ),
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => widget.onDone(null),
                      child: const Text('Cancel'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      key: const ValueKey('new-repository-use'),
                      onPressed: _usable ? _use : null,
                      child: const Text('Use this name'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
