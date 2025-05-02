// helpful script for testing the parser - loads .env.playground file
import { envSpecUpdater, parseEnvSpecDotEnvFile } from '../dist/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const fileStr = await fs.readFile(`${__dirname}/playground.env`, 'utf-8');
console.log(fileStr);
const result = parseEnvSpecDotEnvFile(fileStr);

console.log(result.toSimpleObj());
console.log(result.contents[0]);
console.log(result.header);

envSpecUpdater.setRootDecorator(result, 'foo', 'bar');
