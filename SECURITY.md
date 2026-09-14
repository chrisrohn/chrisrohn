# Security

This is a static site on GitHub Pages plus a daily GitHub Actions pipeline. There is no server of ours to
compromise, but the browser client does hold a Google access token and, optionally, a GitHub token in local storage,
and the pipeline runs with repository secrets.

**Reporting.** Please use GitHub's private vulnerability reporting for this repository
(Security → Report a vulnerability) rather than a public issue. Include what you found, how to reproduce it, and
what you think the impact is. Reports are read within a few days.

**What is in scope.** The client in `site/`, the service worker, the Content-Security-Policy in `site/index.html`,
the Google sign-in and YouTube Data API flows, the ratings push to `api.github.com`, and the workflows under
`.github/workflows/`.

**Automated checks.** Every change runs CodeQL (JavaScript and Python), ESLint, html-validate, `tsc --strict`,
a Playwright smoke test with axe-core accessibility scans, and Lighthouse. Dependabot keeps the pinned
dependencies and actions current.
