import 'package:flutter/material.dart';

/// Provider artwork for known models; the brain identifies Models and unknown models.
class ModelMark extends StatelessWidget {
  const ModelMark({super.key, this.model, this.size = 22, this.semanticLabel});

  final String? model;
  final double size;
  final String? semanticLabel;

  static const _brands = {
    'qwen': 'qwen',
    'qwq': 'qwen',
    'gemma': 'gemma',
    'deepseek': 'deepseek',
    'gpt-oss': 'openai',
    'openai': 'openai',
    'codex': 'openai',
    'llama': 'meta',
    'mistral': 'mistral',
    'mixtral': 'mistral',
    'ministral': 'mistral',
    'codestral': 'mistral',
    'devstral': 'mistral',
    'phi': 'microsoft',
    'glm': 'zai',
    'zai': 'zai',
    'kimi': 'kimi',
    'claude': 'claude',
    'anthropic': 'claude',
  };
  static final _family = RegExp(
    '(?:^|[^a-z0-9])(${_brands.keys.join('|')})(?=\$|[^a-z])',
  );

  /// Match the model name, not a hosting organization or a coincidental substring.
  /// The first family wins for names such as DeepSeek-R1-Distill-Qwen.
  static String? assetFor(String? model) {
    final name = model?.trim().toLowerCase().split('/').last ?? '';
    final family = _family.firstMatch(name)?.group(1);
    return family == null ? null : 'assets/model-icons/${_brands[family]}.png';
  }

  @override
  Widget build(BuildContext context) {
    final asset = assetFor(model);
    final light = Theme.of(context).brightness == Brightness.light;
    final monochrome =
        asset == 'assets/model-icons/openai.png' ||
        asset == 'assets/model-icons/zai.png';
    return Image.asset(
      asset ?? 'assets/models.png',
      width: size,
      height: size,
      filterQuality: FilterQuality.high,
      color: monochrome
          ? (light ? const Color(0xff252429) : const Color(0xffeeeef0))
          : asset == null && light
          ? const Color(0xff7051c9)
          : null,
      semanticLabel: semanticLabel,
      excludeFromSemantics: semanticLabel == null,
    );
  }
}
