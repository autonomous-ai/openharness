import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Store {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'state.json'); this.data = { benchmarks: [], loadTests: [], runs: [], jobs: [] }; this.writing = Promise.resolve(); }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      for (const key of ['benchmarks', 'loadTests', 'runs', 'jobs']) if (Array.isArray(parsed[key])) this.data[key] = parsed[key];
      this.data.jobs = this.data.jobs.map(job => ['queued', 'running'].includes(job.status) ? { ...job, status: 'interrupted', message: 'Harness restarted before this job completed. Retry the action to continue.', completedAt: new Date().toISOString() } : { ...job, message: String(job.message || '').replace(/https?:\/\/[^\s"<>]+/g, url => url.split('?')[0]).slice(0, 700) });
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not read saved Harness data: ${error.message}`); }
    await this.save();
    return this;
  }
  save() {
    const content = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => { const temp = `${this.file}.tmp`; await writeFile(temp, content, { mode: 0o600 }); await rename(temp, this.file); });
    return this.writing;
  }
}
