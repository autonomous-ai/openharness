import 'dart:async';

import 'package:flutter/material.dart';

import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
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
      }
    });
  }

  @override
  void dispose() {
    _text.dispose();
    _input.dispose();
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
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => TerminalPromptKeys(
        inputFocus: _input,
        composing: () => _composing,
        cancel: _close,
        accept: _accept,
        child: TerminalPrompt(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(widget.title, style: boxMonoStyle(color: kBoxFaint)),
                      if (widget.detail case final detail?) ...[
                        const SizedBox(height: 6),
                        Text(
                          detail,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: boxMonoStyle(color: kBoxFaint),
                        ),
                      ],
                      const SizedBox(height: 10),
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
                            style: boxMonoStyle(),
                            textAlignVertical: TextAlignVertical.center,
                            textInputAction: TextInputAction.done,
                            decoration: InputDecoration(
                              hintText: widget.fieldLabel,
                              hintStyle: boxMonoStyle(color: kBoxFaint),
                              counterText: '',
                              suffixText:
                                  widget.maxLength != null &&
                                      _text.text.characters.length >=
                                          widget.maxLength! - 10
                                  ? '${_text.text.characters.length}/${widget.maxLength}'
                                  : null,
                              suffixStyle: boxMonoStyle(color: kBoxFaint),
                              isDense: true,
                              filled: false,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              prefixIcon: Padding(
                                padding: const EdgeInsets.only(right: 10),
                                child: Center(
                                  widthFactor: 1,
                                  heightFactor: 1,
                                  child: Text(
                                    'name >',
                                    style: boxMonoStyle(color: Colors.white70),
                                  ),
                                ),
                              ),
                              prefixIconConstraints: const BoxConstraints(
                                minHeight: 38,
                              ),
                              contentPadding: EdgeInsets.zero,
                            ),
                            onChanged: _changed,
                            onEditingComplete: () {},
                            onSubmitted: (_) => _save(),
                          ),
                        ),
                      ),
                      if (_saving)
                        Text(
                          'Saving continues if you close this prompt.',
                          style: boxMonoStyle(color: kBoxFaint),
                        ),
                    ],
                  ),
                ),
              ),
              BoxHintStrip(
                message: _error ?? (_saving ? 'Saving name…' : null),
                isError: _error != null,
                hints: [
                  if (!_saving)
                    BoxHint(
                      terminalPromptHint(context, 'picker.accept', 'enter'),
                      'save',
                      onTap: _save,
                    ),
                  BoxHint(
                    terminalPromptHint(context, 'picker.cancel', 'esc'),
                    'close',
                    onTap: _close,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
