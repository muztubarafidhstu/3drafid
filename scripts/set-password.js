'use strict';

// Sets (or changes) the admin password from the command line:  npm run set-password
// Docker:  docker compose exec shop npm run set-password

const path = require('path');
const readline = require('readline');
const { Auth } = require('../lib/auth');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    process.stdout.write(question);
    rl._writeToOutput = function (s) { if (s.includes('\n') || s.includes('\r')) write.call(rl, s); };
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const auth = new Auth(dataDir);
  const first = await ask(`New admin password (at least 8 characters): `);
  const why = Auth.checkStrength(first);
  if (why) { console.error(why); process.exit(1); }
  const second = await ask('Type it again: ');
  if (first !== second) { console.error('The two passwords are different. Nothing was changed.'); process.exit(1); }
  await auth.setPassword(first);
  console.log(`Password saved in ${path.join(dataDir, 'auth.json')} (hashed). Everyone is signed out; sign in again with the new password.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
