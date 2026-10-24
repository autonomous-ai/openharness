import 'package:flutter_test/flutter_test.dart';
import 'package:harness/models/coding_model.dart';
import 'package:harness/models/local_model.dart';

LocalModel _model(Map<String, Object?> json) =>
    LocalModel.fromJson({'id': 'm', 'state': 'downloaded', ...json});

void main() {
  test('reads the parameter count off a name: the total, never an active count', () {
    expect(paramsFromName('llama3.2:3b'), 3);
    expect(paramsFromName('Qwen3.6-35B-A3B'), 35);
    expect(paramsFromName('mixtral-8x7b'), isNull);
    expect(paramsFromName('gemma-4-E2B-it'), isNull);
  });

  test('refuses a model too small or too slow, as the CLI does, and lets anything unknown pass', () {
    expect(
      codingRefusal(_model({'name': 'llama3.2:3b'})),
      'llama3.2:3b is too small for a coding agent (about 3B parameters; Builders need 7B or more).',
    );
    expect(
      codingRefusal(_model({'name': 'gemma-4-E2B-it', 'sizeBytes': 3.2e9})),
      'gemma-4-E2B-it is too small for a coding agent (about 5.3B parameters; Builders need 7B or more).',
    );
    expect(
      codingRefusal(_model({'name': 'm', 'sizeBytes': 16e9, 'quant': 'BF16'})),
      isNull,
    );
    expect(
      codingRefusal(_model({'name': 'm', 'sizeBytes': 4.3e9, 'quant': 'IQ4_XS'})),
      isNull,
    );
    expect(
      codingRefusal(_model({'name': 'm', 'sizeBytes': 4.25e9, 'quant': 'MXFP4'})),
      isNull,
    );
    expect(
      codingRefusal(_model({'name': 'Qwen3.6-35B-A3B', 'estTokS': 4.4})),
      'Qwen3.6-35B-A3B is too slow on this computer for a coding agent (about 4 tok/s; Builders need 10 or more).',
    );
    expect(
      codingRefusal(_model({'name': 'Qwen3.6-35B-A3B', 'paramsB': 35, 'estTokS': 30})),
      isNull,
    );
    expect(codingRefusal(_model({'name': 'mystery'})), isNull);
  });
}
