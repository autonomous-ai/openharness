import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:xterm/src/ui/palette_builder.dart';
import 'package:xterm/xterm.dart';

/// The colours a terminal paints: what SGR 38/48 set, and what palette slot 15
/// holds.
void main() {
  int foreground(Terminal terminal) =>
      terminal.buffer.lines[0].getForeground(0) & ~CellColor.typeMask;
  int foregroundType(Terminal terminal) =>
      terminal.buffer.lines[0].getForeground(0) & CellColor.typeMask;

  test('a 256-colour and a truecolour foreground land on the cell', () {
    final indexed = Terminal()..write('\u001b[38;5;244mX');
    expect(foregroundType(indexed), CellColor.palette);
    expect(foreground(indexed), 244);

    final rgb = Terminal()..write('\u001b[38;2;1;2;3mX');
    expect(foregroundType(rgb), CellColor.rgb);
    expect(foreground(rgb), 0x010203);
  });

  // A malformed colour used to index past the parameters and throw, which
  // failed the renderer and forced a resync for one bad sequence.
  test(
    'a colour cut short is dropped without throwing, and so is the rest of it',
    () {
      for (final cut in [
        '\u001b[38;2;1m',
        '\u001b[48;2;1;2m',
        '\u001b[38;5m',
        '\u001b[38m',
      ]) {
        final terminal = Terminal();
        expect(() => terminal.write('${cut}X'), returnsNormally, reason: cut);
        expect(foregroundType(terminal), CellColor.normal, reason: cut);
      }
      // What came before the cut colour still applies.
      final faint = Terminal()..write('\u001b[2;38;2;1mX');
      expect(
        faint.buffer.lines[0].getAttributes(0) & CellAttr.faint,
        CellAttr.faint,
      );
    },
  );

  test('palette slot 15 is bright white, not white', () {
    final palette = PaletteBuilder(darkTerminalTheme).build();
    expect(palette[15], darkTerminalTheme.brightWhite);
    expect(palette[7], darkTerminalTheme.white);
  });
}
