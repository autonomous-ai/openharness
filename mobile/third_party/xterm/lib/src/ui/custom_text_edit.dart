import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/src/utils/unicode_v11.dart';

class CustomTextEdit extends StatefulWidget {
  CustomTextEdit({
    super.key,
    required this.child,
    required this.onInsert,
    required this.onDelete,
    required this.onComposing,
    required this.onAction,
    required this.onKeyEvent,
    required this.focusNode,
    this.autofocus = false,
    this.readOnly = false,
    // this.initEditingState = TextEditingValue.empty,
    this.inputType = TextInputType.text,
    this.inputAction = TextInputAction.newline,
    this.keyboardAppearance = Brightness.light,
    this.deleteDetection = false,
    this.allowedMimeTypes = const <String>[],
    this.onContentInserted,
  });

  final Widget child;

  final void Function(String) onInsert;

  final void Function(int count) onDelete;

  final void Function(String? text, int backtrackCells) onComposing;

  final void Function(TextInputAction) onAction;

  final KeyEventResult Function(FocusNode, KeyEvent) onKeyEvent;

  final FocusNode focusNode;

  final bool autofocus;

  final bool readOnly;

  final TextInputType inputType;

  final TextInputAction inputAction;

  final Brightness keyboardAppearance;

  final bool deleteDetection;

  /// Content types this connection accepts from the keyboard's own clipboard, as
  /// `EditorInfo.contentMimeTypes` on Android.
  ///
  /// ⚠️ Empty — the default — is what makes Gboard refuse a clipboard image with
  /// "the current app does not allow pasting images here". The refusal happens in
  /// the keyboard, before anything reaches Dart, so no amount of handling here
  /// substitutes for declaring the type.
  final List<String> allowedMimeTypes;

  /// One item of [allowedMimeTypes] arriving from the keyboard.
  ///
  /// ⚠️ [KeyboardInsertedContent.data] can be null even for a type that was asked
  /// for: the platform hands over a URI it could not read for us.
  final void Function(KeyboardInsertedContent content)? onContentInserted;

  @override
  CustomTextEditState createState() => CustomTextEditState();
}

class CustomTextEditState extends State<CustomTextEdit> with TextInputClient {
  TextInputConnection? _connection;

  @override
  void initState() {
    widget.focusNode.addListener(_onFocusChange);
    super.initState();
  }

  @override
  void didUpdateWidget(CustomTextEdit oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.focusNode != oldWidget.focusNode) {
      oldWidget.focusNode.removeListener(_onFocusChange);
      widget.focusNode.addListener(_onFocusChange);
    }

