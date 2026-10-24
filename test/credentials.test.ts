import assert from "node:assert/strict";
import { test } from "node:test";
import { containsCredentialValue, findCredentialValueMatches } from "../src/credentials.js";

test("real-shaped secrets are found", () => {
  const secrets = [
    `I pushed with ${"ghp_"}${"A".repeat(24)} yesterday.`,
    `The bucket key id is ${"AKIA"}${"B".repeat(16)} for the backup.`,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    "DB_PASSWORD=8f3kQ9zT1",
    'api_key = "k3y-Enter-7f"',
    "Authorization: Basic RkFLRTpGQUtFMDAwMA==",
    "postgres://app:0f1e2d3c4b5a6978@db.example.test:5432/app",
  ];
  for (const text of secrets) assert.equal(containsCredentialValue(text), true, text);
});

test("placeholders and environment reads are not secrets", () => {
  const clean = [
    'api_key = os.environ["API_KEY"]',
    "api_key = ${API_KEY}",
    "password = <PASSWORD>",
    "Authorization: Bearer YOUR_ACCESS_TOKEN",
    "NEXTAUTH_SECRET=your-secret-here",
    "AUTH_SECRET=8f3k...",
    "const secret = params.secret;",
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "api_key = \"Enter your API key\"",
    "password=correcthorse",
    '"password": "Password"',
  ];
  for (const text of clean) assert.equal(containsCredentialValue(text), false, text);
});

test("the public sample's known false hits are clean", () => {
  assert.equal(containsCredentialValue("password=hunter2"), false);
  assert.equal(containsCredentialValue('const fakekey = "sk-kimi-fakekey123"'), false);
  assert.equal(
    containsCredentialValue("Call the maps endpoint with AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe please."),
    false,
  );
  assert.equal(containsCredentialValue('api_key = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"'), false);
});

test("a secret is reported by position, never by value", () => {
  const text = "hello\nDB_PASSWORD=8f3kQ9zT1\nbye";
  const matches = findCredentialValueMatches(text);
  assert.ok(matches.length > 0);
  assert.equal(text.slice(matches[0]?.start, matches[0]?.end).includes("8f3kQ9zT1"), true);
});

test("a public token name is not a secret", () => {
  assert.equal(containsCredentialValue("PublicKeyToken=b03f5f7f11d50a3a"), false);
  assert.equal(containsCredentialValue("publishable_key=pk_live_example"), false);
});
