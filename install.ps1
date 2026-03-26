#!/usr/bin/env pwsh
<#
PowerShell port of the Bash installer so it can be run from PowerShell on Windows.
Supports the same logical options as the original: --cli-only, --skill-only,
--plugin-only, --restart-gateway, --no-skills, --with-skills
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$ScriptArgs
)

Set-StrictMode -Version Latest
$MODE = 'all'
$RESTART_GATEWAY = $false
$SKILLS_PREF = 'default'

foreach ($arg in $ScriptArgs) {
    switch ($arg) {
        '--cli-only' { $MODE = 'cli' }
        '--skill-only' { $MODE = 'skill' }
        '--plugin-only' { $MODE = 'plugin' }
        '--restart-gateway' { $RESTART_GATEWAY = $true }
        '--no-skills' { $SKILLS_PREF = 'off' }
        '--with-skills' { $SKILLS_PREF = 'on' }
        '-h' { Show-Usage; exit 0 }
        '--help' { Show-Usage; exit 0 }
        default { Write-Error "Unknown argument: $arg"; exit 1 }
    }
}

function Show-Usage {
    @'
Usage: install.ps1 [--cli-only|--skill-only|--plugin-only] [--no-skills|--with-skills] [--restart-gateway]

Installs the skillhub CLI (Windows-friendly port).
'@ | Write-Host
}

function Join-Home { param($rel) return Join-Path $env:USERPROFILE $rel }

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $SCRIPT_DIR 'cli')) {
    $CLI_SRC_DIR = Join-Path $SCRIPT_DIR 'cli'
    $PLUGIN_SRC_DIR = Join-Path $SCRIPT_DIR 'plugin'
    $SKILL_SRC_DIR = Join-Path $SCRIPT_DIR 'skill'
} else {
    $CLI_SRC_DIR = $SCRIPT_DIR
    $PLUGIN_SRC_DIR = Join-Path $SCRIPT_DIR 'plugin'
    $SKILL_SRC_DIR = Join-Path $SCRIPT_DIR 'skill'
}

$INSTALL_BASE = Join-Home '.skillhub'
$BIN_DIR = Join-Home '.local\bin'
$CLI_TARGET = Join-Path $INSTALL_BASE 'skills_store_cli.js'
$UPGRADE_MODULE_TARGET = Join-Path $INSTALL_BASE 'skills_upgrade.js'
$PACKAGE_JSON_TARGET = Join-Path $INSTALL_BASE 'package.json'
$VERSION_TARGET = Join-Path $INSTALL_BASE 'version.json'
$METADATA_TARGET = Join-Path $INSTALL_BASE 'metadata.json'
$INDEX_TARGET = Join-Path $INSTALL_BASE 'skills_index.local.json'
$CONFIG_TARGET = Join-Path $INSTALL_BASE 'config.json'
$WRAPPER_TARGET = Join-Path $BIN_DIR 'skillhub.cmd'
$LEGACY_WRAPPER_TARGET = Join-Path $BIN_DIR 'oc-skills.cmd'

$PLUGIN_TARGET_DIR = Join-Path $env:USERPROFILE '.openclaw\extensions\skillhub'
$FIND_SKILL_TARGET_DIR = Join-Path $env:USERPROFILE '.openclaw\workspace\skills\find-skills'
$PREFERENCE_SKILL_TARGET_DIR = Join-Path $env:USERPROFILE '.openclaw\workspace\skills\skillhub-preference'

