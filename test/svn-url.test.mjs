import test from 'node:test';import assert from 'node:assert/strict';import {sameSvnUrl,canonicalSvnUrl} from '../src/svn-url.mjs';
// Deferred unified acceptance.
test('SVN URL equivalence does not turn encoded separators into path authority',()=>{assert.equal(sameSvnUrl('file:///repo/a%7Eb','file:///repo/a~b'),true);assert.equal(sameSvnUrl('https://example.invalid/repo/a%2Fb','https://example.invalid/repo/a/b'),false);for(const u of ['https://user:pass@example.invalid/repo','https://example.invalid/repo/a%5Cb','https://example.invalid/repo/a%00b'])assert.throws(()=>canonicalSvnUrl(u));});
