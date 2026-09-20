import {Matrix, SVD, studentTQuantile} from './math-vendor.mjs';
import {assert, clone, validateProject, settingsValid, canonical, digest} from './project.mjs';

export function columnsFor(p) {
  const columns = [{id: 'intercept', label: 'Intercept', factors: []}];
  const bases = id => {const f = p.factors.find(f => f.id === id); return f.type === 'number' ? [{factor: id, power: 1, label: f.name}] : f.levels.slice(1).map(level => ({factor: id, level, label: `${f.name}: ${level} vs ${f.levels[0]}`}));};
  for (const term of p.model.terms) {
    if (term.endsWith('^2')) {const id = term.slice(0, -2), f = p.factors.find(f => f.id === id); columns.push({id: term, label: `${f.name} squared`, factors: [{factor: id, power: 2}]});}
    else {
      const ids = term.split(':'), groups = ids.map(bases), parts = groups.length === 1 ? groups[0].map(x => [x]) : groups[0].flatMap(a => groups[1].map(b => [a, b]));
      for (const factors of parts) columns.push({id: factors.map(f => f.factor + (f.level === undefined ? '' : '[' + f.level + ']')).join(':'), label: factors.map(f => f.label).join(' × '), factors});
    }
  }
  if (p.model.blocks) for (const block of p.design.blocks.slice(1)) columns.push({id: 'block[' + block + ']', label: `Block: ${block} vs ${p.design.blocks[0]}`, block, factors: []});
  assert(columns.length <= 48, 'The expanded model exceeds 48 columns. Reduce factors, levels or interactions.'); return columns;
}
export function designRow(p, settings, block, columns = columnsFor(p)) {
  settingsValid(p, settings); assert(p.design.blocks.includes(block), 'Choose a declared block.');
  return columns.map(c => c.block !== undefined ? +(block === c.block) : c.factors.reduce((value, term) => {
    const f = p.factors.find(f => f.id === term.factor);
    return value * (f.type === 'category' ? +(settings[f.id] === term.level) : ((settings[f.id] - (f.levels[0] + f.levels.at(-1)) / 2) / ((f.levels.at(-1) - f.levels[0]) / 2)) ** term.power);
  }, 1));
}
const sum = a => a.reduce((s, v) => s + v, 0);
const dot = (a, b) => sum(a.map((v, i) => v * b[i]));
export const mean = a => sum(a) / a.length;
function decomposition(rows, count) {
  if (!rows.length) return {rank: 0, condition: null, df: -count, svd: null};
  const svd = new SVD(new Matrix(rows), {autoTranspose: true}), singular = svd.diagonal;
  const cutoff = singular[0] * 1e-12, rank = singular.filter(x => x > cutoff).length;
  return {rank, condition: rank < count ? null : singular[0] / singular.at(-1), df: rows.length - count, singular, svd};
}
export function plannedAnalysis(p) {
  const columns = columnsFor(p), phases = new Map(p.phases.map(x => [x.id, x]));
  const rows = p.runs.filter(r => phases.get(r.phase).kind !== 'confirmation').map(r => designRow(p, r.settings, r.block, columns));
  const {svd, ...diagnostic} = decomposition(rows, columns.length);
  return {...diagnostic, rows: rows.length, columns: columns.map(c => c.label), parameters: columns.length};
}
export function fitProject(raw, {includeExcluded = false} = {}) {
  const p = validateProject(raw), columns = columnsFor(p), phases = new Map(p.phases.map(x => [x.id, x]));
  const observations = new Map(p.measurements.map(m => [m.runId, m]));
  const used = p.runs.filter(r => phases.get(r.phase).kind !== 'confirmation' && observations.has(r.id) && (includeExcluded || !observations.get(r.id).excluded));
  const X = used.map(r => designRow(p, r.settings, r.block, columns)), y = used.map(r => observations.get(r.id).value);
  const dec = decomposition(X, columns.length), n = y.length, k = columns.length;
  const summary = {n, parameters: k, rank: dec.rank, df: n - k, condition: dec.condition, includeExcluded, columns,
    pending: p.runs.length - p.measurements.length, excluded: p.measurements.filter(m => m.excluded).length,
    confirmation: p.measurements.filter(m => phases.get(p.runs.find(r => r.id === m.runId).phase).kind === 'confirmation').length,
    model: clone(p.model), matrix: {X, y, runIds: used.map(r => r.id)}, warnings: []};
  if (!n) return {...summary, ok: false, issue: 'Collect measurements first. The plan does not contain invented responses.'};
  if (dec.rank < k) return {...summary, ok: false, issue: `These measurements identify ${dec.rank} of ${k} model columns. Collect the missing combinations or simplify the model. Center points alone cannot separate multiple squared effects.`};
  if (n <= k) return {...summary, ok: false, issue: `There are ${n} measured runs and ${k} parameters. Independent repetitions are needed to estimate residual uncertainty.`};
  if (dec.condition > 1e9) return {...summary, ok: false, issue: 'The model is numerically unstable. Redesign the experiment or remove confounded terms.'};
  const inverse = dec.svd.inverse(), beta = inverse.mmul(Matrix.columnVector(y)).to1DArray();
  const normalizedCovariance = inverse.mmul(inverse.transpose()).to2DArray();
  const fitted = X.map(x => dot(x, beta)), residuals = y.map((v, i) => v - fitted[i]), sse = sum(residuals.map(x => x * x));
  const df = n - k, mse = sse / df, scale = Math.max(1, ...y.map(Math.abs));
  const inferential = mse > (Number.EPSILON * scale * 64) ** 2;
  const covariance = normalizedCovariance.map(row => row.map(x => x * mse)), critical = studentTQuantile((1 + p.model.confidence) / 2, df);
  assert(Number.isFinite(critical), 'The uncertainty calculation could not be resolved.');
  const coefficients = columns.map((c, i) => {const se = Math.sqrt(Math.max(0, covariance[i][i])); return {id: c.id, label: c.label, value: beta[i], se: inferential ? se : null, ci: inferential ? [beta[i] - critical * se, beta[i] + critical * se] : null};});
  const residualRows = used.map((run, i) => {
    const leverage = Math.max(0, Math.min(1, dot(X[i], normalizedCovariance.map(row => dot(row, X[i])))));
    const studentized = inferential && 1 - leverage > 1e-10 ? residuals[i] / Math.sqrt(mse * (1 - leverage)) : null;
    const cook = studentized === null ? null : studentized ** 2 * leverage / (k * (1 - leverage));
    return {runId: run.id, order: run.order, block: run.block, settings: clone(run.settings), measured: y[i], fitted: fitted[i], residual: residuals[i], leverage, studentized, cook,
      review: leverage > 2 * k / n || (cook !== null && cook > 4 / n)};
  });
  const sst = sum(y.map(v => (v - mean(y)) ** 2));
  const looRMSE = residualRows.every(r => 1 - r.leverage > 1e-10) ? Math.sqrt(mean(residualRows.map(r => (r.residual / (1 - r.leverage)) ** 2))) : null;
  if (!inferential) summary.warnings.push('Residual variation is zero at numerical precision. Uncertainty intervals are withheld; collect independently varying repeated measurements.');
  if (dec.condition > 1e6) summary.warnings.push('The design is poorly conditioned; coefficients are sensitive to small measurement changes.');
  if (residualRows.some(r => r.review)) summary.warnings.push('Some measurements have high leverage or influence. Review their procedure and provenance; they have not been deleted.');
  if (p.audit.some(e => e.action === 'model' && e.afterCollection)) summary.warnings.push('Model terms changed after data were collected. Treat the revised analysis as exploratory.');
  if (summary.excluded) summary.warnings.push(`${summary.excluded} recorded measurements are excluded with reasons. Compare the sensitivity fit that includes them.`);
  return {...summary, ok: true, inferential, coefficients, beta, covariance, normalizedCovariance, critical, mse, sse, rmse: Math.sqrt(mse),
    r2: sst > (Number.EPSILON * scale * 64) ** 2 ? 1 - sse / sst : null,
    adjustedR2: sst > (Number.EPSILON * scale * 64) ** 2 ? 1 - (sse / df) / (sst / (n - 1)) : null,
    residuals: residualRows, looRMSE,
    assumptions: 'Intervals assume independent experimental units, a correctly specified linear mean model, constant residual variance and approximately normal errors. Intervals are pointwise, without adjustment for searching many settings. Confirmation measurements are held out of this fit.'};
}
export function predict(p, fit, settings, block) {
  assert(fit.ok, fit.issue || 'Fit the measured data first.'); const x = designRow(p, settings, block, fit.columns), prediction = dot(x, fit.beta);
  const variance = Math.max(0, dot(x, fit.covariance.map(row => dot(row, x)))), se = Math.sqrt(variance), predictionSE = Math.sqrt(variance + fit.mse);
  return {settings: clone(settings), block, x, mean: prediction, se: fit.inferential ? se : null,
    meanCI: fit.inferential ? [prediction - fit.critical * se, prediction + fit.critical * se] : null,
    predictionCI: fit.inferential ? [prediction - fit.critical * predictionSE, prediction + fit.critical * predictionSE] : null};
}
export function compare(p, fit, a, b) {
  const A = predict(p, fit, a.settings, a.block), B = predict(p, fit, b.settings, b.block), delta = B.x.map((x, i) => x - A.x[i]);
  const variance = Math.max(0, dot(delta, fit.covariance.map(row => dot(row, delta)))), difference = B.mean - A.mean;
  return {A, B, difference, se: fit.inferential ? Math.sqrt(variance) : null, ci: fit.inferential ? [difference - fit.critical * Math.sqrt(variance), difference + fit.critical * Math.sqrt(variance)] : null};
}
export async function predictionSnapshot(p, fit, points) {
  assert(fit.ok && fit.inferential && !fit.includeExcluded, 'Use a measured primary model with residual uncertainty before planning confirmation.');
  return {trainingRevision: await digest(p), n: fit.n, df: fit.df, model: clone(p.model), columns: clone(fit.columns), matrix: clone(fit.matrix), coefficients: clone(fit.coefficients), covariance: clone(fit.covariance), mse: fit.mse, assumptions: fit.assumptions,
    predictions: points.map(point => predict(p, fit, point.settings, point.block))};
}
export function confirmationResults(p) {
  const measured = new Map(p.measurements.filter(m => !m.excluded).map(m => [m.runId, m]));
  return p.phases.filter(phase => phase.kind === 'confirmation').flatMap(phase => phase.snapshot.predictions.map(prediction => {
    const rows = p.runs.filter(r => r.phase === phase.id && r.block === prediction.block && canonical(r.settings) === canonical(prediction.settings));
    const values = rows.filter(r => measured.has(r.id)).map(r => measured.get(r.id).value), n = values.length;
    const average = n ? mean(values) : null, se = n > 1 ? Math.sqrt(sum(values.map(x => (x - average) ** 2)) / ((n - 1) * n)) : null;
    const critical = n > 1 ? studentTQuantile((1 + phase.snapshot.model.confidence) / 2, n - 1) : null;
    return {phase: phase.label, phaseId: phase.id, prediction, planned: rows.length, n, runIds: rows.map(r => r.id), mean: average,
      ci: se === null ? null : [average - critical * se, average + critical * se], difference: n ? average - prediction.mean : null};
  }));
}
