# CyberStrike Firefox Extension

Captures browser HTTP traffic and forwards it to your local [CyberStrike](https://github.com/CyberStrikeus/CyberStrike) server, so the requests you see in DevTools become live proxy traffic for CyberStrike's HackBrowser feature and its 8 proxy sub-testers (IDOR, authorization bypass, mass assignment, injection, authentication, business logic, SSRF, file attacks).

Browse the target the way a real user would: log in as different roles, click through the app, trigger the flows that matter. The extension mirrors every request to CyberStrike, which builds role and credential context automatically, no manual proxy setup required.

## How it works

```
Firefox → cyberstrike-firefox-ext → CyberStrike server (proxy-agent pipeline) → 8 sub-testers
```

## Install

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on** and select this repo's `manifest.json`.
3. Start `cyberstrike web` (or the CyberStrike TUI) so the extension has a server to forward traffic to.

## Permissions

This extension requests `webRequest`, `<all_urls>`, `cookies`, and `contextualIdentities` because it needs to see the full request and response cycle, including session cookies, across whatever target you point your browser at. Captured traffic is forwarded only to the CyberStrike server you configure; it does not go anywhere else.

Use only against targets you are authorized to test.

## Related

- [CyberStrike](https://github.com/CyberStrikeus/CyberStrike) — the core AI agent this extension feeds traffic into
- [HackBrowser docs](https://docs.cyberstrike.io/docs/tools/hacker-browser/)
