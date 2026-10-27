import { openPublic, publicURL, readLimited } from './network.mjs';
const ID = /^[a-zA-Z0-9_-]{10,200}$/;
export function driveFolder(value) {
  const url = publicURL(value);
  if (url.hostname !== 'drive.google.com') return null;
  const id = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id || !ID.test(id)) return null;
  const resourceKey = url.searchParams.get('resourcekey');
  if (resourceKey && !/^[a-zA-Z0-9_-]{1,200}$/.test(resourceKey)) throw new Error('Invalid Drive resource key');
  return {id, resourceKey};
}
export function parseDriveFolder(html) {
  const match = html.match(/window\[['_"]_DRIVE_ivd['_"]\]\s*=\s*'((?:\\.|[^'\\])*)'/);
  if (!match) throw new Error('Public Drive listing unavailable: share this folder with anyone with the link; login, CAPTCHA and restricted folders are unsupported');
  // Decode only the JavaScript string escapes used by Drive; never evaluate HTML/JS.
  const decoded = match[1].replace(/\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\(['"\\/nrtbf])/gi, (_m,x,u,c) => x || u ? String.fromCharCode(parseInt(x || u,16)) : ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}[c] ?? c));
  let data;
  try { data = JSON.parse(decoded); } catch { throw new Error('Public Drive listing format changed'); }
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Public Drive listing format changed');
  // Public HTML is limited to an initial page. Never claim a large folder is complete.
  if (data[0].length >= 50 || data[1]) throw new Error('Drive folder may be paginated; use folders with fewer than 50 entries');
  return data[0].map(entry => {
    if (!Array.isArray(entry) || !ID.test(entry[0]) || typeof entry[2] !== 'string' || typeof entry[3] !== 'string') throw new Error('Invalid public Drive file metadata');
    return {id:entry[0], name:entry[2], mime:entry[3], size:Number.isSafeInteger(entry[13]) ? entry[13] : null, modifiedAt:Number.isSafeInteger(entry[9]) ? entry[9] : null};
  });
}
export async function listDriveFiles(value, {open = openPublic, signal, maxFiles = 500, maxDepth = 3, maxFolders = 50} = {}) {
  const folder = driveFolder(value);
  if (!folder) throw new Error('Expected a public Google Drive folder URL');
  const pending = [{...folder,depth:0}], seen = new Set(), files = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const current = pending.shift();
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (seen.size > maxFolders) throw new Error('Drive folder count limit exceeded');
    const url = new URL(`https://drive.google.com/drive/folders/${current.id}`);
    if (current.resourceKey) url.searchParams.set('resourcekey',current.resourceKey);
    const response = await open(url.href,{signal});
    const entries = parseDriveFolder((await readLimited(response, 8 * 1024 * 1024)).toString('utf8'));
    for (const entry of entries) {
      if (entry.mime === 'application/vnd.google-apps.folder') {
        if (current.depth >= maxDepth) throw new Error('Drive recursion depth limit exceeded');
        pending.push({id:entry.id,depth:current.depth+1});
      } else if (entry.mime.startsWith('audio/') || /\.(mp3|wav|flac|ogg|opus|m4a|aac|webm)$/i.test(entry.name)) {
        if (files.length >= maxFiles) throw new Error('Source file count limit exceeded');
        files.push({...entry, url:`https://drive.google.com/uc?export=download&id=${entry.id}`});
      }
    }
  }
  return files;
}
