import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart' show BoxAnnouncer, ReadlineKeys;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'terminal_prompt.dart';

/// One rename editor for tabs, agents, and machines. A remote save may outlive
/// the route; its owner supplies that same future when the prompt is reopened.
class TerminalNamePrompt extends StatefulWidget {
  const TerminalNamePrompt({
    super.key,
    required this.title,
    required this.name,
    required this.fieldKey,
    required this.fieldLabel,
    this.detail,
    this.maxLength,
    this.save,
    this.pending,
  });
  final String title, name, fieldLabel;
  final Key fieldKey;
  final String? detail;
  final int? maxLength;
  final Future<String?> Function(String name)? save;
  final Future<String?>? pending;

  @override
  State<TerminalNamePrompt> createState() => _TerminalNamePromptState();
}

class _TerminalNamePromptState extends State<TerminalNamePrompt> {
  late final _text = TextEditingController(
    text: widget.name,
  )..selection = TextSelection(baseOffset: 0, extentOffset: widget.name.length);
  final _input = FocusNode(debugLabel: 'Rename input');
  final _body = ScrollController();
  final _announcer = BoxAnnouncer();
  bool _saving = false;
  String? _error;
  bool get _composing =>
      _text.value.composing.isValid && !_text.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    if (widget.pending case final pending?) {
      _saving = true;
      unawaited(_finish(pending, widget.name));
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _input.requestFocus();
        if (_body.hasClients) _body.jumpTo(_body.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    _text.dispose();
    _input.dispose();
    _body.dispose();
    super.dispose();
  }

  void _close() {
    if (!_composing) Navigator.pop(context);
  }

  void _changed(String _) => setState(() => _error = null);

  void _failed(String error) {
    setState(() {
      _saving = false;
      _error = error;
    });
    _input.requestFocus();
    _announcer.row(context, error);
    // Enlarged text can make the title and detail scroll. Keep the field and
    // its validation at the end of that scroll area above the fixed actions.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _body.hasClients) {
        _body.jumpTo(_body.position.maxScrollExtent);
      }
    });
  }

  void _accept() {
    if (_input.hasFocus) {
      _save();
    } else {
      activatePromptControl();
    }
  }

  void _save() {
    if (_saving || _composing) return;
    final name = _text.text.trim();
    if (name.isEmpty) return _failed('Name cannot be empty');
    if (widget.maxLength case final limit?) {
      if (name.characters.length > limit) {
        return _failed('Use at most $limit characters.');
      }
    }
    final save = widget.save;
    if (save == null) {
      Navigator.pop(context, name);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    unawaited(_finish(Future.sync(() => save(name)), name));
  }

  Future<void> _finish(Future<String?> request, String name) async {
    String? error;
    try {
      error = await request;
    } catch (_) {
      error = 'Could not save the name. Try again.';
    }
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context, name);
    } else {
      _failed(error);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final errorColor = Theme.of(context).colorScheme.error;
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(grid.AppDesktop.fieldRadius),
      borderSide: BorderSide(color: DesktopChrome.rim),
    );
    return TerminalPromptKeys(
      inputFocus: _input,
      composing: () => _composing,
      cancel: _close,
      accept: _accept,
      child: DesktopPromptSurface(
        width: 460,
        body: DesktopPromptScrollBody(
          controller: _body,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopDialogHeader(
                title: widget.title,
                padding: EdgeInsets.zero,
              ),
              if (widget.detail case final detail?) ...[
                const SizedBox(height: 8),
                Text(
                  detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.fieldLabel,
                style: DesktopChrome.text(size: 13, medium: true),
              ),
              const SizedBox(height: 8),
              ReadlineKeys(
                controller: _text,
                enabled: !_saving,
                onChanged: _changed,
                child: Semantics(
                  label: widget.fieldLabel,
                  child: TextField(
                    key: widget.fieldKey,
                    controller: _text,
                    focusNode: _input,
                    readOnly: _saving,
                    maxLength: widget.maxLength,
                    style: DesktopChrome.text(size: 14),
                    cursorColor: DesktopChrome.accent,
                    textAlignVertical: TextAlignVertical.center,
                    textInputAction: TextInputAction.done,
                    decoration: InputDecoration(
                      hintText: widget.fieldLabel,
                      hintStyle: DesktopChrome.text(color: DesktopChrome.muted),
                      counterText: '',
                      suffixText:
                          widget.maxLength != null &&
                              _text.text.characters.length >=
                                  widget.maxLength! - 10
                          ? '${_text.text.characters.length}/${widget.maxLength}'
                          : null,
                      suffixStyle: DesktopChrome.text(
                        size: 12,
                        color: DesktopChrome.muted,
                      ),
                      isDense: true,
                      filled: true,
                      fillColor: DesktopChrome.field,
                      border: border,
                      enabledBorder: border,
                      focusedBorder: border.copyWith(
                        borderSide: BorderSide(
                          color: DesktopChrome.focusRing,
                          width: grid.AppDesktop.focusWidth,
                        ),
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                    ),
                    onChanged: _changed,
                    onEditingComplete: () {},
                    onSubmitted: (_) => _save(),
                  ),
                ),
              ),
              if (_error != null || _saving) ...[
                const SizedBox(height: 12),
                Semantics(
                  liveRegion: true,
                  child: DesktopPromptMessage(
                    _error ?? 'Saving name… You can close this dialog while it finishes.',
                    color: _error == null ? DesktopChrome.muted : errorColor,
                  ),
                ),
              ],
            ],
          ),
        ),
        actions: [
          Tooltip(
            message:
                'Cancel · ${terminalPromptHint(context, 'picker.cancel', 'esc')}',
            child: TextButton(
              onPressed: _close,
              style: TextButton.styleFrom(
                foregroundColor: DesktopChrome.foreground,
                textStyle: DesktopChrome.text(size: 13),
              ),
              child: const Text('Cancel'),
            ),
          ),
          Tooltip(
            message:
                'Save · ${terminalPromptHint(context, 'picker.accept', 'enter')}',
            child: FilledButton(
              onPressed: _saving ? null : _save,
              style: FilledButton.styleFrom(
                textStyle: DesktopChrome.text(size: 13),
              ),
              child: Text(_saving ? 'Saving…' : 'Save'),
            ),
          ),
        ],
      ),
    );
  }
}
