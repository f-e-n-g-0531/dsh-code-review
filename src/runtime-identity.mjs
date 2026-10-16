import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const manifestUrl=new URL('../package.json',import.meta.url);
export const REVIEW_RUNTIME=Object.freeze({version:JSON.parse(readFileSync(manifestUrl,'utf8')).version,modulePath:fileURLToPath(new URL('../index.mjs',import.meta.url)),defaultInternalDeadline:false});
