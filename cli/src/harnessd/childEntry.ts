/** First import in every CLI/lean entry: no config, features or runtime effects before admission. */
import { childAdmissionFailure } from './childAdmission.js'

if (process.argv[2] === '__run' || process.argv[2] === '__service') {
  const failure = childAdmissionFailure(process.env, process.ppid, process.argv[1])
  if (failure) {
    console.error(`[harnessd] child bundle admission failed: ${failure}`)
    process.exit(2)
  }
}
