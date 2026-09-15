// Audit T1-13: Conventional Commits gate for the lefthook commit-msg hook.
// Usage: node scripts/check-commit-msg.mjs <path-to-COMMIT_EDITMSG>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('check-commit-msg: missing commit message file argument');
  process.exit(2);
}

const subject = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '';

const conventional = /^(feat|fix|refactor|test|chore|docs|perf|ci|build|revert)(\([^)]+\))?!?: .+/;
const merge = /^(Merge |Revert )/;

if (conventional.test(subject) || merge.test(subject)) {
  process.exit(0);
}

console.error(
  `Commit subject must follow Conventional Commits (AGENTS.md): type(scope): subject\n  got: "${subject}"`
);
process.exit(1);
