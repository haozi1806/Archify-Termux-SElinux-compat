# Archify Termux / SELinux 兼容层

在 Android + Termux 上运行 [Archify](https://github.com/tt-a1i/archify) 绘图技能的兼容层。

Archify 本身是为常规 Linux 写的，它依赖两项 Android 应用域并不提供的行为，导致在手机上直接跑必然失败：

- 子进程用 `process.execPath` 启动，而 termux-exec 把它报成动态链接器 → `bad ELF magic`
- 发布产物用 `link(2)` 做「不覆盖」原子替换，而 SELinux 直接拒绝 → `EACCES`

本插件在 Node 进程内部接管这两处，**不修改 Archify 的任何文件**，因此 Archify 升级后依然有效。

---

## 症状与根因

| 假设 | Android 的实际行为 | 典型报错 |
|---|---|---|
| `process.execPath` 是 node 二进制 | termux-exec 把 `execve` 改写成 `linker64 <elf>`，于是 `execPath` 报的是链接器 | `has bad ELF magic: 696d706f` |
| `link(2)` 可用 | SELinux 拒绝，返回 `EACCES` | `output/target-indeterminate`<br>`output/target-hardlinked`<br>`*-publication-link-failed` |

`696d706f` 正是 `impo`（`import` 的前四个字节）的十六进制——链接器把 `.mjs` 当 ELF 解析了。

### 为什么 `link(2)` 这一段绕不过去

Archify 的发布契约是四步，全部基于硬链接：

```
1. capture  记录候选文件的 inode 与摘要
2. publish  link(candidate, commit)         → 同一个 inode 有两个名字
3. verify   两个名字同 inode 且 nlink === 2
4. retire   unlink(candidate)               → nlink 回到 1
```

所以「失败就复制一份」这种简单回退**不够用**：复制产生的是不同 inode，Archify 自己的第 3 步校验会拒绝，报 `target-hardlinked` 或 `target-indeterminate`。本插件必须同时替换发布动作与校验判定，才能让它自洽。

### 失败与 Landlock 无关

Android 4.19 内核确实没有上游 Landlock（5.13 才引入），但这里的阻断源是 SELinux。实测证据：

- 进程域为 `u:r:untrusted_app:s0:c28,c257,c512,c768`
- 在 `$HOME`、工作区、`/data/local/tmp`、`/storage/emulated/0` 下 `link(2)` **全部** 返回 `EACCES`
- shell 的 `ln` 命令同样失败
- **在 danger-full-access 档位下依然失败**，与本机沙箱策略无关

---

## 环境要求

| 项 | 实测值 |
|---|---|
| Node | v24.18.0（需支持 `--import` 与 ESM loader，建议 ≥ 20.6） |
| 系统 | Android 12，arm64-v8a，内核 4.19.191+ |
| Archify 技能 | `@tt-a1i/archify-dsh`（实测 1.0.0） |
| DSH | DeepSeek Harness，profile `web` |

无需 root，无需 Shizuku。

---

## 安装

本目录是**未安装**的源码副本。安装到 DSH profile：

```bash
# 在 DSH 会话中，用 plugin_manager 指向本目录
plugin_manager install_bundle <本目录绝对路径>
```

安装成功后 `application` 字段应为 `applied`，插件列表会出现 `archify-selinux-compat`，同时注册一个同名技能。

> 包名是 `archify-selinux-compat`，与目录名 `archify-termux-selinux-compat` 不同。安装与解析都认 **包名**。

---

## 使用

所有 Archify 命令都要经过 wrapper，不能直接跑 `archify.mjs`：

```bash
node <本目录>/lib/cli.js <archify 的 bin/archify.mjs> <command> [args...]
```

例如生成并校验一张架构图：

```bash
ARCHIFY=$DSH_PROFILE_DIR/node_modules/@tt-a1i/archify-dsh/skills/archify/bin/archify.mjs
COMPAT=<本目录>/lib/cli.js

node "$COMPAT" "$ARCHIFY" finalize architecture candidate.json out.html --quality showcase --json
```

wrapper 的行为：

- 解析真实的 ELF node 二进制，再用 `NODE_OPTIONS=--import <preload>` 启动 Archify
- 该 preload 会被 Archify 派生的所有子进程继承，因此 renderer、`finalize` 各阶段、浏览器门禁全部生效
- stdout / stderr / 退出码原样透传，可当作 Archify 本身使用
- 参数缺失或入口文件不存在时退出码为 `2`

---

## preload 改了什么

注入文件为 `lib/preload.mjs`，加载 `lib/hooks.mjs`（ESM loader hook）与 `lib/hardlink-shim.mjs`（`fs` 层）。

| 目标 | 处理方式 |
|---|---|
| `process.execPath` | 探测真实 ELF node（顺序：`TERMUX_EXEC__PROC_SELF_EXE` → `/proc/self/cmdline` → `PATH`），覆盖为可执行的真实路径 |
| `fs.linkSync` | `EACCES/EPERM/ENOTSUP/EOPNOTSUPP/ENOSYS/EXDEV` 时回退为 `wx` 独占 + `fsync` 的字节复制；**`EEXIST` 原样抛出**，保留「名字已被抢占」语义 |
| `publishRegularFileBinding` | 改为 `fsync` + `rename` 提交，保持单 inode、`nlink` 精确 |
| `verifyRegularFileBinding` | 改为按 mode / size / SHA-256 判定，替代无法成立的 inode 别名计数 |

### 设计取舍

- **不覆盖 `LD_PRELOAD`**。清空它会连带关掉 termux-exec，而 Termux 下执行 ELF 依赖它；既然 `execPath` 已指向正确，就无需动它。
- **失去 `nlink` 层面的跨进程别名检测**。这是硬链接不可用带来的固有损失。内容级 SHA-256 校验仍然生效，被替换或改写的产物依旧会被拒绝。
- **不改 Archify 源码**。全部通过 `--import` 运行时注入，`node_modules` 里的文件保持原样。

---

## 实测结果

在本机（Android 12 / arm64 / Node v24.18.0）跑 `finalize`：

```
validate      pass
deliver       pass
check         pass
browser-check skipped
```

前三级门禁全部通过，产物正常落盘（约 744 KiB 的单文件 HTML）。

`browser-check` 因**本机没有 Chrome / Chromium** 而跳过，与 SELinux 无关。此时 `finalize` 的 `ok` 为 `false`，但这是该单一环境限制造成的，不代表兼容层失败。若需该门禁，安装 Chrome 后设置：

```bash
export ARCHIFY_CHROME=/path/to/chrome
```

---

## 排错

先开调试日志：

```bash
export ARCHIFY_COMPAT_TRACE=1
export ARCHIFY_COMPAT_LOG="$HOME/compat.log"
```

有两点容易误判，先说清楚：

- **必须写文件**。Archify 会捕获子进程 stderr；只设 `ARCHIFY_COMPAT_TRACE=1` 时 trace 打在 stderr 上会被吞掉，一行都看不到。
- **`demo` / `render` 这类轻量命令可能一行日志都没有**，它们不经过发布步骤。要观察 shim 的实际动作，请用 `finalize` 或 `deliver`（实测 `finalize` 产生 20 行以上）。

日志形如：

```
[22299] copied o.delivery-pending.json->o.delivery-pending.json
[22299] join o.delivery-pending.json group=1 n=2
[22299] rename o.delivery-pending.json->o.delivery-pending.json group=1 n=2
[22299] retire o.delivery-pending.json group=1 n=1
```

出现 `copied` / `join` / `retire` 说明兼容层在工作；完全无行则说明 preload 没生效。

| 现象 | 原因与处理 |
|---|---|
| `bad ELF magic: 696d706f` | preload 没传到子进程。确认是通过 `lib/cli.js` 启动，且 `NODE_OPTIONS` 里含 `--import` 与 preload 的绝对路径 |
| `target-indeterminate` / `target-hardlinked` | `fs.linkSync` 兼容层未生效，通常是绕过 wrapper 直接跑了 `archify.mjs` |
| `*-publication-link-failed` 且带 `EACCES` | 原生 `link(2)` 直达了 SELinux，同上，检查启动方式 |
| 校验阶段 `link-count-changed` | shim 的逻辑分组与 rename 步骤不一致；换一个干净输出目录重跑，再判断是否为回归 |
| `chrome-unavailable` | 环境缺 Chrome，非兼容问题 |

---

## 文件结构

```
archify-termux-selinux-compat/
├── package.json                     # 含 dsh.bundle 声明，供 plugin_manager 识别
├── cordis.patch.yml                 # 插入技能提供者，导出 skills/
├── icon.svg                         # 36×36，DSH 蓝色系
├── locale/
│   ├── en.json                      # 插件标题与描述（英文）
│   └── zh.json                      # 同上（中文）
├── lib/
│   ├── index.js                     # 插件入口，导出 resolvePreloadUrl()
│   ├── cli.js                       # 命令包装器（日常都从这里进）
│   ├── preload.mjs                  # 注入点：execPath + 安装 loader hook
│   ├── hooks.mjs                    # ESM loader hook：重写发布与校验函数
│   └── hardlink-shim.mjs            # fs 层：link/stat/fstat/rename/unlink 语义
└── skills/
    └── archify-selinux-compat/
        └── SKILL.md                 # 给 agent 看的技能文档
```

`preload.mjs` 与 `cli.js` 有各自的 node 探测逻辑（前者服务当前进程，后者服务被 spawn 的子进程），这是有意重复，便于两者独立演化。

---

## 已知限制

- **仅在实测环境验证**：Android 12 / arm64-v8a / 内核 4.19.191+ / Node v24.18.0。其它 Android 版本或 ROM 未验证。
- **未做界面视觉验证**：本机无 Chrome，插件图标与技能条目在 DSH Web UI 中的实际显示未截图核对。
- **`browser-check` 门禁不可用**：除非自行安装 Chrome。
- **不支持 `nlink` 别名语义**：见上文「设计取舍」。

---

## 相关

- Archify 技能：`@tt-a1i/archify-dsh`
- 详细用法与排错：见 `skills/archify-selinux-compat/SKILL.md`
