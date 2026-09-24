import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_model_name.dart';

void main() {
  test('observed model names preserve identity and never infer a version', () {
    for (final (engine, model, label) in [
      ('codex', 'gpt-6-astra', 'GPT-6 Astra'),
      ('codex', 'gpt-5.6-sol', 'GPT-5.6 Sol'),
      ('codex', 'gpt-5.6', 'GPT-5.6'),
      ('claude', 'fable', 'Fable'),
      ('claude', 'opus', 'Opus'),
      ('claude', 'claude-opus-5', 'Opus 5'),
      ('claude', 'claude-sonnet-4-6[1m]', 'Sonnet 4.6[1m]'),
      ('claude', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'),
      ('opencode', 'provider/Model-Next', 'provider/Model-Next'),
    ]) {
      expect(
        runtimeModelName(
          'runtime-v1:a%3A1:$engine:${Uri.encodeComponent(model)}@high',
          agentId: 'a:1',
          engine: engine,
        ),
        label,
      );
    }
  });

  test('missing, stale and malformed runtime metadata has no model label', () {
    for (final value in <Object?>[
      null,
      42,
      '',
      'gpt-6-astra',
      'x' * 1025,
      'runtime-v2:a:codex:gpt-6-astra@high',
      'runtime-v1:a:claude:opus@high',
      'runtime-v1:other:codex:gpt-6-astra@high',
      'runtime-v1:%ZZ:codex:gpt-6-astra@high',
      'runtime-v1:a:codex:%ZZ@high',
      'runtime-v1:a:codex:%FF@high',
      'runtime-v1:a:codex:%C0%80@high',
      'runtime-v1:a:codex:%20@high',
      'runtime-v1:a:codex:model%0Aname@high',
      'runtime-v1:a:codex:${'x' * 257}@high',
    ]) {
      expect(
        runtimeModelName(value, agentId: 'a', engine: 'codex'),
        isNull,
        reason: '$value',
      );
    }
    expect(
      runtimeModelName('runtime-v1:a:codex:gpt-6-astra@high', agentId: 'a'),
      isNull,
    );
  });
}
