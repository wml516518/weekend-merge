// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('redacts invite/recover bearer fragments from uncaught browser errors while retaining diagnostics', () => {
  // Fail at the Playwright boundary before starting a browser; run the real verifier's error path.
  const code = `
import runpy, sys, types
module = types.ModuleType('playwright.sync_api')
def fail():
    try:
        raise ValueError('https://example.test/#recover=synthetic-recovery-secret')
    except ValueError as error:
        raise RuntimeError('Navigation timeout https://example.test/#invite=synthetic-invite-secret') from error
module.sync_playwright = fail
module.expect = None
sys.modules['playwright'] = types.ModuleType('playwright')
sys.modules['playwright.sync_api'] = module
runpy.run_path('scripts/verify-groups-browser.py', run_name='__main__')
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  const output = result.stdout + result.stderr;
  expect(output).toContain('Navigation timeout');
  expect(output).toContain('RuntimeError');
  expect(output).not.toContain('synthetic-invite-secret');
  expect(output).not.toContain('synthetic-recovery-secret');
  expect(output).toContain('#invite=[REDACTED]');
  expect(output).toContain('#recover=[REDACTED]');
});
