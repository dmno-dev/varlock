import { execSync } from 'node:child_process';
import { loadFromSerializedGraph } from './index';

const execResult = execSync('varlock load --format json-full');
const serializedGraph = JSON.parse(execResult.toString());
loadFromSerializedGraph(serializedGraph);
