import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { stopTree } from '../lib/gitProject.js'

/**
 * One Windows PowerShell 5.1 for a spec file, and a fresh runspace for each of its calls.
 *
 * Why: the first command a 5.1 process has module autoload find costs 22 to 29 s on windows-11-arm (0.25 to 0.8 s on
 * windows-latest), once per process, whatever PSModulePath is (runs 43581413308 and 43582091190). A spec that starts a
 * powershell.exe per call pays it at every call; through one session it pays it once, and a later runspace costs about
 * 0.17 s.
 *
 * A call runs as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` would run it: the
 * process environment replaced by the call's, PSModulePath included (autoload reads it), then a runspace of its own
 * from InitialSessionState.CreateDefault2(), execution policy Bypass, a single-threaded apartment, the script in its
 * global scope, in this process's working folder. Requests and answers cross a named pipe this process serves, not the host's standard handles: a native
 * command a call runs inherits those (a Start-Process -NoNewWindow child writes straight to them).
 *
 * What a fresh runspace does not reset: the .NET assemblies and types loaded in the process (Add-Type), and $PID, one
 * value for every call of a host.
 *
 * Not covered, so no call may depend on either:
 * - `exit N`: a runspace has no process to end, so the script would stop with no status. A script whose own text has an
 *   exit statement is refused.
 * - a native command's standard error under `$ErrorActionPreference = 'Stop'`: in a runspace each of its lines is an
 *   error record, which stops the script, where powershell.exe passes it through to its own standard error.
 */

/** What one call gave, as `powershell.exe -EncodedCommand` would have. */
export interface PowerShellRun { status: number; stdout: string; stderr: string }

export interface WindowsPowerShell {
  /**
   * Runs [script] after the calls made before it. `env` is the call's whole environment, `process.env` when left out;
   * `timeoutMs` is 120 s when left out. Rejects when the call passes its timeout or its host exits under it, once that
   * host has exited or is still there 3 s after its tree was ended (the next call starts a new one), and for a script
   * with an exit statement.
   */
  run(script: string, call?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<PowerShellRun>
  /**
   * Ends the host, and its tree if it is still there 5 s later; resolves once it has exited, and rejects, naming it,
   * if it is still there 3 s after that.
   */
  close(): Promise<void>
}

export function windowsPowerShell(): WindowsPowerShell {
  let host: Promise<Host> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  async function call(script: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<PowerShellRun> {
    const starting = host ??= startHost()
    const own = await starting.catch((error: unknown) => {
      if (host === starting) host = undefined
      throw error
    })
    // .NET cannot set a name with `=` (Windows' hidden per-drive folders, `=C:`), and the host would stop on it.
    const sent = Object.fromEntries(Object.entries(env).filter(([name]) => !name.includes('=')))
    const answer = await within(Promise.race([own.ask(JSON.stringify({ script, env: sent })), own.exited.then(() => 'exited' as const)]), timeoutMs)
    if (answer !== 'late' && answer !== 'exited') {
      const result = JSON.parse(answer) as PowerShellRun & { refused?: true }
      if (result.refused) throw new Error('Windows PowerShell: a script with an exit statement is refused here: its runspace has no process to end, so it would stop with no status. Run it in a powershell.exe of its own.')
      return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
    }
    // This host is done: the next call starts a new one.
    if (host === starting) host = undefined
    const what = answer === 'late' ? `the call timed out after ${timeoutMs} ms` : `host exited with code ${await own.exited}`
    const left = answer === 'late' ? await endTree(own) : ''
    const said = own.said()
    throw new Error(`Windows PowerShell: ${what}${left ? `, and ${left}` : ''}${said ? `. Its last stderr: ${said}` : ''}`)
  }

  return {
    run(script, { env = { ...process.env }, timeoutMs = 120_000 } = {}) {
      const result = queue.then(() => call(script, env, timeoutMs))
      queue = result.catch(() => undefined)
      return result
    },
    async close() {
      const own = await host?.catch(() => undefined)
      host = undefined
      if (!own) return
      own.end()
      if (await within(own.exited, 5_000) !== 'late') return
      const left = await endTree(own)
      if (left) throw new Error(`Windows PowerShell: ${left}`)
    },
  }
}

/**
 * Ends [own]'s process tree, and gives '' once it has exited, or, when it is still there 3 s later, what is left and
 * what taskkill said: a wait with no end would hang the call, or the spec's afterAll, with no word of why.
 */
async function endTree(own: Host): Promise<string> {
  const failed = await stopTree(own.pid)
  if (await within(own.exited, 3_000) !== 'late') return ''
  return `host ${own.pid} is still running 3 s after its tree was ended${failed ? ` (${failed})` : ''}`
}

interface Host {
  pid: number | undefined
  /** Its exit code, once the process has exited. */
  exited: Promise<number | null>
  /** The answer to one request; it never comes from a host that is gone, which `exited` tells. */
  ask(request: string): Promise<string>
  /** Ends the pipe: the host reads its end and exits. */
  end(): void
  /** The end of what the host wrote to its standard error. */
  said(): string
}

async function startHost(): Promise<Host> {
  const name = `harness-ps-${randomUUID()}`
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(`\\\\.\\pipe\\${name}`, () => resolve())
  })
  // Started without PSModulePath, the host builds the one a new process builds, and gives it to a call that sends none.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  const encoded = Buffer.from(hostLoop(name), 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  // A child a call starts with the host's own handles writes here: read, so it never blocks on a full pipe, and dropped.
  child.stdout.resume()
  let said = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => { said = `${said}${text}`.slice(-4_000) })
  const stderrEnded = new Promise<void>((resolve) => child.stderr.once('end', resolve))

  let pipe: Socket | undefined
  let answer: ((line: string) => void) | undefined
  const connected = new Promise<Socket>((resolve) => server.once('connection', (socket) => {
    server.close()
    let text = ''
    socket.setEncoding('utf8')
    socket.on('error', () => { /* a write to a host that died: its exit names what went wrong */ })
    socket.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n', text.length - chunk.length)
      if (end < 0) return
      const line = text.slice(0, end)
      text = text.slice(end + 1)
      answer?.(line)
    })
    resolve(pipe = socket)
  }))

  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      if (child.pid !== undefined) return
      said = error.message
      server.close()
      resolve(null)
    })
    child.once('exit', (code) => {
      // What the host wrote last is read first, for a second at most: a process a call left behind can hold its output
      // open for as long as it runs.
      void within(stderrEnded, 1_000).then(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        pipe?.destroy()
        server.close()
        resolve(code)
      })
    })
  })

  return {
    pid: child.pid,
    exited,
    async ask(request) {
      const socket = await connected
      return new Promise((resolve) => {
        answer = resolve
        socket.write(`${request}\n`)
      })
    },
    end: () => { void connected.then((socket) => socket.destroy()) },
    said: () => said.trim(),
  }
}

