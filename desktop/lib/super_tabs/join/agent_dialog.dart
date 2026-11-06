import 'package:flutter/material.dart';

import '../../shared/widgets/app_select_field.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/desktop_prompt_surface.dart';
import '../controller.dart' show superTabOperationId;

/// Starts only through the authenticated owner's daemon adapter. The dialog
/// never reads CLI settings, credentials or another machine's login.
typedef SwarmAgentCreate = Future<Map<String, dynamic>> Function(
  String engine,
  String kind,
  String? projectName,
  String operationId,
);

class SwarmAgentDialog extends StatefulWidget {
  const SwarmAgentDialog({
    super.key,
    required this.engines,
    required this.create,
    required this.isCurrent,
    this.bringing = false,
  });
  final List<String> engines;
  final SwarmAgentCreate create;
  final bool Function() isCurrent;
  final bool bringing;

  @override
  State<SwarmAgentDialog> createState() => _SwarmAgentDialogState();
}

class _SwarmAgentDialogState extends State<SwarmAgentDialog> {
  final _project = TextEditingController();
  final _operation = superTabOperationId();
  late String? _engine = widget.engines.firstOrNull;
  String _kind = 'regular';
  bool _busy = false, _submitted = false, _invalid = false;
  String? _error;
  String get _selectedKind => widget.bringing ? 'buddy' : _kind;

  Future<void> _submit() async {
    if (_busy || _invalid || _engine == null) return;
    if (!widget.isCurrent()) {
      setState(() {
        _invalid = true;
        _error = 'Your account changed. Close this dialog and try again.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _submitted = true;
      _error = null;
    });
    try {
      final result = await widget
          .create(
            _engine!,
            _selectedKind,
            _selectedKind == 'pm' ? _project.text.trim() : null,
            _operation,
          )
          .timeout(const Duration(seconds: 30));
      if (!mounted) return;
      if (!widget.isCurrent()) {
        setState(() {
          _invalid = true;
          _error = 'Your account changed. Close this dialog and try again.';
        });
        return;
      }
      if (result['agentId'] is! String && result['startId'] is! String) {
        throw const FormatException('Agent start not acknowledged');
      }
      Navigator.pop(context, result);
    } catch (_) {
      if (mounted)
        setState(
          () => _error = 'Could not start your agent. Check this computer’s connection and try again.',
        );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _project.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final enabled =
        !_busy &&
        !_invalid &&
        _engine != null &&
        (_selectedKind != 'pm' || _project.text.trim().isNotEmpty);
    return DesktopPromptSurface(
      body: DesktopPromptScrollBody(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DesktopDialogHeader(
              title: widget.bringing ? 'Bring your agent' : 'New agent',
              padding: EdgeInsets.zero,
              onClose: () => Navigator.pop(context),
            ),
            const SizedBox(height: 16),
            Text(
              widget.bringing
                  ? 'Choose the agent you use on this computer. It becomes your Buddy.'
                  : 'Regular agents work across projects. A PM starts and leads a project.',
              style: DesktopChrome.text(),
            ),
            const SizedBox(height: 16),
            if (!widget.bringing) ...[
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'regular', label: Text('Regular')),
                  ButtonSegment(value: 'pm', label: Text('PM')),
                ],
                selected: {_kind},
                onSelectionChanged: _submitted
                    ? null
                    : (values) => setState(() => _kind = values.single),
              ),
              const SizedBox(height: 16),
            ],
            if (widget.engines.isEmpty)
              Text(
                'Install Claude Code or Codex on this computer, then open this dialog again.',
                style: DesktopChrome.text(),
              )
            else
              AppSelectField<String>(
                key: const Key('swarm-agent-engine'),
                value: _engine!,
                semanticLabel: 'Engine',
                options: [
                  for (final e in widget.engines)
                    SelectOption(
                      value: e,
                      label: e == 'claude'
                          ? 'Claude Code'
                          : e == 'codex'
                          ? 'Codex'
                          : e,
                    ),
                ],
                onChanged: (value) {
                  if (!_submitted) setState(() => _engine = value);
                },
              ),
            if (_selectedKind == 'pm') ...[
              const SizedBox(height: 16),
              TextField(
                key: const Key('swarm-agent-project'),
                controller: _project,
                enabled: !_submitted,
                maxLength: 120,
                decoration: const InputDecoration(labelText: 'Project name'),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) {
                  if (enabled) _submit();
                },
              ),
            ],
            const SizedBox(height: 8),
            Text(
              'On this computer, with your own agent settings.',
              style: DesktopChrome.metadata(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('swarm-agent-error'),
                style: DesktopChrome.text(),
              ),
            ],
          ],
        ),
      ),
      actions: [
        FilledButton(
          key: const Key('swarm-agent-submit'),
          onPressed: enabled ? _submit : null,
          child: Text(
            _busy
                ? 'Starting…'
                : _error != null && !_invalid
                ? 'Retry'
                : widget.bringing
                ? 'Bring agent'
                : 'Create agent',
          ),
        ),
      ],
    );
  }
}
