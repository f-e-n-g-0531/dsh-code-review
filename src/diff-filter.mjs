// Match the Code Report resource defaults; shader/source and unknown suffixes stay in scope.
export const DEFAULT_RESOURCE_SUFFIXES = 'png jpg jpeg gif webp bmp ico tga dds ktx ktx2 psd tif tiff exr hdr wav mp3 ogg flac aac m4a mp4 mov webm avi fbx gltf glb dae c3 c3_model ska sea mtl material particle zip 7z rar gz tgz tar dll exe lib obj pdb map so dylib a o class jar wasm';
export const DEFAULT_EXCLUDED_FOLDERS = 'Test';

export function diffFilter({autoExcludeNonCode = true, diffExcludeSuffixes = DEFAULT_RESOURCE_SUFFIXES, diffExcludeFolderNames = DEFAULT_EXCLUDED_FOLDERS} = {}) {
  if (typeof autoExcludeNonCode !== 'boolean') throw new Error('autoExcludeNonCode must be a boolean');
  if (typeof diffExcludeSuffixes !== 'string' || diffExcludeSuffixes.length > 4096) throw new Error('Invalid diffExcludeSuffixes');
  if (typeof diffExcludeFolderNames !== 'string' || diffExcludeFolderNames.length > 2048) throw new Error('Invalid diffExcludeFolderNames');
  const suffixes = new Set(diffExcludeSuffixes.split(/[\s,，;；]+/u).filter(Boolean).map(token => {
    if (!/^\.?[a-z0-9][a-z0-9_]{0,23}$/i.test(token)) throw new Error('Invalid diffExcludeSuffixes entry');
    return token.replace(/^\./, '').toLowerCase();
  }));
  const folders = new Set(diffExcludeFolderNames.split(/[,，;；\r\n]+/u).map(name => name.trim()).filter(Boolean).map(name => {
    if (!/^[\p{L}\p{N}_. -]{1,64}$/u.test(name) || name === '.' || name === '..') throw new Error('Invalid diffExcludeFolderNames entry');
    return name.toLowerCase();
  }));
  if (suffixes.size > 128 || folders.size > 32) throw new Error('Too many diff filter entries');
  const byFolder = (name, kind) => {
    const parts = name.split('/');
    const basename = parts.pop();
    if (kind === 'dir') parts.push(basename);
    const matched = parts.find(part => folders.has(part.toLowerCase()));
    return matched === undefined ? undefined : 'Filtered folder: ' + matched;
  };
  const bySuffix = name => {
    if (!autoExcludeNonCode) return undefined;
    const basename = name.slice(name.lastIndexOf('/') + 1);
    const dot = basename.lastIndexOf('.');
    const suffix = basename.slice(dot + 1).toLowerCase();
    return dot >= 0 && suffixes.has(suffix) ? 'Filtered resource suffix: .' + suffix : undefined;
  };
  return {
    byFolder, bySuffix,
    reason(name, kind = 'file') { return byFolder(name, kind) ?? (kind === 'file' ? bySuffix(name) : undefined); },
  };
}
