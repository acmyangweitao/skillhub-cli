#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

const AdmZip = require('adm-zip');
const tar = require('tar');
const { Command } = require('commander');

const { cmdUpgrade: runSkillsUpgrade } = require('./skills_upgrade');

const AUTO_INSTALL_ROOT_SENTINEL = '__auto_install_root__';
const AUTO_WORKDIR_SENTINEL = '__auto_workdir__';
const LOCKFILE_NAME = '.skills_store_lock.json';
const SKILL_CONFIG_NAME = 'config.json';
const SKILL_META_NAME = '_meta.json';
const CLI_CONFIG_NAME = 'config.json';
const CLI_VERSION_FILE_NAME = 'version.json';
const CLI_METADATA_FILE_NAME = 'metadata.json';
const CLI_VERSION_FALLBACK = '2026.3.3';
const DEFAULT_INDEX_URI_FALLBACK = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills.json';
const DEFAULT_SEARCH_URL_FALLBACK = 'https://lightmake.site/api/v1/search';
const SELF_UPGRADE_CHECK_TIMEOUT_SECONDS = 2;
const DEFAULT_CLI_HOME = '~/.skillhub';
const SELF_UPGRADE_REEXEC_ENV = 'SKILLHUB_SELF_UPGRADE_REEXEC';
const SKIP_SELF_UPGRADE_ENV = 'SKILLHUB_SKIP_SELF_UPGRADE';
const SKIP_WORKSPACE_SKILLS_ENV = 'SKILLHUB_SKIP_WORKSPACE_SKILLS';
const DEFAULT_SELF_UPDATE_MANIFEST_URL_FALLBACK = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/version.json';
const DEFAULT_SKILLS_DOWNLOAD_URL_TEMPLATE_FALLBACK = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/{slug}.zip';
const DEFAULT_PRIMARY_DOWNLOAD_URL_TEMPLATE_FALLBACK = 'https://lightmake.site/api/v1/download?slug={slug}';
const DEFAULT_OPENCLAW_CONFIG_PATH = '~/.openclaw/openclaw.json';
const DEFAULT_OPENCLAW_WORKSPACE_PATH = '~/.openclaw/workspace';
const DEFAULT_OPENCLAW_PLUGIN_DIR = '~/.openclaw/extensions/skillhub';
const LEGACY_OPENCLAW_PLUGIN_FILES = ['index.ts', 'openclaw.plugin.json'];
const POST_UPGRADE_SKILL_MIGRATION_MIN_VERSION = [3, 13];
const FIND_SKILLS_SLUG = 'find-skills';
const SKILLHUB_PREFERENCE_SLUG = 'skillhub-preference';

