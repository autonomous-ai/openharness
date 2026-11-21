/** First import in every CLI/lean entry: no config, features or runtime effects before admission. */
import { childAdmissionFailure } from './childAdmission.js'
import { fingerprint } from './bundleFingerprint.js'
import { rememberExecutedEntry } from './executedEntry.js'
import { WORKER_COHORT_ENV } from './workerContract.js'

if (process.argv[2] === '__run' || process.argv[2] === '__service' || process.argv[2] === '__storage') {
  const failure = childAdmissionFailure(process.env, process.ppid, process.argv[1])
  if (failure) {
    console.error(`[harnessd] child bundle admission failed: ${failure}`)
    process.exit(2)
  }
}

if (process.argv[2] === '__run' || process.argv[2] === 'start') {
  const file = process.argv[1]
  const admitted = process.argv[2] === '__run' && (process.env.HARNESSD_SUPERVISED === '1' || !!process.env.HARNESSD_SERVICE_TOKEN)
  const sha256 = admitted ? process.env[WORKER_COHORT_ENV]?.split(':')[3] : file ? fingerprint(file) : null
  if (file && sha256) rememberExecutedEntry({ file, sha256, admitted })
}
