/** Applies to public entry points and embedded workers; neither may boot a core service. */
export function assertOptionalBundle(metafile) {
  const forbidden = Object.keys(metafile.inputs).filter(path =>
    /(?:^|\/)cli\/src\/(?:config\/|(?:cli|backendSocket|localWsServer|hookServer)\.ts$|lib\/(?:registry|authSession|oneshot)\.ts$)/.test(path.replaceAll('\\', '/')))
  if (forbidden.length) throw new Error(`Optional package imported a core service: ${forbidden.join(', ')}`)
}
