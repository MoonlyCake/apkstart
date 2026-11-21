$ErrorActionPreference = 'Stop'
function Note($message) {
  try { Add-Content -LiteralPath $spec.log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format HH:mm:ss), $message) }
  catch { Write-Warning ("Update log unavailable: " + $_.Exception.Message) }
}
function MarkFailure() {
  try { [IO.File]::WriteAllText($spec.failure, 'failed') }
  catch { Note ('Could not persist update failure: ' + $_.Exception.Message) }
}

$install = [IO.Path]::GetFullPath($spec.install)
$prefix = $install.TrimEnd('\') + '\'
function LocalPath([string]$candidate) {
  $full = [IO.Path]::GetFullPath($candidate)
  if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $full -eq $prefix) {
    throw "Update path outside install directory: $full"
  }
  # Never follow an existing link/junction when replacing a directory or rolling back.
  for ($p = $full; $p -ine $install -and $p -ine $prefix; $p = [IO.Path]::GetDirectoryName($p)) {
    if (!$p) { throw 'Invalid update path' }
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Update path is a reparse point: $p"
    }
  }
  return $full
}

function Assert-File([string]$file, [string]$hash, [long]$size = -1) {
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ($size -ge 0 -and $item.Length -ne $size)) { throw "Update file failed verification: $file" }
  $stream = [IO.File]::OpenRead($file)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($actual -ine $hash) {
    throw "Update file failed verification: $file"
  }
}

$quitted = $false
$restoreOK = $true
$applyOK = $false
$transaction = $null
$changes = New-Object 'System.Collections.Generic.List[object]'
Note 'updater start'
try {
  if ($spec.waitPid -gt 0 -and (Get-Process -Id $spec.waitPid -ErrorAction SilentlyContinue)) {
    Wait-Process -Id $spec.waitPid -Timeout 90
  }
  $quitted = $true
  if ($spec.mode -eq 'setup') {
    Assert-File $spec.payload $spec.expected
    $p = Start-Process -FilePath $spec.payload -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw "Installer failed (exit $($p.ExitCode))" }
    $installed = [Diagnostics.FileVersionInfo]::GetVersionInfo((LocalPath (Join-Path $install $spec.exe))).ProductVersion
    if ($installed -ne $spec.version -and $installed -ne ($spec.version + '.0')) {
      throw "Installed executable version did not change: $installed"
    }
  } else {
    $manifestPath = Join-Path $spec.payload '.apkstart-ready'
    Assert-File $manifestPath $spec.expected
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $transaction = LocalPath (Join-Path $install ('.apkstart-update-' + [Guid]::NewGuid().ToString('N')))
    $stage = Join-Path $transaction 'stage'
    $backup = Join-Path $transaction 'backup'
    New-Item -ItemType Directory -Path $stage,$backup | Out-Null
    $roots = @{}
    foreach ($file in $manifest.files) {
      $rel = $file.rel
      $from = Join-Path $spec.payload $rel
      $to = LocalPath (Join-Path $stage $rel)
      New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
      Copy-Item -LiteralPath $from -Destination $to
      Assert-File $to $file.sha256 $file.size
      # Update code as a clean directory, but retain bundled runtime in a light package update.
      $segments = $rel.Split('/')
      $entry = if ($segments.Length -gt 1 -and $segments[0] -ieq 'resources') {
        $segments[0] + '/' + $segments[1]
      } else { $segments[0] }
      $roots[$entry] = $true
    }
    # Validate every replace/backup path before changing the old installation.
    foreach ($entry in ($roots.Keys | Sort-Object)) {
      $current = LocalPath (Join-Path $install $entry)
      $saved = LocalPath (Join-Path $backup $entry)
      $incoming = LocalPath (Join-Path $stage $entry)
      $changes.Add([pscustomobject]@{ Current=$current; Saved=$saved; Incoming=$incoming; OldMoved=$false; NewMoved=$false })
    }
    foreach ($change in $changes) {
      if (Test-Path -LiteralPath $change.Current) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $change.Saved) -Force | Out-Null
        Move-Item -LiteralPath $change.Current -Destination $change.Saved
        $change.OldMoved = $true
      }
      New-Item -ItemType Directory -Path (Split-Path -Parent $change.Current) -Force | Out-Null
      Move-Item -LiteralPath $change.Incoming -Destination $change.Current
      $change.NewMoved = $true
    }
    foreach ($file in $manifest.files) {
      Assert-File (LocalPath (Join-Path $install $file.rel)) $file.sha256 $file.size
    }
  }
  $applyOK = $true
} catch {
  Note ('update failed: ' + $_.Exception.Message)
  MarkFailure
  for ($i = $changes.Count - 1; $i -ge 0; $i--) {
    $change = $changes[$i]
    try {
      if ($change.NewMoved) { Move-Item -LiteralPath (LocalPath $change.Current) -Destination (LocalPath $change.Incoming) }
      if ($change.OldMoved) { Move-Item -LiteralPath (LocalPath $change.Saved) -Destination (LocalPath $change.Current) }
    } catch {
      $restoreOK = $false
      Note ('rollback failed, backup retained at ' + $backup + ': ' + $_.Exception.Message)
    }
  }
  if ($spec.mode -eq 'app') {
    try { New-Item -ItemType File -Path $spec.forceFull -Force | Out-Null } catch { Note $_.Exception.Message }
  }
}

if ($spec.relaunch -and $quitted -and $restoreOK) {
  try {
    $exe = LocalPath (Join-Path $install $spec.exe)
    Start-Process -FilePath $exe -WorkingDirectory $install
  } catch {
    Note ('relaunch failed: ' + $_.Exception.Message)
    MarkFailure
    exit 1
  }
}
if ($transaction -and $restoreOK) {
  try { Remove-Item -LiteralPath (LocalPath $transaction) -Recurse -Force }
  catch { Note ('staging cleanup failed: ' + $_.Exception.Message) }
}
if (!$applyOK) { exit 1 }
Note 'update verified'
exit 0
