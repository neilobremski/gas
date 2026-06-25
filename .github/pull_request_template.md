## PR Checklist

- [ ] Version bumped in `_info()` response (`version: 'X.Y'`) and header comment (`GAS Bridge vX.Y`) — when `bridge/` deployable files change
- [ ] Version bumped in `VERSION` constant and header comment (`A8S vX.Y`) — when `a8s/` deployable files change
- [ ] New actions added to README action table — Bridge only
- [ ] No hardcoded secrets (bridge keys, OAuth tokens, deployment URLs)
- [ ] No PII in committed code or PR description (real emails, phone numbers — use example.com)
- [ ] Critic review passed

CI enforces version bumps and PII checks on pull requests.
