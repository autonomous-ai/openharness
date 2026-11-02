import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'instructions_model.dart';
import 'model.dart';
import 'swarm_code_block.dart';
import 'swarm_message_row.dart' show swarmChatText;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_style.dart';

/// Opens [projectId]'s instructions over [context]'s page.
void openSwarmInstructions(
  BuildContext context, {
  required SwarmReader reader,
  required String projectId,
}) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmInstructionsPage(reader: reader, projectId: projectId),
    ),
  ),
);

/// A project's instruction document and its coordinator's notes, read only
/// (project instructions, decisions 15 and 16). Read when it opens and again
/// when the project's `instructionsRevision` or `notesRevision` moves in the
/// Swarm read; a pull reads again. Nothing is read on a poll, and nothing is
/// written from the phone.
class SwarmInstructionsPage extends StatefulWidget {
  const SwarmInstructionsPage({
    super.key,
    required this.reader,
    required this.projectId,
  });

  final SwarmReader reader;
  final String projectId;

  @override
  State<SwarmInstructionsPage> createState() => _SwarmInstructionsPageState();
}

class _SwarmInstructionsPageState extends State<SwarmInstructionsPage> {
  SuperTabInstructions? _doc;
  String? _error;
  bool _missing = false;

  /// The revisions of the project the last read was sent for.
  (int, int)? _readFor;
  Future<void>? _reading;
  bool _again = false;

  SuperTabProject? get _project => widget.reader.snapshot?.projects
      .where((p) => p.id == widget.projectId)
      .firstOrNull;

  /// A member's username from the reader's snapshot, else "a member".
  String _personName(String id) =>
      widget.reader.snapshot?.people
          .where((p) => p.id == id)
          .firstOrNull
          ?.username ??
      'a member';

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
    unawaited(_read());
  }

  @override
  void didUpdateWidget(SwarmInstructionsPage old) {
    super.didUpdateWidget(old);
    if (old.reader != widget.reader || old.projectId != widget.projectId) {
      old.reader.removeListener(_moved);
      widget.reader.addListener(_moved);
      _doc = null;
      _readFor = null;
      unawaited(_read());
    }
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    super.dispose();
  }

  void _moved() {
    final project = _project;
    final seen = _readFor;
    if (project == null || seen == null) return;
    if (seen != (project.instructionsRevision, project.notesRevision)) {
      unawaited(_read());
    }
  }

  /// One read at a time; a move while one is under way asks for one more.
  Future<void> _read() {
    if (_reading != null) {
      _again = true;
      return _reading!;
    }
    return _reading = _fetch().whenComplete(() {
      _reading = null;
      if (_again && mounted) {
        _again = false;
        unawaited(_read());
      }
    });
  }

  Future<void> _fetch() async {
    final reader = widget.reader;
    final project = _project;
    final path = superTabInstructionsPath(reader.tabId, widget.projectId);
    _readFor = (
      project?.instructionsRevision ?? 0,
      project?.notesRevision ?? 0,
    );
    try {
      final answer = superTabMap(await reader.request('GET', path));
      if (!mounted) return;
      setState(() {
        _doc = SuperTabInstructions.fromJson(answer);
        _error = null;
        _missing = false;
      });
    } on SuperTabFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        _missing = superTabMissingRoute(failure.code, failure.statusCode);
        _error = failure.message;
      });
    } on Object {
      if (!mounted) return;
      setState(() {
        _missing = false;
        _error = 'Couldn’t read the instructions.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final doc = _doc;
    final project = _project;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Instructions',
              subtitle: switch ((project, doc)) {
                (final p?, final d?) =>
                  '#${p.name} · ${d.revision == 0 ? 'built-in template' : 'revision ${d.revision}'}',
                (final p?, null) => '#${p.name}',
                _ => null,
              },
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _read,
                child: _body(context, doc),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, SuperTabInstructions? doc) {
    final tty = Tty.of(context);
    final quiet = tty.style(color: AppPalette.textFaint, size: 12.5);
    final padding = EdgeInsets.fromLTRB(
      AppSpace.m,
      AppSpace.xs,
      AppSpace.m,
      MediaQuery.paddingOf(context).bottom + AppSpace.xl,
    );
    const scroll = AlwaysScrollableScrollPhysics();
    if (doc == null) {
      final error = _error;
      return ListView(
        physics: scroll,
        padding: padding,
        children: [
          if (error == null)
            Text('Loading…', style: quiet)
          else if (_missing)
            Text(
              'This Swarm has no project instructions yet.',
              key: const ValueKey('swarm-instructions-missing'),
              style: swarmChatText(15, color: AppPalette.textSecondary),
            )
          else ...[
            Text(
              error,
              key: const ValueKey('swarm-instructions-error'),
              style: swarmChatText(15, color: AppPalette.textSecondary),
            ),
            const SizedBox(height: AppSpace.s),
            Align(
              alignment: Alignment.centerLeft,
              child: SwarmButton(
                key: const ValueKey('swarm-instructions-retry'),
                label: 'Try again',
                onPressed: () => unawaited(_read()),
              ),
            ),
          ],
        ],
      );
    }
    final now = clock.now();
    final notes = [...doc.notes]..sort((a, b) => b.at.compareTo(a.at));
    return SelectionArea(
      child: ListView(
        physics: scroll,
        padding: padding,
        children: [
          if (_error case final error?) ...[
            Text(
              error,
              key: const ValueKey('swarm-instructions-error'),
              style: swarmChatText(15, color: AppPalette.textSecondary),
            ),
            const SizedBox(height: AppSpace.s),
          ],
          Column(
            key: const ValueKey('swarm-instructions-text'),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final part in swarmTextParts(doc.text))
                if (part.code)
                  SwarmCodeBlock(code: part.text, name: part.name)
                else
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpace.s),
                    child: Text(part.text, style: swarmChatText(15)),
                  ),
            ],
          ),
          SwarmCaption('${doc.coordinatorName}’s notes'),
          if (notes.isEmpty)
            Text('No notes.', style: quiet)
          else
            for (final note in notes)
              Padding(
                key: ValueKey('swarm-instructions-note-${note.id}'),
                padding: const EdgeInsets.only(bottom: AppSpace.m),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(note.text, style: swarmChatText(15)),
                    Text(
                      [
                        'asked by ${_personName(note.askedBy)}',
                        relativeAgo(note.at, now),
                        if (note.expiresAt case final until?)
                          'until ${_until(until, now)}',
                      ].join(' · '),
                      style: quiet,
                    ),
                  ],
                ),
              ),
          const SizedBox(height: AppSpace.m),
          Text(
            'Change them in Harness on a computer, or ask '
            '${doc.coordinatorName} in the project chat.',
            style: quiet,
          ),
        ],
      ),
    );
  }
}

/// The time when [at] is today, else the date and time.
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
