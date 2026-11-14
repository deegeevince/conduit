// The improvement loop from the command line. Not part of the server.
// Usage: pnpm improve --dry-run            print what a run would do and what guards it; run nothing
// Not built yet (PLAN-v2.md, package I):
//        pnpm improve --budget 12 --experiments 3 [--minutes 180] [--kinds technique,block] [--yes]
//        pnpm improve status               what is awaiting the steward, and the last entries of the ledger
//        pnpm improve approve <id> | refuse <id> --why "…"     the steward's verdict; approve merges into the integration branch
//        pnpm improve vault --file <path>  run the vault set, which lives outside the repository
import { KEEP_RULE, PROTECTED_PATHS, SEALED_PATHS } from '../loop/guard';
import { EXPERIMENT_ORDER, LOOP_ROLES } from '../loop/types';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

if (!process.argv.includes('--dry-run')) {
  process.stderr.write('improve: the loop is not built yet (PLAN-v2.md, package I). `pnpm improve --dry-run` prints what it will do.\n');
  process.exit(2);
}
out('One run of the improvement loop:');
out('  measure the tune set and the held-out set on this branch');
out(`  critic      ${LOOP_ROLES.critic.model}, effort ${LOOP_ROLES.critic.effort}: reads the tune set's judgements, proposes experiments (${EXPERIMENT_ORDER.join(', then ')})`);
out(`  builder     ${LOOP_ROLES.builder.model}, effort ${LOOP_ROLES.builder.effort}: one git worktree and branch per experiment`);
out('  guard       the diff is refused if it touches a protected path, carries battery text, or fails typecheck or the prompt budget');
out(`  re-measure  the held-out set on candidate and baseline, interleaved, judged blind by ${LOOP_ROLES.judge.model}`);
out(`  decide      kept only if a family it aimed at rises by ${KEEP_RULE.gain} and no family falls by ${KEEP_RULE.slip}; a tie is a discard`);
out(`  reviewer    ${LOOP_ROLES.reviewer.model}, effort ${LOOP_ROLES.reviewer.effort}: reads a kept diff cold`);
out(`  steward     ${LOOP_ROLES.steward.model}, effort ${LOOP_ROLES.steward.effort}: approves, merges into the integration branch, writes techniques to Remote`);
out('  the owner   merges to main');
out(`\nProtected paths: ${PROTECTED_PATHS.join('  ')}`);
out(`Never shown to the critic or the builder: ${SEALED_PATHS.join('  ')}`);
