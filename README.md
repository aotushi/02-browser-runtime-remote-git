# Site 10-Layer Check GitHub Actions Remote Provider

这是 Site 10-Layer Check 的 GitHub Actions remote provider 仓库版本。

它不再只代表 browser runtime。当前职责是承载 Web App 不能直接在浏览器或 Cloudflare Worker 中完成的远程探针，并把报告、快照和截图作为 artifacts 交付。

当前已包含两类 provider：

| Provider | Workflow | 输出 |
| --- | --- | --- |
| Browser runtime | `.github/workflows/site-10-layer-check-browser.yml` | `browser_page_probe` snapshots、Markdown reports、screenshots |
| Live TLS certificate | `.github/workflows/site-10-layer-check-live-tls.yml` | `tls_live_certificate_probe` snapshots、Markdown reports |

## 为什么单独成目录

`resume/` 是项目合集目录，不适合作为这个实验的 GitHub 仓库根目录。GitHub Actions 只识别仓库根目录下的 `.github/workflows/*.yml`，所以需要一个可以独立推送到 GitHub 的目录：

```text
02-browser-runtime-remote-github/
├── .github/
│   └── workflows/
│       ├── site-10-layer-check-browser.yml
│       └── site-10-layer-check-live-tls.yml
├── package.json
├── package-lock.json
├── tsconfig.json
├── tools/
│   └── live-tls-probe.mjs
└── src/
```

## 使用方式

本地验证：

```bash
npm ci
npx playwright install chromium
npm run build
npm run start -- https://example.com
npm run start -- --target-file targets.json
npm run probe:tls -- https://example.com
```

当前已本地验证：

```bash
npm ci
npx playwright install chromium
npm run check
npm run build
npm run start -- https://example.com
npm run probe:tls -- https://example.com --out snapshots/example.com-live-tls-local.json --report reports/example.com-live-tls-local.md
```

## 目标配置

定时任务读取仓库根目录下的 `targets.json`，避免把目标列表写死在 workflow YAML 中。

workflow YAML 不再内置任何默认目标 URL。`workflow_dispatch` 的 `target` 默认为空，`target_file` 默认为 `targets.json`。

当前支持两种写法：

```json
[
  "https://example.com",
  {
    "url": "https://www.cloudflare.com/learning/dns/dns-records/dns-a-record/",
    "wait_ms": 3000,
    "timeout_ms": 30000,
    "screenshot": true
  }
]
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `url` / `target` | 目标 URL 或域名 |
| `wait_ms` / `waitMs` | 页面稳定后额外等待时间 |
| `timeout_ms` / `timeoutMs` | 页面打开超时 |
| `screenshot` | 是否保存截图 |
| `headed` | 本地调试时是否显示浏览器窗口 |

CLI 仍然兼容单目标运行：

```bash
npm run start -- https://example.com
npm run start -- --target-file targets.json
```

推到 GitHub 后：

- 在 Actions 页面手动运行 `Site 10-Layer Check Browser`。
- 手动运行时如果不填写 `target`，默认读取 `targets.json`。
- 手动运行时如果填写 `target`，只跑这个临时单目标。
- 定时任务每天读取 `targets.json`。
- 运行结束后在 artifacts 下载 `reports/`、`snapshots/`、`screenshots/`。

## 当前 workflow

Browser runtime workflow：

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
→ npm run start -- <target> 或 npm run start -- --target-file <target_file>
→ upload reports / snapshots / screenshots
```

Live TLS workflow：

```text
.github/workflows/site-10-layer-check-live-tls.yml
```

流程：

```text
workflow_dispatch
→ checkout
→ setup-node
→ npm ci
→ npm run build
→ npm run probe:tls -- <target>
→ upload reports / snapshots
```

Live TLS 的作用是补齐 Cloudflare Worker Fetch 无法提供的 Layer 2 live certificate 信息：

| 字段 | 来源 |
| --- | --- |
| SAN | Node TLS socket `subjectaltname` |
| issuer / subject | Node TLS peer certificate |
| valid_from / valid_to | Node TLS peer certificate |
| certificate chain | Node TLS peer certificate chain |
| negotiated protocol / cipher | Node TLS socket |

仍未覆盖：

- OCSP / revocation status
- multi-region certificate variance
- browser-specific trust store differences

## 远程验证记录

GitHub 仓库：

```text
https://github.com/aotushi/02-browser-runtime-remote-git
```

已执行的 Actions run：

```text
https://github.com/aotushi/02-browser-runtime-remote-git/actions/runs/26074354642
```

下载 artifacts 后验证：

```text
D:\Users\shiihs_new\Downloads\site-10-layer-check-browser-26074354642
├── reports/
├── snapshots/
└── screenshots/
```

验证结论：

- 远程 GitHub-hosted runner 成功执行 Playwright browser runtime。
- artifact 中包含 Markdown 报告、JSON 快照和 PNG 截图。
- `www.cloudflare.com` 页面返回 HTTP 200。
- 页面标题为 `DNS A record`，截图显示真实内容页，不是 challenge / captcha / access denied 页面。
- `browser_page_probe` 输出 `status: ok`、`risk: info`。

## 当前限制

- 不自动 commit 报告到仓库。
- 不接 Browserless / Browserbase / Cloudflare Browser Run。
- 定时目标列表来自 `targets.json`。
- Browser runtime 核心实现变化仍需要从 `../02-browser-runtime` 同步过来。
- Live TLS provider 是当前目录下的独立 Node probe，用于产出 Web App 可导入的 `SnapshotRecord` artifact。
