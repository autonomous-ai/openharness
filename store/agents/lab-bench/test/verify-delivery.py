"""Independent reader of actual delivered experiments, raw CSV, numerical results and PDFs."""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
import numpy as np
import scipy.stats as stats
import statsmodels.api as sm

root = Path(sys.argv[1]).resolve()
acceptance = json.loads((root / 'acceptance.json').read_text())
results = []
projects = {}

def basis(project, factor_id, settings):
    factor = next(f for f in project['factors'] if f['id'] == factor_id)
    if factor['type'] == 'category':
        return [float(settings[factor_id] == level) for level in factor['levels'][1:]]
    low, high = factor['levels'][0], factor['levels'][-1]
    return [(2 * settings[factor_id] - low - high) / (high - low)]

def row_for(project, run):
    row = [1.0]
    for term in project['model']['terms']:
        if term.endswith('^2'):
            row.append(basis(project, term[:-2], run['settings'])[0] ** 2)
        elif ':' in term:
            a, b = term.split(':')
            row.extend(x*y for x in basis(project, a, run['settings']) for y in basis(project, b, run['settings']))
        else:
            row.extend(basis(project, term, run['settings']))
    if project['model']['blocks']:
        row.extend(float(run['block'] == block) for block in project['design']['blocks'][1:])
    return row

def pdf_check(path):
    xml = subprocess.check_output(['pdftotext', '-bbox', str(path), '-'])
    tree = ET.fromstring(xml)
    pages = tree.findall('.//{http://www.w3.org/1999/xhtml}page')
    assert pages, path
    words = []
    for page in pages:
        width, height = float(page.attrib['width']), float(page.attrib['height'])
        assert abs(min(width, height)-595.28)<2 and abs(max(width, height)-841.89)<2, (path, width, height)
        for word in page.findall('.//{http://www.w3.org/1999/xhtml}word'):
            x0, y0, x1, y1 = [float(word.attrib[k]) for k in ['xMin','yMin','xMax','yMax']]
            assert -1 <= x0 <= x1 <= width+1 and -1 <= y0 <= y1 <= height+1, (path, word.text, word.attrib)
            words.append(word.text or '')
    return len(pages), ' '.join(words)

