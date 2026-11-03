import 'package:flutter_test/flutter_test.dart';
import 'package:harness/models/coding_model.dart';
import 'package:harness/models/local_model.dart';

LocalModel _model(Map<String, Object?> json) =>
    LocalModel.fromJson({'id': 'm', 'state': 'downloaded', ...json});

void main() {
  test(
    'reads the parameter count off a name: the total, never an active count',
    () {
      expect(paramsFromName('llama3.2:3b'), 3);
      expect(paramsFromName('Qwen3.6-35B-A3B'), 35);
      expect(paramsFromName('mixtral-8x7b'), isNull);
      expect(paramsFromName('gemma-4-E2B-it'), isNull);
    },
  );

  test('notes a model too small or too slow, by the CLI\'s rule, and lets anything unknown pass', () {
    expect(
      codingNote(_model({'name': 'llama3.2:3b'})),
      'llama3.2:3b may be too small for a coding agent (about 3B parameters; a coding agent usually needs 7B or more).',
    );
    expect(
      codingNote(_model({'name': 'gemma-4-E2B-it', 'sizeBytes': 3.2e9})),
      'gemma-4-E2B-it may be too small for a coding agent (about 5.3B parameters; a coding agent usually needs 7B or more).',
    );
    expect(
      codingNote(_model({'name': 'm', 'sizeBytes': 16e9, 'quant': 'BF16'})),
      isNull,
    );
    expect(
      codingNote(_model({'name': 'm', 'sizeBytes': 4.3e9, 'quant': 'IQ4_XS'})),
      isNull,
    );
    expect(
      codingNote(_model({'name': 'm', 'sizeBytes': 4.25e9, 'quant': 'MXFP4'})),
      isNull,
    );
    expect(
      codingNote(_model({'name': 'Qwen3.6-35B-A3B', 'estTokS': 4.4})),
      'Qwen3.6-35B-A3B may be too slow on this computer for a coding agent (about 4 tok/s; a coding agent usually needs 10 or more).',
    );
    expect(
      codingNote(
        _model({'name': 'Qwen3.6-35B-A3B', 'paramsB': 35, 'estTokS': 30}),
      ),
      isNull,
    );
    expect(codingNote(_model({'name': 'mystery'})), isNull);
    // A note, never a rule about roles.
    for (final name in ['llama3.2:3b', 'qwen3:4b']) {
      expect(codingNote(_model({'name': name})), isNot(contains('Builders')));
    }
  });
}
