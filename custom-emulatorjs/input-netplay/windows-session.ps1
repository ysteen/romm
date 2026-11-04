param(
    [string]$Manifest,
    [string]$RetroArch,
    [string]$SessionRoot,
    [switch]$PrepareOnly,
    [switch]$InstallCertificate,
    [switch]$RegisterLauncher,
    [switch]$UnregisterLauncher,
    [string]$LaunchUri,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-RommOrigin([string]$Value) {
    $origin = [Uri]$Value
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http', 'https') -or
        $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
        throw 'Invalid RomM server address.'
    }
    return $origin.GetLeftPart([UriPartial]::Authority)
}

function Register-Launcher($Session, [string]$Root, [string]$Source, [string]$Protocol = 'romm-netplay') {
    $origin = Get-RommOrigin $Session.origin
    if ($Session.schemaVersion -ne 1 -or $Protocol -notmatch '^romm-netplay(?:-test-[a-f0-9]+)?$') { throw 'Invalid launcher registration.' }
    $directory = Join-Path $Root 'Launcher'
    New-Item -ItemType Directory -Force $directory | Out-Null
    $destination = Join-Path $directory 'Launch.ps1'
    if ([IO.Path]::GetFullPath($Source) -ne [IO.Path]::GetFullPath($destination)) {
        Copy-Item -LiteralPath $Source -Destination $destination -Force
    }
    $configuration = Join-Path $directory 'servers.json'
    $origins = @($origin)
    if (Test-Path -LiteralPath $configuration) {
        $previous = Get-Content -LiteralPath $configuration -Raw -Encoding UTF8 | ConvertFrom-Json
        $origins += @($previous.origins | ForEach-Object { Get-RommOrigin $_ })
    }
    $value = @{ schemaVersion = 1; origins = @($origins | Select-Object -Unique) } | ConvertTo-Json
    [IO.File]::WriteAllText($configuration, $value, (New-Object Text.UTF8Encoding($false)))
    $key = 'HKCU:\Software\Classes\' + $Protocol
    New-Item -Path ($key + '\shell\open\command') -Force | Out-Null
    Set-Item -Path $key -Value 'URL:RomM Netplay Launcher'
    New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name 'RomM Launcher Directory' -Value $directory -PropertyType String -Force | Out-Null
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $command = '"' + $powershell + '" -NoProfile -ExecutionPolicy Bypass -File "' + $destination + '" -LaunchUri "%1"'
    Set-Item -Path ($key + '\shell\open\command') -Value $command
    Write-Host 'Launcher registered for this Windows user. Join a RomM room and click Open in Windows RetroArch.'
}

function Unregister-Launcher([string]$Root, [string]$Protocol = 'romm-netplay') {
    if ($Protocol -notmatch '^romm-netplay(?:-test-[a-f0-9]+)?$') { throw 'Invalid launcher registration.' }
    $key = 'HKCU:\Software\Classes\' + $Protocol
    if (-not (Test-Path $key)) { Write-Host 'The launcher is not registered.'; return }
    $registered = (Get-Item -LiteralPath $key).GetValue('RomM Launcher Directory')
    if ($registered -ne (Join-Path $Root 'Launcher')) { throw 'This protocol belongs to a different launcher. Its registration was preserved.' }
    Remove-Item -LiteralPath $key -Recurse
    Write-Host 'Launcher link registration removed. RetroArch, downloaded games and saves were preserved.'
}

function Get-LaunchRequest([string]$Value, [string]$Configuration) {
    if ($Value -cnotmatch '^romm-netplay://launch/\?server=([A-Za-z0-9%._~-]+)&room=([A-Za-z0-9_-]{1,64})&ticket=([A-Za-z0-9_-]{32})$') {
        throw 'Invalid RomM launch link.'
    }
    $encoded = $Matches[1]; $room = $Matches[2]; $ticket = $Matches[3]
    $origin = Get-RommOrigin ([Uri]::UnescapeDataString($encoded))
    $allowed = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($allowed.schemaVersion -ne 1 -or $origin -notin @($allowed.origins)) {
        throw 'This RomM server is not registered. Download its launcher and open Register Launcher.cmd once.'
    }
    return [PSCustomObject]@{ Origin = $origin; RoomId = $room; Ticket = $ticket }
}