/** [promise]'s value, or `late` when [ms] pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), ms) })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The host: one request a line, the call's script and environment, one answer a line, as JSON over the pipe. ASCII, and
 * short: -EncodedCommand is on a command line of at most 32 767 characters.
 *
 * The host's own commands come from Utility imported by its path: found by autoload, they would depend on the
 * PSModulePath a call set. Nothing of the host's runs in the call's runspace: a module command there would load 5.1's
 * own module before the script asks for it. Output, Write-Host lines and warnings arrive in one stream, in the order
 * written, and are formatted in the host's runspace; the error stream stays apart, as it is in a process. A script's
 * uncaught error is thrown by EndInvoke, and what it wrote before is in `$output` still.
 */
const hostLoop = (pipe: string) => String.raw`
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
Add-Type -AssemblyName System.Web.Extensions
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$json.MaxJsonLength = [int]::MaxValue
$modulePath = $env:PSModulePath
$directory = [Environment]::CurrentDirectory
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipe}', [System.IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(30000)
$utf8 = [System.Text.UTF8Encoding]::new($false)
$reader = [System.IO.StreamReader]::new($pipe, $utf8)
$writer = [System.IO.StreamWriter]::new($pipe, $utf8)
$writer.AutoFlush = $true
while ($null -ne ($line = $reader.ReadLine())) {
  $request = $json.DeserializeObject($line)
  $text = [string]$request['script']
  $exit = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$null).Find({ param($node) $node -is [System.Management.Automation.Language.ExitStatementAst] }, $true)
  if ($exit) {
    $writer.WriteLine($json.Serialize(@{ refused = $true }))
    continue
  }
  foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) { [Environment]::SetEnvironmentVariable($name, $null) }
  $sent = $request['env']
  foreach ($name in @($sent.Keys)) { [Environment]::SetEnvironmentVariable($name, [string]$sent[$name]) }
  if (-not $env:PSModulePath) { $env:PSModulePath = $modulePath }
  [Environment]::CurrentDirectory = $directory
  $state = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
  $state.ExecutionPolicy = 'Bypass'
  $runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($state)
  $runspace.ApartmentState = 'STA'
  $shell = [PowerShell]::Create()
  try {
    $runspace.Open()
    $shell.Runspace = $runspace
    $null = $shell.AddScript($text)
    $shell.Commands.Commands[0].MergeMyResults('Warning', 'Output')
    $shell.Commands.Commands[0].MergeMyResults('Information', 'Output')
    $inputs = [System.Management.Automation.PSDataCollection[psobject]]::new()
    $inputs.Complete()
    $output = [System.Management.Automation.PSDataCollection[psobject]]::new()
    $status = 0
    $failure = @()
    try { $null = $shell.EndInvoke($shell.BeginInvoke($inputs, $output)) } catch {
      $status = 1
      $cause = $_.Exception
      if ($cause -is [System.Management.Automation.MethodInvocationException]) { $cause = $cause.InnerException }
      $failure = $cause.ErrorRecord
      if (-not $failure) { $failure = $cause.Message }
    }
    $stdout = @($output | ForEach-Object {
      if ($_ -is [System.Management.Automation.WarningRecord]) { 'WARNING: ' + $_.Message }
      elseif ($_ -is [System.Management.Automation.InformationRecord]) { [string]$_.MessageData }
      else { $_ }
    } | Out-String -Stream) -join [Environment]::NewLine
    $stderr = @(foreach ($record in @($shell.Streams.Error) + $failure) {
      [string]$record
      if ($record.InvocationInfo) { $record.InvocationInfo.PositionMessage }
    }) -join [Environment]::NewLine
  } finally {
    $shell.Dispose()
    $runspace.Dispose()
  }
  $writer.WriteLine($json.Serialize(@{ status = [int]$status; stdout = [string]$stdout; stderr = [string]$stderr }))
}
`
