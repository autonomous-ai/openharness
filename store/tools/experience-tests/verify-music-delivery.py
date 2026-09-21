#!/usr/bin/env python3
"""Independent delivery reader: Python wave/zipfile + mido (not the JS writer).
Install mido==1.3.3 in a disposable venv. Pass a production ZIP or delivery folder.
This verifies interoperability and stem summation, never musical quality.
"""
import array
import io
import json
import math
from pathlib import Path
import sys
import wave
import zipfile
import mido

path = Path(sys.argv[1])
bundle = zipfile.ZipFile(path if path.suffix == '.zip' else path / 'production.zip')
assert bundle.testzip() is None, 'ZIP CRC failed'
project = json.loads(bundle.read('project.afterhours.json'))
report = json.loads(bundle.read('delivery.json'))

def read_wave(name):
    with wave.open(io.BytesIO(bundle.read(name)), 'rb') as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (2, 48000, 2)
        assert abs(w.getnframes() / w.getframerate() - report['duration']) < 1 / 48000
        samples = array.array('h', w.readframes(w.getnframes()))
        if sys.byteorder != 'little':
            samples.byteswap()
        return samples

mix = read_wave('mix.wav')
stems = [read_wave('stems/' + t['file']) for t in report['stems']]
assert all(len(s) == len(mix) for s in stems), 'Stems are not aligned'
maximum_error = max((abs(sum(values[1:]) - values[0]) for values in zip(mix, *stems)), default=0)
assert maximum_error <= math.ceil((len(stems) + 1) / 2) + 1, ('Stem sum mismatch', maximum_error)
assert max(map(abs, mix)) < 32767, 'Clipped output'
assert any(abs(x) > 10 for x in mix), 'Silent output'

midi = mido.MidiFile(file=io.BytesIO(bundle.read('composition.mid')))
expected = [t for t in project['tracks'] if t['notes']]
actual = []
tempos, meters, markers = [], [], []
for track in midi.tracks:
    tick, pending, notes, name = 0, {}, [], ''
    for msg in track:
        tick += msg.time
        if msg.type == 'track_name': name = msg.name
        if msg.type == 'set_tempo': tempos.append((tick / midi.ticks_per_beat, mido.tempo2bpm(msg.tempo)))
        if msg.type == 'time_signature': meters.append([msg.numerator, msg.denominator])
        if msg.type == 'marker': markers.append((tick, msg.text))
        if msg.type == 'note_on' and msg.velocity > 0:
            pending.setdefault((msg.channel, msg.note), []).append((tick, msg.velocity))
        elif msg.type == 'note_off' or msg.type == 'note_on' and msg.velocity == 0:
            onset, velocity = pending[(msg.channel, msg.note)].pop(0)
            notes.append((onset, msg.note, tick - onset, velocity))
    assert not any(pending.values()), 'Stuck MIDI notes'
    if notes: actual.append((name, sorted(notes)))
assert len(actual) == len(expected)
for (name, notes), source in zip(actual, expected):
    assert name == source['name']
    wanted = sorted(source['notes'], key=lambda n: (n['beat'], n['midi']))
    assert len(notes) == len(wanted)
    for (onset, pitch, length, velocity), n in zip(notes, wanted):
        assert pitch == n['midi']
        assert abs(onset / midi.ticks_per_beat - n['beat']) <= 1 / midi.ticks_per_beat
        assert abs(length / midi.ticks_per_beat - n['duration']) <= 1 / midi.ticks_per_beat
        assert abs(velocity / 127 - n['velocity']) <= 1 / 127
assert meters == [project['meter']]
assert len(tempos) == len(project['tempos'])
for (beat, bpm), event in zip(tempos, project['tempos']):
    assert abs(beat - event['beat']) <= 1 / midi.ticks_per_beat and abs(bpm - event['bpm']) < .001
assert (round(project['beats'] * midi.ticks_per_beat), 'Afterhours: end') in markers
timeline = sum((min(project['beats'], project['tempos'][i + 1]['beat'] if i + 1 < len(project['tempos']) else project['beats']) - t['beat']) * 60 / t['bpm'] for i, t in enumerate(project['tempos']) if t['beat'] < project['beats'])
assert abs(midi.length - timeline) < .005, (midi.length, timeline)
assert abs(report['duration'] - timeline - project['tail']) < 1 / 48000
print(json.dumps({'title': project['title'], 'duration': report['duration'], 'midiSeconds': midi.length, 'notes': sum(len(t['notes']) for t in expected), 'stems': len(stems), 'stemMaximumErrorPCM16': maximum_error, 'independentReaders': ['Python wave', 'Python zipfile', 'mido 1.3.3'], 'listeningReviewed': False}))