function Receive-LaunchSession($Request, [string]$Root) {
    New-Item -ItemType Directory -Force $Root | Out-Null
    $temporary = Join-Path $Root ('launch-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        $url = $Request.Origin + '/api/netplay/bridge/rooms/' + $Request.RoomId + '/native/claim'
        Receive-SessionFile $url $temporary $Request.Ticket 1048576 1 'POST'
        $session = Get-Content -LiteralPath $temporary -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($session.roomId -ne $Request.RoomId -or $session.origin -ne $Request.Origin) { throw 'The launcher response belongs to a different room or server.' }
        return $session
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SessionCertificate($Session, [string]$PackageRoot) {
    if (-not $Session.PSObject.Properties['certificate']) { throw 'This package does not include a private CA certificate.' }
    $origin = [Uri]$Session.origin
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -ne 'https' -or $origin.UserInfo -or
        $Session.certificate.name -cne 'RomM-CA.cer' -or $Session.certificate.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid certificate package.'
    }
    $path = Join-Path $PackageRoot 'RomM-CA.cer'
    if ((Get-Item -LiteralPath $path).Length -gt 65536 -or (Get-Sha256 $path) -cne $Session.certificate.sha256) {
        throw 'Certificate checksum mismatch. Download the Windows session again.'
    }
    $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($path)
    try {
        $constraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        if ($certificate.HasPrivateKey -or $certificate.Subject -ne $certificate.Issuer -or
            $constraints.Count -ne 1 -or -not $constraints[0].CertificateAuthority -or
            $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
            throw 'The package must contain a currently valid public root CA certificate.'
        }
        return $certificate
    } catch { $certificate.Dispose(); throw }
}

function Test-TrustedRoot($Certificate) {
    foreach ($location in @('CurrentUser', 'LocalMachine')) {
        $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', $location)
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
            foreach ($candidate in $store.Certificates.Find('FindByThumbprint', $Certificate.Thumbprint, $false)) {
                if ([Convert]::ToBase64String($candidate.RawData) -ceq [Convert]::ToBase64String($Certificate.RawData)) { return $true }
            }
        } finally { $store.Close() }
    }
    return $false
}

function Install-SessionCertificate($Session, [string]$PackageRoot) {
    $certificate = Get-SessionCertificate $Session $PackageRoot
    try {
        if (Test-TrustedRoot $certificate) { Write-Host 'The server certificate is already trusted. Open Play.cmd.'; return }
        Write-Host "Trusting $($Session.origin) CA for the current Windows user: $($certificate.Subject)"
        $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $store.Add($certificate)
        } finally { $store.Close() }
        Write-Host 'Certificate installed. Open Play.cmd to join the room.'
    } finally { $certificate.Dispose() }
}

function Assert-Session($Session) {
    if ($Session.schemaVersion -notin @(1, 2, 3) -or $Session.roomId -notmatch '^[A-Za-z0-9_-]{1,64}$') {
        throw 'Unsupported room file.'
    }
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $Session.expiresAt) {
        throw 'This room download expired. Prepare a new Windows session in RomM.'
    }
    if ($Session.credential -notmatch '^[A-Za-z0-9_-]{32}$' -or
        $Session.connection.password -notmatch '^[A-Za-z0-9_-]{32}$') { throw 'Invalid room credential.' }
    if ($Session.platform -notin @('windows-x86_64', 'windows-x86', 'windows-arm64')) { throw 'This package requires Windows.' }
    $origin = [Uri]$Session.origin
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http', 'https') -or $origin.UserInfo) {
        throw 'Invalid RomM server address.'
    }
    if ($Session.profile.id -notin @('sameboy', 'mgba_splitscreen', 'snes9x')) { throw 'Unsupported core.' }
    if ($Session.connection.port -lt 1 -or $Session.connection.port -gt 65535 -or
        $Session.connection.host -notmatch '^[a-zA-Z0-9.:[\]_-]+$') { throw 'Invalid RetroArch server address.' }
    $count = @($Session.cartridges).Count
    if ($Session.schemaVersion -ge 2) {
        if (@($Session.initialBatteries).Count -ne $count) { throw 'The room needs one save selection per cartridge.' }
        foreach ($encoded in $Session.initialBatteries) {
            if ($encoded -isnot [string] -or $encoded.Length -gt 174764) { throw 'Invalid cartridge save.' }
            $bytes = [Convert]::FromBase64String($encoded)
            if ($bytes.Length -gt 131072) { throw 'Cartridge save exceeds 128 KiB.' }
        }
    }
    if (($Session.profile.id -eq 'snes9x' -and $count -ne 1) -or
        ($Session.profile.id -eq 'sameboy' -and $count -ne 2) -or
        ($Session.profile.id -eq 'mgba_splitscreen' -and ($count -lt 2 -or $count -gt 4))) {
        throw 'Invalid number of cartridges.'
    }
    $expectedSubsystem = switch ($Session.profile.id) {
        'sameboy' { 'gb_link_2p' }
        'mgba_splitscreen' { "gba_link_${count}p" }
        'snes9x' { '' }
    }
    if ([string]$Session.profile.subsystem -ne $expectedSubsystem) { throw 'Invalid core subsystem.' }
    $assets = @($Session.core) + @($Session.cartridges)
    if ($null -ne $Session.coreInfo) { $assets += $Session.coreInfo }
    foreach ($asset in $assets) {
        $url = [Uri]$asset.url
        if (-not $url.IsAbsoluteUri -or $url.GetLeftPart([UriPartial]::Authority) -ne $origin.GetLeftPart([UriPartial]::Authority) -or
            $url.UserInfo -or $asset.name -notmatch '^[a-zA-Z0-9_.-]+$' -or $asset.name -in @('.', '..') -or
            $asset.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid session download.' }
    }
    if ($Session.core.name -ne "$($Session.profile.id)_libretro.dll") { throw 'Unexpected core filename.' }
    foreach ($rom in $Session.cartridges) {
        if ($rom.size -lt 1 -or $rom.size -gt 33554432 -or $rom.name -notmatch '^player-[1-4]\.(gba|gb|sfc)$') {
            throw 'Invalid cartridge size or filename.'
        }
    }
}