for item in acceptance['results']:
    folder = Path(item['destination'])
    project = json.loads((folder / 'project.signal.json').read_text())
    projects[(item['kind'], item['edition'])] = project
    assert 'synthetic' in project['evidenceNote'].lower()
    analysis = json.loads((folder / 'analysis.json').read_text())
    assert analysis['ok'] and analysis['inferential']
    with zipfile.ZipFile(folder / 'experiment-kit.zip') as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(set(archive.namelist()))
        for name in item['files']:
            assert archive.read(name) == (folder / name).read_bytes(), (folder, name)
    for source in project['sources']:
        raw = base64.b64decode(source['base64'], validate=True)
        assert hashlib.sha256(raw).hexdigest() == source['sha256']
        assert (folder / 'sources' / (source['id']+'.csv')).read_bytes() == raw
        reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        rows = {r[source['mapping']['runId']].strip(): r for r in reader}
        for m in [m for m in project['measurements'] if m['origin'].get('source') == source['id']]:
            assert float(rows[m['runId']][source['mapping']['response']]) == m['origin']['value']
            if m['value'] != m['origin']['value'] or m['excluded']:
                assert any(e.get('after') == m and e['reason'] for e in project['audit'] if e['action']=='measurement')
    measured = {m['runId']:m for m in project['measurements']}
    phases = {phase['id']:phase for phase in project['phases']}
    used = [r for r in project['runs'] if r['id'] in measured and not measured[r['id']]['excluded'] and phases[r['phase']]['kind'] != 'confirmation']
    x = np.array([row_for(project, r) for r in used])
    y = np.array([measured[r['id']]['value'] for r in used])
    np.testing.assert_allclose(x, analysis['matrix']['X'], atol=1e-13)
    np.testing.assert_array_equal(y, analysis['matrix']['y'])
    assert [r['id'] for r in used] == analysis['matrix']['runIds']
    result = sm.OLS(y, x, hasconst=True, missing='raise').fit()
    influence = result.get_influence()
    alpha = 1-project['model']['confidence']
    np.testing.assert_allclose(result.params, analysis['beta'], rtol=1e-8, atol=1e-8)
    np.testing.assert_allclose(result.bse, [c['se'] for c in analysis['coefficients']], rtol=1e-8, atol=1e-8)
    np.testing.assert_allclose(result.conf_int(alpha=alpha), [c['ci'] for c in analysis['coefficients']], rtol=1e-7, atol=1e-7)
    np.testing.assert_allclose(result.resid, [r['residual'] for r in analysis['residuals']], rtol=1e-8, atol=1e-8)
    np.testing.assert_allclose(influence.resid_studentized_internal, [r['studentized'] for r in analysis['residuals']], rtol=1e-7, atol=1e-7)
    np.testing.assert_allclose(influence.cooks_distance[0], [r['cook'] for r in analysis['residuals']], rtol=1e-7, atol=1e-7)
    np.testing.assert_allclose(np.sqrt(np.mean((result.resid/(1-influence.hat_matrix_diag))**2)), analysis['looRMSE'], rtol=1e-8, atol=1e-8)
    if (folder / 'comparison.json').exists():
        comparison = json.loads((folder / 'comparison.json').read_text())
        for key in ['A', 'B']:
            point = comparison[key]
            point_x = np.asarray(row_for(project, {'settings':point['settings'], 'block':point['block']}))
            prediction = result.get_prediction(point_x[None,:]).summary_frame(alpha=alpha)
            np.testing.assert_allclose(point['mean'], prediction['mean'].iloc[0], rtol=1e-8, atol=1e-8)
            np.testing.assert_allclose(point['meanCI'], prediction[['mean_ci_lower','mean_ci_upper']].iloc[0], rtol=1e-7, atol=1e-7)
            np.testing.assert_allclose(point['predictionCI'], prediction[['obs_ci_lower','obs_ci_upper']].iloc[0], rtol=1e-7, atol=1e-7)
        delta = np.asarray(comparison['B']['x']) - np.asarray(comparison['A']['x'])
        contrast = result.t_test(delta)
        np.testing.assert_allclose(comparison['ci'], contrast.conf_int(alpha=alpha)[0], rtol=1e-7, atol=1e-7)
    subprocess.run([sys.executable, str(folder/'reproduce.py')], check=True, capture_output=True, text=True)
    for file in (folder/'charts').glob('*.svg'):
        svg = ET.fromstring(file.read_text()); assert svg.attrib['viewBox']
    report_pages, report_text = pdf_check(folder/'report.pdf')
    sheet_pages, sheet_text = pdf_check(folder/'collection-sheet.pdf')
    for text in [report_text, sheet_text]:
        assert project['title'] in text and project['response']['name'] in text
    for r in project['runs']:
        assert r['id'] in sheet_text
    assert 'Synthetic' in report_text or 'synthetic' in report_text
    results.append({'kind':item['kind'],'edition':item['edition'],'training':len(y),'columns':x.shape[1],'df':int(result.df_resid),'reportPages':report_pages,'sheetPages':sheet_pages,'sourcesVerified':len(project['sources']),'independentStatistics':'passed'})

for kind in ['coffee','canopy','fold']:
    before, after = projects[(kind,'before')], projects[(kind,'after')]
    for key in ['factors','protocol','response','design']:
        assert before[key] == after[key], (kind,key)
    assert after['runs'][:len(before['runs'])] == before['runs']
    assert after['sources'][:len(before['sources'])] == before['sources']
    assert after['audit'][:len(before['audit'])] == before['audit']

proof = {'reader':'Python CSV/ZIP/XML, independently constructed matrix, statsmodels 0.14.6 / SciPy 1.13.1 and Poppler','results':results,'pages':sum(r['reportPages']+r['sheetPages'] for r in results)}
(root/'independent-verification.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof,indent=2))
