import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'instructions_link.dart';
import 'model.dart';

/// An agent's own instructions (Swarm v4, anh Dee 2026-11-09): the plain file `agents/NAME.md` in its folder, which the agent
/// writes when its person tells it a rule and reads at every start. Its person reads and changes it here, from any of their
/// computers: the file stays on the computer the agent runs on, and [SwarmInstructionsLink] asks that computer over the
/// encrypted link between them, so it goes through neither GitHub nor the server.
class SwarmAgentInstructions extends StatefulWidget {
  const SwarmAgentInstructions({
    super.key,
    required this.agent,
    required this.machineName,
    required this.onClose,
    this.link,
  });

  final SuperTabAgent agent;

  /// The name of the computer the agent runs on.
  final String machineName;
  final VoidCallback onClose;

  /// How to ask that computer for the file; null where this app has no link to any computer.
  final SwarmInstructionsLink? link;

  /// What its person calls it: the name its file is written under, as it is told "You are `name`.".
  String get name => agent.displayName ?? agent.name;

  @override
  State<SwarmAgentInstructions> createState() => _SwarmAgentInstructionsState();
}

class _SwarmAgentInstructionsState extends State<SwarmAgentInstructions> {
  final _draft = TextEditingController();

  /// What the computer last said the file is; null while it is read, or when it could not be.
  SwarmInstructionsFile? _file;

  /// Why the file could not be read, in words.
  String? _readError;
  bool _editing = false;
  bool _saving = false;

  /// Why the last save was refused, in words.
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _draft.addListener(() => setState(() {}));
    _read();
  }

  @override
  void didUpdateWidget(SwarmAgentInstructions old) {
    super.didUpdateWidget(old);
    if (old.agent.id != widget.agent.id || old.name != widget.name) {
      _file = null;
      _readError = null;
      _editing = false;
      _saveError = null;
      _read();
    }
  }

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  Future<void> _read() async {
    final link = widget.link;
    if (link == null) return;
    final agent = widget.agent;
    setState(() => _readError = null);
    try {
      final file = await link.read(agent);
      if (!mounted || agent.id != widget.agent.id) return;
      setState(() => _file = file);
    } on SwarmInstructionsError catch (error) {
      if (!mounted || agent.id != widget.agent.id) return;
      setState(() => _readError = _words(error.code, saving: false));
    }
  }

  Future<void> _save() async {
    final link = widget.link, file = _file;
    if (link == null || file == null || _saving) return;
    final agent = widget.agent, text = _draft.text;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final saved = await link.write(agent, text, file.version);
      if (!mounted || agent.id != widget.agent.id) return;
      setState(() {
        _file = saved;
        _editing = false;
      });
    } on SwarmInstructionsError catch (error) {
      if (!mounted || agent.id != widget.agent.id) return;
      // A save whose answer was lost, made again, is refused as changed: it changed to what was typed.
      if (error.code == 'CHANGED' && await _isSaved(link, agent, text)) return;
      if (!mounted) return;
      setState(() => _saveError = _words(error.code, saving: true));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Whether the computer now holds [text] as the file: the save went through though its answer was lost.
  Future<bool> _isSaved(
    SwarmInstructionsLink link,
    SuperTabAgent agent,
    String text,
  ) async {
    try {
      final now = await link.read(agent);
      if (!mounted || agent.id != widget.agent.id || now.text != text) {
        return false;
      }
      setState(() {
        _file = now;
        _editing = false;
      });
      return true;
    } on SwarmInstructionsError {
      return false;
    }
  }

  void _edit() {
    _draft.text = _file?.text ?? '';
    setState(() {
      _editing = true;
      _saveError = null;
    });
  }

  /// What a failure says, in a few words, by the computer's own code.
  String _words(String code, {required bool saving}) {
    final machine = widget.machineName, name = widget.name;
    return switch (code) {
      'UNSUPPORTED' => 'Update Harness on $machine.',
      'UPDATE_HERE' => 'Update Harness on this computer.',
      'UNSAFE_PATH' => 'agents/$name.md on $machine isn\'t a plain file.',
      'NOT_UTF8' => 'agents/$name.md on $machine isn\'t text.',
      'AGENT_NOT_FOUND' => '$name isn\'t running on $machine.',
      'OFFLINE' => '$machine is offline.',
      'TIMEOUT' => '$machine didn\'t answer. Try again.',
      'CHANGED' => 'It changed on $machine. Close it and open it again.',
      'TOO_LARGE' =>
        saving
            ? 'Too long to save. Keep it under 64 KB.'
            : 'Too long to open here.',
      'BAD_NAME' => '"$name" can\'t be a file name.',
      _ =>
        saving
            ? 'Couldn\'t save it. Try again.'
            : 'Couldn\'t read it. Try again.',
    };
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final name = widget.name, file = _file;
    final empty = file != null && (file.text ?? '').trim().isEmpty;
    return ColoredBox(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(
              horizontal: SwarmLayout.barSide,
            ),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    'agents/$name.md',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(medium: true),
                  ),
                ),
                const Spacer(),
                if (_editing) ...[
                  DesktopPill(
                    key: const ValueKey('swarm-instructions-cancel'),
                    label: 'Cancel',
                    compact: true,
                    quiet: true,
                    onPressed: _saving
                        ? null
                        : () => setState(() => _editing = false),
                  ),
                  const SizedBox(width: 6),
                  DesktopPill(
                    key: const ValueKey('swarm-instructions-save'),
                    label: 'Save',
                    compact: true,
                    onPressed: _saving || _draft.text == (file?.text ?? '')
                        ? null
                        : _save,
                  ),
                ] else if (file != null)
                  DesktopPill(
                    key: const ValueKey('swarm-instructions-edit'),
                    label: 'Edit',
                    compact: true,
                    onPressed: _edit,
                  ),
                const SizedBox(width: 4),
                AppIconButton(
                  key: const ValueKey('swarm-instructions-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Expanded(
            child: widget.link == null
                ? _note('Open it on ${widget.machineName}.')
                : _readError != null
                ? Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _note(_readError!, key: 'swarm-instructions-error'),
                      AppIconButton(
                        key: const ValueKey('swarm-instructions-retry'),
                        icon: AppIcons.refreshCw,
                        tooltip: 'Try again',
                        onPressed: _read,
                      ),
                    ],
                  )
                : file == null
                ? const SizedBox.shrink()
                : _editing
                ? _editor()
                : empty
                ? _note(
                    'No instructions yet. Tell $name how you want it to '
                    'work, and it writes them here.',
                  )
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
                    child: SelectableText(
                      file.text!,
                      key: const ValueKey('swarm-instructions-text'),
                      style: grid.AppType.mono(color: DesktopChrome.foreground),
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _editor() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (_saveError != null)
        _note(_saveError!, key: 'swarm-instructions-save-error'),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
          child: TextField(
            key: const ValueKey('swarm-instructions-field'),
            controller: _draft,
            autofocus: true,
            maxLines: null,
            expands: true,
            textAlignVertical: TextAlignVertical.top,
            keyboardType: TextInputType.multiline,
            inputFormatters: [LengthLimitingTextInputFormatter(65536)],
            style: grid.AppType.mono(color: DesktopChrome.foreground),
            decoration: const InputDecoration.collapsed(hintText: ''),
          ),
        ),
      ),
    ],
  );

  Widget _note(String text, {String? key}) => Padding(
    padding: const EdgeInsets.all(SwarmLayout.barSide),
    child: Text(
      text,
      key: key == null ? null : ValueKey(key),
      style: DesktopChrome.metadata(),
    ),
  );
}
