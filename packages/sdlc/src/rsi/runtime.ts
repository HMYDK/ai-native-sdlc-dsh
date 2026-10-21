import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fingerprintJavaScript} from '../verify/recording.js';
import {hash} from './snapshot.js';

/** Frozen at module load: rebuilding files later must not rewrite the runtime's identity. */
const lib=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=resolve(lib,'..');
export const LOADED_SUITE={
  version:String(JSON.parse(readFileSync(resolve(pkg,'package.json'),'utf8')).version),
  javascript_sha256:fingerprintJavaScript(lib),
  patch_sha256:hash(readFileSync(resolve(pkg,'cordis.patch.yml'))),
};
