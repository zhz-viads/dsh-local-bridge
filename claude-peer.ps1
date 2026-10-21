param(
    [Parameter(Mandatory=$true)][string]$SessionId,
    [Parameter(Mandatory=$true)][string]$MessageFile
)
$ErrorActionPreference = 'Stop'
if ($SessionId -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { throw 'invalid_session_id' }
$messageBody = [IO.File]::ReadAllText($MessageFile)
if ($messageBody -match '<\/?cross-session-message\b') { throw 'forbidden_wrapper_tag' }
$registryDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\sessions'
$sessionMatches = @(Get-ChildItem -LiteralPath $registryDirectory -Filter '*.json' -File | ForEach-Object {
    $metadata = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    if ($metadata.sessionId -eq $SessionId) { [pscustomobject]@{ Metadata=$metadata; Path=$_.FullName } }
})
if ($sessionMatches.Count -ne 1) { throw 'claude_session_not_unique' }
$target = $sessionMatches[0].Metadata
$targetProcess = Get-Process -Id $target.pid
if ($targetProcess.ProcessName -ne 'claude' -or $target.peerProtocol -ne 1) { throw 'unsupported_claude_session' }
if ($target.kind -ne 'interactive') { throw 'claude_session_requires_interactive' }
if ($targetProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne [string]$target.procStart) { throw 'claude_process_changed' }
$keys = @(Get-ChildItem -LiteralPath $registryDirectory -Filter ($target.pid.ToString() + '.*.key') -File)
if ($keys.Count -ne 1) { throw 'claude_peer_key_not_unique' }
$key = Get-Content -LiteralPath $keys[0].FullName -Raw | ConvertFrom-Json
if ([string]$key.procStartFt -ne [string]$target.procStart -or $key.pidDomain -ne $target.pidDomain -or -not $key.peerToken) { throw 'claude_peer_metadata_mismatch' }
$prefix = '\\.\pipe\'
if (-not $target.messagingSocketPath.StartsWith($prefix)) { throw 'unsupported_claude_transport' }
Add-Type @'
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AgentBridgePipeCheck {
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
}
'@
$content = '<cross-session-message from-name="DSH">' + "`n" + $messageBody + "`n" + '</cross-session-message>'
$frame = @{msgV=1;msg_id=[guid]::NewGuid().ToString();type='user';message=@{role='user';content=$content};priority='next';session_id=$SessionId;uuid=[guid]::NewGuid().ToString()}
$authentication = @{type='auth';token=$key.peerToken} | ConvertTo-Json -Compress
$payload = [Text.UTF8Encoding]::new($false).GetBytes($authentication + "`n" + ($frame | ConvertTo-Json -Depth 6 -Compress) + "`n")
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $target.messagingSocketPath.Substring($prefix.Length), [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
    $pipe.Connect(3000)
    [uint32]$serverProcess=0
    if (-not [AgentBridgePipeCheck]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$serverProcess) -or $serverProcess -ne $target.pid) { throw 'claude_pipe_owner_mismatch' }
    $fresh = Get-Content -LiteralPath $sessionMatches[0].Path -Raw | ConvertFrom-Json
    if ($fresh.sessionId -ne $SessionId -or $fresh.procStart -ne $target.procStart) { throw 'claude_session_changed' }
    $pipe.Write($payload,0,$payload.Length)
    $pipe.Flush()
    Start-Sleep -Milliseconds 200
    Write-Output '{"transport":"claude_peer","state":"written"}'
} finally {
    $pipe.Dispose()
    [Array]::Clear($payload,0,$payload.Length)
    $key=$null
    $authentication=$null
    $payload=$null
}
