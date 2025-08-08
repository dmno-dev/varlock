import * as core from '@actions/core';
import * as github from '@actions/github';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

interface ActionInputs {
  workingDirectory: string;
  environment?: string;
  showSummary: boolean;
  failOnError: boolean;
  outputFormat: 'env' | 'json';
}

export function getInputs(): ActionInputs {
  return {
    workingDirectory: core.getInput('working-directory') || '.',
    environment: core.getInput('environment') || undefined,
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
  const envSchemaPath = join(workingDir, '.env.schema');
  const envPath = join(workingDir, '.env');
  
  if (existsSync(envSchemaPath)) {
    core.info('Found .env.schema file');
    return true;
  }
  
  if (existsSync(envPath)) {
    // Check if .env file has varlock @env-spec decorators
    // TODO improve this    
    try {
      const envContent = execSync('cat .env', { cwd: workingDir, stdio: 'pipe' }).toString();
      if (envContent.includes('@') && (
        envContent.includes('@required') || 
        envContent.includes('@sensitive') || 
        envContent.includes('@example') ||
        envContent.includes('@type=') ||
        envContent.includes('@generateTypes') ||
        envContent.includes('@defaultSensitive') ||
        envContent.includes('@envFlag') ||
        envContent.includes('@docsUrl')
      )) {
        core.info('Found .env file with @env-spec decorators');
        return true;
      }
    } catch {
      // Ignore errors when checking .env content
    }
  }
  
  return false;
}

export function installVarlock(): void {
  core.info('Installing varlock...');
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

export function runVarlockLoad(inputs: ActionInputs): { output: string; errorCount: number; warningCount: number } {
  const args = ['load'];
  
  if (inputs.environment) {
    args.push('--env', inputs.environment);
  }
  
  if (inputs.outputFormat === 'json') {
    args.push('--format', 'json');
  } else {
    args.push('--format', 'env');
  }
  
  core.info(`Running: varlock ${args.join(' ')}`);
  
  try {
    const output = execSync(`varlock ${args.join(' ')}`, {
      cwd: inputs.workingDirectory,
      stdio: 'pipe',
      encoding: 'utf8',
    }).toString();
    
    return { output, errorCount: 0, warningCount: 0 };
  } catch (error: any) {
    if (error.stdout) {
      const output = error.stdout.toString();
      // Parse error count from output if available
      const errorCount = (output.match(/error/gi) || []).length;
      const warningCount = (output.match(/warning/gi) || []).length;
      
      return { output, errorCount, warningCount };
    }
    
    throw error;
  }
}

export function setEnvironmentVariables(output: string, format: 'env' | 'json'): void {
  if (format === 'json') {
    try {
      const envVars = JSON.parse(output);
      for (const [key, value] of Object.entries(envVars)) {
        if (value !== undefined && value !== null) {
          core.exportVariable(key, String(value));
        }
      }
    } catch (error) {
      core.warning(`Failed to parse JSON output: ${error}`);
    }
  } else {
    // Parse env format (key=value pairs)
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const equalIndex = trimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmed.substring(0, equalIndex);
          let value = trimmed.substring(equalIndex + 1);
          
          // Handle quoted values
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
          }
          
          core.exportVariable(key, value);
        }
      }
    }
  }
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
    
    core.info('🔍 Checking for @env-spec environment files...');
    const hasEnvFiles = checkForEnvFiles(inputs.workingDirectory);
    
    if (!hasEnvFiles) {
      core.warning('No .env.schema or .env files with @env-spec decorators found');
      core.info('This action requires either:');
      core.info('  - A .env.schema file with @env-spec decorators');
      core.info('  - A .env file with @env-spec decorators (e.g., @required, @sensitive, @example)');
      core.setFailed('No @env-spec environment files found');
      return;
    }
    
    core.info('✅ @env-spec environment files found');
    
    core.info('🚀 Loading environment variables with varlock...');
    const { output, errorCount, warningCount } = runVarlockLoad(inputs);
    
    // Set outputs
    core.setOutput('error-count', errorCount.toString());
    core.setOutput('warning-count', warningCount.toString());
    
    if (inputs.showSummary) {
      core.setOutput('summary', output);
      core.info('📋 Environment Summary:');
      core.info(output);
    }
    
    // Set environment variables for use in subsequent steps
    core.info('🔧 Setting environment variables...');
    setEnvironmentVariables(output, inputs.outputFormat);
    
    if (errorCount > 0) {
      const message = `Found ${errorCount} validation error(s)`;
      if (inputs.failOnError) {
        core.setFailed(message);
      } else {
        core.warning(message);
      }
    }
    
    if (warningCount > 0) {
      core.warning(`Found ${warningCount} validation warning(s)`);
    }
    
    core.info('✅ Environment variables loaded successfully');
    
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run(); 