import { pathToFileURL } from 'node:url';
import { main as coverage } from '../../tools/coverage-policy.mjs';

export const checkWorkerCoverage = (root, options) => coverage(['collect', 'worker'], root, options);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = checkWorkerCoverage();
