/// AUTONOMOUS PATCH: where the input path tells an embedder what it did — each
/// edit the keyboard sent, what of it reached the terminal, the keyboard's
/// buffer being reset, an echo predicted, a paint's cost — for the embedder's
/// log. Null, the default, says nothing and costs a null check; the app sets it
/// only in a build that asks for its typing trace.
void Function(String message)? xtermInputTrace;

/// [message] for [xtermInputTrace], built only when somebody listens.
void inputTrace(String Function() message) {
  final trace = xtermInputTrace;
  if (trace != null) trace(message());
}

/// [text] for a trace line: its last [max] characters, control characters
/// spelled out so a line of the log stays one line.
String traceText(String text, {int max = 32}) {
  final tail = text.length <= max ? text : text.substring(text.length - max);
  final out = StringBuffer(text.length > max ? '…' : '');
  for (final unit in tail.codeUnits) {
    if (unit == 0x0d) {
      out.write(r'\r');
    } else if (unit == 0x0a) {
      out.write(r'\n');
    } else if (unit == 0x1b) {
      out.write(r'\e');
    } else if (unit < 0x20 || unit == 0x7f) {
      out.write('\\x${unit.toRadixString(16).padLeft(2, '0')}');
    } else {
      out.writeCharCode(unit);
    }
  }
  return out.toString();
}

/// Where [inputTrace] was called from, two frames up — for the calls that
/// matter by who made them (the keyboard's buffer being reset).
String traceCaller() {
  final frames = StackTrace.current.toString().split('\n');
  return frames
      .skip(2)
      .take(2)
      .map((frame) => frame.replaceFirst(RegExp(r'^#\d+\s+'), '').trim())
      .join(' ← ');
}
