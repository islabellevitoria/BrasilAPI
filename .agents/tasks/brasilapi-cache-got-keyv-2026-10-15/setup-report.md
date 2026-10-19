# Setup report

## Branch
- `git branch --show-current` → `feature/648-cache-got-keyv-sqlite`
- `git status`: clean except untracked `.agents/` (and now modified `.gitignore`, see below). No commits made.

## Node 20 mechanism
- Portable Node **v20.20.2** (npm 10.8.2) extracted to `.tools/node20/` (from `https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip`). System Node v24.17.0 untouched.
- `.tools/` added to `.gitignore` (only change to a tracked file).
- Use in every PowerShell command (per-call, PATH doesn't persist):
  ```powershell
  $env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"; node -v; npm run build
  ```
  Or by full path: `.\.tools\node20\node.exe`, `.\.tools\node20\npm.cmd`, `.\.tools\node20\npx.cmd`.

## Install
- `npm ci` under Node 20: **succeeded** (exit 0), 799 packages added in ~6m, husky hooks installed.
- Warnings: deprecated `@humanwhocodes/object-schema@2.0.3`, `eslint@8.57.1`; `npm audit` reports 60 vulnerabilities (4 low, 9 moderate, 41 high, 6 critical). Not addressed.

## Blockers
None.
