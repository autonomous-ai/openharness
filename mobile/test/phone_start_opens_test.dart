import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/machines_tab.dart';

void main() {
  // MSI, 2026-11-26: Harness OS's screen started a terminal as it signed in, and Start opened that shell.
  test('Start never opens a plain terminal, and makes an OpenCode where that is all there is', () {
    final shell = Agent.fromJson({'id': 't', 'name': 'bash', 'engine': 'terminal'});
    final opencode = Agent.fromJson({'id': 'o', 'name': 'opencode-2026-11-26', 'engine': 'opencode'});
    final claude = Agent.fromJson({'id': 'c', 'name': 'claude-2026-11-26', 'engine': 'claude'});

    expect(startOpens([shell]), isNull);
    expect(startOpens([shell, claude, opencode])?.id, 'o');
    expect(startOpens([shell, claude])?.id, 'c');
    expect(startOpens(const []), isNull);
  });
}
