const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const db = require('./db');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));
(async () => {
 const name = (await ask('Initial administrator full name: ')).trim();
 const email = (await ask('Administrator email: ')).trim().toLowerCase();
 const password = (await ask('Password (minimum 10 characters): ')).trim();
 if (!name || !email.includes('@') || password.length < 10) { console.error('Invalid details or password too short.'); process.exit(1); }
 const hash = await bcrypt.hash(password, 12);
 try {
  db.prepare("INSERT INTO users(full_name,email,password_hash,role,status) VALUES(?,?,?,'admin','verified')").run(name,email,hash);
  db.prepare('INSERT OR IGNORE INTO school_years(label,is_active) VALUES(?,1)').run('2026-2027');
  console.log('Initial administrator created. Keep credentials private.');
 } catch(e) { console.error('Could not create account:',e.message); }
 rl.close();
})();