function expandUser(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function looksLikeWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function hasExplicitScheme(value) {
  if (!value || looksLikeWindowsAbsolutePath(value)) {
    return false;
  }
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function loadCliVersion(baseDir) {
  const versionPath = path.join(baseDir, CLI_VERSION_FILE_NAME);
  if (!fs.existsSync(versionPath)) {
    return CLI_VERSION_FALLBACK;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.version === 'string' && raw.version.trim()) {
      return raw.version.trim();
    }
  } catch {
    return CLI_VERSION_FALLBACK;
  }
  return CLI_VERSION_FALLBACK;
}

function loadCliMetadata(baseDir) {
  const metadataPath = path.join(baseDir, CLI_METADATA_FILE_NAME);
  if (!fs.existsSync(metadataPath)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const out = {};
    for (const key of [
      'skills_index_url',
      'skills_download_url_template',
      'self_update_manifest_url',
      'skills_search_url',
      'skills_primary_download_url_template',
    ]) {
      if (typeof raw[key] === 'string' && raw[key].trim()) {
        out[key] = raw[key].trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

const BASE_DIR = __dirname;
const CLI_VERSION = loadCliVersion(BASE_DIR);
const CLI_METADATA = loadCliMetadata(BASE_DIR);
const DEFAULT_INDEX_URI = CLI_METADATA.skills_index_url || DEFAULT_INDEX_URI_FALLBACK;
const DEFAULT_SELF_UPDATE_MANIFEST_URL = CLI_METADATA.self_update_manifest_url || DEFAULT_SELF_UPDATE_MANIFEST_URL_FALLBACK;
const DEFAULT_SKILLS_DOWNLOAD_URL_TEMPLATE =
  CLI_METADATA.skills_download_url_template || DEFAULT_SKILLS_DOWNLOAD_URL_TEMPLATE_FALLBACK;
const DEFAULT_SEARCH_URL = process.env.SKILLHUB_SEARCH_URL?.trim() || CLI_METADATA.skills_search_url || DEFAULT_SEARCH_URL_FALLBACK;
const DEFAULT_PRIMARY_DOWNLOAD_URL_TEMPLATE =
  process.env.SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE?.trim() ||
  CLI_METADATA.skills_primary_download_url_template ||
  DEFAULT_PRIMARY_DOWNLOAD_URL_TEMPLATE_FALLBACK;
const CLI_USER_AGENT = `skills-store-cli/${CLI_VERSION}`;

function verboseEnabled() {
  return process.env.LOG === 'VERBOSE';
}

function verboseLog(message) {
  if (verboseEnabled()) {
    console.log(`[self-upgrade][verbose] ${message}`);
  }
}

function createExitError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function asDict(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstNonEmptyString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeFileUri(uriOrPath) {
  const parsed = new URL(uriOrPath);
  if (parsed.protocol !== 'file:') {
    throw createExitError(`Invalid file URI: ${uriOrPath}`);
  }
  return path.resolve(decodeURIComponent(parsed.pathname.replace(/^\/+/, parsed.host ? '/' : '')));
}

function parsePathLikeUri(uriOrPath) {
  const value = String(uriOrPath || '').trim();
  if (!value) {
    throw createExitError('Path is required');
  }
  if (value.startsWith('file://')) {
    return normalizeFileUri(value);
  }
  if (hasExplicitScheme(value)) {
    throw createExitError(`Only file:// or local paths are supported here. Got: ${value}`);
  }
  return path.resolve(expandUser(value));
}

function appendSlugZip(baseUriOrPath, slug) {
  const base = String(baseUriOrPath || '').trim();
  if (!base) {
    return '';
  }
  if (base.includes('{slug}')) {
    return base.replaceAll('{slug}', encodeURIComponent(slug));
  }
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return new URL(`${encodeURIComponent(slug)}.zip`, base.endsWith('/') ? base : `${base}/`).toString();
  }
  const basePath = parsePathLikeUri(base);
  return path.join(basePath, `${slug}.zip`);
}

function fillSlugTemplate(template, slug) {
  const raw = String(template || '').trim();
  if (!raw) {
    return '';
  }
  if (!raw.includes('{slug}')) {
    return raw;
  }
  return raw.replaceAll('{slug}', encodeURIComponent(slug));
}

function parseBoolLike(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Boolean(value);
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function normalizeVersionText(value) {
  return String(value || '').trim();
}

function parseVersionKey(version) {
  let raw = normalizeVersionText(version).toLowerCase();
  if (raw.startsWith('v')) {
    raw = raw.slice(1);
  }
  if (!raw) {
    return null;
  }
  const core = raw.split('-', 1)[0].split('+', 1)[0];
  const parts = core.split('.');
  const out = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    out.push(Number(part));
  }
  return out.length ? out : null;
}

function compareVersionArrays(a, b) {
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }
  return 0;
}

function versionIsNewer(candidate, current) {
  const normalizedCandidate = normalizeVersionText(candidate);
  const normalizedCurrent = normalizeVersionText(current);
  if (!normalizedCandidate) {
    return false;
  }
  if (!normalizedCurrent) {
    return true;
  }
  const a = parseVersionKey(normalizedCandidate);
  const b = parseVersionKey(normalizedCurrent);
  if (a && b) {
    return compareVersionArrays(a, b) > 0;
  }
  return normalizedCandidate !== normalizedCurrent;
}

function versionAtLeast(version, minimum) {
  const parsed = parseVersionKey(version);
  if (!parsed) {
    return false;
  }
  return compareVersionArrays(parsed, minimum) >= 0;
}

function selfUpdateUrlFromConfig(config) {
  const direct = firstNonEmptyString(config, [
    'self_update_url',
    'selfUpdateUrl',
    'update_url',
    'updateUrl',
    'manifest_url',
    'manifestUrl',
  ]);
  if (direct) {
    return direct;
  }
  for (const key of ['self_update', 'selfUpdate', 'update', 'upgrade']) {
    const nested = asDict(config[key]);
    const urlValue = firstNonEmptyString(nested, ['url', 'uri', 'manifest', 'manifest_url', 'manifestUrl']);
    if (urlValue) {
      return urlValue;
    }
  }
  return '';
}

function selfUpdateEnabledFromConfig(config) {
  for (const key of ['auto_self_upgrade', 'autoSelfUpgrade', 'self_update_auto', 'selfUpdateAuto']) {
    const parsed = parseBoolLike(config[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  for (const key of ['self_update', 'selfUpdate', 'update', 'upgrade']) {
    const nested = asDict(config[key]);
    for (const nestedKey of ['auto', 'enabled', 'auto_upgrade', 'autoUpgrade', 'enabled_auto_upgrade']) {
      const parsed = parseBoolLike(nested[nestedKey]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

function resolveOpenclawConfigPath() {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return path.resolve(expandUser(override));
  }
  return path.resolve(expandUser(DEFAULT_OPENCLAW_CONFIG_PATH));
}

function resolveSkillhubConfigPath() {
  const override = process.env.SKILLHUB_CONFIG_PATH?.trim();
  if (override) {
    return path.resolve(expandUser(override));
  }
  return path.resolve(expandUser(path.posix.join(DEFAULT_CLI_HOME, CLI_CONFIG_NAME)));
}

function cleanupLegacyOpenclawPluginFiles(pluginDir) {
  const baseDir = pluginDir ? path.resolve(pluginDir) : path.resolve(expandUser(DEFAULT_OPENCLAW_PLUGIN_DIR));
  for (const name of LEGACY_OPENCLAW_PLUGIN_FILES) {
    const target = path.join(baseDir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      verboseLog(`removed legacy skillhub plugin file: ${target}`);
    } catch (error) {
      verboseLog(`failed to remove legacy skillhub plugin file ${target}: ${error.message}`);
    }
  }
}

function readJsonObject(targetPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    return asDict(raw);
  } catch {
    return {};
  }
}

function shouldInstallWorkspaceSkills() {
  const envOverride = parseBoolLike(process.env[SKIP_WORKSPACE_SKILLS_ENV]);
  if (envOverride === true) {
    verboseLog(`workspace skills install skipped by env ${SKIP_WORKSPACE_SKILLS_ENV}=true`);
    return false;
  }
  if (envOverride === false) {
    return true;
  }
  const config = readJsonObject(resolveSkillhubConfigPath());
  const configured = parseBoolLike(config.install_workspace_skills);
  return configured === null ? true : configured;
}

function openclawConfigHasSkillhubEntry(config) {
  const plugins = asDict(config.plugins);
  const entries = asDict(plugins.entries);
  return Object.prototype.hasOwnProperty.call(entries, 'skillhub');
}

function skillhubPluginDirPresent() {
  const pluginDir = path.resolve(expandUser(DEFAULT_OPENCLAW_PLUGIN_DIR));
  try {
    return fs.existsSync(pluginDir) && fs.readdirSync(pluginDir).length > 0;
  } catch {
    return false;
  }
}

function detectSkillhubPluginBehavior(configPath) {
  const config = readJsonObject(configPath);
  return [skillhubPluginDirPresent() || openclawConfigHasSkillhubEntry(config), config];
}

function resolveOpenclawBin() {
  const candidate = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const result = spawnSync(candidate, ['--help'], { stdio: 'ignore', shell: false });
  if (!result.error) {
    return candidate;
  }
  const fallback = path.resolve(expandUser('~/.local/share/pnpm/openclaw'));
  return fs.existsSync(fallback) ? fallback : '';
}

function disableSkillhubPluginViaOpenclaw(openclawBin) {
  if (!openclawBin) {
    return false;
  }
  try {
    const result = spawnSync(openclawBin, ['config', 'unset', 'plugins.entries.skillhub'], {
      encoding: 'utf8',
      shell: false,
    });
    if (result.status === 0) {
      verboseLog('removed skillhub plugin config via openclaw config unset');
      return true;
    }
    const err = `${result.stderr || ''}${result.stdout || ''}`.trim().toLowerCase();
    if (err.includes('config path not found')) {
      return true;
    }
    if (err) {
      verboseLog(`openclaw config unset failed: ${err}`);
    }
  } catch (error) {
    verboseLog(`disable plugin by openclaw failed: ${error.message}`);
  }
  return false;
}

function resolveOpenclawWorkspacePath(config) {
  const envWorkspace = process.env.OPENCLAW_WORKSPACE?.trim();
  if (envWorkspace) {
    return path.resolve(expandUser(envWorkspace));
  }
  for (const key of ['workspace', 'workspace_dir', 'workspaceDir', 'workspace_path', 'workspacePath']) {
    if (typeof config[key] === 'string' && config[key].trim()) {
      return path.resolve(expandUser(config[key].trim()));
    }
  }
  const pathsSection = asDict(config.paths);
  for (const key of ['workspace', 'workspaceDir', 'workspace_path', 'workspacePath']) {
    if (typeof pathsSection[key] === 'string' && pathsSection[key].trim()) {
      return path.resolve(expandUser(pathsSection[key].trim()));
    }
  }
  const agents = asDict(config.agents);
  const defaults = asDict(agents.defaults);
  for (const key of ['workspace', 'workspace_dir', 'workspaceDir', 'workspace_path', 'workspacePath']) {
    if (typeof defaults[key] === 'string' && defaults[key].trim()) {
      return path.resolve(expandUser(defaults[key].trim()));
    }
  }
  const legacyAgent = asDict(config.agent);
  for (const key of ['workspace', 'workspace_dir', 'workspaceDir', 'workspace_path', 'workspacePath']) {
    if (typeof legacyAgent[key] === 'string' && legacyAgent[key].trim()) {
      return path.resolve(expandUser(legacyAgent[key].trim()));
    }
  }
  const agentCandidates = Array.isArray(agents.list) ? agents.list : [];
  let selected = agentCandidates.find((item) => asDict(item).default === true);
  if (!selected) {
    selected = agentCandidates.find((item) => asDict(item).id === 'main');
  }
  if (!selected) {
    selected = agentCandidates.find((item) => typeof asDict(item).workspace === 'string' && asDict(item).workspace.trim());
  }
  if (selected) {
    for (const key of ['workspace', 'workspace_dir', 'workspaceDir', 'workspace_path', 'workspacePath']) {
      if (typeof selected[key] === 'string' && selected[key].trim()) {
        return path.resolve(expandUser(selected[key].trim()));
      }
    }
  }
  return path.resolve(expandUser(DEFAULT_OPENCLAW_WORKSPACE_PATH));
}

function resolveDefaultWorkdir() {
  const envWorkdir = process.env.SKILLHUB_WORKDIR?.trim();
  if (envWorkdir) {
    return path.resolve(expandUser(envWorkdir));
  }
  const configPath = resolveOpenclawConfigPath();
  const config = readJsonObject(configPath);
  const workspacePath = resolveOpenclawWorkspacePath(config);
  if (Object.keys(config).length > 0 || fs.existsSync(workspacePath) || process.env.OPENCLAW_WORKSPACE?.trim()) {
    return workspacePath;
  }
  return process.cwd();
}

function resolveWorkdir(rawWorkdir) {
  const value = String(rawWorkdir || '').trim();
  if (value && value !== AUTO_WORKDIR_SENTINEL) {
    return path.resolve(expandUser(value));
  }
  return resolveDefaultWorkdir();
}

function resolveInstallRoot(rawDir, rawWorkdir) {
  const envDir = process.env.SKILLHUB_INSTALL_DIR?.trim();
  const rawDirValue = String(rawDir || '').trim();
  if (envDir && (!rawDirValue || rawDirValue === AUTO_INSTALL_ROOT_SENTINEL)) {
    return path.resolve(expandUser(envDir));
  }
  const workdir = resolveWorkdir(rawWorkdir);
  if (rawDirValue && rawDirValue !== AUTO_INSTALL_ROOT_SENTINEL) {
    const candidate = expandUser(rawDirValue);
    if (path.isAbsolute(candidate)) {
      return path.resolve(candidate);
    }
    return path.resolve(workdir, candidate);
  }
  return path.resolve(workdir, 'skills');
}

function readSkillTemplate(templatePath) {
  if (!templatePath || !fs.existsSync(templatePath)) {
    return '';
  }
  try {
    return fs.readFileSync(templatePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function installWorkspaceSkill(workspacePath, slug, content) {
  const target = path.join(workspacePath, 'skills', slug, 'SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  return target;
}

function runPostUpgradePluginMigration(latestVersion, findSkillTemplate, preferenceSkillTemplate) {
  if (!versionAtLeast(latestVersion, POST_UPGRADE_SKILL_MIGRATION_MIN_VERSION)) {
    return;
  }
  const configPath = resolveOpenclawConfigPath();
  const [hasPluginBehavior, config] = detectSkillhubPluginBehavior(configPath);
  if (!hasPluginBehavior) {
    return;
  }
  const openclawBin = resolveOpenclawBin();
  if (openclawBin) {
    disableSkillhubPluginViaOpenclaw(openclawBin);
  }
  if (!shouldInstallWorkspaceSkills()) {
    return;
  }
  const configAfter = readJsonObject(configPath);
  const workspacePath = resolveOpenclawWorkspacePath(Object.keys(configAfter).length ? configAfter : config);
  const findSkillText = readSkillTemplate(findSkillTemplate);
  const preferenceSkillText = readSkillTemplate(preferenceSkillTemplate);
  if (findSkillText) {
    installWorkspaceSkill(workspacePath, FIND_SKILLS_SLUG, findSkillText);
  }
  if (preferenceSkillText) {
    installWorkspaceSkill(workspacePath, SKILLHUB_PREFERENCE_SLUG, preferenceSkillText);
  }
}

function resolveUriWithBase(raw, baseDir) {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('file://')) {
    return value;
  }
  if (hasExplicitScheme(value)) {
    throw createExitError(`Unsupported URI scheme: ${value}`);
  }
  return path.resolve(baseDir, expandUser(value));
}

function extractUpdateManifestInfo(manifest) {
  const candidates = [asDict(manifest)];
  for (const key of ['latest', 'release', 'data', 'skill', 'package']) {
    const nested = asDict(manifest[key]);
    if (Object.keys(nested).length > 0) {
      candidates.push(nested);
    }
  }
  let latestVersion = '';
  let packageUri = '';
  let sha256 = '';
  for (const item of candidates) {
    if (!latestVersion) {
      latestVersion = firstNonEmptyString(item, ['version', 'latest_version', 'latestVersion']);
    }
    if (!packageUri) {
      packageUri = firstNonEmptyString(item, ['zip_url', 'zipUrl', 'download_url', 'downloadUrl', 'package_url', 'packageUrl', 'url']);
    }
    if (!sha256) {
      sha256 = firstNonEmptyString(item, ['sha256', 'sha_256', 'checksum']).toLowerCase();
    }
  }
  return { latestVersion, packageUri, sha256 };
}

function requestBuffer(urlString, timeoutSeconds = 20, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      target,
      {
        method: 'GET',
        headers: {
          'User-Agent': CLI_USER_AGENT,
          Accept: accept,
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          const redirected = new URL(response.headers.location, target).toString();
          response.resume();
          requestBuffer(redirected, timeoutSeconds, accept).then(resolve, reject);
          return;
        }
        if (status >= 400) {
          response.resume();
          reject(new Error(`Request failed (${status}) for ${urlString}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    request.setTimeout(Math.max(1, Number(timeoutSeconds || 20)) * 1000, () => {
      request.destroy(new Error(`Request timed out for ${urlString}`));
    });
    request.on('error', reject);
    request.end();
  });
}

async function readJsonFromUri(uriOrPath, timeout = 20) {
  const value = String(uriOrPath || '').trim();
  if (!value) {
    throw new Error('JSON source is required');
  }
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const payload = await requestBuffer(value, timeout, 'application/json');
    return JSON.parse(payload.toString('utf8'));
  }
  const targetPath = parsePathLikeUri(value);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`JSON source not found: ${targetPath}`);
  }
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

function normalizeSkillsPayload(data) {
  if (Array.isArray(data)) {
    return { skills: data };
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.skills)) {
      return data;
    }
    throw createExitError('Index JSON must include a "skills" array.');
  }
  throw createExitError('Index JSON must be an object or array.');
}

async function loadIndex(indexUri) {
  const data = await readJsonFromUri(indexUri, 20);
  return normalizeSkillsPayload(data);
}

function indexLocalPathOrNone(indexUri) {
  const value = String(indexUri || '').trim();
  if (!value) {
    return null;
  }
  if (!hasExplicitScheme(value) || value.startsWith('file://')) {
    return parsePathLikeUri(value);
  }
  return null;
}

function skillZipUri(skill, slug, indexPath, filesBaseUri, downloadUrlTemplate) {
  if (String(filesBaseUri || '').trim()) {
    const fromBase = appendSlugZip(filesBaseUri, slug);
    if (fromBase) {
      return fromBase;
    }
  }
  if (indexPath) {
    const siblingFiles = path.resolve(path.dirname(indexPath), 'files', `${slug}.zip`);
    if (fs.existsSync(siblingFiles)) {
      return siblingFiles;
    }
  }
  for (const key of ['zip_url', 'zipUrl', 'archive_url', 'archiveUrl', 'file_url', 'fileUrl']) {
    const raw = String(skill[key] || '').trim();
    if (!raw) {
      continue;
    }
    if (hasExplicitScheme(raw) || raw.startsWith('file://')) {
      return raw;
    }
    return path.resolve(expandUser(raw));
  }
  if (String(downloadUrlTemplate || '').trim()) {
    return appendSlugZip(downloadUrlTemplate, slug);
  }
  throw createExitError(`Skill "${slug}" has no zip_url and no local archive found. Use --files-base-uri or --download-url-template.`);
}

function loadLockfile(installRoot) {
  const lockPath = path.join(installRoot, LOCKFILE_NAME);
  if (!fs.existsSync(lockPath)) {
    return { version: 1, skills: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { version: 1, skills: {} };
    }
    if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
      raw.skills = {};
    }
    return raw;
  } catch {
    return { version: 1, skills: {} };
  }
}

function saveLockfile(installRoot, lock) {
  fs.mkdirSync(installRoot, { recursive: true });
  const lockPath = path.join(installRoot, LOCKFILE_NAME);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function resolveClawhubLockPath() {
  const override = process.env.SKILLHUB_CLAWHUB_LOCK_PATH?.trim();
  if (override) {
    return path.resolve(expandUser(override));
  }
  return path.resolve(expandUser('~/.openclaw/workspace/.clawhub/lock.json'));
}

function updateClawhubLockV1(slug, version) {
  const lockPath = resolveClawhubLockPath();
  if (!fs.existsSync(lockPath)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.version !== 1) {
      return;
    }
    if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
      raw.skills = {};
    }
    raw.skills[slug] = {
      version,
      installedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  } catch {
  }
}

function normalizeSourceLabel(value) {
  const source = String(value || '').trim();
  return !source || source.toLowerCase() === 'unknown' ? 'skillhub' : source;
}

function isClawhubUrl(value) {
  try {
    const host = new URL(value).host.toLowerCase();
    return host === 'clawhub.ai' || host.endsWith('.clawhub.ai');
  } catch {
    return false;
  }
}

async function fetchRemoteSearchResults(searchUrl, query, limit, timeout) {
  const base = String(searchUrl || '').trim();
  const q = String(query || '').trim();
  if (!base || !q || !(base.startsWith('http://') || base.startsWith('https://'))) {
    return null;
  }
  try {
    const target = new URL(base);
    target.searchParams.set('q', q);
    target.searchParams.set('limit', String(Math.max(1, Number(limit || 20))));
    const payload = await requestBuffer(target.toString(), timeout, 'application/json');
    const raw = JSON.parse(payload.toString('utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) {
      return null;
    }
    const out = [];
    for (const item of raw.results) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const slug = String(item.slug || '').trim();
      if (!slug) {
        continue;
      }
      out.push({
        slug,
        name: String(item.displayName || item.name || slug).trim() || slug,
        description: String(item.summary || item.description || '').trim(),
        summary: String(item.summary || '').trim(),
        version: String(item.version || '').trim(),
        source: isClawhubUrl(item.url || '') ? 'clawhub' : 'skillhub',
      });
    }
    return out.slice(0, Math.max(1, Number(limit || 20)));
  } catch {
    return null;
  }
}

async function downloadFileOrRaise(url, destPath) {
  if (!url) {
    throw new Error('Download URL is required');
  }
  if (!hasExplicitScheme(url) || url.startsWith('file://')) {
    const sourcePath = parsePathLikeUri(url);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Download failed: local file not found: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, destPath);
    return;
  }
  const payload = await requestBuffer(url, 30, 'application/zip,application/octet-stream,*/*');
  fs.writeFileSync(destPath, payload);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function assertSafeArchivePath(entryName, label) {
  const normalized = entryName.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw createExitError(`Unsafe ${label} path entry detected: ${entryName}`);
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) {
    throw createExitError(`Unsafe ${label} path entry detected: ${entryName}`);
  }
}

function safeExtractZip(zipPath, targetDir) {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    assertSafeArchivePath(entry.entryName, 'zip');
  }
  zip.extractAllTo(targetDir, true);
}

async function safeExtractTar(tarPath, targetDir) {
  await tar.t({
    file: tarPath,
    onentry: (entry) => assertSafeArchivePath(entry.path, 'tar'),
  });
  await tar.x({
    file: tarPath,
    cwd: targetDir,
    strict: true,
  });
}

function findSkill(data, slug) {
  return data.skills.find((item) => item && typeof item === 'object' && String(item.slug || '').trim() === slug) || null;
}

async function installZipToTarget({ slug, zipUri, targetDir, force, expectedSha256 = '' }) {
  if (fs.existsSync(targetDir) && !force) {
    throw createExitError(`Target exists: ${targetDir} (use --force to overwrite)`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-cli-'));
  try {
    const zipPath = path.join(tempDir, `${slug}.zip`);
    const stageDir = path.join(tempDir, 'stage');
    fs.mkdirSync(stageDir, { recursive: true });
    console.log(`Downloading: ${zipUri}`);
    await downloadFileOrRaise(zipUri, zipPath);
    if (expectedSha256) {
      const actual = sha256File(zipPath).toLowerCase();
      if (actual !== expectedSha256.toLowerCase()) {
        throw createExitError(`SHA256 mismatch for ${slug}: expected ${expectedSha256}, got ${actual}`);
      }
    }
    try {
      safeExtractZip(zipPath, stageDir);
    } catch (error) {
      throw createExitError(`Downloaded file is not a valid zip archive: ${zipUri}`);
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(stageDir, targetDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function installZipToTargetWithFallback({ slug, zipUris, targetDir, force, expectedSha256 = '' }) {
  const ordered = [];
  const seen = new Set();
  for (const item of zipUris) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  if (ordered.length === 0) {
    throw createExitError(`No download URL candidates for "${slug}"`);
  }
  let lastError = null;
  for (let index = 0; index < ordered.length; index += 1) {
    try {
      await installZipToTarget({ slug, zipUri: ordered[index], targetDir, force, expectedSha256 });
      return ordered[index];
    } catch (error) {
      lastError = error;
      if (index + 1 < ordered.length) {
        console.error(`Download failed, fallback next source: ${error.message || error}`);
      }
    }
  }
  throw lastError || createExitError(`Failed to download ${slug}`);
}

async function cmdSearch(options) {
  const queryParts = Array.isArray(options.query) ? options.query : [options.query];
  const query = queryParts.map((part) => String(part || '')).join(' ').toLowerCase().trim();
  if (!query) {
    throw createExitError('search query is required');
  }
  const remote = await fetchRemoteSearchResults(options.searchUrl, query, options.searchLimit, options.searchTimeout);
  if (remote === null) {
    throw createExitError(`remote search unavailable: ${options.searchUrl}`);
  }
  if (options.jsonOutput) {
    console.log(JSON.stringify({ query, count: remote.length, results: remote }, null, 0));
    return;
  }
  if (remote.length === 0) {
    console.log('No skills found.');
    return;
  }
  console.log('You can use "skillhub install [skill]" to install.');
  for (const skill of remote) {
    console.log(`${skill.slug}  ${skill.name}`);
    if (skill.description) {
      console.log(`  - ${skill.description}`);
    }
    if (skill.version) {
      console.log(`  - version: ${skill.version}`);
    }
  }
}

async function cmdInstall(options) {
  let data = { skills: [] };
  try {
    data = await loadIndex(options.index);
  } catch (error) {
    console.error(`warn: failed to load index (${options.index}), continue with remote/direct install`);
  }

  let skill = findSkill(data, options.slug);
  if (!skill) {
    const remote = await fetchRemoteSearchResults(options.searchUrl, options.slug, options.searchLimit, options.searchTimeout);
    if (remote) {
      const exact = remote.find((item) => String(item.slug || '').trim() === options.slug);
      if (exact) {
        skill = exact;
        console.error(`info: "${options.slug}" not in index, using remote registry exact match`);
      } else {
        console.error(`info: "${options.slug}" not in index, and remote search has no exact slug match; try direct download by slug`);
      }
    }
  }

  if (!skill) {
    skill = { slug: options.slug, name: options.slug, version: '', source: 'skillhub' };
    console.error(`info: "${options.slug}" not in index/remote search, try direct download by slug`);
  }

  const primaryZipUrl = fillSlugTemplate(options.primaryDownloadUrlTemplate, options.slug);
  if (!primaryZipUrl) {
    throw createExitError('Primary download URL template resolved empty URL');
  }

  const installRoot = path.resolve(options.dir);
  const targetDir = path.join(installRoot, options.slug);
  const expectedSha256 = String(skill.sha256 || '').trim().toLowerCase();
  await installZipToTargetWithFallback({
    slug: options.slug,
    zipUris: [primaryZipUrl],
    targetDir,
    force: Boolean(options.force),
    expectedSha256,
  });

  const lock = loadLockfile(installRoot);
  if (!lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) {
    lock.skills = {};
  }
  lock.skills[options.slug] = {
    name: skill.name || options.slug,
    zip_url: primaryZipUrl,
    source: normalizeSourceLabel(skill.source),
    version: String(skill.version || '').trim(),
  };
  saveLockfile(installRoot, lock);
  updateClawhubLockV1(options.slug, String(skill.version || '').trim());
  console.log(`Installed: ${options.slug} -> ${targetDir}`);
}

async function cmdUpgrade(options) {
  const code = await runSkillsUpgrade(
    {
      ...options,
      checkOnly: Boolean(options.checkOnly),
      timeout: Number(options.timeout || 20),
    },
    {
      loadLockfile,
      saveLockfile,
      readJsonFromUri,
      extractUpdateManifestInfo,
      resolveUriWithBase,
      versionIsNewer,
      installZipToTarget,
      skillConfigName: SKILL_CONFIG_NAME,
      skillMetaName: SKILL_META_NAME,
    }
  );
  if (code !== 0) {
    throw createExitError('Upgrade failed', code);
  }
}

function resolveSelfUpdateManifestUrl(configPath) {
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const manifestUrlRaw = selfUpdateUrlFromConfig(asDict(raw));
      if (manifestUrlRaw) {
        return resolveUriWithBase(manifestUrlRaw, path.dirname(configPath));
      }
    } catch {
    }
  }
  return DEFAULT_SELF_UPDATE_MANIFEST_URL;
}

function shouldRunStartupSelfUpgrade(configPath) {
  const envOverride = parseBoolLike(process.env[SKIP_SELF_UPGRADE_ENV]);
  if (envOverride === true) {
    return false;
  }
  if (!fs.existsSync(configPath)) {
    return true;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const enabled = selfUpdateEnabledFromConfig(asDict(raw));
    if (enabled === false) {
      return false;
    }
  } catch {
  }
  return true;
}

function findFileInExtracted(root, filename) {
  const direct = path.join(root, filename);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const nested = path.join(root, 'cli', filename);
  if (fs.existsSync(nested)) {
    return nested;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === filename) {
        return full;
      }
    }
  }
  return null;
}

function findSkillFileInExtracted(root, filename) {
  const direct = path.join(root, 'skill', filename);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const nested = path.join(root, 'cli', 'skill', filename);
  if (fs.existsSync(nested)) {
    return nested;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === filename && path.basename(path.dirname(full)) === 'skill') {
        return full;
      }
    }
  }
  return null;
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    return buffer.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    return false;
  }
}

function isTarLike(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
}

async function runSelfUpgradeFlow({ configPath, targetPath, currentVersion, timeout, checkOnly, quiet }) {
  const manifestUrl = resolveSelfUpdateManifestUrl(configPath);
  const manifest = await readJsonFromUri(manifestUrl, timeout);
  const { latestVersion, packageUri, sha256 } = extractUpdateManifestInfo(asDict(manifest));
  if (!latestVersion) {
    throw new Error(`Self-update manifest missing version: ${manifestUrl}`);
  }
  if (!packageUri) {
    throw new Error(`Self-update manifest missing package URL: ${manifestUrl}`);
  }
  const current = normalizeVersionText(currentVersion || CLI_VERSION);
  const latest = normalizeVersionText(latestVersion);
  if (!versionIsNewer(latest, current)) {
    return { upgraded: false, currentVersion: current, latestVersion: latest };
  }
  const resolvedPackageUri = resolveUriWithBase(packageUri, path.dirname(configPath));
  if (!quiet) {
    console.log(`Self-upgrade available: current=${current} latest=${latest}`);
    console.log(`Manifest: ${manifestUrl}`);
    console.log(`Package:  ${resolvedPackageUri}`);
    console.log(`Target:   ${targetPath}`);
  }
  if (checkOnly) {
    return { upgraded: false, currentVersion: current, latestVersion: latest };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-self-upgrade-'));
  try {
    const packagePath = path.join(tempDir, 'package.bin');
    await downloadFileOrRaise(resolvedPackageUri, packagePath);
    if (sha256) {
      const actual = sha256File(packagePath).toLowerCase();
      if (actual !== sha256.toLowerCase()) {
        throw new Error(`Self-upgrade SHA256 mismatch: expected ${sha256}, got ${actual}`);
      }
    }

    let extractRoot = tempDir;
    if (isZipFile(packagePath)) {
      extractRoot = path.join(tempDir, 'extract');
      fs.mkdirSync(extractRoot, { recursive: true });
      safeExtractZip(packagePath, extractRoot);
    } else if (isTarLike(resolvedPackageUri)) {
      extractRoot = path.join(tempDir, 'extract');
      fs.mkdirSync(extractRoot, { recursive: true });
      await safeExtractTar(packagePath, extractRoot);
    }

    const sourceCli = isZipFile(packagePath) || isTarLike(resolvedPackageUri) ? findFileInExtracted(extractRoot, 'skills_store_cli.js') : packagePath;
    if (!sourceCli || !fs.existsSync(sourceCli)) {
      throw new Error('Self-upgrade package does not contain skills_store_cli.js');
    }

    const targetBaseDir = path.dirname(targetPath);
    const sourceBin = findFileInExtracted(extractRoot, 'skillhub-bin.js');
    const sourceUpgrade = findFileInExtracted(extractRoot, 'skills_upgrade.js');
    const sourceVersion = findFileInExtracted(extractRoot, CLI_VERSION_FILE_NAME);
    const sourceMetadata = findFileInExtracted(extractRoot, CLI_METADATA_FILE_NAME);
    const sourceFindSkill = findSkillFileInExtracted(extractRoot, 'SKILL.md');
    const sourcePreferenceSkill = findSkillFileInExtracted(extractRoot, 'SKILL.skillhub-preference.md');

    const backupPath = `${targetPath}.bak`;
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, backupPath);
    }
    fs.copyFileSync(sourceCli, targetPath);
    if (sourceBin) {
      fs.copyFileSync(sourceBin, path.join(targetBaseDir, 'skillhub-bin.js'));
    }
    if (sourceUpgrade) {
      fs.copyFileSync(sourceUpgrade, path.join(targetBaseDir, 'skills_upgrade.js'));
    }
    if (sourceMetadata) {
      fs.copyFileSync(sourceMetadata, path.join(targetBaseDir, CLI_METADATA_FILE_NAME));
    }
    if (sourceVersion) {
      fs.copyFileSync(sourceVersion, path.join(targetBaseDir, CLI_VERSION_FILE_NAME));
    } else {
      fs.writeFileSync(path.join(targetBaseDir, CLI_VERSION_FILE_NAME), `${JSON.stringify({ version: latest }, null, 2)}\n`, 'utf8');
    }

    runPostUpgradePluginMigration(latest, sourceFindSkill, sourcePreferenceSkill);
    if (!quiet) {
      console.log(`Self-upgrade complete: ${targetPath} -> version ${latest}`);
      console.log(`Backup saved at: ${backupPath}`);
    }
    return { upgraded: true, currentVersion: current, latestVersion: latest };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function startupSelfUpgradeCheck(configPath) {
  try {
    const result = await runSelfUpgradeFlow({
      configPath,
      targetPath: path.resolve(__filename),
      currentVersion: CLI_VERSION,
      timeout: SELF_UPGRADE_CHECK_TIMEOUT_SECONDS,
      checkOnly: false,
      quiet: true,
    });
    return result.upgraded;
  } catch {
    return false;
  }
}

function cmdList(options) {
  const installRoot = path.resolve(options.dir);
  const lock = loadLockfile(installRoot);
  const skills = asDict(lock.skills);
  const slugs = Object.keys(skills).sort();
  if (slugs.length === 0) {
    console.log('No installed skills.');
    return;
  }
  for (const slug of slugs) {
    const meta = asDict(skills[slug]);
    const version = String(meta.version || '').trim();
    console.log(`${slug}  ${version}`);
  }
}

function addLocationOptions(command) {
  return command
    .option(
      '--workdir <workdir>',
      'Base workspace directory used for relative install roots. Default: SKILLHUB_WORKDIR, otherwise OpenClaw workspace, otherwise current directory.',
      AUTO_WORKDIR_SENTINEL
    )
    .option(
      '--dir <dir>',
      'Install root directory. Absolute paths are used as-is; relative paths are resolved under --workdir. Default: SKILLHUB_INSTALL_DIR, otherwise skills under resolved workdir.',
      AUTO_INSTALL_ROOT_SENTINEL
    );
}

function applyResolvedPaths(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'workdir')) {
    options.workdir = resolveWorkdir(options.workdir);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'dir')) {
    options.dir = resolveInstallRoot(options.dir, options.workdir);
  }
  return options;
}

function buildProgram() {
  const program = new Command();
  program
    .name('skillhub')
    .description('Minimal local skills store CLI')
    .version(`skillhub ${CLI_VERSION}`, '-v, --version', 'Show skillhub CLI version and exit')
    .option(
      '--skip-self-upgrade',
      'Skip startup self-upgrade check for this run'
    );

  program
    .command('search')
    .description('Search skills')
    .argument('[query...]', 'Search query words')
    .option('--search-url <url>', 'Remote search API URL.', DEFAULT_SEARCH_URL)
    .option('--search-limit <number>', 'Remote search limit (default: 20)', (value) => Number(value), 20)
    .option('--search-timeout <number>', 'Remote search timeout seconds (default: 6)', (value) => Number(value), 6)
    .option('--json', 'Print search results as JSON', false)
    .action(async function (query) {
      const opts = this.opts();
      await cmdSearch({
        query,
        searchUrl: opts.searchUrl,
        searchLimit: opts.searchLimit,
        searchTimeout: opts.searchTimeout,
        jsonOutput: opts.json,
      });
    });

  addLocationOptions(
    program
      .command('install')
      .description('Install a skill by slug')
      .argument('<slug>', 'Skill slug')
      .option('--files-base-uri <uri>', 'Base URI/path for local archives.', '')
      .option('--download-url-template <template>', 'Fallback download URL template when zip_url/local file is missing.', DEFAULT_SKILLS_DOWNLOAD_URL_TEMPLATE)
      .option('--primary-download-url-template <template>', 'Primary download URL template for install (supports {slug}).', DEFAULT_PRIMARY_DOWNLOAD_URL_TEMPLATE)
      .option('--search-url <url>', 'Remote search API URL used when slug is not found in index.', DEFAULT_SEARCH_URL)
      .option('--search-limit <number>', 'Remote search limit for install fallback (default: 20)', (value) => Number(value), 20)
      .option('--search-timeout <number>', 'Remote search timeout for install fallback in seconds (default: 6)', (value) => Number(value), 6)
      .option('--index <uri>', 'Skills index JSON path/URI.', DEFAULT_INDEX_URI)
      .option('--force', 'Overwrite existing target directory', false)
      .action(async function (slug) {
        const opts = applyResolvedPaths(this.opts());
        await cmdInstall({
          ...opts,
          slug,
        });
      })
  );

  addLocationOptions(
    program
      .command('upgrade')
      .description("Upgrade installed skills based on each skill's config.json update URL")
      .argument('[slug]', 'Optional skill slug. If omitted, upgrade all skills in lockfile.', '')
      .option('--check-only', 'Only check and print available upgrades without installing', false)
      .option('--timeout <number>', 'Timeout in seconds for manifest fetch (default: 20)', (value) => Number(value), 20)
      .action(async function (slug) {
        const opts = applyResolvedPaths(this.opts());
        await cmdUpgrade({
          ...opts,
          slug,
        });
      })
  );

  addLocationOptions(
    program
      .command('list')
      .description('List locally installed skills')
      .action(function () {
        const opts = applyResolvedPaths(this.opts());
        cmdList(opts);
      })
  );

  program
    .command('self-upgrade')
    .description('Self-upgrade this CLI from update manifest URL in config.json')
    .option('--config <path>', 'Self-upgrade config path.', path.posix.join(DEFAULT_CLI_HOME, 'config.json'))
    .option('--target <path>', 'CLI script target path to replace (default: current running script path)', '')
    .option('--current-version <version>', `Current CLI version for comparison (default: "${CLI_VERSION}")`, CLI_VERSION)
    .option('--timeout <number>', 'Timeout in seconds for manifest fetch/download requests (default: 20)', (value) => Number(value), 20)
    .option('--check-only', 'Only check and print available CLI upgrade without replacing files', false)
    .action(async function () {
      const opts = this.opts();
      const configPath = path.resolve(expandUser(opts.config));
      const targetPath = opts.target ? path.resolve(expandUser(opts.target)) : path.resolve(__filename);
      const result = await runSelfUpgradeFlow({
        configPath,
        targetPath,
        currentVersion: opts.currentVersion || CLI_VERSION,
        timeout: opts.timeout,
        checkOnly: opts.checkOnly,
        quiet: false,
      });
      if (!result.upgraded && !opts.checkOnly) {
        console.log(`CLI is up-to-date: current=${result.currentVersion} latest=${result.latestVersion}`);
      }
    });

  return program;
}

async function maybeRunStartupSelfUpgrade(rawArgv) {
  const commandName = rawArgv.find((arg) => !arg.startsWith('-')) || '';
  const skipSelfUpgrade = rawArgv.includes('--skip-self-upgrade');
  const configPath = path.resolve(expandUser(path.posix.join(DEFAULT_CLI_HOME, CLI_CONFIG_NAME)));
  if (
    commandName !== 'self-upgrade' &&
    process.env[SELF_UPGRADE_REEXEC_ENV] !== '1' &&
    !skipSelfUpgrade &&
    shouldRunStartupSelfUpgrade(configPath)
  ) {
    const upgraded = await startupSelfUpgradeCheck(configPath);
    if (upgraded) {
      const env = { ...process.env, [SELF_UPGRADE_REEXEC_ENV]: '1' };
      const child = spawnSync(process.execPath, [path.resolve(__filename), ...rawArgv], {
        env,
        stdio: 'inherit',
      });
      process.exit(child.status ?? 0);
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  cleanupLegacyOpenclawPluginFiles();
  await maybeRunStartupSelfUpgrade(argv);
  const program = buildProgram();
  await program.parseAsync(argv, { from: 'user' });
}

if (require.main === module) {
  main().catch((error) => {
    const message = error?.message || String(error);
    if (message) {
      console.error(`Error: ${message}`);
    }
    process.exit(error?.exitCode || 1);
  });
}

module.exports = {
  main,
};