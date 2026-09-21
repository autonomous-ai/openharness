// Preloaded (node --import) into the viewer the server tests spawn: exit normally on SIGTERM, so the
// process runs its exit hooks — V8 writes its coverage there — instead of dying on the signal.
process.on('SIGTERM', () => process.exit(0))
