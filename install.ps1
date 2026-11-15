# WhatsApp MCP - one-step installer for Windows.
#
# Paste this ONE line into PowerShell (no admin needed):
#   irm https://raw.githubusercontent.com/realgrowthnexus/whatsapp-mcp/main/install.ps1 | iex
#
# It does everything by itself:
#   1. Uses your Node.js if it is new enough, otherwise downloads a private copy of
#      Node.js 24 LTS (checksum verified) into %LOCALAPPDATA%\WhatsAppMCP-runtime.
#   2. Downloads/updates this project into %USERPROFILE%\whatsapp-mcp
#      (an older copy is moved aside, never deleted; your WhatsApp data is not touched).
#   3. Installs, builds, creates the private data folder and connects Claude Desktop.
#   4. Shows the WhatsApp QR code. The ONLY thing you do is scan it.
#   5. After linking, starts the background listener and sets it to start at login,
#      and allows your clients (every one-to-one chat except +92 numbers) for Claude.
# Running it again is safe: it updates and skips steps that are already done.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo       = 'realgrowthnexus/whatsapp-mcp'
  $Branch     = 'main'
  $AppDir     = Join-Path $HOME 'whatsapp-mcp'
  $RuntimeDir = Join-Path $env:LOCALAPPDATA 'WhatsAppMCP-runtime'
  $DataDir    = Join-Path $env:LOCALAPPDATA 'WhatsAppMCP'

  function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
  function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
  function Fail($msg) { throw $msg }

  # Run a program straight in this console window (so the QR code and any names show correctly).
  function Exec([string]$exe, [string[]]$argv) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $exe
    $psi.Arguments = ($argv | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = (Get-Location).Path
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
    return $p.ExitCode
  }

  # Same, but stop with a clear message if it fails.
  function Run([string]$what, [string]$exe, [string[]]$argv) {
    $code = Exec $exe $argv
    if ($code -ne 0) { Fail "$what failed (exit code $code). The error text above says why." }
  }

  function NodeVersionOk([string]$nodeExe) {
    try {
      $v = (& $nodeExe -p "process.versions.node" 2>$null).Trim()
      $p = $v.Split('.'); $maj = [int]$p[0]; $min = [int]$p[1]
      return ($maj -gt 22) -or ($maj -eq 22 -and $min -ge 13)
    } catch { return $false }
  }

  function Get-Node {
    $private = Join-Path $RuntimeDir 'node\node.exe'
    if ((Test-Path $private) -and (NodeVersionOk $private)) { Ok "Using private Node.js: $private"; return $private }
    $sys = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sys -and (NodeVersionOk $sys.Source)) {
      $npmCli = Join-Path (Split-Path $sys.Source) 'node_modules\npm\bin\npm-cli.js'
      if (Test-Path $npmCli) { Ok "Using installed Node.js $(& $sys.Source -v): $($sys.Source)"; return $sys.Source }
    }

    Say 'Downloading Node.js 24 LTS (private copy, no admin needed)...'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $base = 'https://nodejs.org/dist/latest-v24.x'
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "node-v24\.\d+\.\d+-win-$arch\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { Fail 'Could not find the Node.js download. Check your internet connection and try again.' }
    $hash, $file = ($line.Trim() -split '\s+')
    $zip = Join-Path $env:TEMP $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { Remove-Item $zip -Force; Fail 'Node.js download was corrupted (checksum mismatch). Run the installer again.' }

    $tmp = Join-Path $env:TEMP ("node-extract-" + [guid]::NewGuid())
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    if (Test-Path (Join-Path $RuntimeDir 'node')) { Remove-Item (Join-Path $RuntimeDir 'node') -Recurse -Force }
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName (Join-Path $RuntimeDir 'node')
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Ok "Node.js installed: $private"
    return $private
  }

  function MoveAside([string]$dir) {
    $dest = "$dir.old-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item $dir $dest
    Ok "Moved the previous copy to $dest"
  }

  function Get-Code {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git -and (Test-Path (Join-Path $AppDir '.git'))) {
      $code = Exec $git.Source @('-C', $AppDir, 'pull', '--ff-only', 'origin', $Branch)
      if ($code -eq 0) { Ok 'Project updated.'; return }
      MoveAside $AppDir
    } elseif (Test-Path $AppDir) {
      MoveAside $AppDir
    }
    if ($git) {
      Run 'Downloading the project (git clone)' $git.Source @('clone', '--depth', '1', '--branch', $Branch, "https://github.com/$Repo.git", $AppDir)
    } else {
      $zip = Join-Path $env:TEMP 'whatsapp-mcp.zip'
      Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
      $tmp = Join-Path $env:TEMP ("wa-extract-" + [guid]::NewGuid())
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
      Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $AppDir
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
    Ok "Project downloaded to $AppDir"
  }

  function IsLinked {
    $creds = Join-Path $DataDir 'auth\creds.json'
    if (-not (Test-Path $creds)) { return $false }
    try { $c = Get-Content $creds -Raw | ConvertFrom-Json; return [bool]($c.me.id -or $c.registered) } catch { return $false }
  }

  function CanUseDataDir {
    try {
      Get-ChildItem -LiteralPath $DataDir -Recurse -Force -ErrorAction Stop | Where-Object { -not $_.PSIsContainer } |
        ForEach-Object { [IO.File]::Open($_.FullName, 'Open', 'Read', 'ReadWrite').Dispose() }
      return $true
    } catch { return $false }
  }

  # Make the private data folder readable by you again (only you), without touching its contents.
  function Repair-DataDir {
    if (-not (Test-Path -LiteralPath $DataDir)) { return }
    if (CanUseDataDir) { return }
    Say 'Repairing permissions on your private WhatsApp folder...'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = Exec 'icacls.exe' @($DataDir, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '/Q')
    $null = Exec 'icacls.exe' @((Join-Path $DataDir '*'), '/reset', '/T', '/C', '/Q')
    if (CanUseDataDir) { Ok 'Permissions repaired.'; return }

    Write-Host '    Windows needs your OK for this. Click "Yes" on the prompt that appears.' -ForegroundColor Yellow
    $d = $DataDir
    $cmd = "takeown /F `"$d`" /R /D Y >nul 2>&1 & icacls `"$d`" /setowner *$sid /T /C /Q >nul 2>&1 & " +
           "icacls `"$d`" /inheritance:r /grant:r *${sid}:(OI)(CI)F /Q & icacls `"$d\*`" /reset /T /C /Q"
    try { Start-Process cmd.exe -ArgumentList "/c $cmd" -Verb RunAs -Wait -WindowStyle Hidden } catch { Fail 'Permission repair was cancelled. Run the installer again and click "Yes".' }
    if (CanUseDataDir) { Ok 'Permissions repaired.'; return }
    Fail "Could not repair permissions on $DataDir. Make sure no WhatsApp listener window is open, then run the installer again."
  }

  try {
    Write-Host "`nWhatsApp MCP installer - sit back, the only thing you'll do is scan a QR code." -ForegroundColor White

    Say 'Step 1/5: Node.js'
    $node    = Get-Node
    $nodeDir = Split-Path $node
    $npmCli  = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $env:Path = "$nodeDir;$env:Path"   # so npm's build scripts find this node.exe

    Say 'Step 2/5: Getting the latest version of the project'
    if (Test-Path (Join-Path $AppDir 'dist\cli\service.js')) {
      Push-Location $AppDir
      $null = Exec $node @('dist\cli\service.js', 'stop')   # stop an older listener, if one is running
      Pop-Location
    }
    Get-Code
    Set-Location $AppDir

    Say 'Step 3/5: Installing and building (1-3 minutes)'
    Run 'Installing packages' $node @($npmCli, 'ci', '--no-audit', '--no-fund')
    Run 'Building' $node @($npmCli, 'run', 'build')

    Say 'Step 4/5: Private data folder + Claude Desktop connection'
    Repair-DataDir
    Run 'Setup' $node @('dist\cli\setup.js', '--claude')

    Say 'Step 5/5: Link WhatsApp'
    if (IsLinked) {
      Ok 'Already linked - no QR code needed.'
    } else {
      Write-Host ''
      Write-Host '  >>> READY TO SCAN <<<' -ForegroundColor Yellow
      Write-Host '  On your phone: WhatsApp Business -> (three dots / Settings) -> Linked devices -> Link a device' -ForegroundColor Yellow
      Write-Host '  then point the camera at the QR code below. It refreshes by itself; just keep this window open.' -ForegroundColor Yellow
      Run 'Linking WhatsApp' $node @('dist\listener\index.js', '--link', '--exit-after-link')
    }

    Say 'Starting the background listener (and auto-start at login)'
    Run 'Auto-start setup' $node @('dist\cli\service.js', 'install')
    Run 'Starting the listener' $node @('dist\cli\service.js', 'start')

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host ' ALL DONE. WhatsApp is connected and running in the background.' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host ' Last step: fully QUIT Claude Desktop (right-click its tray icon near the clock -> Quit) and open it again.'
    Write-Host ''
    Write-Host ' Allowing your clients (every one-to-one chat EXCEPT +92 numbers) so Claude can read and draft replies:'
    $null = Exec $node @('dist\cli\allow-clients.js')
    Write-Host ''
    Write-Host ' Groups and +92 numbers stay hidden. New clients later? Just run this installer line again.'
    Write-Host " To hide a chat, delete its number from `"allowlist`" -> `"chats`" in: $DataDir\config.json"
  } catch {
    Write-Host ''
    Write-Host "INSTALL STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Copy everything in this window and paste it to Claude; it will fix it. Running the installer again is safe.' -ForegroundColor Red
  }
}