function Get-ExecutablePlatform([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Select a Windows RetroArch executable.' }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset -gt $stream.Length - 6) { throw 'Invalid Windows executable.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { throw 'Invalid PE header.' }
        switch ($reader.ReadUInt16()) {
            0x8664 { return 'windows-x86_64' }
            0x014c { return 'windows-x86' }
            0xaa64 { return 'windows-arm64' }
            default { throw 'Unsupported RetroArch architecture.' }
        }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Wait-SessionManifest($Session, [string]$Root) {
    if (-not $Session.PSObject.Properties['pending'] -or -not $Session.pending) { return $Session }
    $origin = [Uri]$Session.origin
    if ($Session.roomId -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Session.credential -notmatch '^[A-Za-z0-9_-]{32}$' -or
        -not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http', 'https') -or $origin.UserInfo -or
        $Session.manifestUrl -ne ($Session.origin.TrimEnd('/') + '/api/netplay/bridge/rooms/' + $Session.roomId + '/native/manifest')) {
        throw 'Invalid room preparation file.'
    }
    $bootstrap = $Session
    New-Item -ItemType Directory -Force $Root | Out-Null
    $temporary = Join-Path $Root ('pending-' + [Guid]::NewGuid().ToString('N') + '.json')
    Write-Host 'Your selected cartridge is registered. Choose your player number in RomM and wait for the host to start.'
    try {
        while ($true) {
            if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $bootstrap.expiresAt) {
                throw 'Room preparation expired. Prepare a new Windows session in RomM.'
            }
            Receive-SessionFile $bootstrap.manifestUrl $temporary $bootstrap.credential 1048576 1
            $current = Get-Content -LiteralPath $temporary -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($current.roomId -ne $bootstrap.roomId -or $current.credential -ne $bootstrap.credential -or
                $current.origin -ne $bootstrap.origin -or $current.platform -ne $bootstrap.platform) { throw 'Room preparation identity changed.' }
            if (-not $current.PSObject.Properties['pending'] -or -not $current.pending) { return $current }
            Start-Sleep -Seconds 2
        }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Get-ExceptionDetails([Exception]$Exception) {
    $details = @()
    for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
        if ($current.InnerException -and ($current -is [Management.Automation.MethodInvocationException] -or
            $current -is [AggregateException])) { continue }
        if ($current.Message -and $current.Message -notin $details) { $details += $current.Message }
    }
    return ($details -join [Environment]::NewLine)
}

function Get-DownloadError([Exception]$Exception, [string]$Url, [string]$Credential) {
    $address = New-Object UriBuilder($Url)
    $address.UserName = ''; $address.Password = ''; $address.Query = ''; $address.Fragment = ''
    $endpoint = $address.Uri.AbsoluteUri
    $hint = ''
    for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
        if ($current -is [Net.WebException]) {
            switch ($current.Status.ToString()) {
                'TrustFailure' { $hint = 'Windows rejected the HTTPS certificate. If this ZIP includes Install Certificate.cmd, open it once, then Play.cmd. Otherwise, install the private CA certificate in Current User > Trusted Root Certification Authorities. A browser certificate exception does not apply to this launcher.' }
                'SecureChannelFailure' { $hint = 'The HTTPS handshake failed. Check the server certificate and Windows date/time, and use a Windows version with current TLS support.' }
                'NameResolutionFailure' { $hint = 'Windows could not resolve the server name. Check the server address and DNS connection.' }
                'ProxyNameResolutionFailure' { $hint = 'Windows could not resolve the configured proxy. Check the Windows proxy settings.' }
                'ConnectFailure' { $hint = 'Windows could not connect to the server. Check its address, port and network access.' }
                'Timeout' { $hint = 'The download timed out. Check the connection and try again.' }
            }
        } elseif ($current -is [Threading.Tasks.TaskCanceledException]) {
            $hint = 'The download timed out. Check the connection and try again.'
        }
    }
    $detail = (Get-ExceptionDetails $Exception).Replace($Url, $endpoint)
    if ($Credential) { $detail = $detail.Replace($Credential, '[redacted]') }
    return (@("Download failed: $endpoint", $hint, $detail) | Where-Object { $_ }) -join [Environment]::NewLine
}

function Get-HttpDownloadError($Response) {
    $status = [int]$Response.StatusCode
    $detail = switch ($status) {
        404 { 'The room or download is no longer available. Refresh the room in RomM.' }
        410 { 'Your Windows session preparation expired. Prepare a new Windows session in RomM.' }
        401 { 'This Windows session is no longer authorized. Prepare a new Windows session in RomM.' }
        403 { 'This Windows session is no longer authorized. Prepare a new Windows session in RomM.' }
        default { 'The server rejected the download.' }
    }
    try {
        if ($Response.Content.Headers.ContentType.MediaType -eq 'application/json') {
            $Response.Content.LoadIntoBufferAsync(4096).GetAwaiter().GetResult() | Out-Null
            $body = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
            if ($body.PSObject.Properties['detail'] -and $body.detail -is [string] -and $body.detail.Length -le 1024 -and $body.detail.Trim()) {
                $detail = [regex]::Replace($body.detail, '[\x00-\x1f\x7f]', ' ')
            }
        }
    } catch { }
    return "HTTP $($status): $detail"
}

function Receive-SessionFile([string]$Url, [string]$Destination, [string]$Credential, [long]$Limit, [int]$TimeoutMinutes = 3, [string]$Method = 'GET') {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes($TimeoutMinutes)
    if ($Method -notin @('GET', 'POST')) { throw 'Unsupported download method.' }
    $request = New-Object Net.Http.HttpRequestMessage((New-Object Net.Http.HttpMethod($Method)), $Url)
    if ($Credential) { $request.Headers.Add('X-Netplay-Launch', $Credential) }
    $response = $null
    $inputStream = $null
    $outputStream = $null
    $complete = $false
    try {
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw (Get-HttpDownloadError $response) }
        if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'Download exceeds its size limit.' }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Create($Destination)
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt $Limit) { throw 'Download exceeds its size limit.' }
            $outputStream.Write($buffer, 0, $count)
        }
        $complete = $true
    } catch {
        throw (Get-DownloadError $_.Exception $Url $Credential)
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose(); $client.Dispose(); $handler.Dispose()
        if (-not $complete -and $outputStream -and (Test-Path -LiteralPath $Destination)) {
            Remove-Item -LiteralPath $Destination -ErrorAction SilentlyContinue
        }
    }
}

