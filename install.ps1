#requires -Version 5.1
<#
.SYNOPSIS
    Installs the per-window fork of Debug MCP Bridge on this machine.

.DESCRIPTION
    Downloads two artifacts from a GitHub release of the fork:

      * vscode-debug-mcp-bridge-<version>.vsix  — the VS Code extension (HTTP bridge)
      * vscode-debug-mcp-<version>.tgz          — the stdio MCP server

    installs the extension into VS Code and the MCP server into the global npm
    prefix, then prints the Kilo MCP config entry for THIS machine (the global
    path differs per machine, so it is not patched automatically).

.PARAMETER Tag
    Release tag to install from. Default: v0.2.0

.PARAMETER Repo
    GitHub repository holding the release. Default: mujdatdinc/vscode-debug-mcp

.EXAMPLE
    pwsh -File install.ps1
#>
[CmdletBinding()]
param(
    [string]$Tag = "v0.2.0",
    [string]$Repo = "mujdatdinc/vscode-debug-mcp",
    [switch]$SkipExtension,
    [switch]$SkipServer
)

$ErrorActionPreference = "Stop"

$vsixName = "vscode-debug-mcp-bridge-0.2.0.vsix"
$tgzName = "vscode-debug-mcp-0.2.0.tgz"
$base = "https://github.com/$Repo/releases/download/$Tag"
$work = Join-Path $env:TEMP "vscode-debug-mcp-install"

New-Item -ItemType Directory -Force -Path $work | Out-Null

# ── 1. VS Code extension ────────────────────────────────────────────
if (-not $SkipExtension) {
    $vsixPath = Join-Path $work $vsixName
    Write-Host "Downloading $vsixName ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$base/$vsixName" -OutFile $vsixPath

    if (Get-Command code -ErrorAction SilentlyContinue) {
        Write-Host "Installing extension ..." -ForegroundColor Cyan
        & code --install-extension $vsixPath --force
    }
    else {
        Write-Warning "'code' is not on PATH. Install it manually in VS Code:"
        Write-Warning "  Extensions view > ... menu > Install from VSIX... > $vsixPath"
    }
}

# ── 2. stdio MCP server ─────────────────────────────────────────────
if (-not $SkipServer) {
    $tgzPath = Join-Path $work $tgzName
    Write-Host "Downloading $tgzName ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$base/$tgzName" -OutFile $tgzPath

    Write-Host "Installing MCP server globally ..." -ForegroundColor Cyan
    npm install -g $tgzPath
}

# ── 3. Print the Kilo config entry for this machine ─────────────────
$prefix = (npm prefix -g).Trim()
$entry = Join-Path $prefix "node_modules\vscode-debug-mcp\dist\index.js"

if (-not (Test-Path -LiteralPath $entry)) {
    Write-Warning "Expected MCP server entry was not found at: $entry"
}

$snippet = @"
    "vscode-debug": {
      "type": "local",
      "command": [
        "node",
        "$($entry -replace '\\', '\\')"
      ],
      "enabled": true
    }
"@

Write-Host ""
Write-Host "Add this to the 'mcp' object in $env:USERPROFILE\.config\kilo\kilo.jsonc :" -ForegroundColor Green
Write-Host $snippet
Write-Host ""
Write-Host "Then reload the VS Code window (Developer: Reload Window) so the" -ForegroundColor Yellow
Write-Host "extension activates and publishes its bridge to:" -ForegroundColor Yellow
Write-Host "  $env:TEMP\vscode-debug-mcp\instances.json" -ForegroundColor Yellow
