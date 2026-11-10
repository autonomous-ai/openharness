import 'dart:convert';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'instructions_link.dart';
import 'model.dart';
import 'swarm_type.dart';

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

  /// What else instructs the agent in its folder, as the last read said (a refused read says it too): never from a save.
  var _shared = SwarmSharedInstructions.none;

  /// Why the file could not be read, in words.
  String? _readError;

  /// A read is out: Try again turns until it answers.
  bool _asking = false;
  bool _editing = false;
  bool _saving = false;

  /// Whether the draft differs from the file: Save waits for a change. Kept apart so a keystroke rebuilds only when it flips.
  bool _dirty = false;

  /// Which read is the latest: an older answer that comes after it is dropped.
  int _reading = 0;

  /// Why the last save was refused, in words.
  String? _saveError;

  /// The files of its folder opened to their text, by place: each starts folded, its name and size (anh Dee, 2026-11-10: a
  /// project's long AGENTS.md shown whole read as the agent's own instructions).
  final _open = <int>{};

  /// The most the computer takes: 64 KiB of UTF-8, as its answer `TOO_LARGE` says. Counted in bytes, not characters.
  static const _maxBytes = 65536;

  @override
  void initState() {
    super.initState();
    _draft.addListener(() {
      final dirty = _draft.text != (_file?.text ?? '');
      if (dirty != _dirty) setState(() => _dirty = dirty);
    });
    _read();
  }

  @override
  void didUpdateWidget(SwarmAgentInstructions old) {
    super.didUpdateWidget(old);
    if (old.agent.id != widget.agent.id || old.name != widget.name) {
      _file = null;
      _shared = SwarmSharedInstructions.none;
      _readError = null;
      _editing = false;
      _saving = false;
      _saveError = null;
      _dirty = false;
      _open.clear();
      _draft.clear();
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
    final agent = widget.agent, turn = ++_reading;
    // What shows stays while the read is out (the retry turns); the answer replaces it.
    setState(() => _asking = true);
    try {
      final read = await link.read(agent);
      if (!mounted || agent.id != widget.agent.id || turn != _reading) return;
      setState(() {
        _file = read.file;
        _shared = read.shared;
        _readError = null;
        _asking = false;
      });
    } on SwarmInstructionsError catch (error) {
      if (!mounted || agent.id != widget.agent.id || turn != _reading) return;
      setState(() {
        _readError = _words(error.code, saving: false);
        // A refusal that says nothing of the others (offline, a timeout) does not take back what was read of them.
        if (error.shared.files.isNotEmpty || error.shared.skipped.isNotEmpty) {
          _shared = error.shared;
        }
        _asking = false;
      });
    }
  }

  Future<void> _save() async {
    final link = widget.link, file = _file;
    if (link == null || file == null || _saving) return;
    final agent = widget.agent, text = _draft.text;
    // Counted here, not by the field: a field that stops typing at a limit drops a paste without a word.
    if (utf8.encode(text).length > _maxBytes) {
      setState(() => _saveError = _words('TOO_LARGE', saving: true));
      return;
    }
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
        _dirty = false;
      });
    } on SwarmInstructionsError catch (error) {
      if (!mounted || agent.id != widget.agent.id) return;
      if (error.code == 'CHANGED') {
        await _changed(link, agent, text);
      } else {
        setState(() => _saveError = _words(error.code, saving: true));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// The computer says the file is not the version this save read. It is read again: it may have changed to what was typed (a
  /// save whose answer was lost, made again), which is saved; else the new version is taken, and a second Save replaces it on
  /// purpose, the typed text kept.
  Future<void> _changed(
    SwarmInstructionsLink link,
    SuperTabAgent agent,
    String text,
  ) async {
    try {
      final read = await link.read(agent);
      if (!mounted || agent.id != widget.agent.id) return;
      final now = read.file;
      setState(() {
        _file = now;
        _shared = read.shared;
        if (now.text == text) {
          _editing = false;
          _dirty = false;
          _saveError = null;
        } else {
          _dirty = true;
          _saveError = _words('CHANGED', saving: true);
        }
      });
    } on SwarmInstructionsError catch (error) {
      if (!mounted) return;
      setState(() => _saveError = _words(error.code, saving: true));
    }
  }

  void _edit() {
    _draft.text = _file?.text ?? '';
    setState(() {
      _editing = true;
      _dirty = false;
      _saveError = null;
    });
  }

  /// What a failure says, in a few words, by the computer's own code.
  String _words(String code, {required bool saving}) {
    final machine = widget.machineName, name = widget.name;
    return switch (code) {
      'UNSUPPORTED' => 'Update Harness on $machine.',
      'UPDATE_HERE' || 'E2EE_REQUIRED' => 'Update Harness on this computer.',
      'NOT_READY' => 'This computer isn\'t ready. Try again.',
      'OWNER_REQUIRED' => 'Only $name\'s person can open this.',
      'SERVICE_UNAVAILABLE' => '$machine isn\'t ready. Try again.',
      'UNSAFE_PATH' => 'agents/$name.md on $machine isn\'t a plain file.',
      'NOT_UTF8' => 'agents/$name.md on $machine isn\'t text.',
      'AGENT_NOT_FOUND' => '$name isn\'t running on $machine.',
      'OFFLINE' => '$machine is offline.',
      'TIMEOUT' => '$machine didn\'t answer. Try again.',
      'CHANGED' => 'It changed on $machine. Save again to replace it.',
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
                // The title takes what the buttons leave, so they sit at the right edge.
                Expanded(
                  child: Text(
                    'agents/$name.md',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(medium: true),
                  ),
                ),
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
                    onPressed: _saving || !_dirty ? null : _save,
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
                  // Closing while a save is out would drop its answer: nobody would be told whether the file changed.
                  onPressed: _saving ? null : widget.onClose,
                ),
              ],
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  /// The agent's own file, then what else instructs it in its folder, one after the other. While the own file is typed, it
  /// has the pane to itself.
  Widget _body() {
    if (widget.link == null) {
      return _note('Open it on ${widget.machineName}.');
    }
    final file = _file, error = _readError, shared = _shared;
    if (_editing) return _editor();
    if (file == null && error == null) return const SizedBox.shrink();
    final own = (file?.text ?? '').trim().isNotEmpty;
    final blocks = <Widget>[
      if (error != null)
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _note(error, key: 'swarm-instructions-error'),
            Padding(
              // The glyph sits 8 points inside its 32-point target: it starts where the note's words do.
              padding: const EdgeInsets.symmetric(
                horizontal: SwarmLayout.barSide - 8,
              ),
              child: AppIconButton(
                key: const ValueKey('swarm-instructions-retry'),
                icon: AppIcons.refreshCw,
                tooltip: 'Try again',
                spinning: _asking,
                onPressed: _read,
              ),
            ),
          ],
        )
      else if (own)
        Padding(
          padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
          child: SelectableText(
            file!.text!,
            key: const ValueKey('swarm-instructions-text'),
            // At the terminal's size, as the panes beside it (anh Dee, 2026-11-10).
            style: grid.AppType.mono(color: DesktopChrome.foreground)
                .copyWith(fontSize: SwarmType.sizeOf(context)),
          ),
        )
      else
        _note(
          'Empty for now. Tell ${widget.name} how you want it to work, and it '
          'writes it down here.',
          key: 'swarm-instructions-empty',
        ),
      if (shared.files.isNotEmpty) _folder(shared.files),
    ];
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, block) in blocks.indexed) ...[
            if (i > 0)
              ColoredBox(
                color: DesktopChrome.rim,
                child: const SizedBox(height: 1),
              ),
            block,
          ],
          for (final (i, skip) in shared.skipped.indexed)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.panelPadding,
                0,
                grid.AppDesktop.panelPadding,
                grid.AppDesktop.controlGap,
              ),
              child: Text(
                _skippedWords(skip),
                key: ValueKey('swarm-skipped-$i'),
                style: DesktopChrome.metadata(),
              ),
            ),
        ],
      ),
    );
  }

  /// What else instructs the agent in its folder, read only, under its own heading so it never reads as the agent's own:
  /// each file folded to its name and size, a click away from its text.
  Widget _folder(List<SwarmSharedFile> files) => Padding(
    padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.controlGap),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
          ),
          child: Text(
            'From its folder',
            key: const ValueKey('swarm-shared-heading'),
            style: DesktopChrome.metadata(),
          ),
        ),
        for (final (i, one) in files.indexed) _sharedFile(i, one),
      ],
    ),
  );

  /// A file of the agent's folder: its name and size, its text below once opened, and a line when the computer cut it. One
  /// with the text of an earlier file ([SwarmSharedFile.sameAs]) says so in place of its size and has nothing to open.
  Widget _sharedFile(int index, SwarmSharedFile file) {
    final same = file.sameAs;
    final open = same == null && _open.contains(index);
    final lines = file.text.isEmpty ? 0 : '\n'.allMatches(file.text).length + 1;
    final row = Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.panelPadding,
        vertical: grid.AppDesktop.controlGap,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              file.name,
              key: ValueKey('swarm-shared-name-$index'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(medium: true),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Text(
            same != null
                ? 'Same as $same.'
                : lines == 1
                ? '1 line'
                : '$lines lines',
            key: ValueKey(
              same != null
                  ? 'swarm-shared-same-$index'
                  : 'swarm-shared-size-$index',
            ),
            style: DesktopChrome.metadata(),
          ),
          if (same == null) ...[
            const SizedBox(width: 4),
            Icon(
              open ? AppIcons.chevronDown : AppIcons.chevronRight,
              size: 14,
              color: DesktopChrome.muted,
            ),
          ],
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (same != null)
          row
        else
          InkWell(
            key: ValueKey('swarm-shared-row-$index'),
            onTap: () =>
                setState(() => open ? _open.remove(index) : _open.add(index)),
            child: Semantics(button: true, expanded: open, child: row),
          ),
        if (open)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.panelPadding,
              0,
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.controlGap,
            ),
            child: SelectableText(
              file.text,
              key: ValueKey('swarm-shared-text-$index'),
              // At the terminal's size, as the panes beside it (anh Dee, 2026-11-10).
              style: grid.AppType.mono(color: DesktopChrome.foreground)
                  .copyWith(fontSize: SwarmType.sizeOf(context)),
            ),
          ),
        if (open && file.truncated)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.panelPadding,
              0,
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.controlGap,
            ),
            child: Text(
              'Cut at 64 KB.',
              key: ValueKey('swarm-shared-cut-$index'),
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
    );
  }

  /// Why a file in the agent's folder is not shown, by the computer's own word for it.
  String _skippedWords(SwarmSkippedFile file) => switch (file.why) {
    'link' => '${file.name} is a link.',
    'not_text' => '${file.name} isn\'t text.',
    'unreadable' => '${file.name} can\'t be read.',
    'not_a_file' => '${file.name} isn\'t a file.',
    'too_much' => '${file.name} isn\'t shown: too much text.',
    _ => '${file.name} isn\'t shown.',
  };

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
            // At the terminal's size, as the panes beside it (anh Dee, 2026-11-10).
            style: grid.AppType.mono(color: DesktopChrome.foreground)
                .copyWith(fontSize: SwarmType.sizeOf(context)),
            // An empty file says what goes in it, rather than looking like a blank page.
            decoration: InputDecoration.collapsed(
              hintText:
                  'Rules for ${widget.name}, as you would tell it. It reads '
                  'them at every start.',
              hintStyle: grid.AppType.mono(color: DesktopChrome.muted)
                  .copyWith(fontSize: SwarmType.sizeOf(context)),
            ),
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
