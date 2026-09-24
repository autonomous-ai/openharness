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
  });
  final String id, name, state;
  final String? quant;
  final double? sizeBytes, tokensPerSecond, requests, windowSeconds;
  final bool recommended, canStart, canStop;
  final LocalModelOperation? operation;

  /// Running here, parked while the account's own grid sleeps (`gridAsleep`). It answers again by
  /// itself on the next message, so the row says so rather than reading as a plain `running`. An
  /// older daemon never sends it.
  final bool gridAsleep;
  bool get running => state == 'running';

  /// Running, and resting until somebody sends a message — see [gridAsleep].
  bool get resting => running && gridAsleep;
  bool get downloaded => state == 'downloaded' || running;

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
    'starting' => 'Starting',
    'verifying' => 'Testing',
    'stopping' => 'Stopping',
    _ => 'Checking',
  };
  static LocalModelOperation? parse(Object? raw) {
    if (raw is! Map<String, dynamic> ||
        raw['id'] is! String ||
        raw['modelId'] is! String ||
        !['start', 'stop'].contains(raw['action']) ||
        ![
          'checking',
          'downloading',
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
