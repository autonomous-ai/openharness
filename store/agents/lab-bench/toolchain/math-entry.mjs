export {Matrix,SingularValueDecomposition as SVD} from 'ml-matrix';
import jstat from 'jstat';
export const studentTQuantile=(p,df)=>jstat.studentt.inv(p,df);