function Get-RetroArchCandidates([string]$Root, [string]$PackageRoot) {
    $remembered = Join-Path $Root 'retroarch-path.txt'
    if (Test-Path -LiteralPath $remembered -PathType Leaf) { [IO.File]::ReadAllText($remembered).Trim() }
    $command = Get-Command retroarch.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $command.Source }
    foreach ($key in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\retroarch.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\retroarch.exe'
    )) {
        if (Test-Path $key) { (Get-Item $key).GetValue('') }
    }
    foreach ($key in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        foreach ($app in @(Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
            $name = $app.PSObject.Properties['DisplayName']
            $location = $app.PSObject.Properties['InstallLocation']
            if ($name -and $name.Value -like '*RetroArch*' -and $location -and $location.Value) {
                Join-Path ([string]$location.Value).Trim('"') 'retroarch.exe'
            }
        }
    }
    $roots = @($PackageRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA,
        ($env:SystemDrive + '\'), (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop'))
    foreach ($base in $roots) {
        if (-not $base) { continue }
        foreach ($relative in @('retroarch.exe', 'RetroArch\retroarch.exe', 'RetroArch-Win64\retroarch.exe',
            'RetroArch-Win32\retroarch.exe', 'Programs\RetroArch\retroarch.exe', 'Steam\steamapps\common\RetroArch\retroarch.exe')) {
            Join-Path $base $relative
        }
    }
}

function Find-InstalledRetroArch([string]$Root, [string]$Platform, [string]$PackageRoot) {
    foreach ($candidate in @(Get-RetroArchCandidates $Root $PackageRoot | Select-Object -Unique)) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            if ((Get-ExecutablePlatform $candidate) -eq $Platform) { return (Get-Item -LiteralPath $candidate).FullName }
        } catch { continue }
    }
    return $null
}

function Get-PortableBuild([string]$Platform) {
    switch ($Platform) {
        'windows-x86_64' { return @{
            Architecture = 'x86_64'; Directory = 'RetroArch-Win64'
            Sha256 = 'b2139b1d0f9d4526dc6b5ce23cbb3efdc766096fa6f2c3df016818b486ac6372'
        } }
        'windows-x86' { return @{
            Architecture = 'x86'; Directory = 'RetroArch-Win32'
            Sha256 = 'f25fea07465e76d80250bda69f108dab88a876cf1191aac208567032fb7f4185'
        } }
        default { throw 'Automatic portable download supports Windows x64 and x86. Select one of these in RomM, or pass -RetroArch with an existing matching ARM64 executable.' }
    }
}

