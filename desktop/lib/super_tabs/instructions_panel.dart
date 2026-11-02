import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../core/relative_time.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'instructions_model.dart';

const _gap = DesktopChrome.controlGap;
const _halfGap = _gap / 2;

/// The details frame at its document width; the frame clamps it to the window.
const _width = 720.0;

/// The editor's height in lines: it scrolls inside, under a frame that does not move.
const _editorLines = 14;
const _theirLines = 8;

/// Which of the panel's three views is shown: the document, the list of its revisions, or one revision beside it.
enum _View { document, history }

/// A time of day today, else the date, in local time.
String _until(DateTime at, DateTime now) {
  final local = at.toLocal();
  final today = now.toLocal();
  if (local.year == today.year &&
      local.month == today.month &&
      local.day == today.day) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.hour)}:${two(local.minute)}';
  }
  return fullDateTime(at);
}

/// Whether [text] is over the document's limit, in UTF-8 bytes as the server counts them. A UTF-16 unit is at most
/// three bytes, so most texts are decided by their length alone.
bool _overLimit(String text) {
  if (text.length > kInstructionsMaxBytes) return true;
  if (text.length * 3 <= kInstructionsMaxBytes) return false;
  return utf8.encode(text).length > kInstructionsMaxBytes;
}

/// The project's instruction document in the Swarm's details frame: every member reads it, and a member who can
/// write saves a change with a one-line summary on the revision they read (spec: The instruction document).
Future<void> showSuperTabInstructions(
  BuildContext context,
  SuperTabController c,
  String projectId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: projectId,
    requireWrite: false,
    child: _InstructionsPanel(controller: c, projectId: projectId),
  ),
);

class _InstructionsPanel extends StatefulWidget {
  const _InstructionsPanel({required this.controller, required this.projectId});

  final SuperTabController controller;
  final String projectId;

  @override
  State<_InstructionsPanel> createState() => _InstructionsPanelState();
}

class _InstructionsPanelState extends State<_InstructionsPanel> {
  final _editor = TextEditingController();
  final _summary = TextEditingController();
  final _theirText = TextEditingController();
  final _pickedText = TextEditingController();

  SuperTabController get c => widget.controller;

  /// The last document read: its notes and their revision (the notes are task 3's).
  SuperTabInstructions? _doc;

  /// The revision the next Save goes on, and its text: the draft is a change while it differs from that text.
  int _base = 0;
  String _baseText = '';

  /// A revision saved by someone else while the draft was changed: shown beside it to merge (decision 3).
  int? _theirs;

  /// The project's revisions in the Swarm read when last looked at: a move reads the document again (decision 16).
  ({int instructions, int notes})? _seen;

  Object? _readFailure;
  _View _view = _View.document;

  /// The kept revisions, newest first, read when History opens; a failed read; the revision picked, with its text.
  List<SuperTabRevision>? _history;
  Object? _historyFailure, _pickFailure;
  int? _picked;
  SuperTabRevision? _pickedRevision;
  int _historyReads = 0, _pickReads = 0;

  /// Notes being removed, so that a second tap does nothing.
  final _removing = <String>{};
  bool _saving = false, _discarding = false;
  String? _saveError;

  /// Counts reads, so that an older answer never lands over a newer one.
  int _reads = 0;

  bool get _writable => c.canWrite;
  bool get _changed => _doc != null && _editor.text != _baseText;

  @override
  void initState() {
    super.initState();
    c.addListener(_onSwarm);
    unawaited(_read());
  }

  @override
  void dispose() {
    c.removeListener(_onSwarm);
    _editor.dispose();
    _summary.dispose();
    _theirText.dispose();
    _pickedText.dispose();
    super.dispose();
  }

  ({int instructions, int notes})? _revisions() =>
      switch (c.snapshot?.projectById(widget.projectId)) {
        final project? => (
          instructions: project.instructionsRevision,
          notes: project.notesRevision,
        ),
        null => null,
      };

