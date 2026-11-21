/** Source execution only. Packaged storage enters through the admitted lean entry. */
import { childAdmissionFailure } from '../harnessd/childAdmission.js'

const failure = childAdmissionFailure(process.env, process.ppid, process.argv[1])
if (failure || process.argv[2] !== '__storage') process.exit(2)
;(await import('./process.js')).runSessionStorage()