function Initialize-PortableRetroArch([string]$Root, [string]$Platform) {
    $build = Get-PortableBuild $Platform
    $runtimes = Join-Path $Root 'runtimes'
    New-Item -ItemType Directory -Force $runtimes | Out-Null
    $target = Join-Path $runtimes ('retroarch-1.22.2-' + $Platform + '-' + $build.Sha256.Substring(0, 12))
    $executable = Join-Path $target 'retroarch.exe'
    $marker = Join-Path $target 'romm-runtime.json'
    try { $lock = [IO.File]::Open($target + '.lock', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'Another Windows session is preparing RetroArch. Wait for it to finish, then open Play.cmd again.' }
    $staging = $null
    try {
        if ((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $executable)) {
            try {
                $ready = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
                if ($ready.archive -eq $build.Sha256 -and $ready.executable -eq (Get-Sha256 $executable) -and
                    (Get-ExecutablePlatform $executable) -eq $Platform) { return $executable }
            } catch { Write-Host 'Repairing the cached portable RetroArch...' }
        }
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path -LiteralPath $tar)) {
            throw 'Windows tar.exe is required to extract portable RetroArch. Use a current Windows 10/11 release, or pass -RetroArch with an existing executable.'
        }
        $archive = Join-Path $runtimes ($build.Sha256 + '.7z')
        if (-not (Test-Path -LiteralPath $archive) -or (Get-Sha256 $archive) -ne $build.Sha256) {
            Write-Host 'No matching RetroArch found. Downloading official portable RetroArch 1.22.2 (about 200 MB)...'
            Receive-SessionFile "https://buildbot.libretro.com/stable/1.22.2/windows/$($build.Architecture)/RetroArch.7z" ($archive + '.part') '' 268435456 10
            if ((Get-Sha256 ($archive + '.part')) -ne $build.Sha256) { throw 'Portable RetroArch checksum mismatch.' }
            Move-Item -LiteralPath ($archive + '.part') -Destination $archive -Force
        }
        $staging = Join-Path $runtimes ('extract-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $staging | Out-Null
        Write-Host 'Extracting portable RetroArch...'
        # Optional shader packs exceed legacy Windows path limits inside a session cache.
        & $tar -xf $archive -C $staging --exclude "$($build.Directory)/shaders" --exclude "$($build.Directory)/database" --exclude "$($build.Directory)/overlays"
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract portable RetroArch.' }
        $unpacked = Join-Path $staging $build.Directory
        $prepared = Join-Path $unpacked 'retroarch.exe'
        if ((Get-ExecutablePlatform $prepared) -ne $Platform) { throw 'Portable RetroArch architecture mismatch.' }
        @{ archive = $build.Sha256; executable = Get-Sha256 $prepared } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $unpacked 'romm-runtime.json') -Encoding UTF8
        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination ($target + '-previous-' + [Guid]::NewGuid().ToString('N'))
        }
        Move-Item -LiteralPath $unpacked -Destination $target
        return $executable
    } finally {
        if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
        $lock.Dispose()
    }
}

function Resolve-RetroArch([string]$Requested, [string]$Root, [string]$Platform, [string]$PackageRoot) {
    if ($Requested) {
        $path = (Get-Item -LiteralPath $Requested).FullName
        if ((Get-ExecutablePlatform $path) -ne $Platform) { throw 'Selected RetroArch architecture differs from the room package.' }
        return $path
    }
    Write-Host 'Checking for an existing RetroArch...'
    $installed = Find-InstalledRetroArch $Root $Platform $PackageRoot
    if ($installed) { Write-Host "Using existing RetroArch: $installed"; return $installed }
    return Initialize-PortableRetroArch $Root $Platform
}

function Expand-Cartridge([string]$Source, [string]$Destination, $Rom, [string]$Core) {
    if ((Get-Sha256 $Source) -eq $Rom.sha256 -and (Get-Item -LiteralPath $Source).Length -eq $Rom.size) {
        [IO.File]::Copy($Source, $Destination, $true)
        return
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Source)
    try {
        if ($archive.Entries.Count -gt 1024) { throw 'Cartridge ZIP contains too many files.' }
        $pattern = switch ($Core) { 'mgba_splitscreen' { '\.gba$' } 'sameboy' { '\.(gb|gbc)$' } 'snes9x' { '\.(sfc|smc)$' } }
        $entries = @($archive.Entries | Where-Object { $_.FullName -match $pattern -and $_.FullName -notmatch '(^|/)(__MACOSX|\._)' })
        if ($entries.Count -ne 1 -or $entries[0].Length -ne $Rom.size) { throw 'Expected exactly one matching cartridge in the ZIP.' }
        $inputStream = $entries[0].Open()
        $outputStream = [IO.File]::Create($Destination)
        try {
            $buffer = New-Object byte[] 65536
            [long]$total = 0
            while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $count
                if ($total -gt $Rom.size) { throw 'Expanded cartridge exceeds its expected size.' }
                $outputStream.Write($buffer, 0, $count)
            }
            if ($total -ne $Rom.size) { throw 'Expanded cartridge size differs from the room.' }
        } finally { $inputStream.Dispose(); $outputStream.Dispose() }
    } finally { $archive.Dispose() }
    if ((Get-Sha256 $Destination) -ne $Rom.sha256) { throw 'Cartridge hash does not match the room. Refresh the room files.' }
}

