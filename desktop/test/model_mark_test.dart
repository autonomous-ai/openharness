import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/models/model_mark.dart';

void main() {
  test(
    'recognizes model families across hosts, versions and quantizations',
    () {
      const names = {
        'Qwen/Qwen3.8-27B': 'qwen',
        'unsloth/Qwen3-Coder-30B-A3B-Q4_K_M.gguf': 'qwen',
        'M2-qwen3.8-27b': 'qwen',
        'QwQ-32B': 'qwen',
        'google/gemma-4-12b-it': 'gemma',
        'DeepSeek-R1-Distill-Qwen-32B': 'deepseek',
        'openai/gpt-oss-20b': 'openai',
        'OpenAI': 'openai',
        'Codex': 'openai',
        'meta-llama/Llama-3.3-70B-Instruct': 'meta',
        'Mistral-Small-3.2': 'mistral',
        'Mixtral-8x7B': 'mistral',
        'Ministral-8B': 'mistral',
        'Codestral-22B': 'mistral',
        'Devstral-Small-24B': 'mistral',
        'microsoft/Phi-4-mini-instruct': 'microsoft',
        'zai-org/GLM-4.5': 'zai',
        'Zai': 'zai',
        'moonshotai/Kimi-K2': 'kimi',
        'Claude': 'claude',
        'Anthropic': 'claude',
      };
      for (final entry in names.entries) {
        expect(
          ModelMark.assetFor(entry.key),
          'assets/model-icons/${entry.value}.png',
          reason: entry.key,
        );
      }
      for (final unknown in [
        null,
        '',
        'Team coding model',
        'qwen-owner/custom-model',
        'Gemmax',
        'Alphine',
      ]) {
        expect(ModelMark.assetFor(unknown), isNull, reason: '$unknown');
      }
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'all model marks render in ${brightness.name}, unknowns use the brain',
      (tester) async {
        const models = [
          'Qwen3',
          'Gemma-4',
          'GPT-OSS',
          'DeepSeek',
          'Llama',
          'Mistral',
          'Phi-4',
          'GLM-4',
          'Kimi',
          'Claude',
          'Team coding model',
        ];
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData(brightness: brightness),
            home: Scaffold(
              body: Wrap(
                children: [
                  const ModelMark(semanticLabel: 'AI Models'),
                  for (final model in models) ModelMark(model: model),
                ],
              ),
            ),
          ),
        );
        await tester.runAsync(() async {
          for (final image in tester.widgetList<Image>(find.byType(Image))) {
            await precacheImage(image.image, tester.element(find.byType(Wrap)));
          }
        });
        await tester.pump();
        final images = tester.widgetList<Image>(find.byType(Image)).toList();
        expect(images.length, models.length + 1);
        expect(
          (images.first.image as AssetImage).assetName,
          'assets/models.png',
        );
        expect(
          (images.last.image as AssetImage).assetName,
          'assets/models.png',
        );
        expect(images.first.semanticLabel, 'AI Models');
        expect(tester.takeException(), isNull);
      },
    );
  }
}
