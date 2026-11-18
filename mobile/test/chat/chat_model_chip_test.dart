import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/terminal_page.dart';

void main() {
  test('an OpenCode chip names the model as its footer does, the id the machine reports when no footer is on screen', () {
    const id = '774b61bd-dd52-4d12-9e76-275325cabc65';
    final agent = Agent.fromJson({
      'id': id,
      'engine': 'opencode',
      'selectedModel':
          'runtime-v1:$id:opencode:${Uri.encodeComponent('opencode/deepseek-v4.1-flash-free')}@auto',
    });

    expect(
      chatModelChip(
        agent,
        () => (name: 'DeepSeek V4.1 Flash Free', effort: null),
      ),
      'OpenCode DeepSeek V4.1 Flash Free',
    );
    expect(
      chatModelChip(agent, () => null),
      'OpenCode opencode/deepseek-v4.1-flash-free · Auto',
    );
  });

  test('only OpenCode reads its footer', () {
    final agent = Agent.fromJson({
      'id': 'a',
      'engine': 'claude',
      'selectedModel': 'runtime-v1:a:claude:claude-opus-5-5@high',
    });
    expect(
      chatModelChip(agent, () => (name: 'Something else', effort: null)),
      'Claude Opus 5.5 · High',
    );
  });
}
