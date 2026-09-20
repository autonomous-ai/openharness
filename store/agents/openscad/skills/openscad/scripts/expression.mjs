// Bounded arithmetic for saved geometric requirements; no JavaScript evaluation.
export function number(value, parameters={}, label='measurement') {
  if (typeof value==='number') {
    if (!Number.isFinite(value) || Math.abs(value)>1e7) throw new Error(label+' must be finite and within ±10,000,000.');
    return value;
  }
  if (typeof value!=='string' || !value.trim() || value.length>300) throw new Error('Invalid '+label+' expression.');
  const tokens=[]; let cursor=0;
  const pattern=/\s*(?:(\d+(?:\.\d+)?|\.\d+)|([a-zA-Z_][a-zA-Z0-9_]*)|([()+*/-]))/y;
  while (cursor<value.trimEnd().length) {
    pattern.lastIndex=cursor; const match=pattern.exec(value);
    if (!match) throw new Error('Unsupported '+label+' expression near '+value.slice(cursor));
    tokens.push(match[1]!==undefined?{numeric:Number(match[1])}:match[2]!==undefined?{name:match[2]}:{op:match[3]});
    cursor=pattern.lastIndex;
    if (tokens.length>128) throw new Error(label+' expression is too long.');
  }
  let index=0,depth=0;
  const primary=()=>{
    if (++depth>24) throw new Error(label+' expression is too deeply nested.');
    const token=tokens[index++]; let result;
    if (token?.op==='+' || token?.op==='-') result=(token.op==='-'?-1:1)*primary();
    else if (token?.op==='(') {
      result=add();
      if (tokens[index++]?.op!==')') throw new Error('Missing closing parenthesis in '+label);
    } else if (token?.numeric!==undefined) result=token.numeric;
    else if (token?.name!==undefined && Object.hasOwn(parameters,token.name)) result=parameters[token.name];
    else throw new Error('Unknown value in '+label+': '+(token?.name||token?.op||'end of expression'));
    depth--; return result;
  };
  const multiply=()=>{
    let result=primary();
    while (['*','/'].includes(tokens[index]?.op)) { const op=tokens[index++].op, right=primary();result=op==='*'?result*right:result/right; }
    return result;
  };
  const add=()=>{
    let result=multiply();
    while (['+','-'].includes(tokens[index]?.op)) { const op=tokens[index++].op, right=multiply();result=op==='+'?result+right:result-right; }
    return result;
  };
  const result=add();
  if (index!==tokens.length) throw new Error('Unexpected token in '+label);
  return number(result,{},label);
}
export function vector(value,parameters,label,{positive=false}={}) {
  if (!Array.isArray(value) || value.length!==3) throw new Error(label+' needs three coordinates.');
  const result=value.map((item,axis)=>number(item,parameters,label+'['+axis+']'));
  if (positive && result.some(value=>value<=0)) throw new Error(label+' must be positive.');
  return result;
}
