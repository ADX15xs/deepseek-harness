# 桌面端 asar 补丁工具

[English](README.md) | 中文

本工具把预构建的客户端 bundle 注入到已安装的 DeepSeek Harness 桌面应用中，做法是重写
`resources/app.asar` 里的条目。它存在的意义是：性能补丁要打到的机器只有发行版构建，
没有源码 checkout。

工具会打两个客户端 bundle：

| 包 | 补丁改动 |
|---|---|
| `@deepseek-ai/dsh-client-ui-chat` | `ChatSnapshotBuilder` 对活跃的 Step 走尾部追加快速路径 |
| `@deepseek-ai/dsh-client-ui-conversation` | Turn 身份在 Step 推进时保持不变；被重构的 Turn 会被重新标记为 dirty |

## 文件

| 文件 | 作用 |
|---|---|
| `patch-asar.cjs` | 安装器。读取 `manifest.json`，重写归档，并校验每一条条目。 |
| `build-payload.cjs` | 针对新发行版重新生成 `payload/` 与 `manifest.json`。 |
| `manifest.json` | 目标发行版、归档条目，以及每个 bundle 预期的基线与补丁后 sha256。 |
| `payload/` | 被写入归档的对齐后客户端 bundle。 |
| `apply-patch.cmd` | Windows 启动器，用应用自带的 Electron 二进制运行安装器。 |

## 给机器打补丁

1. 完全退出 DeepSeek Harness，包括托盘图标。
2. 运行 `apply-patch.cmd`，或 `apply-patch.cmd "C:\Program Files\DeepSeek Harness"`。

   不带参数时，启动器依次尝试 `D:\deepseek-harness`、
   `C:\Program Files\DeepSeek Harness` 和
   `%LOCALAPPDATA%\Programs\DeepSeek Harness`。
3. 预期看到 `verify     : entries ..., integrity failures 0, aligned true`。
4. 启动 DeepSeek Harness。

安装器在写入前会把原归档复制到 `app.asar.pre-patch`，并且拒绝改动 bundle 与记录基线
不符的归档，因此打错版本或打上外来补丁会明确报错，而不是损坏应用。重复运行是安全的：
已打过补丁的 bundle 会被报告并跳过。

选项：`--app <dir>`、`--dry-run`、`--restore`、`--force`。

## 为新发行版重建

bundle 必须从该发行版自己的源码构建。用较新的 `master` 构建出来的 bundle 会链接到该
发行版并不提供的 API，因此它能正常注册，但会在运行时失败。

```sh
git worktree add ../dsh-release <release-tag> -b perf/<release>-patched-host
cd ../dsh-release
git cherry-pick <patch commits>
pnpm install --frozen-lockfile
pnpm run build:artifacts
```

然后在这个 worktree 里构建未打补丁的基线，因为 CSS module 前缀是内容哈希，每次构建
都会变化：

```sh
git checkout <release-tag> -- <the patched source files>
pnpm run build:lib:client
cp packages/client/ui-chat/lib/client.js            ../baseline/ui-chat.client.js
cp packages/client/ui-conversation/lib/client.js    ../baseline/ui-conversation.client.js
git checkout HEAD -- <the patched source files>
pnpm run build:lib:client
cp packages/client/ui-chat/lib/client.js            ../patched/ui-chat.client.js
cp packages/client/ui-conversation/lib/client.js    ../patched/ui-conversation.client.js
```

最后针对实际要打补丁的归档重新生成 payload：

```sh
node tools/desktop-asar-patch/build-payload.cjs \
  --stock "<install dir>/resources/app.asar" \
  --baseline ../baseline --patched ../patched
```

当基线构建与随附 bundle 的差异超出 CSS 类名哈希时，`build-payload.cjs` 会拒绝运行，
从而能够在错误源码变成 payload 之前将其拦下。

## 为什么要有 CSS 哈希重映射

`packages/client/tsdown.client.ts` 配置了 `cssModules: { pattern: '[hash]_[local]' }`。
哈希覆盖构建环境，因此同一份源码在不同机器上会产生不同的前缀。生成器按首次出现的顺序
把本地与随附的 token 列表配对，并把补丁 bundle 的前缀改写为随附版本的前缀。结果与官方
bundle 的差异只出现在补丁本身有差异的地方，这正是补丁归档可复现的原因：同一发行版加
同一组补丁提交，在任何机器上都会得到相同的 `app.asar` sha256。
