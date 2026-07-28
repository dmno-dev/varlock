#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs');
const path = require('node:path');

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function appendLog(logPath, args) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`, 'utf8');
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const mockDir = process.env.FAKE_PASS_CLI_DIR;
if (!mockDir) fail('fake pass-cli misconfigured: FAKE_PASS_CLI_DIR is required');

const configPath = path.join(mockDir, 'config.json');
const statePath = path.join(mockDir, 'state.json');
const logPath = path.join(mockDir, 'calls.log');

const config = loadJson(configPath, {});
const state = loadJson(statePath, { loggedIn: false });
const args = process.argv.slice(2);

appendLog(logPath, args);

const ensureLoggedIn = () => {
  if (!state.loggedIn) {
    fail(config.notLoggedMessage || 'not authenticated');
  }
};

const resolveRefsInText = (val) => {
  if (typeof val !== 'string') return val;
  return val.replace(/pass:\/\/[^\s"'`]+/g, (ref) => {
    if (config.refs && Object.prototype.hasOwnProperty.call(config.refs, ref)) {
      return String(config.refs[ref]);
    }
    if (config.missingRefs && config.missingRefs.includes(ref)) {
      throw new Error(config.notFoundMessage || `secret not found: ${ref}`);
    }
    throw new Error(config.notFoundMessage || `secret not found: ${ref}`);
  });
};

if (!args.length) fail('missing command');

if (args[0] === 'info') {
  if (state.loggedIn) process.exit(0);
  fail(config.notLoggedMessage || 'not authenticated');
}

if (args[0] === 'login') {
  // A personal access token is a self-contained credential — no username/password needed.
  if (process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN) {
    if (config.invalidToken) fail('personal access token invalid or expired');
    state.loggedIn = true;
    writeJson(statePath, state);
    process.exit(0);
  }
  const needsPassword = config.requirePassword !== false;
  if (needsPassword && !process.env.PROTON_PASS_PASSWORD) {
    fail('password missing');
  }
  state.loggedIn = true;
  writeJson(statePath, state);
  process.exit(0);
}

if (args[0] === 'run') {
  ensureLoggedIn();
  if (config.runErrorMessage) fail(config.runErrorMessage);

  const runSkipRefs = new Set(config.runSkipRefs || []);
  const outputPairs = [];
  for (const [key, rawVal] of Object.entries(process.env)) {
    if (!key.startsWith('VARLOCK_PROTON_PASS_INJECT_')) continue;
    if (runSkipRefs.has(rawVal)) continue;
    try {
      const resolved = resolveRefsInText(rawVal);
      outputPairs.push(`${key}=${resolved}`);
    } catch (err) {
      fail((err && err.message) || 'run resolution failed');
    }
  }

  process.stdout.write(outputPairs.join('\0'));
  if (outputPairs.length) process.stdout.write('\0');
  process.exit(0);
}

if (args[0] === 'item' && args[1] === 'view') {
  ensureLoggedIn();
  const secretRef = args[args.length - 1];
  const parts = String(secretRef).replace(/^pass:\/\//, '').split('/');
  const fieldName = parts[parts.length - 1] || 'value';
  const itemErrors = config.itemViewErrors || {};
  if (itemErrors[secretRef]) fail(itemErrors[secretRef]);

  if (config.refs && Object.prototype.hasOwnProperty.call(config.refs, secretRef)) {
    process.stdout.write(JSON.stringify({ [fieldName]: String(config.refs[secretRef]) }));
    process.exit(0);
  }

  fail(config.notFoundMessage || `secret not found: ${secretRef}`);
}

fail(`unsupported fake pass-cli command: ${args.join(' ')}`);
