import fs from 'node:fs';

export const AUTH_TOKEN_ENV = 'PR_AUDIT_AUTH_TOKEN';

/**
 * The engine's credentials, from (first match) `--auth-token <value>`,
 * `--auth-token-file <path>` or $PR_AUDIT_AUTH_TOKEN. '' means none was given:
 * the agent CLI uses its own local login.
 *
 * A source that is present but empty is an error — in CI that means the step
 * fetching the credentials failed, and running on without them hides why.
 */
export function readAuthToken(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const valueOf = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    const value = args[idx + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };

  // Not parsed, and as a positional it could be mistaken for the PR ref and echoed in an error
  for (const a of args) {
    const flag = /^(--auth-token(?:-file)?)=/.exec(a)?.[1];
    if (flag) throw new Error(`Use \`${flag} <value>\`; the ${flag}=<value> form isn't supported`);
  }

  const token = valueOf('--auth-token');
  const file = valueOf('--auth-token-file');
  if (token !== null && file !== null) throw new Error('Use either --auth-token or --auth-token-file, not both');

  if (token !== null) {
    if (!token.trim()) throw new Error('--auth-token is empty');
    return token;
  }
  if (file !== null) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read --auth-token-file ${file}: ${(err as Error).message}`);
    }
    if (!content.trim()) throw new Error(`--auth-token-file ${file} is empty`);
    return content.trim();
  }
  if (env[AUTH_TOKEN_ENV] !== undefined) {
    if (!env[AUTH_TOKEN_ENV]!.trim()) throw new Error(`$${AUTH_TOKEN_ENV} is set but empty`);
    return env[AUTH_TOKEN_ENV]!.trim();
  }
  return '';
}

/** argv with the --auth-token value replaced, for logging. */
export function redactArgs(argv: string[]): string[] {
  return argv.map((a, i) => {
    if (argv[i - 1] === '--auth-token') return '***';
    if (a.startsWith('--auth-token=')) return '--auth-token=***';
    return a;
  });
}
