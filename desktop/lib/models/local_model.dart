/// The local daemon reports lifecycle and measured telemetry. Unknown values
/// stay absent; a weights file's size is never relabelled as memory use.
class LocalModel {
  const LocalModel({
    required this.id,
    required this.name,
    this.state = 'available',
    this.sizeBytes,
    this.quant,
    this.recommended = false,
    this.canStart = false,
    this.canStop = false,
    this.tokensPerSecond,
    this.requests,
    this.windowSeconds,
    this.operation,
    this.gridAsleep = false,
    this.contextWindow,
    this.estTokS,
    this.paramsB,
    this.app,
    this.decision = false,
  });
  final String id, name, state;

  /// A Jev (System One) decision model (`kind: decision`): Get downloads it, updates Grid's engine when
  /// it is too old to serve one, and runs it on the grid — it is called, never a harness's model. False
  /// for every chat model, and from an older daemon.

  /// The app this model was downloaded with and starts in (`Ollama`, `LM Studio`, `llama.cpp`): one found
  /// in that app's folder. Null for Grid's own models, and from an older daemon.
  final String? app;
  final String? quant;
  final double? sizeBytes, tokensPerSecond, requests, windowSeconds;
  final bool recommended, canStart, canStop;
  final LocalModelOperation? operation;

  /// What the grid catalog expects of this model on its machine, for choosing before a download:
  /// the window it is given, its estimated speed, and its size in billions of parameters. Absent
  /// for weights found on disk, which the catalog never sized, and from an older daemon.
  final double? contextWindow, estTokS, paramsB;

  /// Running here, parked while the account's own grid sleeps (`gridAsleep`). It answers again by
  /// itself on the next message, so the row says so rather than reading as a plain `running`. An
  /// older daemon never sends it.
  final bool gridAsleep;
  final bool decision;
  bool get running => state == 'running';

  /// Running, and resting until somebody sends a message — see [gridAsleep].
  bool get resting => running && gridAsleep;
  bool get downloaded => state == 'downloaded' || running;

  /// Imported weights can omit `quant`, but their filename still names the
  /// exact variant. Never infer quantization from size or model family.
  String? get quantization {
    if (quant?.trim().isNotEmpty == true) return quant!.trim();
    return RegExp(
      r'(?:^|[^a-z0-9])(IQ\d+[a-z0-9_]*|Q\d+[a-z0-9_]*|MXFP\d+(?:_[a-z0-9]+)*|BF16|FP16|F16)(?=[^a-z0-9_]|$)',
      caseSensitive: false,
    ).firstMatch(id)?.group(1)?.toUpperCase();
  }

  String get displayName {
    final variant = quantization;
    if (variant == null || variant.isEmpty) return name;
    final present = RegExp(
      '(^|[^a-z0-9])${RegExp.escape(variant.toLowerCase())}([^a-z0-9]|\$)',
    ).hasMatch(name.toLowerCase());
    return present ? name : '$name · $variant';
  }

  factory LocalModel.fromJson(Map<String, dynamic> data) => LocalModel(
    id: data['id'] as String? ?? '',
    name: data['name'] as String? ?? '',
    state: data['state'] as String? ?? 'available',
    sizeBytes: _number(data['sizeBytes']),
    quant: data['quant'] as String?,
    recommended: data['recommended'] == true,
    canStart: data['canStart'] == true,
    canStop: data['canStop'] == true,
    tokensPerSecond: _number(data['tokensPerSecond']),
    requests: _number(data['requests']),
    windowSeconds: _number(data['windowSeconds']),
    operation: LocalModelOperation.parse(data['operation']),
    gridAsleep: data['gridAsleep'] == true,
    contextWindow: _number(data['contextWindow']),
    estTokS: _number(data['estTokS']),
    paramsB: _number(data['paramsB']),
    app: switch (data['app']) {
      final String app when app.trim().isNotEmpty => app.trim(),
      _ => null,
    },
    decision: data['kind'] == 'decision',
  );
}

class LocalModelOperation {
  const LocalModelOperation({
    required this.id,
    required this.modelId,
    required this.action,
    required this.stage,
    required this.phase,
    this.progress,
    this.error,
  });
  final String id, modelId, action, stage, phase;
  final double? progress;
  final String? error;
  bool get active => phase == 'running';
  bool get failed => phase == 'failed';
  bool get started => phase == 'done' && action == 'start';
  String get label => switch (stage) {
    'downloading' => 'Downloading',
    'updating' => 'Updating engine',
    'starting' => 'Starting',
    'verifying' => 'Testing',
    'stopping' => 'Stopping',
    _ => 'Checking',
  };
  static LocalModelOperation? parse(Object? raw) {
    if (raw is! Map<String, dynamic> ||
        raw['id'] is! String ||
        raw['modelId'] is! String ||
        !['download', 'start', 'stop'].contains(raw['action']) ||
        ![
          'checking',
          'downloading',
          'updating',
          'starting',
          'verifying',
          'stopping',
        ].contains(raw['stage']) ||
        !['running', 'done', 'failed'].contains(raw['phase'])) {
      return null;
    }
    return LocalModelOperation(
      id: raw['id'] as String,
      modelId: raw['modelId'] as String,
      action: raw['action'] as String,
      stage: raw['stage'] as String,
      phase: raw['phase'] as String,
      progress: _number(raw['progress'])?.clamp(0, 1),
      error: raw['error'] as String?,
    );
  }
}

double? _number(Object? value) =>
    value is num && value.isFinite && value >= 0 ? value.toDouble() : null;