    if (!_shouldCreateInputConnection) {
      _closeInputConnectionIfNeeded();
    } else {
      if (oldWidget.readOnly && widget.focusNode.hasFocus) {
        _openInputConnection();
      }
    }
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_onFocusChange);
    _closeInputConnectionIfNeeded();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      onKeyEvent: _onKeyEvent,
      child: widget.child,
    );
  }

  bool get hasInputConnection => _connection != null && _connection!.attached;

  void requestKeyboard() {
    if (widget.focusNode.hasFocus) {
      _openInputConnection();
    } else {
      widget.focusNode.requestFocus();
    }
  }

  void closeKeyboard() {
    if (hasInputConnection) {
      _connection?.close();
    }
  }

  void setEditingState(TextEditingValue value) {
    _cancelPendingDeletes();
    _currentEditingState = value;
    _terminalText = value.text;
    _connection?.setEditingState(value);
  }

  /// Clears the native input buffer after the terminal accepts a command.
  /// It intentionally stays intact between ordinary key presses: Vietnamese
  /// Telex needs the preceding `u` available to convert it into `ư`.
  void resetEditingState() {
    _cancelPendingDeletes();
    _currentEditingState = _initEditingState.copyWith();
    _terminalText = _currentEditingState.text;
    widget.onComposing(null, 0);
    _connection?.setEditingState(_currentEditingState);
  }

  void setEditableRect(Rect rect, Rect caretRect) {
    if (!hasInputConnection) {
      return;
    }

    _connection?.setEditableSizeAndTransform(
      rect.size,
      Matrix4.translationValues(0, 0, 0),
    );

    _connection?.setCaretRect(caretRect);
  }

  void _onFocusChange() {
    _openOrCloseInputConnectionIfNeeded();
  }

  KeyEventResult _onKeyEvent(FocusNode focusNode, KeyEvent event) {
    if (_currentEditingState.composing.isCollapsed) {
      if (_isBufferBackspace(event)) {
        _cancelPendingDeletes();
        _applyNativeBackspace();
        return KeyEventResult.handled;
      }
      return widget.onKeyEvent(focusNode, event);
    }

    return KeyEventResult.skipRemainingHandlers;
  }

  /// A plain Backspace from a phone keyboard, arriving as a KEY while the native buffer still holds
  /// text this side has mirrored to the pty.
  ///
  /// ⚠️ **Gboard sends Backspace as a key event, not as an edit to its buffer** — and a key the
  /// terminal consumes deletes on the pty while the buffer the keyboard edits keeps the letter. The
  /// two then disagree about what is on the line: after "xin chào" and four Backspaces the keyboard
  /// still holds "xin chào", appends the next word to it ("xin chàochao"), and when Telex re-marks
  /// that run the diff against it deletes and retypes characters that were already gone — "chào"
  /// typed again came out as "xiaochaof".
  ///
  /// So the deletion is made IN the buffer and the buffer handed back to the keyboard; the pty gets
  /// the same one delete through [_syncTerminalText]. An empty buffer (a fresh prompt) still sends
  /// the delete straight on — see [_applyNativeBackspace].
  ///
  /// Only without modifiers: Ctrl/Alt+Backspace mean something else to a shell, and only on a phone,
  /// where the software keyboard is the input method. A desktop IME reaches Backspace through
  /// `performSelector` instead, which already edits the buffer.
  bool _isBufferBackspace(KeyEvent event) {
    if (!_composesThroughSoftwareKeyboard) return false;
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return false;
    if (event.logicalKey != LogicalKeyboardKey.backspace) return false;
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isControlPressed ||
        keyboard.isAltPressed ||
        keyboard.isMetaPressed) {
      return false;
    }
    return _currentEditingState.text != _initEditingState.text;
  }

  void _openOrCloseInputConnectionIfNeeded() {
    if (widget.focusNode.hasFocus && widget.focusNode.consumeKeyboardToken()) {
      _openInputConnection();
    } else if (!widget.focusNode.hasFocus) {
      _closeInputConnectionIfNeeded();
    }
  }

  bool get _shouldCreateInputConnection => kIsWeb || !widget.readOnly;

  /// Whether the platform's on-screen keyboard is the input method itself,
  /// rather than a layer a hardware keyboard composes through. See the IME
  /// note in [_openInputConnection].
  static bool get _composesThroughSoftwareKeyboard =>
      defaultTargetPlatform == TargetPlatform.iOS ||
      defaultTargetPlatform == TargetPlatform.android;

  void _openInputConnection() {
    if (!_shouldCreateInputConnection) {
      return;
    }

    if (hasInputConnection) {
      _connection!.show();
    } else {
      final config = TextInputConfiguration(
        inputType: widget.inputType,
        inputAction: widget.inputAction,
        keyboardAppearance: widget.keyboardAppearance,
        // ⚠️ On a phone the software keyboard IS the input method, and these two
        // switches are what turn its pre-edit buffer off: iOS maps
        // `autocorrect: false` onto `UITextAutocorrectionTypeNo`, Android maps
        // `enableSuggestions: false` onto `TYPE_TEXT_FLAG_NO_SUGGESTIONS`. With
        // either one set the keyboard has nowhere to compose, so Vietnamese
        // Telex converted nothing and `hoom` reached the pty as four raw
        // letters instead of `hôm`; a CJK candidate window dies the same way.
        // A desktop IME composes through marked text, which neither flag
        // touches, so those platforms keep the strict config — a terminal has
        // no business autocorrecting a command.
        //
        // iOS has no finer knob: that one `autocorrect` gates its autocorrection
        // AND its Telex conversion. Android's composing hangs off
        // `enableSuggestions` alone, so its autocorrect flag
        // (`TYPE_TEXT_FLAG_AUTO_CORRECT`) stays off there and Gboard rewrites
        // nothing that was typed.
        autocorrect: defaultTargetPlatform == TargetPlatform.iOS,
        enableSuggestions: _composesThroughSoftwareKeyboard,
        // Straight quotes and hyphens, always: `"` and `--flag` are syntax at a
        // prompt, not typography. Both default to ENABLED, and turning
        // autocorrect on above is what would finally let iOS act on them.
        smartDashesType: SmartDashesType.disabled,
        smartQuotesType: SmartQuotesType.disabled,
        // ⚠️ `false` here maps to Android's IME_FLAG_NO_PERSONALIZED_LEARNING,
        // which puts Gboard in INCOGNITO MODE — and incognito costs far more
        // than the learning it declines. Gboard replaces its toolbar with the
        // incognito glasses, and the clipboard goes with it: no pasting into a
        // terminal from anywhere else on the phone. The two are one switch in
        // Gboard, so a terminal that wants paste cannot also decline learning.
        //
        // Declining was the safer default and is no longer the right one: a
        // phone has no other way to get text INTO a pane, where a desktop has
        // ⌘V. The cost is real — Gboard now learns words typed at this prompt,
        // masked password prompts included, since a pty gives the keyboard no
        // way to know one is open.
        enableIMEPersonalizedLearning: true,
        allowedMimeTypes: widget.allowedMimeTypes,
      );

      _connection = TextInput.attach(this, config);

      _connection!.show();

      // setEditableRect(Rect.zero, Rect.zero);

      _connection!.setEditingState(_initEditingState);
    }
  }

  void _closeInputConnectionIfNeeded() {
    if (_connection != null && _connection!.attached) {
      _connection!.close();
      _connection = null;
    }

    // An IME can still have a pre-edit string while focus moves to another
    // terminal. That text belongs to the old native input connection and must
    // never remain painted (or be committed) in the newly focused terminal.
    resetEditingState();
  }

  TextEditingValue get _initEditingState => widget.deleteDetection
      ? const TextEditingValue(
          text: '  ',
          selection: TextSelection.collapsed(offset: 2),
        )
      : const TextEditingValue(
          text: '',
          selection: TextSelection.collapsed(offset: 0),
        );

  late var _currentEditingState = _initEditingState.copyWith();

  /// Text that has already been mirrored to the PTY. This deliberately stays
  /// separate from [_currentEditingState], whose composing range can contain
  /// marked text that must not reach the terminal before the IME commits it.
  late String _terminalText = _initEditingState.text;

  int _pendingDeleteSelectors = 0;
  Timer? _deleteSelectorTimer;

  @override
  TextEditingValue? get currentTextEditingValue {
    return _currentEditingState;
  }

  @override
  AutofillScope? get currentAutofillScope {
    return null;
  }

  /// The native buffer's text at the moment the terminal accepted an action.
  ///
  /// iOS answers Return by calling [performAction] and then inserting the
  /// newline into its own buffer anyway: `shouldChangeTextInRange:` returns YES
  /// for the default return key (Flutter's `FlutterTextInputPlugin.mm`). So a
  /// value the terminal has ALREADY acted on arrives right after the action —
  /// and by then [resetEditingState] has emptied the mirror, so diffing it
  /// retypes the whole line into the pty and follows it with a literal LF,
  /// which a TUI reads as Ctrl+J: a soft newline, not a submit. The line the
  /// user just sent is left sitting in the prompt underneath its own answer.
  ///
  /// Android performs the editor action without that second insert, and nothing
  /// it does send matches the shape [_consumeActionEcho] checks for.
  String? _pendingActionEcho;

  @override
  void updateEditingValue(TextEditingValue value) {
    if (_consumeActionEcho(value)) return;
    _applyEditingValue(
      value,
      hasTextMutation: value.text != _currentEditingState.text,
    );
  }

  /// Drops the newline described by [_pendingActionEcho] and puts the native
  /// buffer back on the state the action left, so the line the terminal was
  /// already sent cannot be typed a second time.
  ///
  /// One shot: whatever arrives first after an action disarms this, so real
  /// typing that follows a submit is never swallowed.
  bool _consumeActionEcho(TextEditingValue value) {
    final submitted = _pendingActionEcho;
    _pendingActionEcho = null;
    if (submitted == null) return false;
    // The newline either lands on the buffer the action was performed on, or
    // after this side's reset has already emptied it — whichever wins the race.
    // "Emptied" is the delete-detection padding when that is on.
    if (value.text != '$submitted\n' &&
        value.text != '${_initEditingState.text}\n') {
      return false;
    }
    _connection?.setEditingState(_currentEditingState);
    return true;
  }

  void _applyEditingValue(
    TextEditingValue value, {
    required bool hasTextMutation,
  }) {
    final wasComposing = !_currentEditingState.composing.isCollapsed;
    _currentEditingState = value;
    final isComposing = !_currentEditingState.composing.isCollapsed;

    if (hasTextMutation || wasComposing || isComposing) {
      // A text delta is authoritative. Any delete selector queued during the
      // same native input transaction is part of that replacement/composition
      // and must not be forwarded to the PTY a second time.
      _cancelPendingDeletes();
    }

    if (isComposing) {
      final text = _currentEditingState.text;
      final composingText = _currentEditingState.composing.textInside(text);

      // macOS can keep the whole editable buffer marked even after that exact
      // value has already been mirrored to the PTY. Painting it again leaves
      // a stale IME overlay (previously visible as an underline) until the
      // terminal is rebuilt. Only preview text that is genuinely ahead of the
      // terminal state; CJK/Japanese pre-edit text still takes this path.
      if (text == _terminalText) {
        widget.onComposing(null, 0);
        return;
      }

      widget.onComposing(
        composingText,
        _composingBacktrackCells(_currentEditingState.composing.start),
      );
      return;
    }

    widget.onComposing(null, 0);

    if (hasTextMutation || wasComposing || value.text != _terminalText) {
      _syncTerminalText(value.text);
    }
  }

  void _syncTerminalText(String value) {
    final edit = _TextEdit.between(_terminalText, value);
    if (edit.removed.isNotEmpty) {
      widget.onDelete(edit.removed.runes.length);
    }
    if (edit.inserted.isNotEmpty) {
      widget.onInsert(edit.inserted);
    }
    _terminalText = value;
    // ⚠️ The padding is spent one space per Backspace past the typed text, and
    // the buffer is kept between keys (Telex needs it), so nothing else puts it
    // back: two deletes into a line the keyboard never typed — a voice
    // transcript, a recalled command — and Backspace goes dead again.
    if (widget.deleteDetection && !value.startsWith(_initEditingState.text)) {
      resetEditingState();
    }
  }

  int _composingBacktrackCells(int composingStart) {
    if (composingStart < 0 || composingStart >= _terminalText.length) return 0;

    var width = 0;
    for (final rune in _terminalText.substring(composingStart).runes) {
      final runeWidth = unicodeV11.wcwidth(rune);
      if (runeWidth > 0) width += runeWidth;
    }
    return width;
  }

  @override
  void performAction(TextInputAction action) {
    // Captured before the handler runs: it is what the pty has been sent, and
    // what iOS is about to append its newline to. See [_pendingActionEcho].
    _pendingActionEcho = _currentEditingState.text;
    widget.onAction(action);
  }

  @override
  void performSelector(String selectorName) {
    if (!selectorName.startsWith('deleteBackward')) return;

    // A marked string belongs entirely to the IME. It will send a fresh
    // editing value after changing the pre-edit text, so nothing reaches the
    // terminal yet.
    if (!_currentEditingState.composing.isCollapsed) return;

    _pendingDeleteSelectors++;
    _deleteSelectorTimer ??= Timer(
      Duration.zero,
      _flushPendingDeleteSelectors,
    );
  }

  void _flushPendingDeleteSelectors() {
    _deleteSelectorTimer = null;
    final count = _pendingDeleteSelectors;
    _pendingDeleteSelectors = 0;

    if (count == 0 || !_currentEditingState.composing.isCollapsed) return;

    for (var index = 0; index < count; index++) {
      _applyNativeBackspace();
    }
  }

  void _applyNativeBackspace() {
    final value = _currentEditingState;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    final end = selection.end;
    final start = selection.isCollapsed
        ? _previousCodePointBoundary(value.text, end)
        : selection.start;

    if (start < end) {
      final next = value.copyWith(
        text: value.text.replaceRange(start, end, ''),
        selection: TextSelection.collapsed(offset: start),
        composing: TextRange.empty,
      );
      _currentEditingState = next;
      _connection?.setEditingState(next);
      _syncTerminalText(next.text);
      return;
    }

    // The native buffer can be empty at a shell prompt, but Backspace still
    // has meaning to the remote terminal.
    widget.onDelete(1);
  }

  void _cancelPendingDeletes() {
    _pendingDeleteSelectors = 0;
    _deleteSelectorTimer?.cancel();
    _deleteSelectorTimer = null;
  }

  int _previousCodePointBoundary(String text, int offset) {
    if (offset <= 0) return 0;
    final previous = text.codeUnitAt(offset - 1);
    if (previous >= 0xdc00 &&
        previous <= 0xdfff &&
        offset >= 2 &&
        text.codeUnitAt(offset - 2) >= 0xd800 &&
        text.codeUnitAt(offset - 2) <= 0xdbff) {
      return offset - 2;
    }
    return offset - 1;
  }

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {
    // print('updateFloatingCursor $point');
  }

  @override
  void didChangeInputControl(
    TextInputControl? oldControl,
    TextInputControl? newControl,
  ) {}

  @override
  void insertContent(KeyboardInsertedContent content) {
    widget.onContentInserted?.call(content);
  }

  @override
  bool onFocusReceived() => false;

  @override
  void showAutocorrectionPromptRect(int start, int end) {
    // print('showAutocorrectionPromptRect');
  }

  @override
  void connectionClosed() {
    // print('connectionClosed');
  }

  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {
    // print('performPrivateCommand $action');
  }

  @override
  void insertTextPlaceholder(Size size) {
    // print('insertTextPlaceholder');
  }

  @override
  void removeTextPlaceholder() {
    // print('removeTextPlaceholder');
  }

  @override
  void showToolbar() {
    // print('showToolbar');
  }
}

class _TextEdit {
  const _TextEdit({required this.removed, required this.inserted});

  factory _TextEdit.between(String before, String after) {
    var prefix = 0;
    final sharedLength =
        before.length < after.length ? before.length : after.length;
    while (prefix < sharedLength &&
        before.codeUnitAt(prefix) == after.codeUnitAt(prefix)) {
      prefix++;
    }

    return _TextEdit(
      // A PTY terminal edits at the current cursor; it cannot preserve a
      // common suffix while replacing an earlier character. Rewind the whole
      // suffix from the first difference, then replay the desired suffix.
      removed: before.substring(prefix),
      inserted: after.substring(prefix),
    );
  }

  final String removed;
  final String inserted;
}
