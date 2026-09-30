# Adapted from f-e-n-g-0531/dsh-vcs; see LICENSES/dsh-vcs.txt.
param([Parameter(Mandatory=$true)][string]$Bin)
$ErrorActionPreference = 'Stop'
# Only call for disposable CI tools; modifying resources invalidates vendor signatures.
$mt = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/mt.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (!$mt) { throw 'Windows SDK mt.exe is required' }
foreach ($name in @('svn.exe','svnadmin.exe')) {
  $exe = Join-Path $Bin $name
  $manifest = Join-Path $Bin ($name + '.ci.manifest')
  & $mt.FullName '-nologo' "-inputresource:$exe;#1" "-out:$manifest"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract existing manifest' }
  [xml]$doc = Get-Content -Raw $manifest
  $ns = 'urn:schemas-microsoft-com:asm.v3'
  $app = $doc.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='application']")
  if (!$app) { $app=$doc.CreateElement('application',$ns); [void]$doc.DocumentElement.AppendChild($app) }
  $settings=$app.SelectSingleNode("*[local-name()='windowsSettings']")
  if (!$settings) { $settings=$doc.CreateElement('windowsSettings',$ns); [void]$app.AppendChild($settings) }
  $cp=$settings.SelectSingleNode("*[local-name()='activeCodePage']")
  if (!$cp) { $cp=$doc.CreateElement('activeCodePage','http://schemas.microsoft.com/SMI/2019/WindowsSettings'); [void]$settings.AppendChild($cp) }
  $cp.InnerText='UTF-8'
  $doc.Save($manifest)
  & $mt.FullName '-nologo' '-manifest' $manifest "-outputresource:$exe;#1"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot embed UTF-8 manifest' }
  Write-Host "Enabled per-process UTF-8 for disposable $name"
}
