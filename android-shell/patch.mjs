// Доповнює згенерований проєкт Android: іконки, заставка, номер версії.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
const build = String(parseInt(process.argv[2] || '1', 10) || 1);
cpSync('res', 'android/app/src/main/res', { recursive: true, force: true });
const g = 'android/app/build.gradle';
let s = readFileSync(g, 'utf8');
s = s.replace(/versionCode \d+/, `versionCode ${build}`).replace(/versionName "[^"]*"/, `versionName "1.${build}"`);
writeFileSync(g, s);
console.log('Версія застосунку: 1.' + build);
