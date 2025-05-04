import path from 'node:path';
import fs from 'node:fs/promises';

import { VarlockNativeAppClient } from '../../lib/native-app-client';
import { loadEnvGraph } from '@env-spec/env-graph';

export const commandSpec = {
  name: 'doctor',
  description: 'Debug and diagnose issues with your env file(s) and system',
  options: {

  },
};

export const commandFn = async (args: any) => {
  console.log('');
  await console.log('🧙 Scanning for issues... ✨');

  const envGraph = await loadEnvGraph();
  await envGraph.resolveEnvValues();
  const resolvedEnv = envGraph.getResolvedEnvObject();

  // TODO: Mac app checks
  // - installed, running, logged in, set up (keys exist), locked/unlocked state
};

