import fs from 'node:fs/promises';
import path from 'node:path';
import { fdir } from 'fdir';
import { parseEnvSpecDotEnvFile } from '@env-spec/parser';

import { checkIsFileGitIgnored } from '../utils/git-utils';

import _ from '../utils/my-dash';
import { asyncMap } from '../utils/async-utils';

import { ConfigItem } from './config-item';
import { EnvGraph } from './env-graph';
import { DotEnvFileDataSource, ProcessEnvDataSource } from './data-source';

function autoDetectContextPath() {
  const PWD = process.env.PWD;
  if (!PWD) {
    throw new Error('PWD is not set');
  }
  return PWD;
}


export async function loadEnvGraph(opts?: {
  contextPath?: string,
  relativePaths: Array<string>,
  checkGitIgnored?: boolean,
  excludeDirs?: Array<string>,
}) {
  const contextPath = opts?.contextPath ?? autoDetectContextPath();

  const graph = new EnvGraph();
  graph.basePath = contextPath;

  const globs = [
    '**/.env',
    // files may have additional suffixes that denote a type, a specific env, or format
    // examples: .env.schema, .env.local, .env.test, .env.test.local.json
    '**/.env.*',
  ];
  const dotEnvFilePaths = await new fdir() // eslint-disable-line new-cap
    .withRelativePaths()
    .glob(...globs)
    .exclude((excludeDirName, excludeDirPath) => {
      // skip .XXX folders (other than a `.env` folder)
      if (excludeDirName !== '.env' && excludeDirName.startsWith('.')) return true;
      // skip node_modules
      if (excludeDirName === 'node_modules') return true;
      // exclude directories - note as passed in, they do not have trailing slashes)
      // but the dirPath does, so we must trailing slash
      if (opts?.excludeDirs?.includes(excludeDirPath.replace(/\/$/, ''))) return true;
      return false;
    })
    .crawl(contextPath)
    .withPromise();

  for (const relativePath of dotEnvFilePaths) {
    // explicitly exclude a few files we know do not contain definitions/values
    if (
      relativePath.endsWith('.d.ts')
      || relativePath.endsWith('.md')
    ) continue;

    const fullPath = path.join(contextPath, relativePath);
    const fileDataSource = new DotEnvFileDataSource(fullPath);
    await fileDataSource.finishInit();
    graph.addDataSource(fileDataSource);
  }
  graph.addDataSource(new ProcessEnvDataSource());

  await graph.finishLoad();

  return graph;
}

