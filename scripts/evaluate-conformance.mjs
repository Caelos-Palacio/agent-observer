import {readFile} from 'node:fs/promises';
import {evaluateConformance} from '../src/conformance.mjs';
const fixture=JSON.parse(await readFile(new URL('../fixtures/conformance-v1.json',import.meta.url)));
console.log(JSON.stringify(evaluateConformance(fixture),null,2));
