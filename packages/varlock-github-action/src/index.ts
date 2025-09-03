import * as core from '@actions/core';
import { execSync } from 'child_process';
import { readdirSync } from 'fs';

interface ActionInputs {
  workingDirectory: string;
  showSummary: boolean;
  failOnError: boolean;
  outputFormat: 'env' | 'json';
}

interface SerializedEnvGraph {
  basePath?: string;
  sources: Array<{
    label: string;
    enabled: boolean;
    path?: string;
  }>;
  settings: {
    redactLogs?: boolean;
    preventLeaks?: boolean;
  };
  config: Record<string, {
    value: any;
    isSensitive: boolean;
  }>;
}

export function getInputs(): ActionInputs {
  return {
    workingDirectory: core.getInput('working-directory') || '.',
    showSummary: core.getInput('show-summary') === 'true',
    failOnError: core.getInput('fail-on-error') === 'true',
    outputFormat: (core.getInput('output-format') as 'env' | 'json') || 'env',
  };
}

export function checkVarlockInstalled(): boolean {
  try {
    execSync('varlock --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkForEnvFiles(workingDir: string): boolean {
  try {
    const files = readdirSync(workingDir);
    const envFiles = files.filter((file: string) => file === '.env' || file.startsWith('.env.'));

    if (envFiles.length > 0) {
      core.info(`Found environment files: ${envFiles.join(', ')}`);
      return true;
    }

    return false;
  } catch (error) {
    core.warning(`Error reading directory ${workingDir}: ${error}`);
    return false;
  }
}

export function installVarlock(): void {
  core.info('Installing varlock...');
  // TODO: Add a check to see if varlock is already installed and use that
  try {
    // Try to install varlock using npm
    execSync('npm install -g varlock', { stdio: 'inherit' });
  } catch {
    try {
      // Fallback to curl installation
      execSync('curl -fsSL https://raw.githubusercontent.com/dmno-dev/varlock/main/install.sh | sh', { stdio: 'inherit' });
    } catch (error) {
      core.setFailed(`Failed to install varlock: ${error}`);
    }
  }
}

export function runVarlockLoad(inputs: ActionInputs): {
  output: string;
  errorCount: number;
  envGraph?: SerializedEnvGraph;
} {
  const defaultArgs = ['load'];

  // If show-summary is true, run without format options to get human-readable output
  if (inputs.showSummary) {
    core.info(`Running: varlock ${defaultArgs.join(' ')}`);

    try {
      const output = execSync(`varlock ${defaultArgs.join(' ')}`, {
        cwd: inputs.workingDirectory,
        stdio: 'pipe',
        encoding: 'utf8',
      }).toString();

      return { output, errorCount: 0 };
    } catch (error: any) {
      if (error.stdout) {
        const output = error.stdout.toString();
        // Parse error count from output if available
        const errorCount = (output.match(/error/gi) || []).length;
        return { output, errorCount };
      }
      throw error;
    }
  }

  // Otherwise, use json-full format to get sensitive information
  const internalArgs = [...defaultArgs, '--format', 'json-full'];

  // we may not want to show this in the output
  // core.info(`Running: varlock ${internalArgs.join(' ')}`);

  try {
    const output = execSync(`varlock ${internalArgs.join(' ')}`, {
      cwd: inputs.workingDirectory,
      stdio: 'pipe',
      encoding: 'utf8',
    }).toString();

    // Parse the json-full output to get the environment graph
    const envGraph = JSON.parse(output) as SerializedEnvGraph;

    return { output, errorCount: 0, envGraph };
  } catch (error: any) {
    if (error.stdout) {
      const output = error.stdout.toString();
      // Parse error count from output if available
      const errorCount = (output.match(/error/gi) || []).length;

      // Try to parse as json-full if possible
      let envGraph: SerializedEnvGraph | undefined;
      try {
        envGraph = JSON.parse(output) as SerializedEnvGraph;
      } catch {
        core.setFailed('Failed to parse varlock output.');
      }

      return { output, errorCount, envGraph };
    }

    throw error;
  }
}

export function setEnvironmentVariables(envGraph: SerializedEnvGraph): void {
  let regularVars = 0;
  let secretVars = 0;

  for (const [key, itemInfo] of Object.entries(envGraph.config)) {
    if (itemInfo.value !== undefined && itemInfo.value !== null) {
      const value = String(itemInfo.value);

      if (itemInfo.isSensitive) {
        // Export sensitive values as secrets
        core.setSecret(value);
        core.exportVariable(key, value);
        secretVars++;
      } else {
        // Export non-sensitive values as regular environment variables
        core.exportVariable(key, value);
        regularVars++;
      }
    }
  }

  core.info(`✅ Exported ${regularVars} regular environment variables and ${secretVars} secrets`);
}

export function outputJsonBlob(envGraph: SerializedEnvGraph): void {
  // Create a clean JSON object with just the values (no sensitive flags)
  const jsonOutput: Record<string, any> = {};

  for (const [key, itemInfo] of Object.entries(envGraph.config)) {
    if (itemInfo.value !== undefined && itemInfo.value !== null) {
      jsonOutput[key] = itemInfo.value;
    }
  }

  // Output the JSON blob
  core.setOutput('json-env', JSON.stringify(jsonOutput, null, 2));
  core.info('✅ Output JSON blob with environment variables');
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();

    core.info('🔍 Checking for varlock installation...');
    let varlockInstalled = checkVarlockInstalled();

    if (!varlockInstalled) {
      core.info('📦 Varlock not found, installing...');
      installVarlock();
      varlockInstalled = checkVarlockInstalled();

      if (!varlockInstalled) {
        core.setFailed('Failed to install varlock');
        return;
      }
    }

    core.info('✅ Varlock is available');

    core.info('🔍 Checking for environment files...');
    const hasEnvFiles = checkForEnvFiles(inputs.workingDirectory);

    if (!hasEnvFiles) {
      core.warning('No .env files detected');
      core.info('This action requires environment files (e.g., .env, .env.local, .env.production)');
      core.setFailed('No environment files found');
      return;
    }

    core.info('✅ Environment files found');

    core.info('🚀 Loading environment variables with varlock...');
    const { output, errorCount, envGraph } = runVarlockLoad(inputs);

    // Set outputs
    core.setOutput('error-count', errorCount.toString());

    if (inputs.showSummary) {
      core.setOutput('summary', output);
      core.info('📋 Environment Summary:');
      core.info(output);
    }

    if (envGraph) {
      if (inputs.outputFormat === 'env') {
        // Export as environment variables and secrets
        core.info('🔧 Setting environment variables...');
        setEnvironmentVariables(envGraph);
      } else if (inputs.outputFormat === 'json') {
        // Output as JSON blob
        core.info('📄 Outputting JSON blob...');
        outputJsonBlob(envGraph);
      }
    } else {
      core.warning('Could not parse varlock output as json-full');
      if (inputs.outputFormat === 'json') {
        core.setFailed('JSON output format requires valid varlock json-full output');
      }
    }

    if (errorCount > 0) {
      const message = `Found ${errorCount} validation error(s)`;
      if (inputs.failOnError) {
        core.setFailed(message);
      } else {
        core.warning(message);
      }
    }



    core.info('✅ Environment variables loaded successfully');
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
