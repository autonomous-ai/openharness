/// One model the Lead may route to, as the backend stores it
/// (backend/src/superTabs/routingPolicy.ts).
class RoutingModel {
  const RoutingModel({
    required this.engine,
    required this.model,
    required this.effort,
    required this.quality,
    required this.cost,
    required this.enabled,
  });

  factory RoutingModel.fromJson(Map<String, dynamic> j) => RoutingModel(
    engine: j['engine'] as String,
    model: j['model'] as String,
    effort: j['effort'] as String,
    quality: (j['quality'] as num).toInt(),
    cost: (j['cost'] as num).toInt(),
    enabled: j['enabled'] == true,
  );

  final String engine, model, effort;
  final int quality, cost;
  final bool enabled;

  RoutingModel copyWith({int? quality, int? cost, bool? enabled}) =>
      RoutingModel(
        engine: engine,
        model: model,
        effort: effort,
        quality: quality ?? this.quality,
        cost: cost ?? this.cost,
        enabled: enabled ?? this.enabled,
      );

  Map<String, dynamic> toJson() => {
    'engine': engine,
    'model': model,
    'effort': effort,
    'quality': quality,
    'cost': cost,
    'enabled': enabled,
  };

  String get label =>
      '${engine == 'claude' ? 'Claude' : 'Codex'} '
      '${model == 'default' ? 'default model' : model}'
      '${effort == 'default' ? '' : ' $effort'}';
}

/// The Swarm routing policy: which models may be chosen, the quality each
/// difficulty needs, and how much quota to keep back.
class RoutingPolicy {
  const RoutingPolicy({
    required this.models,
    required this.floor,
    required this.quotaReserve,
    required this.notes,
  });

  factory RoutingPolicy.fromJson(Map<String, dynamic> j) {
    final floor = Map<String, dynamic>.from(j['floor'] as Map);
    return RoutingPolicy(
      models: [
        for (final m in j['models'] as List)
          RoutingModel.fromJson(Map<String, dynamic>.from(m as Map)),
      ],
      floor: {
        for (final k in const ['low', 'medium', 'high'])
          k: (floor[k] as num).toInt(),
      },
      quotaReserve: (j['quotaReserve'] as num).toInt(),
      notes: j['notes'] as String? ?? '',
    );
  }

  final List<RoutingModel> models;
  final Map<String, int> floor;
  final int quotaReserve;
  final String notes;

  RoutingPolicy copyWith({
    List<RoutingModel>? models,
    Map<String, int>? floor,
    int? quotaReserve,
    String? notes,
  }) => RoutingPolicy(
    models: models ?? this.models,
    floor: floor ?? this.floor,
    quotaReserve: quotaReserve ?? this.quotaReserve,
    notes: notes ?? this.notes,
  );

  Map<String, dynamic> toJson() => {
    'version': 1,
    'floor': floor,
    'quotaReserve': quotaReserve,
    'notes': notes,
    'models': [for (final m in models) m.toJson()],
  };

  /// This policy with one field taken from [other], for a field that goes back
  /// to the account default.
  RoutingPolicy takeField(String field, RoutingPolicy other) => switch (field) {
    'models' => copyWith(models: other.models),
    'floor' => copyWith(floor: other.floor),
    'quotaReserve' => copyWith(quotaReserve: other.quotaReserve),
    _ => copyWith(notes: other.notes),
  };

  /// Only the named fields, for a Swarm override.
  Map<String, dynamic> fields(Set<String> names) => {
    for (final e in toJson().entries)
      if (names.contains(e.key)) e.key: e.value,
  };
}
