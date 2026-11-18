'use strict';
// Build oldidan native/input.cs ni native/uzat-input.exe ga kompilyatsiya qiladi (Windows'dagi csc bilan).
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const src = path.join(root, 'native', 'input.cs');
const out = path.join(root, 'native', 'uzat-input.exe');

execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${out}`, src], { stdio: 'inherit' });
console.log('native/uzat-input.exe tayyor');
