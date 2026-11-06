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
- It sends requests only to the Studio address you set (and to the GitHub API if you use the GitHub-hosted-site mode). The README lists every host under "What is sent where".
- If a token may have leaked: revoke it (a Studio token under More → Client access in your Studio; a GitHub token in your GitHub account's token settings) and create a new one.
