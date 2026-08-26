// scripts/hash-password.js — interactive helper: prompts for the admin
// password (stdin, never argv — argv leaks into shell history), prints the
// bcrypt hash (cost 12) to paste into ADMIN_PASSWORD_HASH. Prints the hash
// ONLY; the password itself is masked and never echoed or logged.

const readline = require('readline');
const bcrypt = require('bcrypt');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,
  terminal: true,
});

let masking = false;
const origWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
if (origWrite) {
  rl._writeToOutput = (s) => {
    if (masking) origWrite(s.includes('\n') ? '\n' : '*');
    else origWrite(s);
  };
}

rl.question('Enter admin password: ', (password) => {
  masking = false;
  rl.close();
  process.stderr.write('\n');
  if (!password) {
    console.error('No password entered — nothing hashed.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  process.stdout.write(hash + '\n');
});
masking = true;