function Find-OpenClaw-Bin {
    $exe = Get-Command openclaw -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Definition -ErrorAction SilentlyContinue
    if ($exe) { return $exe }
    $candidate = Join-Path $env:USERPROFILE '.local\share\pnpm\openclaw'
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Install-CLI {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Write-Error 'Error: node is required for skillhub.'; exit 1 }

    New-Item -ItemType Directory -Path $INSTALL_BASE -Force | Out-Null
    New-Item -ItemType Directory -Path $BIN_DIR -Force | Out-Null

    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'skills_store_cli.js') -Destination $CLI_TARGET -Force
    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'skills_upgrade.js') -Destination $UPGRADE_MODULE_TARGET -Force
    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'skillhub-bin.js') -Destination (Join-Path $INSTALL_BASE 'skillhub-bin.js') -Force
    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'package.json') -Destination $PACKAGE_JSON_TARGET -Force
    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'version.json') -Destination $VERSION_TARGET -Force
    Copy-Item -Path (Join-Path $CLI_SRC_DIR 'metadata.json') -Destination $METADATA_TARGET -Force
    if (Test-Path (Join-Path $CLI_SRC_DIR 'skills_index.local.json')) {
        Copy-Item -Path (Join-Path $CLI_SRC_DIR 'skills_index.local.json') -Destination $INDEX_TARGET -Force
    }
    if (Test-Path (Join-Path $INSTALL_BASE 'node_modules')) {
        Remove-Item -Path (Join-Path $INSTALL_BASE 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    }
    Push-Location $INSTALL_BASE
    try {
        & npm install --omit=dev | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Error 'Error: npm install failed while preparing the skillhub runtime.'
            exit 1
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $CONFIG_TARGET)) {
        '{' | Out-File -FilePath $CONFIG_TARGET -Encoding utf8
        '  "self_update_url": "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/version.json"' | Out-File -FilePath $CONFIG_TARGET -Encoding utf8 -Append
        '}' | Out-File -FilePath $CONFIG_TARGET -Encoding utf8 -Append
    }

    $wrapperContent = "@echo off`r`n"
    $wrapperContent += 'node "' + $CLI_TARGET + '" %*' + "`r`n"
    $wrapperContent | Out-File -FilePath $WRAPPER_TARGET -Encoding ascii -Force

    $legacy = "@echo off`r`n%~dp0skillhub %*`r`n"
    $legacy | Out-File -FilePath $LEGACY_WRAPPER_TARGET -Encoding ascii -Force
}

function Set-Workspace-Skills-Preference {
    param([bool]$enabled)
    $raw = @{}
    if (Test-Path $CONFIG_TARGET) {
        try {
            $loaded = Get-Content $CONFIG_TARGET -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
            if ($loaded) { $raw = $loaded }
        } catch {
            $raw = @{}
        }
    }
    if (-not $raw.ContainsKey('self_update_url') -or [string]::IsNullOrWhiteSpace([string]$raw['self_update_url'])) {
        $raw['self_update_url'] = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/version.json'
    }
    $raw['install_workspace_skills'] = $enabled
    New-Item -ItemType Directory -Path (Split-Path -Parent $CONFIG_TARGET) -Force | Out-Null
    ($raw | ConvertTo-Json -Depth 10) + "`n" | Set-Content -Path $CONFIG_TARGET -Encoding UTF8
}

function Install-Plugin {
    New-Item -ItemType Directory -Path $PLUGIN_TARGET_DIR -Force | Out-Null
    Copy-Item -Path (Join-Path $PLUGIN_SRC_DIR 'index.ts') -Destination (Join-Path $PLUGIN_TARGET_DIR 'index.ts') -Force
    Copy-Item -Path (Join-Path $PLUGIN_SRC_DIR 'openclaw.plugin.json') -Destination (Join-Path $PLUGIN_TARGET_DIR 'openclaw.plugin.json') -Force
}

function Install-Skill {
    $find_skill_src = Join-Path $SKILL_SRC_DIR 'SKILL.md'
    $preference_skill_src = Join-Path $SKILL_SRC_DIR 'SKILL.skillhub-preference.md'
    $installed = $false

    if (Test-Path $find_skill_src) {
        New-Item -ItemType Directory -Path $FIND_SKILL_TARGET_DIR -Force | Out-Null
        Copy-Item -Path $find_skill_src -Destination (Join-Path $FIND_SKILL_TARGET_DIR 'SKILL.md') -Force
        $installed = $true
    } else { Write-Warning "find-skills source not found at $find_skill_src; skipped." }

    if (Test-Path $preference_skill_src) {
        New-Item -ItemType Directory -Path $PREFERENCE_SKILL_TARGET_DIR -Force | Out-Null
        Copy-Item -Path $preference_skill_src -Destination (Join-Path $PREFERENCE_SKILL_TARGET_DIR 'SKILL.md') -Force
        $installed = $true
    } else { Write-Warning "skillhub-preference source not found at $preference_skill_src; skipped." }

    if (-not $installed) { Write-Warning 'Warn: no skill templates installed.' }
}

