const fs = require('fs');
const path = require('path');

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

function extractUpdateUrl(config, skillDir, resolveUriWithBase) {
  const direct = firstNonEmptyString(config, [
    'update_url',
    'updateUrl',
    'upgrade_url',
    'upgradeUrl',
    'manifest_url',
    'manifestUrl',
  ]);
  if (direct) {
    return resolveUriWithBase(direct, skillDir);
  }

  for (const containerKey of ['update', 'upgrade', 'autoupdate']) {
    const nested = asDict(config[containerKey]);
    const urlValue = firstNonEmptyString(nested, ['url', 'uri', 'manifest', 'manifest_url']);
    if (urlValue) {
      return resolveUriWithBase(urlValue, skillDir);
    }
  }
  return '';
}

function readInstalledSkillVersion(skillDir, lockMeta, skillMetaName) {
  const lockVersion = firstNonEmptyString(lockMeta, ['version']);
  if (lockVersion) {
    return lockVersion;
  }

  const metaPath = path.join(skillDir, skillMetaName);
  if (!fs.existsSync(metaPath)) {
    return '';
  }

  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return firstNonEmptyString(raw, ['version']);
    }
  } catch {
    return '';
  }
  return '';
}

async function cmdUpgrade(args, deps) {
  const installRoot = path.resolve(args.dir);
  const lock = deps.loadLockfile(installRoot);
  const skills = asDict(lock.skills);

  let targets = [];
  if (args.slug) {
    targets = [args.slug];
  } else {
    targets = Object.keys(skills).sort();
    if (targets.length === 0) {
      const error = new Error(`No installed skills in lockfile: ${path.join(installRoot, '.skills_store_lock.json')}`);
      error.exitCode = 1;
      throw error;
    }
  }

  let checked = 0;
  let upgraded = 0;
  let skipped = 0;
  let failed = 0;

  for (const slug of targets) {
    checked += 1;
    const targetDir = path.join(installRoot, slug);
    if (!fs.existsSync(targetDir)) {
      console.log(`[${slug}] skip: skill directory not found: ${targetDir}`);
      skipped += 1;
      continue;
    }

    const lockMeta = asDict(skills[slug]);
    const configPath = path.join(targetDir, deps.skillConfigName);
    if (!fs.existsSync(configPath)) {
      console.log(`[${slug}] skip: ${deps.skillConfigName} not found`);
      skipped += 1;
      continue;
    }

    let rawConfig;
    try {
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.log(`[${slug}] fail: invalid ${deps.skillConfigName}: ${error.message}`);
      failed += 1;
      continue;
    }

    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      console.log(`[${slug}] fail: ${deps.skillConfigName} must be a JSON object`);
      failed += 1;
      continue;
    }

    const updateUrl = extractUpdateUrl(rawConfig, targetDir, deps.resolveUriWithBase);
    if (!updateUrl) {
      console.log(`[${slug}] skip: missing update URL in ${deps.skillConfigName}`);
      skipped += 1;
      continue;
    }

    try {
      const preservedConfigText = fs.readFileSync(configPath, 'utf8');
      const manifest = await deps.readJsonFromUri(updateUrl, args.timeout);
      const { latestVersion, packageUri, sha256 } = deps.extractUpdateManifestInfo(manifest);

      if (!latestVersion) {
        console.log(`[${slug}] fail: update manifest missing version: ${updateUrl}`);
        failed += 1;
        continue;
      }
      if (!packageUri) {
        console.log(`[${slug}] fail: update manifest missing package URL: ${updateUrl}`);
        failed += 1;
        continue;
      }

      const currentVersion = readInstalledSkillVersion(targetDir, lockMeta, deps.skillMetaName);
      if (!deps.versionIsNewer(latestVersion, currentVersion)) {
        console.log(`[${slug}] up-to-date: current=${currentVersion || '<unknown>'} latest=${latestVersion}`);
        skipped += 1;
        continue;
      }

      const resolvedPackageUri = deps.resolveUriWithBase(packageUri, targetDir);
      if (args.checkOnly) {
        console.log(
          `[${slug}] upgrade available: current=${currentVersion || '<unknown>'} latest=${latestVersion} package=${resolvedPackageUri}`
        );
        continue;
      }

      await deps.installZipToTarget({
        slug,
        zipUri: resolvedPackageUri,
        targetDir,
        force: true,
        expectedSha256: sha256,
      });

      const restoredConfigPath = path.join(targetDir, deps.skillConfigName);
      if (!fs.existsSync(restoredConfigPath)) {
        fs.writeFileSync(restoredConfigPath, preservedConfigText, 'utf8');
      }

      const updatedMeta = {
        ...lockMeta,
        zip_url: resolvedPackageUri,
        version: latestVersion,
        update_url: updateUrl,
      };
      if (!updatedMeta.name) {
        updatedMeta.name = slug;
      }
      if (!updatedMeta.source) {
        updatedMeta.source = 'unknown';
      }
      skills[slug] = updatedMeta;
      upgraded += 1;
      console.log(`[${slug}] upgraded: ${currentVersion || '<unknown>'} -> ${latestVersion}`);
    } catch (error) {
      console.log(`[${slug}] fail: ${error.message || error}`);
      failed += 1;
    }
  }

  lock.skills = skills;
  deps.saveLockfile(installRoot, lock);
  console.log(
    `upgrade done: checked=${checked} upgraded=${upgraded} skipped=${skipped} failed=${failed} dir=${installRoot}`
  );
  return failed > 0 ? 2 : 0;
}

module.exports = {
  cmdUpgrade,
};