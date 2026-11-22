# Security policy

Blyg for Obsidian is a beta (0.9.x). Only the latest release is supported.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Use GitHub's private reporting: open this repository's **Security** tab and choose **Report a vulnerability**.
- If you do not see that option, open an issue that says only that you have a security matter and would like a private way to send it (no details), and the maintainer will reply with one.

Please include the Blyg version, what you did, what you saw and why you think it matters. Never include a real token, a password or the text of private notes.

This is a one-person beta: you will get an answer as soon as it can be given, but there is no guaranteed response time.

## Tokens

- The plugin keeps secrets only in Obsidian's keychain. The settings store the name of a keychain entry, never the value, and the plugin never logs a token, writes it to a file or puts it in a URL.
- Unless you turn on the optional AI digest (the next point), it sends requests only to the Studio address you set (and to the GitHub API if you use the GitHub-hosted-site mode). The README lists every host under "What is sent where".
- Optional, off by default: the Daily's AI digest sends the text of posts you have read (other people's words) to the AI provider you configure (default: the Anthropic API, `api.anthropic.com`), with your API key from Obsidian's keychain in a header. Every request is preceded by a receipt window showing the exact text and needs a tap on Send. Posts are treated as untrusted input (delimited as data, the answer is shown as plain text only, sizes are capped), results are kept only in the plugin's storage, and the key is never logged or stored in the plugin's files. Failures fall back to the digest made on the device. If you submit the plugin to a directory, its disclosure rules likely require stating this network use and the third-party service.
- If a token may have leaked: revoke it (a Studio token under More → Client access in your Studio; a GitHub token in your GitHub account's token settings) and create a new one.
