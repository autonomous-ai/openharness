import 'local_model.dart';

/// Whether a local model is likely to drive a coding agent well: the CLI's rule (`cli/src/lib/codingModel.ts`), here as
/// a note beside Get and Run for Swarm, never a refusal (project instructions, decision 14). 2026-10-24: an agent on
/// llama3.2:3b made over a thousand requests for a one-line edit and never finished.
const minCodingParamsB = 7.0;
const minCodingTokS = 10.0;

double _bitsPerWeight(String? quant) {
  final q = (quant ?? '').toUpperCase();
  if (q.contains('MXFP4')) return 4.25;
  if (RegExp(r'BF16|FP16|F16').hasMatch(q)) return 16;
  final digit = RegExp(r'(IQ|Q)(\d)').firstMatch(q);
  return digit == null
      ? 4.8
      : int.parse(digit.group(2)!) + (digit.group(1) == 'IQ' ? 0.3 : 0.8);
}

/// The parameter count a model's name gives (`llama3.2:3b`, `Qwen3.6-35B-A3B`: the total, not the active `A3B`).
double? paramsFromName(String name) {
  final match = RegExp(
    r'(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])',
    caseSensitive: false,
  ).firstMatch(name);
  return match == null ? null : double.parse(match.group(1)!);
}

/// Why [model] may struggle to drive a coding agent, in a sentence, or null when it should not or nothing says.
String? codingNote(LocalModel model) {
  final size = model.sizeBytes;
  final params =
      model.paramsB ??
      paramsFromName(model.name) ??
      (size == null || size <= 0
          ? null
          : size * 8 / _bitsPerWeight(model.quantization) / 1e9);
  if (params != null && params < minCodingParamsB) {
    final shown = (params * 10).round() / 10;
    return '${model.shownName} may be too small for a coding agent (about '
        '${shown == shown.roundToDouble() ? shown.toInt() : shown}B parameters; '
        'a coding agent usually needs ${minCodingParamsB.toInt()}B or more).';
  }
  final speed = model.tokensPerSecond ?? model.estTokS;
  if (speed != null && speed < minCodingTokS) {
    return '${model.shownName} may be too slow on this computer for a coding agent '
        '(about ${speed.round()} tok/s; a coding agent usually needs ${minCodingTokS.toInt()} or more).';
  }
  return null;
}
