import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/opencode_footer.dart';
import 'package:xterm/xterm.dart';

Terminal _screen(String text) => Terminal(maxLines: 50)
  ..resize(60, 8)
  ..write(text.replaceAll('\n', '\r\n'));

void main() {
  test('names the model and variant OpenCode\'s footer says it runs', () {
    // As OpenCode 2.2 draws it on MSI, before anybody has written to it.
    expect(
      opencodeFooter(
        _screen(
          '  ┃\n  ┃  Build · Big Pickle OpenCode\n'
          '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  …/opencode…  shift+tab agents',
        ),
      ),
      (name: 'Big Pickle', effort: null),
    );
    // A variant after it, a provider that may be part of the name, a name a phone's width cut short.
    expect(
      opencodeFooter(
        _screen('  ┃  Build auto · Ox Alpha Free OpenCode Zen · high'),
      ),
      (name: 'Ox Alpha Free', effort: 'high'),
    );
    expect(opencodeFooter(_screen('  ┃  Plan · MiniMax M3 Vibe Gateway')), (
      name: 'MiniMax M3 Vibe Gateway',
      effort: null,
    ));
    expect(
      opencodeFooter(_screen('  ┃  Build · DeepSeek V4.1 Flash F… · high')),
      (name: 'DeepSeek V4.1 Flash F…', effort: 'high'),
    );
  });

  test('none where no footer is on screen', () {
    expect(opencodeFooter(_screen('loading…')), isNull);
    expect(opencodeFooter(_screen('  ┃  Build ·')), isNull);
  });
}