  /// Reads the document again when the Swarm read moves its revision or its notes' past what the panel holds; never
  /// for its own save, which already knows its revision.
  void _onSwarm() {
    if (_saving || !mounted) return;
    final now = _revisions();
    if (now == null || now == _seen) return;
    _seen = now;
    final doc = _doc;
    if (doc != null &&
        now.instructions == _base &&
        now.notes == doc.notesRevision) {
      return;
    }
    unawaited(_read());
  }

  Future<void> _read() async {
    final read = ++_reads;
    _seen = _revisions();
    if (_readFailure != null) setState(() => _readFailure = null);
    try {
      final answer = await c.request(
        'GET',
        superTabInstructionsPath(c.tabId, widget.projectId),
      );
      if (!mounted || read != _reads) return;
      _apply(SuperTabInstructions.fromJson(answer));
    } catch (failure) {
      if (!mounted || read != _reads) return;
      setState(() => _readFailure = failure);
    }
  }

  /// Takes a document read: an unchanged draft becomes its text; a changed one stays, with a newer revision's text
  /// beside it, and the next Save goes on that revision.
  void _apply(SuperTabInstructions doc) => setState(() {
    if (!_changed) {
      _editor.text = doc.text;
      _theirs = null;
    } else if (doc.revision != _base) {
      _theirs = doc.revision;
      _theirText.text = doc.text;
    }
    if (_editor.text == doc.text) _theirs = null;
    _doc = doc;
    _base = doc.revision;
    _baseText = doc.text;
  });

  Future<void> _save() async {
    final command = <String, dynamic>{
      'type': 'instructions.save',
      'projectId': widget.projectId,
      'baseRevision': _base,
      'text': _editor.text,
      'summary': _summary.text.trim(),
    };
    setState(() {
      _saving = true;
      _saveError = null;
    });
    final result = await c.command(command);
    if (!mounted) return;
    await _settle(command, result);
  }

  /// Checks an action whose answer was lost, under its own receipt: every command waits for it, Save included.
  Future<void> _retry() async {
    final command = c.pendingCommand;
    if (command == null) return;
    final ours =
        command['type'] == 'instructions.save' &&
        command['projectId'] == widget.projectId;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    final result = await c.retry();
    if (!mounted) return;
    if (ours) return _settle(command, result);
    setState(() {
      _saving = false;
      if (result == null) _saveError = c.operationError;
    });
  }

  Future<void> _settle(
    Map<String, dynamic> command,
    Map<String, dynamic>? result,
  ) async {
    if (result != null) {
      setState(() {
        _saving = false;
        _base =
            (result['revision'] as num?)?.toInt() ??
            (command['baseRevision'] as int) + 1;
        _baseText = command['text'] as String;
        _theirs = null;
        if (_summary.text.trim() == command['summary']) _summary.clear();
      });
      // Someone else's save may have landed after this one.
      _onSwarm();
      return;
    }
    final stale = c.operationErrorCode == 'INSTRUCTIONS_STALE';
    setState(() {
      _saving = false;
      if (!stale) _saveError = c.operationError;
    });
    // The refusal's text does not reach this client (decision 3): read the revision it missed.
    if (stale) await _read();
  }

  Future<void> _openHistory() async {
    setState(() {
      _view = _View.history;
      _picked = null;
      _pickedRevision = null;
      _pickFailure = null;
    });
    await _readHistory();
  }

  Future<void> _readHistory() async {
    final read = ++_historyReads;
    setState(() {
      _historyFailure = null;
      _history = null;
    });
    try {
      final answer = await c.request(
        'GET',
        superTabInstructionsPath(c.tabId, widget.projectId, revisions: true),
      );
      if (!mounted || read != _historyReads) return;
      setState(
        () => _history = [
          for (final row in answer['revisions'] as List? ?? const [])
            if (row is Map<String, dynamic>) SuperTabRevision.fromJson(row),
        ],
      );
    } catch (failure) {
      if (!mounted || read != _historyReads) return;
      setState(() => _historyFailure = failure);
    }
  }

