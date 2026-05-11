#!/usr/bin/env node
/**
 * One-shot OAuth 1.0a bootstrap CLI.
 *
 * Run locally once to obtain the FatSecret user access token + secret, then
 * paste the printed env block into the Kubernetes Secret used by the remote
 * deployment.
 *
 *   FATSECRET_CLIENT_ID=... \
 *   FATSECRET_CLIENT_SECRET=... \
 *   FATSECRET_CONSUMER_SECRET=... \
 *   node dist/bootstrap.js
 *
 * If env vars are missing, the CLI prompts for them interactively.
 */

import readline from 'node:readline/promises';
import { exec } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { requestToken, accessToken, type OAuth1Credentials } from './oauth1.js';

async function prompt(rl: readline.Interface, q: string, secret = false): Promise<string> {
  if (!secret) return (await rl.question(q)).trim();
  // Minimal masked input for secrets so they don't show up in scrollback.
  process.stdout.write(q);
  return new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (s === '\n' || s === '\r' || s === '\r\n') {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(acc.trim());
      } else {
        acc += s;
        process.stdout.write('*');
      }
    };
    let acc = '';
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    console.error('FatSecret MCP — OAuth 1.0a bootstrap');
    console.error('Get your credentials at https://platform.fatsecret.com/ → My Account → API Keys');
    console.error('');

    const clientId = process.env.FATSECRET_CLIENT_ID || (await prompt(rl, 'Client ID: '));
    const clientSecret = process.env.FATSECRET_CLIENT_SECRET || (await prompt(rl, 'Client Secret (OAuth 2.0): ', true));
    const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET || (await prompt(rl, 'Consumer Secret (OAuth 1.0): ', true));

    if (!clientId || !clientSecret || !consumerSecret) {
      console.error('All three credentials are required.');
      process.exit(1);
    }

    const creds: OAuth1Credentials = { consumerKey: clientId, consumerSecret };

    console.error('\n1/3 Requesting OAuth 1.0a request token…');
    const reqToken = await requestToken(creds);

    console.error('\n2/3 Authorize this app in your browser:');
    console.error(`    ${reqToken.authorizationUrl}\n`);
    openInBrowser(reqToken.authorizationUrl);
    const verifier = await prompt(rl, 'Verifier PIN from the authorization page: ');
    if (!verifier) {
      console.error('Verifier is required.');
      process.exit(1);
    }

    console.error('\n3/3 Exchanging for access token…');
    const access = await accessToken(creds, reqToken.oauthToken, reqToken.oauthTokenSecret, verifier);

    console.error('\n✓ Authentication complete.\n');
    console.error('Paste the following into your Kubernetes Secret (k8s/secret.yaml):');
    console.error('-----------------------------------------------------------------');
    console.log(`FATSECRET_CLIENT_ID=${clientId}`);
    console.log(`FATSECRET_CLIENT_SECRET=${clientSecret}`);
    console.log(`FATSECRET_CONSUMER_SECRET=${consumerSecret}`);
    console.log(`FATSECRET_ACCESS_TOKEN=${access.accessToken}`);
    console.log(`FATSECRET_ACCESS_TOKEN_SECRET=${access.accessTokenSecret}`);
    console.error('-----------------------------------------------------------------');
    console.error('Also generate a random MCP_BEARER_TOKEN (e.g. `openssl rand -hex 32`)');
    console.error('and include it in the same Secret.');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
