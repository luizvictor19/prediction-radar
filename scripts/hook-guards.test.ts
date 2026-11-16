import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * .claude/hooks/guard-main.sh is the only thing that says "never on main" and
 * "only from an issue worktree": the deny list in .claude/settings.json blocks
 * or allows a command whole. Since issue 84 the Claude merges origin/main into
 * issue branches and applies migrations, so a hook that lets the wrong command
 * through reaches main or the production database.
 *
 * Each case runs the script as Claude Code does, with the hook input on stdin
 * (tool_input.command and cwd), against throwaway repositories: a main folder
 * on main, a linked worktree on an issue branch nested under
 * .claude/worktrees/ (the layout of this repository), and a folder outside
 * any repository.
 *
 * Ported from chelsea-st-app (scripts/hook-guards.test.ts, its PR 324).
 */
const HOOK = join(import.meta.dirname, '..', '.claude', 'hooks', 'guard-main.sh');

const RAMO = 'docs/84-owner-out-of-the-loop';

let raiz = '';
let principal = '';
let worktree = '';
let avulsa = '';
let worktreeNaMain = '';
let principalForaDaMain = '';

/** Git with no user or system config, so the machine's settings never leak in. */
const ambienteGit = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: ambienteGit,
    stdio: 'ignore',
  });
}

/** What the hook decides for one Bash call: "deny", or "allow" when it prints nothing. */
function decidir(command: string, cwd: string): 'deny' | 'allow' {
  const run = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    // The folder outside any repository stays outside, wherever tmpdir is.
    env: { ...ambienteGit, GIT_CEILING_DIRECTORIES: raiz },
  });
  assert.equal(run.status, 0, `o hook saiu com ${run.status}: ${run.stderr}`);
  if (run.stdout.trim() === '') return 'allow';
  const saida = JSON.parse(run.stdout) as {
    hookSpecificOutput: { permissionDecision: string };
  };
  assert.equal(
    saida.hookSpecificOutput.permissionDecision,
    'deny',
    'o hook imprimiu uma decisão que não é deny',
  );
  return 'deny';
}

function recusa(command: string, cwd: string): void {
  assert.equal(decidir(command, cwd), 'deny', `devia recusar: ${command} (em ${cwd})`);
}

function deixa(command: string, cwd: string): void {
  assert.equal(decidir(command, cwd), 'allow', `devia deixar passar: ${command} (em ${cwd})`);
}

