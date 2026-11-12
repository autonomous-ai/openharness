import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
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

  /// What else instructs the agent in its folder and on its computer, as the last read said (a refused read says it too):
  /// never from a save.
  var _shared = SwarmSharedInstructions.none;

  /// What Harness adds to its instructions at every start, as its computer last said; null when it says none.
  SwarmBasics? _harness;

  /// Whether a PM's role from Harness is opened to its text: folded, as the other files are.
  bool _roleOpen = false;

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

  /// The files opened to their text, by group and place (`swarm-shared-0`): each starts folded, its name and size (anh Dee,
  /// 2026-11-10: a project's long AGENTS.md shown whole read as the agent's own instructions).
  final _open = <String>{};

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
      _harness = null;
      _roleOpen = false;
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
    // Asked beside the read and shown when it comes, never an error: the rest does not wait for it, as a computer slow to answer
    // it held the agent's own file back (code review of #4047).
    unawaited(
      link.basics(agent).then((harness) {
        if (!mounted || agent.id != widget.agent.id || turn != _reading) return;
        setState(() => _harness = harness);
      }),
    );
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
        final others = error.shared;
        if (others.files.isNotEmpty ||
            others.personal.isNotEmpty ||
            others.skipped.isNotEmpty ||
            others.personalSkipped.isNotEmpty) {
          _shared = others;
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
      // The Swarm's one ground, beside the chat or in its place (design system, One surface).
      color: grid.AppPalette.swarmField,
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

  /// What instructs the agent, narrowest first (anh Dee, 2026-11-12: "users can have control and edit the exact place they
  /// want"): the agent itself, its own file and, for a project's PM, the role Harness gives it; the project's files; and
  /// Harness's. Its own file is the one place to change, and wins where they differ, as its launch tells it. While it is typed,
  /// it has the pane to itself.
  Widget _body() {
    if (widget.link == null) {
      return _note('Open it on ${widget.machineName}.');
    }
    final file = _file, error = _readError, shared = _shared;
    if (_editing) return _editor();
    if (file == null && error == null) return const SizedBox.shrink();
    final own = (file?.text ?? '').trim().isNotEmpty;
    final harness = _harness;
    final blocks = <Widget>[
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            // Where the headings below start.
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.controlGap,
            ),
            child: Text(
              "Yours first; it wins where they differ, except Harness's safety rules.",
              key: const ValueKey('swarm-precedence'),
              style: DesktopChrome.metadata(),
            ),
          ),
          _heading(widget.name, 'swarm-own-heading'),
          if (error != null) ...[
            _note(error, key: 'swarm-instructions-error'),
            Padding(
              // The glyph sits 8 points inside its 32-point target: it starts where the note's words do.
              padding: const EdgeInsets.symmetric(
                horizontal: SwarmLayout.barSide - 8,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: AppIconButton(
                  key: const ValueKey('swarm-instructions-retry'),
                  icon: AppIcons.refreshCw,
                  tooltip: 'Try again',
                  spinning: _asking,
                  onPressed: _read,
                ),
              ),
            ),
          ] else if (own)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.panelPadding,
                0,
                grid.AppDesktop.panelPadding,
                grid.AppDesktop.panelPadding,
              ),
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
          if (harness?.pm case final pm?) _role(pm),
        ],
      ),
      if (shared.files.isNotEmpty || shared.skipped.isNotEmpty)
        _group(
          'This project',
          'swarm-shared',
          shared.files,
          skipped: shared.skipped,
          skippedKey: 'swarm-skipped',
          note: 'Shared with your team; changed by pull request.',
        ),
      if (harness != null)
        _group('Harness', 'swarm-harness', [
          SwarmSharedFile(name: 'Swarm basics', text: harness.swarm),
        ]),
      if (shared.personal.isNotEmpty || shared.personalSkipped.isNotEmpty)
        _group(
          'From ${widget.machineName}',
          'swarm-personal',
          shared.personal,
          skipped: shared.personalSkipped,
        ),
    ];
    final engine = _engineOwn;
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
          if (engine != null) ...[
            ColoredBox(
              color: DesktopChrome.rim,
              child: const SizedBox(height: 1),
            ),
            Padding(
              padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
              child: Text(
                engine,
                key: const ValueKey('swarm-engine-own'),
                style: DesktopChrome.metadata(),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// A section's heading, in metadata grey, as each group's.
  Widget _heading(String text, String key) => Padding(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.panelPadding,
      grid.AppDesktop.controlGap,
      grid.AppDesktop.panelPadding,
      grid.AppDesktop.controlGap,
    ),
    child: Text(text, key: ValueKey(key), style: DesktopChrome.metadata()),
  );

  /// A PM's role as Harness gives it, under its own file (anh Dee, 2026-11-12: "PM basics.. shouldn't that be part of devon?"):
  /// folded to one row, read only, and where to change it. A builder has none.
  Widget _role(String pm) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      InkWell(
        key: const ValueKey('swarm-pm-row'),
        onTap: () => setState(() => _roleOpen = !_roleOpen),
        child: Semantics(
          button: true,
          expanded: _roleOpen,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.panelPadding,
              vertical: grid.AppDesktop.controlGap,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'As this project\'s PM, Harness tells it:',
                    key: const ValueKey('swarm-pm-name'),
                    style: DesktopChrome.control(medium: true),
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  _roleOpen ? AppIcons.chevronDown : AppIcons.chevronRight,
                  size: 14,
                  color: DesktopChrome.muted,
                ),
              ],
            ),
          ),
        ),
      ),
      if (_roleOpen) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.panelPadding,
            0,
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
          ),
          child: SelectableText(
            pm,
            key: const ValueKey('swarm-pm-text'),
            // At the terminal's size, as the panes beside it (anh Dee, 2026-11-10).
            style: grid.AppType.mono(color: DesktopChrome.foreground)
                .copyWith(fontSize: SwarmType.sizeOf(context)),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.panelPadding,
            0,
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
          ),
          child: Text(
            'To change it, write it in agents/${widget.name}.md.',
            key: const ValueKey('swarm-pm-note'),
            style: DesktopChrome.metadata(),
          ),
        ),
      ],
    ],
  );

  /// What the agent's engine is told by its maker first, which nobody sees or changes here (anh Dee, 2026-11-11: an empty
  /// file read as if the agent had no instructions at all).
  String? get _engineOwn => switch (widget.agent.engine.trim()) {
    '' => null,
    'claude' => 'And Claude Code\'s own instructions, from Anthropic.',
    'codex' => 'And Codex\'s own instructions, from OpenAI.',
    final engine => 'And ${engineIdentity(engine).label}\'s own instructions.',
  };

  /// What else instructs the agent, read only, under its own heading so it never reads as the agent's own: the files of its
  /// folder, what Harness adds, and its person's own on its computer, each file folded to its name and size, a click away
  /// from its text, and a line for each that is there and not shown. [key] names the group's parts (`swarm-shared-name-0`),
  /// and [skippedKey] its lines, `<key>-skipped` unless said.
  Widget _group(
    String heading,
    String key,
    List<SwarmSharedFile> files, {
    List<SwarmSkippedFile> skipped = const [],
    String? skippedKey,
    String? note,
  }) => Padding(
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
            heading,
            key: ValueKey('$key-heading'),
            style: DesktopChrome.metadata(),
          ),
        ),
        if (note != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.panelPadding,
              0,
              grid.AppDesktop.panelPadding,
              grid.AppDesktop.controlGap,
            ),
            child: Text(
              note,
              key: ValueKey('$key-note'),
              style: DesktopChrome.metadata(),
            ),
          ),
        for (final (i, one) in files.indexed) _sharedFile(key, i, one),
        for (final (i, skip) in skipped.indexed)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.panelPadding,
              vertical: grid.AppDesktop.controlGap,
            ),
            child: Text(
              _skippedWords(skip),
              key: ValueKey('${skippedKey ?? '$key-skipped'}-$i'),
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
    ),
  );

  /// A file of one of those groups: its name and size, its text below once opened, and a line when the computer cut it. One
  /// with the text of an earlier file ([SwarmSharedFile.sameAs]) says so in place of its size and has nothing to open.
  Widget _sharedFile(String group, int index, SwarmSharedFile file) {
    final same = file.sameAs, place = '$group-$index';
    final open = same == null && _open.contains(place);
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
              key: ValueKey('$group-name-$index'),
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
              same != null ? '$group-same-$index' : '$group-size-$index',
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
            key: ValueKey('$group-row-$index'),
            onTap: () =>
                setState(() => open ? _open.remove(place) : _open.add(place)),
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
              key: ValueKey('$group-text-$index'),
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
              key: ValueKey('$group-cut-$index'),
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
