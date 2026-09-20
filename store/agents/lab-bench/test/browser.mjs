import assert from 'node:assert/strict';
import {mkdir, mkdtemp, cp, readFile, writeFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {browserPath} from '../toolchain/browser.mjs';
import {createBenchViewer} from '../viewer/viewer.mjs';
import {buildBench} from '../template/tools/build.mjs';
import {fitProject} from '../template/studio/analysis.mjs';
import {canonical} from '../template/studio/project.mjs';
import {syntheticCSV} from './fixtures.mjs';

const pkg = fileURLToPath(new URL('..', import.meta.url)), output = resolve(process.env.LAB_QA_ROOT ?? 'work/experience-evidence/signal-browser');
await mkdir(output, {recursive: true}); const workspace = await mkdtemp(join(output, 'workspace-')); await cp(join(pkg, 'template'), workspace, {recursive: true});
process.env.LAB_DSH_DIR = pkg; await buildBench(workspace);
const server = await createBenchViewer(workspace); await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({headless: true, executablePath: await browserPath()});
const errors = [], checks = []; let sequence = 0, page;
const check = (name, detail = {}) => {checks.push({name, ok: true, ...detail}); console.log('ok ' + name);};
async function downloadFrom(page, selector, name) {const wait = page.waitForEvent('download'); await page.locator(selector).click(); const download = await wait, path = join(output, name ?? String(++sequence) + '-' + download.suggestedFilename()); await download.saveAs(path); return path;}
async function snapshot(page) {return JSON.parse(await readFile(await downloadFrom(page, '.sidebar>button[data-action="download-project"]'), 'utf8'));}
async function nav(name) {await page.locator('.sidebar [data-tab="' + name + '"]').click();}
async function importCSV(bytes, name = 'synthetic-observations.csv') {
  await nav('collect'); await page.locator('#csv-file').setInputFiles({name, mimeType: 'text/csv', buffer: Buffer.from(bytes)});
  await page.locator('#import-form button[type="submit"]').click(); await page.waitForSelector('#commit-import:enabled'); await page.locator('#commit-import').click(); await page.waitForSelector('#dialog', {state: 'hidden'});
}
try {
  page = await browser.newPage({viewport: {width: 1440, height: 1080}}); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForSelector('html[data-ready="true"]'); await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Saved in your workspace');
  assert.equal(await page.locator('#project-file').isVisible(), false); assert.equal(await page.locator('#csv-file').isVisible(), false);
  await page.locator('[name="title"]').fill('My coffee experiment'); await page.locator('#plan-form button[type="submit"]').click();
  await page.locator('#save-source').click(); await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Saved in your workspace');
  let saved = JSON.parse(await readFile(join(workspace, 'bench/project.json'), 'utf8')); assert.equal(saved.title, 'My coffee experiment'); assert.equal(saved.measurements.length, 0);
  assert.equal((await readdir(join(workspace, '.harness/history'))).length, 1); check('editable plan saves real source with previous edition history');

  await page.locator('[name="title"]').fill('Draft I want to keep'); await page.locator('#plan-form button[type="submit"]').click();
  saved.title = 'Agent-authored coffee brief'; await writeFile(join(workspace, 'bench/project.json'), JSON.stringify(saved)); await buildBench(workspace);
  await page.waitForSelector('#conflict:not([hidden])'); const oldDraft = JSON.parse(await readFile(await downloadFrom(page, '#conflict [data-action="load-source"]', 'source-conflict-draft.signal.json'), 'utf8')); assert.equal(oldDraft.title, 'Draft I want to keep');
  await page.waitForFunction(() => document.querySelector('[name="title"]').value === 'Agent-authored coffee brief');
  await writeFile(join(workspace, 'bench/project.json'), '{invalid'); await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('Source needs attention'));
  assert.equal((await snapshot(page)).title, saved.title); await writeFile(join(workspace, 'bench/project.json'), JSON.stringify(saved));
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Saved in your workspace'); check('agent/browser conflicts and invalid source preserve the current draft');

  await page.locator('[data-action="approve"]').click(); assert.equal(await page.locator('[name="title"]').isDisabled(), true);
  let project = await snapshot(page); const originalRuns = structuredClone(project.runs), originalProtocol = structuredClone(project.protocol);
  await nav('collect'); await page.locator('#csv-file').setInputFiles({name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('run_id,response\nr0001,1\nr0001,2\n')});
  await page.locator('#import-form button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('duplicate run id'));
  assert.equal(await page.locator('#commit-import').isDisabled(), true); await page.locator('#dialog [data-action="close"]').click(); assert.equal((await snapshot(page)).measurements.length, 0);
  const originalCSV = syntheticCSV(project); await importCSV(originalCSV); project = await snapshot(page); assert.equal(project.measurements.length, 15); assert.equal(project.sources.length, 1);
  check('protocol approval and actual CSV preview/import reject duplicates without partial writes');

  await page.locator('[data-action="measure"][data-id="r0002"]').click(); const originalValue = project.measurements.find(m => m.runId === 'r0002').value;
  await page.locator('#measurement-form [name="value"]').fill(String(originalValue + .05)); await page.locator('#measurement-form [name="reason"]').fill('Synthetic fixture: corrected the transcribed final digit.');
  await page.locator('#measurement-form button[type="submit"]').click(); project = await snapshot(page); assert.equal(project.measurements.find(m => m.runId === 'r0002').origin.value, originalValue);
  await page.getByText('synthetic-observations.csv · original CSV', {exact: true}).click(); const originalPath = await downloadFrom(page, '[data-action="original-csv"]', 'original-observations.csv'); assert.deepEqual(await readFile(originalPath), Buffer.from(originalCSV));
  check('logged correction retains the original imported bytes and original measured value');

  await nav('analyze'); await page.getByLabel('Steeping time · curvature', {exact: true}).check(); await page.getByLabel('Coffee dose · curvature', {exact: true}).check(); await page.locator('#model-form [name="reason"]').fill('Synthetic acceptance: test separate curvature and recover an unidentifiable model.'); await page.locator('#model-form button[type="submit"]').click();
  await page.getByText('These measurements identify 5 of 6 model columns.', {exact: false}).first().waitFor();
  await nav('followup'); await page.getByRole('spinbutton', {name: 'Point A Steeping time', exact: true}).fill('12'); await page.getByRole('spinbutton', {name: 'Point A Steeping time', exact: true}).press('Tab');
  await page.getByRole('spinbutton', {name: 'Point B Steeping time', exact: true}).fill('8'); await page.getByRole('spinbutton', {name: 'Point B Steeping time', exact: true}).press('Tab');
  await page.getByRole('spinbutton', {name: 'Point B Coffee dose', exact: true}).fill('75'); await page.getByRole('spinbutton', {name: 'Point B Coffee dose', exact: true}).press('Tab');
  await page.locator('#followup-form [name="repeats"]').fill('2'); await page.locator('#followup-form [name="label"]').fill('Separate the curved effects'); await page.locator('#followup-form button[type="submit"]').click();
  project = await snapshot(page); assert.equal(project.runs.length, 19); assert.equal(project.phases.at(-1).kind, 'extension');
  await importCSV(syntheticCSV(project, 'coffee', project.runs.filter(r => r.phase !== 'initial')), 'synthetic-extension.csv'); project = await snapshot(page); assert.equal(fitProject(project).rank, 6); assert.equal(fitProject(project).ok, true);
  assert.deepEqual(project.runs.slice(0, originalRuns.length), originalRuns); assert.deepEqual(project.protocol, originalProtocol);
  check('unidentifiable curvature is repaired with actual appended settings and fresh measurements');

  await nav('followup'); const prior = fitProject(project);
  await page.getByRole('spinbutton', {name: 'Candidate Steeping time', exact: true}).fill('13'); await page.getByRole('spinbutton', {name: 'Candidate Steeping time', exact: true}).press('Tab');
  await page.locator('#followup-form [name="label"]').fill('Independent confirmation'); await page.locator('#followup-form button[type="submit"]').click();
  project = await snapshot(page); assert.equal(project.phases.at(-1).kind, 'confirmation'); const phase = project.phases.at(-1).id;
  await importCSV(syntheticCSV(project, 'coffee', project.runs.filter(r => r.phase === phase)), 'synthetic-confirmation.csv'); project = await snapshot(page);
  assert.deepEqual(fitProject(project).beta, prior.beta); assert.equal(fitProject(project).confirmation, 6);
  await nav('followup'); await page.locator('#conclusion-form [name="conclusion"]').fill('Synthetic acceptance exercise: compare actual follow-up measurements with the frozen forecast; no empirical coffee result is claimed.'); await page.locator('#conclusion-form button[type="submit"]').click();
  await page.locator('#save-source').click(); await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Saved in your workspace');
  project = await snapshot(page); assert.equal(canonical(JSON.parse(await readFile(join(workspace, 'bench/project.json'), 'utf8'))), canonical(project));
  await page.screenshot({path: join(output, 'desktop-followup.png'), fullPage: true}); check('real comparison controls create held-out confirmation runs with frozen forecasts');

  const kit = await downloadFrom(page, '.header-actions [data-action="export"]', 'browser-experiment.zip'); const unpacked = join(output, 'offline-kit'); await mkdir(unpacked, {recursive: true});
  execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', kit, unpacked]);
  assert.equal(canonical(JSON.parse(await readFile(join(unpacked, 'project.signal.json'), 'utf8'))), canonical(project));
  const offline = await browser.newPage({viewport: {width: 390, height: 844}}); offline.on('pageerror', e => errors.push(e.message)); await offline.route('http**/*', route => route.abort());
  await offline.goto(pathToFileURL(join(unpacked, 'experiment.html')).href); await offline.waitForSelector('html[data-ready="true"]'); await offline.locator('.sidebar [data-tab="followup"]').click();
  assert.ok(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); assert.equal(await offline.locator('#save-source').isDisabled(), true);
  await offline.screenshot({path: join(output, 'mobile-followup.png'), fullPage: true});
  await offline.locator('#conclusion-form [name="conclusion"]').fill('Offline decision saved on this device.'); await offline.locator('#conclusion-form button[type="submit"]').click(); await offline.reload(); await offline.waitForSelector('html[data-ready="true"]'); await offline.locator('.sidebar [data-tab="followup"]').click(); assert.equal(await offline.locator('#conclusion-form [name="conclusion"]').inputValue(), 'Offline decision saved on this device.');
  await offline.close(); check('browser ZIP reopens offline, preserves its complete source and supports a 390px layout and draft recovery');
  await page.reload(); await page.waitForSelector('html[data-ready="true"]'); const reloaded = await snapshot(page); assert.equal(canonical(reloaded), canonical(project));
  assert.deepEqual(errors, []); await writeFile(join(output, 'report.json'), JSON.stringify({workspace, checks, errors, actualBrowser: await browser.version(), scope: 'Real Chrome inputs and portable output; synthetic responses, not a physical experiment or an installed-agent trial.'}, null, 2));
  console.log(JSON.stringify({output, passed: checks.length, errors}));
} catch (error) {
  if (page) await page.screenshot({path: join(output, 'failure.png'), fullPage: true}).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({checks, errors, error: error.stack}, null, 2)); throw error;
} finally {await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));}
