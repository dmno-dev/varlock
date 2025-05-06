/* eslint-disable no-console */

// helpful script for testing the parser - loads .env.playground file
import {
  expand, parseEnvSpecDotEnvFile,
} from '../dist/index.js';
import { simpleResolver } from '../dist/simple-resolver.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const fileStr = await fs.readFile(`${__dirname}/playground.env`, 'utf-8');
console.log(fileStr, '\n----------');
const result = parseEnvSpecDotEnvFile(fileStr);


const val = result.configItems[0].value;
const expanded = expand(val);
console.log('original - ', val.toString());
console.log('expanded - ', expanded.toString());

const resolvedObj = simpleResolver(result);
console.log(resolvedObj);
