param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$Manifest
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination)
if ([IO.Directory]::Exists($root) -or [IO.File]::Exists($root)) { throw 'Release destination already exists.' }
$rootPrefix = $root.TrimEnd('\') + '\'
$release = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$expected = @{}
foreach ($file in $release.files) {
    $name = [string]$file.path
    if ($name -match '(^/|\\|:|(^|/)\.{1,2}(/|$))' -or $expected.ContainsKey($name)) { throw 'Release manifest path invalid.' }
    $expected.Add($name, [long]$file.bytes)
}
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($zip.Entries.Count -ne $expected.Count) { throw 'Release inventory mismatch.' }
    $seen = @{}
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\','/')
        if (!$expected.ContainsKey($name) -or $seen.ContainsKey($name) -or $entry.Length -ne $expected[$name] -or $name.EndsWith('/')) { throw 'Release inventory mismatch.' }
        $target = [IO.Path]::GetFullPath((Join-Path $root $name.Replace('/','\')))
        if (!$target.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escapes destination.' }
        $seen.Add($name, $true)
    }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = Join-Path $root $entry.FullName.Replace('/','\')
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
