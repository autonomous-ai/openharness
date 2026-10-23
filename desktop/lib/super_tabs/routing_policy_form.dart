import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/widgets/setting_row.dart';
import 'routing_policy.dart';

/// The routing policy editor, used by Settings ▸ Routing (the account default)
/// and by a Swarm's Routing dialog (override mode, with Use account
/// default).
///
/// A number outside what the backend accepts is flagged under its field and is
/// never passed to [onChanged]; [onValidChanged] says whether every field is
/// acceptable, so the host can hold Save back.
class RoutingPolicyForm extends StatefulWidget {
  const RoutingPolicyForm({
    super.key,
    required this.value,
    required this.onChanged,
    this.onValidChanged,
    this.overridden,
    this.onUseDefault,
    this.readOnly = false,
  });
  final RoutingPolicy value;
  final ValueChanged<RoutingPolicy> onChanged;
  final ValueChanged<bool>? onValidChanged;
  final Set<String>? overridden;
  final ValueChanged<String>? onUseDefault;
  final bool readOnly;

  @override
  State<RoutingPolicyForm> createState() => _RoutingPolicyFormState();
}

class _RoutingPolicyFormState extends State<RoutingPolicyForm> {
  final _invalid = <Key>{};
  // Bumped when a field goes back to the account default, so its inputs start
  // again from the value now shown instead of what was typed.
  final _restarts = <String, int>{};
  static const _keyPrefix = {
    'models': 'routing-model-',
    'floor': 'routing-floor-',
    'quotaReserve': 'routing-reserve',
  };

  RoutingPolicy get _value => widget.value;

  void _number(Key key, String text, int min, int max, ValueChanged<int> set) {
    final n = int.tryParse(text);
    final ok = n != null && n >= min && n <= max;
    final wasValid = _invalid.isEmpty;
    setState(() => ok ? _invalid.remove(key) : _invalid.add(key));
    if (wasValid != _invalid.isEmpty) {
      widget.onValidChanged?.call(_invalid.isEmpty);
    }
    if (ok) set(n);
  }

  void _useDefault(String field) {
    final wasValid = _invalid.isEmpty;
    final prefix = _keyPrefix[field];
    setState(() {
      _restarts[field] = (_restarts[field] ?? 0) + 1;
      if (prefix != null) {
        _invalid.removeWhere(
          (k) => (k as ValueKey<String>).value.startsWith(prefix),
        );
      }
    });
    if (wasValid != _invalid.isEmpty) {
      widget.onValidChanged?.call(_invalid.isEmpty);
    }
    widget.onUseDefault!(field);
  }

  Widget _field(
    Key key,
    String label,
    int current,
    int min,
    int max,
    ValueChanged<int> set,
  ) => SizedBox(
    width: 104,
    child: TextFormField(
      key: key,
      initialValue: '$current',
      enabled: !widget.readOnly,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: InputDecoration(
        labelText: label,
        isDense: true,
        errorText: _invalid.contains(key) ? 'Use $min–$max' : null,
      ),
      onChanged: (text) => _number(key, text, min, max, set),
    ),
  );

  /// The setting block: its title and detail, the per-field reset when this
  /// field is overridden, and its editor underneath.
  Widget _block(String field, String title, String detail, Widget editor) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: SettingRow(
          title: title,
          detail: detail,
          control:
              widget.overridden?.contains(field) == true &&
                  widget.onUseDefault != null &&
                  !widget.readOnly
              ? TextButton(
                  onPressed: () => _useDefault(field),
                  child: const Text('Use account default'),
                )
              : const SizedBox.shrink(),
          footer: KeyedSubtree(
            key: ValueKey('$field-${_restarts[field] ?? 0}'),
            child: editor,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    List<RoutingModel> withModel(int i, RoutingModel m) =>
        [..._value.models]..[i] = m;
    const reserveKey = ValueKey('routing-reserve');
    final rangeError = Theme.of(context).colorScheme.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _block(
          'models',
          'Models',
          'Quality 1–3 and relative cost 1–100 decide who is chosen. Turn a model off to never use it.',
          Column(
            children: [
              for (final (i, m) in _value.models.indexed)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Switch(
                        key: ValueKey('routing-model-enabled-$i'),
                        value: m.enabled,
                        onChanged: widget.readOnly
                            ? null
                            : (on) => widget.onChanged(
                                _value.copyWith(
                                  models: withModel(i, m.copyWith(enabled: on)),
                                ),
                              ),
                      ),
                      SizedBox(width: 180, child: Text(m.label)),
                      _field(
                        ValueKey('routing-model-quality-$i'),
                        'Quality',
                        m.quality,
                        1,
                        3,
                        (q) => widget.onChanged(
                          _value.copyWith(
                            models: withModel(i, m.copyWith(quality: q)),
                          ),
                        ),
                      ),
                      _field(
                        ValueKey('routing-model-cost-$i'),
                        'Cost',
                        m.cost,
                        1,
                        100,
                        (c) => widget.onChanged(
                          _value.copyWith(
                            models: withModel(i, m.copyWith(cost: c)),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        _block(
          'floor',
          'Quality floor by difficulty',
          'The lowest quality (1–3) a model needs for a task of that difficulty. High risk raises the floor by one.',
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              for (final level in const ['low', 'medium', 'high'])
                _field(
                  ValueKey('routing-floor-$level'),
                  '${level[0].toUpperCase()}${level.substring(1)}',
                  _value.floor[level]!,
                  1,
                  3,
                  (n) => widget.onChanged(
                    _value.copyWith(floor: {..._value.floor, level: n}),
                  ),
                ),
            ],
          ),
        ),
        _block(
          'quotaReserve',
          'Quota reserve',
          'Percent of an account’s quota to keep back. Below this, the account is used only when nothing else can run the task.',
          Row(
            children: [
              SizedBox(
                width: 120,
                child: TextFormField(
                  key: reserveKey,
                  initialValue: '${_value.quotaReserve}',
                  enabled: !widget.readOnly,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(
                    isDense: true,
                    suffixText: '%',
                  ),
                  onChanged: (text) => _number(
                    reserveKey,
                    text,
                    0,
                    90,
                    (n) => widget.onChanged(_value.copyWith(quotaReserve: n)),
                  ),
                ),
              ),
              if (_invalid.contains(reserveKey))
                Padding(
                  padding: const EdgeInsets.only(left: 12),
                  child: Text(
                    'Enter a number from 0 to 90.',
                    style: small?.copyWith(color: rangeError),
                  ),
                ),
            ],
          ),
        ),
        _block(
          'notes',
          'Notes for Jev',
          'Anything the product manager should weigh when choosing, in plain words.',
          TextFormField(
            key: const ValueKey('routing-notes'),
            initialValue: _value.notes,
            enabled: !widget.readOnly,
            maxLength: 500,
            maxLines: 3,
            decoration: const InputDecoration(
              hintText: 'For example: frontend prefers Claude; long jobs on remote-1.',
            ),
            onChanged: (text) => widget.onChanged(_value.copyWith(notes: text)),
          ),
        ),
      ],
    );
  }
}
