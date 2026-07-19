import { describe, expect, test } from "bun:test";

import {
  buildIsolatedEnv,
  captureSessionEnv,
} from "../../src/mnemosyne/env";

describe("per-session agent env", () => {
  test("builds an operational baseline plus the exact captured session subset", () => {
    const workerEnv = {
      HOME: "/Users/worker",
      PATH: "/usr/local/bin:/usr/bin",
      TMPDIR: "/tmp/worker",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      SSL_CERT_FILE: "/etc/worker-certs.pem",
      GITHUB_TOKEN: "worker-github-secret",
      AWS_ACCESS_KEY_ID: "worker-aws-key",
      AWS_SECRET_ACCESS_KEY: "worker-aws-secret",
      ANTHROPIC_AUTH_TOKEN: "worker-auth-must-not-leak",
      ANTHROPIC_API_KEY: "worker-api-key-must-not-leak",
      CLAUDE_CODE_OAUTH_TOKEN: "worker-oauth-must-not-leak",
    } satisfies NodeJS.ProcessEnv;
    const captured = {
      ANTHROPIC_AUTH_TOKEN: "session-auth",
      ANTHROPIC_API_KEY: "session-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "session-oauth",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "x-account: session-a",
      NODE_EXTRA_CA_CERTS: "/session/ca.pem",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-route",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-route",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-route",
      http_proxy: "http://lower-http",
      HTTP_PROXY: "http://upper-http",
      https_proxy: "http://lower-https",
      HTTPS_PROXY: "http://upper-https",
      all_proxy: "socks5://lower-all",
      ALL_PROXY: "socks5://upper-all",
      no_proxy: "lower.example",
      NO_PROXY: "upper.example",
      ANTHROPIC_MODEL: "must-not-override-cli-model",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      GITHUB_TOKEN: "session-github-secret",
    } satisfies NodeJS.ProcessEnv;

    expect(buildIsolatedEnv(workerEnv, captured)).toEqual({
      HOME: "/Users/worker",
      PATH: "/usr/local/bin:/usr/bin",
      TMPDIR: "/tmp/worker",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      SSL_CERT_FILE: "/etc/worker-certs.pem",
      ANTHROPIC_AUTH_TOKEN: "session-auth",
      ANTHROPIC_API_KEY: "session-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "session-oauth",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "x-account: session-a",
      NODE_EXTRA_CA_CERTS: "/session/ca.pem",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-route",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-route",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-route",
      http_proxy: "http://lower-http",
      HTTP_PROXY: "http://upper-http",
      https_proxy: "http://lower-https",
      HTTPS_PROXY: "http://upper-https",
      all_proxy: "socks5://lower-all",
      ALL_PROXY: "socks5://upper-all",
      no_proxy: "lower.example",
      NO_PROXY: "upper.example",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    });
  });

  test("an API-key-only session retains its key without inventing another auth mode", () => {
    expect(
      buildIsolatedEnv(
        { HOME: "/Users/worker", ANTHROPIC_AUTH_TOKEN: "worker-auth" },
        { ANTHROPIC_API_KEY: "api-key-only" },
      ),
    ).toEqual({
      HOME: "/Users/worker",
      ANTHROPIC_API_KEY: "api-key-only",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    });
  });

  test("capture payload includes only curated keys, including empty present values", () => {
    expect(
      captureSessionEnv({
        ANTHROPIC_API_KEY: "session-key",
        no_proxy: "",
        ANTHROPIC_MODEL: "excluded",
        CLAUDE_CODE_EFFORT_LEVEL: "high",
        AWS_SESSION_TOKEN: "excluded",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "session-key",
      no_proxy: "",
    });
  });
});
