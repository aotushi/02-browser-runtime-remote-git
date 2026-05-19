# Site 10-Layer Check Browser Runtime Remote GitHub

这是 `../02-browser-runtime` 的远程 GitHub Actions 验证仓库版本。

目标不是新增探针能力，而是验证同一套 Playwright browser runtime 能否在 GitHub-hosted runner 中无人值守运行，并把报告、快照和截图作为 artifacts 交付。

## 为什么单独成目录

`resume/` 是项目合集目录，不适合作为这个实验的 GitHub 仓库根目录。GitHub Actions 只识别仓库根目录下的 `.github/workflows/*.yml`，所以需要一个可以独立推送到 GitHub 的目录：

```text
02-browser-runtime-remote-github/
├── .github/
│   └── workflows/
│       └── site-10-layer-check-browser.yml
├── package.json
├── package-lock.json
├── tsconfig.json
└── src/
```

## 使用方式

本地验证：

```bash
npm ci
npx playwright install chromium
npm run build
npm run start -- https://example.com
```

当前已本地验证：

```bash
npm ci
npx playwright install chromium
npm run check
npm run build
npm run start -- https://example.com
```

推到 GitHub 后：

- 在 Actions 页面手动运行 `Site 10-Layer Check Browser`，可以输入单个目标 URL。
- 定时任务每天运行一次内置目标列表。
- 运行结束后在 artifacts 下载 `reports/`、`snapshots/`、`screenshots/`。

## 当前 workflow

文件：

```text
.github/workflows/site-10-layer-check-browser.yml
```

流程：

```text
workflow_dispatch / schedule
→ checkout
→ setup-node
→ npm ci
→ npx playwright install --with-deps chromium
→ npm run build
→ npm run start -- <target>
→ upload reports / snapshots / screenshots
```

## 当前限制

- 不自动 commit 报告到仓库。
- 不接 Browserless / Browserbase / Cloudflare Browser Run。
- 定时目标列表暂时写在 workflow 内。
- 这个目录是远程运行实验副本，核心实现变化需要从 `../02-browser-runtime` 同步过来。