function Configure-Plugin {
    $openclaw = Find-OpenClaw-Bin
    if (-not $openclaw) { Write-Warning 'openclaw not found on PATH; skipped plugin config.'; return }

    & $openclaw config set plugins.entries.skillhub.enabled true
    & $openclaw config set plugins.entries.skillhub.config.primaryCli 'skillhub'
    & $openclaw config set plugins.entries.skillhub.config.fallbackCli 'clawhub'
    & $openclaw config set plugins.entries.skillhub.config.primaryLabel 'cn-optimized'
    & $openclaw config set plugins.entries.skillhub.config.fallbackLabel 'public-registry'
}

function Disable-Plugin-If-Present {
    $openclaw = Find-OpenClaw-Bin
    if (-not $openclaw) { Write-Warning 'openclaw not found on PATH; skipped plugin disable.'; return }
    try { & $openclaw config unset plugins.entries.skillhub > $null 2>&1 } catch { Write-Host 'Info: skillhub plugin config entry not found or already removed; skip disable.' }
}

function Restart-Gateway-If-Needed {
    if (-not $RESTART_GATEWAY) { return }
    $openclaw = Find-OpenClaw-Bin
    if (-not $openclaw) { Write-Warning 'openclaw not found on PATH; skipped gateway restart.'; return }
    $log = Join-Path $env:TEMP 'openclaw-gateway.log'
    Start-Process -FilePath $openclaw -ArgumentList 'gateway','run','--bind','loopback','--port','18789','--force' -RedirectStandardOutput $log -RedirectStandardError $log -WindowStyle Hidden
}

if ($MODE -eq 'all' -or $MODE -eq 'cli') { Install-CLI }

if ($SKILLS_PREF -eq 'off') { Set-Workspace-Skills-Preference -enabled:$false }
elseif ($SKILLS_PREF -eq 'on') { Set-Workspace-Skills-Preference -enabled:$true }

if ($MODE -eq 'all' -or $MODE -eq 'skill') {
    if ($SKILLS_PREF -ne 'off') { Install-Skill } else { Write-Host 'Info: skipped workspace skills installation by --no-skills.' }
    Disable-Plugin-If-Present
}

if ($MODE -eq 'plugin') { Install-Plugin; Configure-Plugin }

Restart-Gateway-If-Needed

Write-Host 'Install complete.'
Write-Host "  mode: $MODE"
if ($MODE -eq 'all' -or $MODE -eq 'cli') {
    Write-Host "  cli: $WRAPPER_TARGET"
    if (Test-Path $INDEX_TARGET) { Write-Host "  index: $INDEX_TARGET" }
}
if ($MODE -eq 'all' -or $MODE -eq 'skill') {
    if ($SKILLS_PREF -ne 'off') {
        Write-Host "  skill: $FIND_SKILL_TARGET_DIR\SKILL.md"
        Write-Host "  skill: $PREFERENCE_SKILL_TARGET_DIR\SKILL.md"
    } else { Write-Host '  skill: skipped (--no-skills)' }
}
if ($MODE -eq 'plugin') { Write-Host "  plugin: $PLUGIN_TARGET_DIR" }

Write-Host ''
Write-Host 'Quick check:'
if ($MODE -eq 'all' -or $MODE -eq 'cli') { Write-Host '  skillhub search calendar' }
if ($MODE -eq 'all' -or $MODE -eq 'skill') {
    if ($SKILLS_PREF -ne 'off') {
        Write-Host "  Test-Path '$FIND_SKILL_TARGET_DIR\SKILL.md' -and (Get-Item '$FIND_SKILL_TARGET_DIR\SKILL.md') -and Write-Host 'find-skills-installed'"
        Write-Host "  Test-Path '$PREFERENCE_SKILL_TARGET_DIR\SKILL.md' -and (Get-Item '$PREFERENCE_SKILL_TARGET_DIR\SKILL.md') -and Write-Host 'skillhub-preference-installed'"
    } else { Write-Host '  skills install skipped by --no-skills' }
}
if ($MODE -eq 'plugin') { Write-Host '  If you use OpenClaw: openclaw plugins list | Select-String skillhub' }