  Future<void> _pick(int revision) async {
    final read = ++_pickReads;
    setState(() {
      _picked = revision;
      _pickedRevision = null;
      _pickFailure = null;
    });
    try {
      final answer = await c.request(
        'GET',
        superTabInstructionsPath(c.tabId, widget.projectId, revision: revision),
      );
      if (!mounted || read != _pickReads) return;
      setState(() {
        _pickedRevision = SuperTabRevision.fromJson(answer);
        _pickedText.text = _pickedRevision?.text ?? '';
      });
    } catch (failure) {
      if (!mounted || read != _pickReads) return;
      setState(() => _pickFailure = failure);
    }
  }

  /// Puts a past revision in the editor with its summary; nothing is written until Save (decision 4). An unsaved
  /// draft is replaced only after asking.
  Future<void> _restore(SuperTabRevision revision) async {
    if (_changed) {
      final replace = await showAppDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(
            'Replace your changes with revision ${revision.revision}?',
          ),
          actions: [
            TextButton(
              autofocus: true,
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep my changes'),
            ),
            FilledButton(
              style: grid.dangerButtonStyle(),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Replace'),
            ),
          ],
        ),
      );
      if (replace != true || !mounted) return;
    }
    setState(() {
      _editor.text = revision.text ?? '';
      _summary.text = 'Restored revision ${revision.revision}.';
      _view = _View.document;
    });
  }

  Future<void> _removeNote(SuperTabNote note) async {
    setState(() {
      _removing.add(note.id);
      _saveError = null;
    });
    final result = await c.command({
      'type': 'note.remove',
      'projectId': widget.projectId,
      'noteId': note.id,
    });
    if (!mounted) return;
    setState(() {
      _removing.remove(note.id);
      if (result == null) _saveError = c.operationError;
    });
    // The notes' revision moved with the command: the Swarm read's move reads them (never touching the draft).
    if (result != null) _onSwarm();
  }

  Future<void> _close() async {
    if (_changed && _writable && !_discarding) {
      final discard = await showAppDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Discard your changes to the instructions?'),
          actions: [
            TextButton(
              autofocus: true,
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep editing'),
            ),
            FilledButton(
              style: grid.dangerButtonStyle(),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Discard'),
            ),
          ],
        ),
      );
      if (discard != true || !mounted) return;
      setState(() => _discarding = true);
    }
    if (mounted) Navigator.pop(context);
  }

  bool get _canSave =>
      _writable &&
      _changed &&
      !_saving &&
      !c.saving &&
      !c.hasPendingAction &&
      _editor.text.trim().isNotEmpty &&
      _summary.text.trim().isNotEmpty &&
      !_overLimit(_editor.text);

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final doc = _doc;
      final writable = _writable && doc != null;
      final history = doc != null && _view == _View.history;
      // An unconfirmed action holds every command back: say so beside Save.
      final saveError =
          _saveError ?? (c.hasPendingAction ? c.operationError : null);
      return PopScope(
        canPop: !_changed || !_writable || _discarding,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(_close());
        },
        child: SuperTabDetailDialog(
          title: history ? 'Instructions › History' : 'Instructions',
          detail: doc == null
              ? null
              : _base == 0
              ? 'Built-in template'
              : 'Revision $_base',
          width: _width,
          onClose: () => unawaited(_close()),
          body: doc == null
              ? _empty()
              : history
              ? _historyBody()
              : _document(writable, doc),
          footer: switch ((doc, _readFailure, saveError)) {
            (_?, final Object failure, _) => _failureLine(failure),
            (_, _, final String error) => Text(
              error,
              style: DesktopChrome.metadata(),
            ),
            _ => null,
          },
          leadingActions: [
            if (history)
              TextButton(
                key: const ValueKey('super-instructions-back'),
                onPressed: () => setState(() => _view = _View.document),
                child: const Text('Back to the instructions'),
              )
            else if (doc != null)
              TextButton(
                key: const ValueKey('super-instructions-history'),
                onPressed: _openHistory,
                child: const Text('History'),
              ),
            if (!history && writable && c.hasPendingAction)
              TextButton(
                onPressed: _saving || c.saving ? null : _retry,
                child: const Text('Retry'),
              ),
          ],
          actions: history
              ? [
                  if (writable && _pickedRevision?.text != null)
                    FilledButton(
                      key: const ValueKey('super-restore'),
                      onPressed: () => unawaited(_restore(_pickedRevision!)),
                      child: Text(
                        'Restore revision ${_pickedRevision!.revision}',
                      ),
                    ),
                ]
              : writable
              ? [
                  TextButton(
                    onPressed: _saving ? null : _close,
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    key: const ValueKey('super-instructions-save'),
                    onPressed: _canSave ? _save : null,
                    child: const Text('Save'),
                  ),
                ]
              : [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Close'),
                  ),
                ],
        ),
      );
    },
  );

  /// Before a document: its shape while it is read, or why there is none.
  Widget _empty() {
    final failure = _readFailure;
    if (failure is SuperTabFailure &&
        superTabMissingRoute(failure.code, failure.statusCode)) {
      return Text(
        'This Swarm has no project instructions yet.',
        style: DesktopChrome.text(),
      );
    }
    if (failure != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _failureLine(failure),
          const SizedBox(height: _gap),
          TextButton(onPressed: _read, child: const Text('Try again')),
        ],
      );
    }
    final mono = grid.AppType.mono();
    return SkeletonBlock(
      semanticsLabel: 'Loading the instructions',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final width in const [.3, .9, .75, .85, .6])
            SkeletonText(style: mono, widthFactor: width),
        ],
      ),
    );
  }

  Widget _failureLine(Object failure) => Text(
    failure is SuperTabFailure
        ? failure.message
        : 'The instructions could not be read.',
    style: DesktopChrome.metadata(),
  );

  Widget _document(bool writable, SuperTabInstructions doc) {
    final mono = grid.AppType.mono();
    final theirs = _theirs;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (theirs != null) ...[
          Text(
            'Revision $theirs was saved while you edited. Merge what it says '
            'into your text, then save again.',
            style: DesktopChrome.text(),
          ),
          const SizedBox(height: _gap),
        ],
        TextField(
          key: const ValueKey('super-instructions-editor'),
          controller: _editor,
          readOnly: !writable,
          autofocus: writable,
          minLines: _editorLines,
          maxLines: _editorLines,
          keyboardType: TextInputType.multiline,
          style: mono,
          onChanged: (_) => setState(() {}),
        ),
        if (writable && _overLimit(_editor.text)) ...[
          const SizedBox(height: _halfGap),
          Text(
            'Instructions are limited to 64 KB.',
            style: DesktopChrome.metadata(),
          ),
        ],
        if (theirs != null) ...[
          const SizedBox(height: _gap + _halfGap),
          Text('Revision $theirs, as saved', style: DesktopChrome.metadata()),
          const SizedBox(height: _halfGap),
          TextField(
            key: const ValueKey('super-instructions-theirs'),
            controller: _theirText,
            readOnly: true,
            minLines: _theirLines,
            maxLines: _theirLines,
            style: mono,
          ),
        ],
        if (writable) ...[
          const SizedBox(height: _gap + _halfGap),
          TextField(
            key: const ValueKey('super-instructions-summary'),
            controller: _summary,
            maxLength: kInstructionsSummaryMax,
            maxLines: 1,
            decoration: const InputDecoration(labelText: 'What changed'),
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) {
              if (_canSave) unawaited(_save());
            },
          ),
        ],
        const SizedBox(height: _gap + _halfGap),
        _notes(doc, writable),
      ],
    );
  }

  String _personName(String id) =>
      c.snapshot?.people.where((p) => p.id == id).firstOrNull?.username ??
      'a member';

  /// What the coordinator was told to keep, newest first, with who asked and until when (spec: PM notes).
  Widget _notes(SuperTabInstructions doc, bool writable) {
    final now = DateTime.now();
    final notes = [...doc.notes]..sort((a, b) => b.at.compareTo(a.at));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text("${doc.coordinatorName}'s notes", style: DesktopChrome.heading()),
        const SizedBox(height: _halfGap),
        if (notes.isEmpty) Text('No notes.', style: DesktopChrome.metadata()),
        for (final note in notes)
          Padding(
            key: ValueKey('super-note-${note.id}'),
            padding: const EdgeInsets.symmetric(vertical: _halfGap / 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(note.text, style: DesktopChrome.text()),
                      Text(
                        'asked by ${_personName(note.askedBy)} · '
                        '${relativeAgo(note.at, now)}'
                        '${note.expiresAt == null ? '' : ' · until ${_until(note.expiresAt!, now)}'}',
                        style: DesktopChrome.metadata(),
                      ),
                    ],
                  ),
                ),
                if (writable)
                  TextButton(
                    key: ValueKey('super-note-delete-${note.id}'),
                    onPressed:
                        _removing.contains(note.id) ||
                            _saving ||
                            c.saving ||
                            c.hasPendingAction
                        ? null
                        : () => unawaited(_removeNote(note)),
                    child: const Text('Delete'),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  /// Who wrote a revision: a person by username, an agent by name (the coordinator's when it is gone), the system as
  /// Harness; `for <asker>` when it carries someone else's words.
  String _writer(SuperTabRevision revision) {
    final by = revision.writtenBy;
    final name = switch (by.kind) {
      'person' => _personName(by.id),
      'agent' =>
        c.snapshot?.agentName(
              by.id,
              fallback: _doc?.coordinatorName ?? 'Product Manager',
            ) ??
            'Product Manager',
      _ => 'Harness',
    };
    final asker = revision.askedBy;
    if (by.kind == 'system' || asker == null || asker == by.id) return name;
    return '$name for ${_personName(asker)}';
  }

  Widget _historyBody() {
    if (_historyFailure != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Could not read the history.', style: DesktopChrome.metadata()),
          const SizedBox(height: _gap),
          TextButton(onPressed: _readHistory, child: const Text('Try again')),
        ],
      );
    }
    final rows = _history;
    if (rows == null) {
      return SkeletonBlock(
        semanticsLabel: 'Loading the history',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final width in const [.8, .7, .6])
              SkeletonText(style: DesktopChrome.text(), widthFactor: width),
          ],
        ),
      );
    }
    final now = DateTime.now();
    final picked = _picked;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final row in rows)
          Material(
            color: row.revision == picked
                ? DesktopChrome.selection
                : Colors.transparent,
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            child: InkWell(
              key: ValueKey('super-revision-${row.revision}'),
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              onTap: () => unawaited(_pick(row.revision)),
              child: Padding(
                padding: const EdgeInsets.all(_halfGap),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: superTabDetailLabelWidth,
                      child: Text(
                        'Revision ${row.revision}',
                        style: DesktopChrome.control(medium: true),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        '${_writer(row)} · ${relativeAgo(row.at, now)} · '
                        '${row.summary}',
                        style: DesktopChrome.text(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        if (picked != null) ...[
          const SizedBox(height: _gap),
          Divider(height: 1, color: DesktopChrome.rim),
          const SizedBox(height: _gap),
          Text('Revision $picked', style: DesktopChrome.heading()),
          const SizedBox(height: _halfGap),
          if (_pickFailure != null) ...[
            Text(
              'Could not read that revision.',
              style: DesktopChrome.metadata(),
            ),
            const SizedBox(height: _halfGap),
            TextButton(
              onPressed: () => unawaited(_pick(picked)),
              child: const Text('Try again'),
            ),
          ] else if (_pickedRevision?.text != null)
            TextField(
              key: const ValueKey('super-revision-text'),
              controller: _pickedText,
              readOnly: true,
              minLines: _theirLines,
              maxLines: _editorLines,
              style: grid.AppType.mono(),
            )
          else
            SkeletonBlock(
              semanticsLabel: 'Loading the revision',
              child: SkeletonText(style: DesktopChrome.text(), widthFactor: .8),
            ),
        ],
      ],
    );
  }
}