function ConvertTo-ConfigValue([string]$Value) {
    if ($Value -match '[\r\n"\x00]') { throw 'Invalid configuration value.' }
    return '"' + $Value.Replace('\', '/') + '"'
}

function ConvertTo-ProcessArgument([string]$Value) {
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Start-NativeTunnel($Connection, [string]$ViewFile = '') {
    if (-not ('RomMNativeTunnel' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
public sealed class RomMNativeTunnel : IDisposable {
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    TcpClient local, remote;
    public int Port { get; private set; }
    public string Error { get; private set; }
    static byte[] ReadExact(Stream stream, int size) {
        var data = new byte[size];
        for (int offset = 0; offset < size;) {
            int count = stream.Read(data, offset, size - offset);
            if (count == 0) throw new IOException("RetroArch handshake ended early.");
            offset += count;
        }
        return data;
    }
    static uint Word(byte[] data, int at) {
        return (uint)data[at] << 24 | (uint)data[at+1] << 16 | (uint)data[at+2] << 8 | data[at+3];
    }
    public static int ModePlayerView(byte[] mode) {
        if (mode.Length < 12 || (Word(mode, 4) & 0x80000000) == 0) return -1;
        if ((Word(mode, 4) & 0x40000000) == 0) return 0;
        uint devices = Word(mode, 8);
        for (int seat = 0; seat < 4; seat++) if (devices == (1u << seat)) return seat + 1;
        return 0;
    }
    static async Task<bool> ReadFull(Stream stream, byte[] data, int count) {
        for (int offset = 0; offset < count;) {
            int read = await stream.ReadAsync(data, offset, count - offset);
            if (read == 0) {
                if (offset == 0) return false;
                throw new IOException("Truncated room packet.");
            }
            offset += read;
        }
        return true;
    }
    public static async Task RelayServer(Stream server, Stream client, string viewFile) {
        var header = new byte[8]; var buffer = new byte[65536]; var mode = new byte[12];
        while (await ReadFull(server, header, header.Length)) {
            uint command = Word(header, 0), remaining = Word(header, 4);
            if (remaining > 16 * 1024 * 1024 + 1024) throw new IOException("Room packet exceeds its size limit.");
            if (command == 0x26 && remaining >= 12 && !String.IsNullOrEmpty(viewFile)) {
                if (!await ReadFull(server, mode, mode.Length)) throw new IOException("Truncated player assignment.");
                int player = ModePlayerView(mode);
                if (player >= 0) {
                    using (var file = new FileStream(viewFile, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
                        file.WriteByte((byte)('0' + player));
                }
                await client.WriteAsync(header, 0, header.Length);
                await client.WriteAsync(mode, 0, mode.Length);
                remaining -= 12;
            } else await client.WriteAsync(header, 0, header.Length);
            while (remaining > 0) {
                int count = (int)Math.Min((uint)buffer.Length, remaining);
                if (!await ReadFull(server, buffer, count)) throw new IOException("Truncated room payload.");
                await client.WriteAsync(buffer, 0, count);
                remaining -= (uint)count;
            }
        }
    }
    public RomMNativeTunnel(string host, int port, string password, string viewFile) {
        listener.Start(1);
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Task.Run(async () => {
            try {
                local = await listener.AcceptTcpClientAsync();
                listener.Stop();
                remote = new TcpClient();
                var connecting = remote.ConnectAsync(host, port);
                if (await Task.WhenAny(connecting, Task.Delay(15000)) != connecting)
                    throw new IOException("Cannot reach the room server.");
                await connecting;
                local.NoDelay = remote.NoDelay = true;
                var client = local.GetStream(); var server = remote.GetStream();
                client.ReadTimeout = server.ReadTimeout = 15000;
                var header = ReadExact(client, 24);
                if (Word(header, 0) != 0x52414e50) throw new IOException("Invalid RetroArch handshake.");
                server.Write(header, 0, header.Length);
                header = ReadExact(server, 24);
                if (Word(header, 0) != 0x52414e50) throw new IOException("Invalid room handshake.");
                uint salt = Word(header, 12);
                if (salt == 0) throw new IOException("Room did not request private authentication.");
                Array.Clear(header, 12, 4);
                client.Write(header, 0, header.Length);
                var nickname = ReadExact(client, 40);
                if (Word(nickname, 0) != 0x20 || Word(nickname, 4) != 32)
                    throw new IOException("Invalid RetroArch nickname packet.");
                server.Write(nickname, 0, nickname.Length);
                byte[] digest;
                using (var sha = SHA256.Create())
                    digest = sha.ComputeHash(Encoding.UTF8.GetBytes(salt.ToString("X8") + password));
                var authentication = new byte[72]; authentication[3] = 0x21; authentication[7] = 64;
                Encoding.ASCII.GetBytes(BitConverter.ToString(digest).Replace("-", "")).CopyTo(authentication, 8);
                server.Write(authentication, 0, authentication.Length);
                var incoming = String.IsNullOrEmpty(viewFile) ? server.CopyToAsync(client) : RelayServer(server, client, viewFile);
                await await Task.WhenAny(client.CopyToAsync(server), incoming);
            } catch (Exception error) { Error = error.Message; }
            finally { Dispose(); }
        });
    }
    public void Dispose() {
        listener.Stop();
        if (local != null) local.Close();
        if (remote != null) remote.Close();
    }
}
'@
    }
    return New-Object RomMNativeTunnel($Connection.host, [int]$Connection.port, $Connection.password, $ViewFile)
}

function Initialize-NativeSession($Session, [string]$Executable, [string]$Root) {
    Assert-Session $Session
    if ((Get-ExecutablePlatform $Executable) -ne $Session.platform) {
        throw 'RetroArch architecture differs from the selected core. Choose its architecture in RomM and prepare again.'
    }
    $cache = Join-Path $Root 'cache'
    $directory = Join-Path $Root ('sessions\' + $Session.roomId + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $cache, $directory | Out-Null
    $coreDirectory = Join-Path $directory 'cores'
    $saveDirectory = Join-Path $directory 'saves'
    # Stock RetroArch redirects rollback clients to this child directory.
    $netplaySaveDirectory = Join-Path $saveDirectory '.netplay'
    New-Item -ItemType Directory -Force $coreDirectory, $saveDirectory, $netplaySaveDirectory | Out-Null
    $assets = @($Session.core)
    if ($null -ne $Session.coreInfo) { $assets += $Session.coreInfo }
    foreach ($asset in $assets) {
        $cached = Join-Path $cache $asset.sha256
        if (-not (Test-Path -LiteralPath $cached) -or (Get-Sha256 $cached) -ne $asset.sha256) {
            Receive-SessionFile $asset.url ($cached + '.part') '' 67108864
            if ((Get-Sha256 ($cached + '.part')) -ne $asset.sha256) { throw 'Core package checksum mismatch.' }
            Move-Item -LiteralPath ($cached + '.part') -Destination $cached -Force
        }
        [IO.File]::Copy($cached, (Join-Path $coreDirectory $asset.name), $true)
    }
    $romPaths = @()
    foreach ($rom in $Session.cartridges) {
        $cached = Join-Path $cache $rom.sha256
        if (-not (Test-Path -LiteralPath $cached) -or (Get-Sha256 $cached) -ne $rom.sha256) {
            $download = Join-Path $directory ($rom.name + '.download')
            Receive-SessionFile $rom.url $download $Session.credential 67108864
            Expand-Cartridge $download ($cached + '.part') $rom $Session.profile.id
            Move-Item -LiteralPath ($cached + '.part') -Destination $cached -Force
            Remove-Item -LiteralPath $download
        }
        $path = Join-Path $directory $rom.name
        [IO.File]::Copy($cached, $path, $true)
        $romPaths += $path
    }
    $config = Join-Path $directory 'retroarch.cfg'
    if ($Session.schemaVersion -ge 2) {
        for ($slot = 0; $slot -lt $Session.cartridges.Count; $slot++) {
            $extension = if ($Session.profile.id -eq 'mgba_splitscreen') {
                if ($slot -eq 0) { 'sav' } else { 'sav' + ($slot + 1) }
            } else { 'srm' }
            $name = [IO.Path]::GetFileNameWithoutExtension($Session.cartridges[$slot].name) + '.' + $extension
            $bytes = [Convert]::FromBase64String($Session.initialBatteries[$slot])
            if ($bytes.Length -gt 0) { [IO.File]::WriteAllBytes((Join-Path $netplaySaveDirectory $name), $bytes) }
        }
    }
    $options = Join-Path $directory 'core-options.cfg'
    $baseConfig = Join-Path (Split-Path -Parent $Executable) 'retroarch.cfg'
    $baseText = if (Test-Path -LiteralPath $baseConfig) { [IO.File]::ReadAllText($baseConfig) + "`n" } else { '' }
    $values = [ordered]@{
        config_save_on_exit = 'false'; core_options_path = $options
        libretro_directory = $coreDirectory; libretro_info_path = $coreDirectory
        savefile_directory = $saveDirectory; savestate_directory = $saveDirectory
        savefiles_in_content_dir = 'false'; savestates_in_content_dir = 'false'
        sort_savefiles_enable = 'false'; sort_savefiles_by_content_enable = 'false'
        savestate_auto_load = 'false'; savestate_auto_save = 'false'
        auto_overrides_enable = 'false'; game_specific_options = 'false'
        run_ahead_enabled = 'false'; preemptive_frames_enable = 'false'
        rewind_enable = 'false'; netplay_start_as_spectator = 'false'
        netplay_password = ''; video_fullscreen = 'false'
        input_auto_game_focus = '0'; menu_pause_libretro = 'false'
        pause_nonactive = 'false'
    }
    if ($Session.profile.id -eq 'sameboy') { $values['audio_out_rate'] = '48000' }
    # RetroArch reads the first occurrence of a setting, including before includes.
    $configText = ''
    foreach ($key in $values.Keys) { $configText += "$key = $(ConvertTo-ConfigValue $values[$key])`n" }
    $configText += $baseText
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($config, $configText, $utf8)
    $optionText = ''
    foreach ($property in $Session.profile.options.PSObject.Properties) {
        if ($property.Name -notmatch '^[a-z0-9_]+$') { throw 'Invalid core option.' }
        $optionText += "$($property.Name) = $(ConvertTo-ConfigValue $property.Value)`n"
    }
    [IO.File]::WriteAllText($options, $optionText, $utf8)
    $arguments = @('--config', $config, '--verbose', '--log-file', (Join-Path $directory 'retroarch.log'),
        '-L', (Join-Path $coreDirectory $Session.core.name), '--connect', $Session.connection.host,
        '--port', [string]$Session.connection.port, '--nick', $Session.connection.nickname)
    if ($Session.profile.subsystem) { $arguments += @('--subsystem', $Session.profile.subsystem) }
    $arguments += $romPaths
    $viewFile = ''
    if ($Session.profile.id -eq 'mgba_splitscreen') {
        $viewFile = Join-Path $directory 'player-view.txt'
        [IO.File]::WriteAllText($viewFile, '0', [Text.Encoding]::ASCII)
    }
    return [PSCustomObject]@{ Directory = $directory; Arguments = $arguments; Executable = $Executable; ViewFile = $viewFile }
}

if ($LibraryOnly) { return }
try {
    if (-not $SessionRoot) { $SessionRoot = Join-Path $env:LOCALAPPDATA 'RomMNetplay' }
    if ($UnregisterLauncher) { Unregister-Launcher $SessionRoot; return }
    $packageRoot = $PSScriptRoot
    if ($LaunchUri) {
        $request = Get-LaunchRequest $LaunchUri (Join-Path $PSScriptRoot 'servers.json')
        Write-Host ('Opening RomM room at ' + $request.Origin)
        $session = Receive-LaunchSession $request $SessionRoot
    } else {
        if (-not $Manifest) { throw 'Open Windows RetroArch from your RomM room, or provide a downloaded session.json.' }
        $session = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $packageRoot = Split-Path -Parent ([IO.Path]::GetFullPath($Manifest))
    }
    if ($RegisterLauncher) { Register-Launcher $session $SessionRoot $PSCommandPath; return }
    if ($InstallCertificate) {
        Install-SessionCertificate $session $packageRoot
        return
    }
    $session = Wait-SessionManifest $session $SessionRoot
    Assert-Session $session
    $RetroArch = Resolve-RetroArch $RetroArch $SessionRoot $session.platform $packageRoot
    Assert-Session $session
    Write-Host 'Preparing matched core and cartridges...'
    $launch = Initialize-NativeSession $session $RetroArch $SessionRoot
    [IO.File]::WriteAllText((Join-Path $SessionRoot 'retroarch-path.txt'), $RetroArch)
    Write-Host "Session files and log: $($launch.Directory)"
    if (-not $PrepareOnly) {
        $tunnel = Start-NativeTunnel $session.connection $launch.ViewFile
        $launch.Arguments[$launch.Arguments.IndexOf('--connect') + 1] = '127.0.0.1'
        $launch.Arguments[$launch.Arguments.IndexOf('--port') + 1] = [string]$tunnel.Port
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $RetroArch
        $start.WorkingDirectory = Split-Path -Parent $RetroArch
        $start.UseShellExecute = $false
        if ($launch.ViewFile) { $start.EnvironmentVariables['ROMM_NETPLAY_PLAYER_FILE'] = $launch.ViewFile }
        $start.Arguments = ($launch.Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
        try {
            $process = [Diagnostics.Process]::Start($start)
            Write-Host 'Choose your player number in the RomM room. The host starts the game.'
            if ($launch.ViewFile) { Write-Host 'mGBA waits on a blank screen until game start, then shows only your assigned screen and audio.' }
            $process.WaitForExit()
        } finally { $tunnel.Dispose() }
        if ($tunnel.Error) { throw $tunnel.Error }
        if ($process.ExitCode -ne 0) { throw "RetroArch exited with code $($process.ExitCode). See the session log." }
    }
} catch {
    [Console]::Error.WriteLine(('RomM launcher failed:' + [Environment]::NewLine + (Get-ExceptionDetails $_.Exception)))
    if ($LaunchUri) { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}
