#!/usr/bin/env node
// Publish a Commissioner's Notes write-up to the site.
//   S51_API=<url> S51_ADMIN=<key> node tools/post-notes.js notes/writeups/03-episode.md [--draft]
// The file starts with a small front-matter block: ep, title, author.
const fs = require('fs');

const [file, flag] = process.argv.slice(2);
const api = process.env.S51_API;
const key = process.env.S51_ADMIN;
if (!file || !api || !key) {
  console.error('usage: S51_API=... S51_ADMIN=... node tools/post-notes.js <file.md> [--draft]');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');
const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) { console.error('missing front matter'); process.exit(1); }
const meta = Object.fromEntries(m[1].split('\n').map(l => l.split(/:\s*/)).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));

fetch(api, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({
    action: 'admin', key, op: 'save_notes',
    ep: Number(meta.ep), title: meta.title, author: meta.author || 'The Commissioner',
    body: m[2].trim(), published: flag !== '--draft'
  })
}).then(r => r.json()).then(res => {
  if (!res.ok) { console.error('failed:', res.error); process.exit(1); }
  console.log(`${flag === '--draft' ? 'Saved draft' : 'Published'}: Ep ${meta.ep} — ${meta.title}`);
});
