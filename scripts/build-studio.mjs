import { copyFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('studio/public/', root), { recursive: true });
await copyFile(new URL('widget/public/widget.js', root), new URL('studio/public/widget.js', root));
console.log('Studio assets ready; preview and embeds use the same widget runtime.');