before(() => {
  raiz = mkdtempSync(join(tmpdir(), 'hook-guards-'));
  principal = join(raiz, 'prediction-radar');
  worktree = join(principal, '.claude', 'worktrees', 'docs-84-owner-out-of-the-loop');
  avulsa = join(raiz, 'avulsa');
  worktreeNaMain = join(raiz, 'na-main');
  principalForaDaMain = join(raiz, 'outro-clone');
  mkdirSync(principal);
  mkdirSync(avulsa);
  mkdirSync(principalForaDaMain);
  git(principal, 'init', '-q', '-b', 'main');
  git(principal, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(principal, 'worktree', 'add', '-q', worktree, '-b', RAMO);
  // A linked worktree on main itself: git allows it only with --force.
  git(principal, 'worktree', 'add', '-q', '--force', worktreeNaMain, 'main');
  // A main folder left on a feature branch: no linked worktree, but no main either.
  git(principalForaDaMain, 'init', '-q', '-b', 'main');
  git(principalForaDaMain, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(principalForaDaMain, 'checkout', '-q', '-b', 'feat/99-outra');
});

after(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('git commit', () => {
  it('é recusado na main', () => {
    recusa('git commit -m "x"', principal);
    recusa('git add . && git commit -m x', principal);
  });

  it('é recusado quando o -C aponta para a main, de qualquer pasta', () => {
    recusa(`git -C ${principal} commit -m x`, worktree);
  });

  it('passa no ramo da issue', () => {
    deixa('git commit -m "x"', worktree);
    deixa(`git -C ${worktree} commit -m x`, principal);
  });
});

describe('git push', () => {
  it('é recusado quando o destino é a main', () => {
    recusa('git push origin main', worktree);
    recusa('git push origin HEAD:main', worktree);
  });

  it('é recusado a partir da main, até para apagar um ramo remoto', () => {
    recusa('git push', principal);
    recusa(`git push origin --delete ${RAMO}`, principal);
  });

  it('é recusado quando forçado, em toda grafia', () => {
    for (const command of [
      `git push --force origin ${RAMO}`,
      `git push -f origin ${RAMO}`,
      `git push -uf origin ${RAMO}`,
      'git push --force-with-lease',
      `git push origin +${RAMO}`,
    ]) {
      recusa(command, worktree);
    }
  });

  it('passa para o ramo da issue', () => {
    deixa(`git push -u origin ${RAMO}`, worktree);
  });
});

describe('git merge', () => {
  it('é recusado na main, até de origin/main', () => {
    recusa('git merge origin/main', principal);
    recusa(`git -C ${principal} merge origin/main`, worktree);
  });

  it('é recusado para qualquer coisa que não seja origin/main', () => {
    for (const command of [
      `git -C ${worktree} merge feat/outra`,
      `git -C ${worktree} merge main`,
      `git -C ${worktree} merge origin/feat/outra`,
      `git -C ${worktree} merge origin/main feat/outra`,
      `git -C ${worktree} merge --squash origin/main`,
      `git -C ${worktree} merge -X theirs origin/main`,
      `git -C ${worktree} merge`,
    ]) {
      recusa(command, principal);
    }
  });

  it('passa para origin/main no ramo da issue', () => {
    for (const command of [
      `git -C ${worktree} merge origin/main`,
      `git -C ${worktree} merge --no-edit origin/main`,
      `git -C ${worktree} merge --no-ff -m "chore: bring main into the branch" origin/main`,
      `git -C ${worktree} merge --abort`,
      `git -C ${worktree} fetch origin && git -C ${worktree} merge --no-edit origin/main`,
    ]) {
      deixa(command, principal);
    }
    deixa('git merge origin/main', worktree);
  });
});

describe('supabase db push', () => {
  it('é recusado da pasta principal', () => {
    for (const command of [
      'supabase db push',
      'supabase db push --dry-run',
      'npx supabase db push',
      'supabase --debug db push',
    ]) {
      recusa(command, principal);
    }
    recusa(`cd ${principal} && supabase db push`, worktree);
    recusa(`supabase --workdir ${principal} db push`, worktree);
  });

  it('é recusado da pasta principal mesmo fora da main', () => {
    recusa('supabase db push', principalForaDaMain);
  });

  it('é recusado de uma pasta fora de qualquer repositório', () => {
    recusa('supabase db push', avulsa);
  });

  it('é recusado de uma worktree que está na main', () => {
    recusa('supabase db push', worktreeNaMain);
  });

  it('passa a partir da worktree da issue', () => {
    deixa('supabase db push', worktree);
    deixa('supabase db push --dry-run', worktree);
    deixa(`cd ${worktree} && supabase db push`, principal);
    deixa(`cd ${worktree} && supabase db push --dry-run`, principal);
    deixa('cd .claude/worktrees/docs-84-owner-out-of-the-loop && supabase db push', principal);
  });
});

describe('comandos que não são dos guardas', () => {
  it('passam, na main e no ramo da issue', () => {
    for (const command of [
      'git status',
      'git pull --ff-only origin main',
      'git merge-base HEAD origin/main',
      'gh pr merge 84 --merge',
      'npm run check',
      'grep -n "git merge feat/x" AGENTS.md',
      'echo "supabase db push"',
      'supabase db dump --linked -f /tmp/x.sql',
      'supabase migration list',
    ]) {
      deixa(command, principal);
      deixa(command, worktree);
    }
  });
});
