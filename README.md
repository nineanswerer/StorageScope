# StorageScope

让磁盘空间从一串数字，变成可以探索、比较和复核的结构。

StorageScope 是一款 Windows 桌面磁盘分析与清理工具。它用目录列表、空间分布和 3D 树帮助定位占用，用快照与差异追踪变化，并在实际清理前复核路径、内容和保留边界。

[![Checks](https://github.com/nineanswerer/StorageScope/actions/workflows/checks.yml/badge.svg)](https://github.com/nineanswerer/StorageScope/actions/workflows/checks.yml)

![StorageScope 的 3D 目录树](docs/images/storagescope-tree.webp)

## 功能

- **目录扫描与结构定位**：扫描普通 Windows 目录，查看各层级的逻辑大小与文件数量；支持取消扫描和目录联接环检测。
- **多种结构视图**：列表用于精确查找，空间分布用于比较占用，3D 树用于理解父子关系并逐层下钻。
- **快照与差异**：保存目录状态，比较新增、删除、增长和缩减的文件，以及各目录的净变化。
- **可复核清理**：目录名仅作为人工复核线索；参考目录、排除目录和重复组保留项由用户明确设置。
- **执行前复核**：重新检查扫描基线、目录清单、文件大小、修改时间和可获取的文件实体身份；发现变化时跳过对应目标。
- **真实空间口径**：分别显示候选逻辑大小、待清空回收站大小和已核实分配空间释放。移入回收站的项目计入待清空大小。
- **重复文件合并**：全文哈希用于筛选，逐字节比较用于最终判等；只处理完整勾选的组，每组至少保留一个路径，并按硬链接数量核实分配空间变化。

## 安全边界

StorageScope 提供判断依据，由用户确认处理范围。当前安全策略包括：

- 扫描根本身与 Windows 系统关键目录受到保护；清理目标限定在扫描根内，并拦截链接越界。
- 参考目录与排除目录同时保护自身、后代和相关祖先目标，Windows 比较不区分大小写；前端选择与 Rust 执行层都会检查。
- 分析后发生变化的目录保持原状；无法确认的对象也保持原状。`backup`、`backups` 不进入默认清理候选。
- 删除操作进入回收站，仍可恢复；重复组只在完整勾选冗余副本后允许合并，每组至少保留一个路径。
- 快照差异仅反映文件清单和逻辑大小变化，卷可用空间需要单独测量。

清理操作仍需用户确认。特殊文件系统支持范围以实际验证记录为准。实际使用时应先分析副本或非关键目录。

## 下载与版本状态

[下载 v0.2.0](https://github.com/nineanswerer/StorageScope/releases/tag/v0.2.0)。

v0.2.0 包含逐字节内容确认、完整选组合并、Windows 大小写保护和硬链接释放计量整改。发布标签记录对应源码，安装包校验值见[安全验收记录](docs/15-release-safety-audit.md)。

## 技术栈与结构

- **Rust**：目录遍历、统计、快照、清理计划和文件操作。
- **Tauri 2**：Windows 桌面壳与前后端命令桥接。
- **React + TypeScript**：交互界面与状态管理。
- **Three.js**：3D 目录结构表达。

```text
core/                    核心库：扫描、统计、规则、快照、差异与清理
apps/cli/                命令行入口
apps/desktop/src-tauri/  Tauri 桌面端
ui/                      React / TypeScript 前端
docs/                    阶段记录与项目素材
.github/workflows/       GitHub Actions 自动检查
```

## 本地运行

### 环境准备

- Windows 10/11 x64；
- Node.js 24；
- Rust `stable-x86_64-pc-windows-msvc`，包含 `rustfmt` 与 `clippy`；
- Tauri 2 所需的 Microsoft C++ 生成工具和 WebView2，见[官方环境说明](https://v2.tauri.app/start/prerequisites/)。

### 构建前端并启动桌面端

```powershell
git clone https://github.com/nineanswerer/StorageScope.git
cd StorageScope
cd ui
npm ci
npm run build
cd ../apps/desktop/src-tauri
cargo run
```

### 构建 NSIS 安装包

先完成上述前端依赖安装与构建，再在 `apps/desktop/src-tauri` 中运行：

```powershell
node -e "require('../../../ui/node_modules/@tauri-apps/cli/main.js').run(['build','--bundles','nsis'],'tauri').catch(e=>{console.error(e);process.exit(1)})"
```

安装包输出到 `apps/desktop/src-tauri/target/release/bundle/nsis/`。

## 检查与测试

在仓库根目录运行 Rust 检查：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

在 `ui` 目录运行前端检查：

```powershell
npm run lint
npm run test:model
npm run build
```

当前自动化覆盖 **38 项 Rust 核心测试、2 项桌面测试和 19 项前端模型测试**。GitHub Actions 会在推送到 `main`、提交 Pull Request 或手动触发时运行这些检查。安装包发布作为独立流程进行。

## 验证记录与限制

- 在一个包含 **307,630 个文件、78.9 GB** 的真实目录上完成过扫描与结构展示验证。一次自动化流程约 24 秒，包含固定等待，该时间仅作为单次运行记录。
- v0.2.0 的调试窗口和 release 窗口分别通过同一套隔离样本验收，覆盖 Windows 大小写保护、变化目录跳过、回收站、结果快照比较、完整选组合并与候选重算。
- 硬链接样本确认：旧实体仍有其他链接时释放记为 0 B；最后链接移除时，3.0 MiB 样本核实释放 3.0 MiB。未勾选组始终保持独立实体。
- 正式窗口与安装包启动均无附加命令行窗口。安装包只验证启动，未执行安装后的完整流程。
- 尚未覆盖多设备或第三方环境复现、所有特殊文件系统、回收站清空后的卷余量测量及普遍性能结论。当前安装包未配置代码签名。

更多设计与验证细节见 [DESIGN.md](DESIGN.md) 和[项目复盘](https://nineanswerer.github.io/writing/storagescope-case-study/)。

## 参与与贡献分工

提交改动前请运行上述检查；涉及清理逻辑时，应同时补充自动化测试和隔离目录中的实景复核。

九术主导产品定义、交互决策与真实场景验收，AI 协作代码实现、调试和文档整理。
