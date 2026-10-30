import { appendFile, readFile, writeFile } from 'node:fs/promises';

const METADATA_URL = new URL('../.upstream.json', import.meta.url);
const DEFAULT_REPORT_PATH = process.env.UPSTREAM_SYNC_REPORT;

async function main() {
  const metadata = await readMetadata();
  const latest = await fetchLatestUpstream(metadata);
  const isUpdateAvailable = latest.revision !== metadata.integrated.revision;
  const report = buildReport(metadata, latest, isUpdateAvailable);

  await writeReport(report);
  await writeGithubOutput({
    'update-available': isUpdateAvailable,
    'upstream-revision': latest.revision,
    'upstream-version': latest.version,
  });
}

async function readMetadata() {
  const rawMetadata = await readFile(METADATA_URL, 'utf8');
  const metadata = JSON.parse(rawMetadata);

  if (!metadata.repository || !metadata.branch || !metadata.integrated?.revision || !metadata.integrated?.version) {
    throw new Error('Invalid .upstream.json metadata');
  }

  return metadata;
}

async function fetchLatestUpstream(metadata) {
  const revision = process.env.UPSTREAM_SYNC_LATEST_SHA
    || await fetchJson(
      `https://api.github.com/repos/${metadata.repository}/commits/${metadata.branch}`,
    ).then((commit) => commit.sha);
  const version = process.env.UPSTREAM_SYNC_LATEST_VERSION
    || await fetchJson(
      `https://raw.githubusercontent.com/${metadata.repository}/${revision}/package.json`,
    ).then((packageJson) => packageJson.version);

  if (!revision || !version) {
    throw new Error('Could not determine the latest upstream revision and version');
  }

  return { revision, version };
}

async function fetchJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'telegram-web-relay-client-upstream-check',
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status}): ${url}`);
  }

  return response.json();
}

function buildReport(metadata, latest, isUpdateAvailable) {
  const comparisonUrl = `https://github.com/${metadata.repository}/compare/${metadata.integrated.revision}`
    + `...${latest.revision}`;
  const status = isUpdateAvailable ? 'Update available' : 'Up to date';

  return [
    '# Telegram-tt upstream sync report',
    '',
    `**Status:** ${status}`,
    '',
    '| Field | Integrated | Latest |',
    '| --- | --- | --- |',
    `| Version | ${metadata.integrated.version} | ${latest.version} |`,
    `| Revision | ${shortRevision(metadata.integrated.revision)} | ${shortRevision(latest.revision)} |`,
    '',
    `[Compare upstream changes](${comparisonUrl})`,
    '',
    isUpdateAvailable
      ? 'Create an integration branch from `main` and follow `AGENTS.md` before adopting this revision.'
      : 'No upstream integration is required.',
    '',
  ].join('\n');
}

function shortRevision(revision) {
  return revision.slice(0, 12);
}

async function writeReport(report) {
  if (DEFAULT_REPORT_PATH) {
    await writeFile(DEFAULT_REPORT_PATH, report);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  } else {
    process.stdout.write(report);
  }
}

async function writeGithubOutput(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const content = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  await appendFile(process.env.GITHUB_OUTPUT, `${content}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
