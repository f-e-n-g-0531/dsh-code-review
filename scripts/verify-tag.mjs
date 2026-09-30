import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const ref = process.env.GITHUB_REF;
if (!/^v(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/.test((ref ?? '').slice(10)) || ref !== 'refs/tags/v' + version) throw new Error('Release tag must be vX.Y.Z and match package version');
console.log('Version tag verified: ' + version);
