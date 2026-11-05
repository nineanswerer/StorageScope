# StorageScope Beta 结项与交接

结项日期：2026-11-04。本文固定当前工程状态、产品定位偏差和恢复开发入口，方便后续从 GitHub 重新克隆继续工作。

## 1. 本次结项范围

本轮完成了从 v0.2.0 到 `0.3.0-beta.2` 的安全整改、故障恢复、真实安装生命周期验收、诊断、性能测量、手动更新检查、外部测试材料和 Beta 发布。

- 当前外部测试版：`v0.3.0-beta.2`，发布提交 `f9f61f6a54050f4e75eb397426b49a13a4b3376a`。
- 历史测试版：`v0.3.0-beta.1`，发布提交 `b4023bbd7c532f7a7609a031b80cf830fb6c0d94`。
- 取消反馈修复：`93512cd`。
- 完整验收记录提交：`b57b5bcbf7113a2902884302443384529455e02c`。
- 最终交接提交以远程 `main` 的最新记录为准。

这次结项代表 **Beta 工程阶段完成**。市场需求、外部设备兼容性、代码签名和正式版质量仍需后续验证，当前不是 v1.0。

## 2. 当前产品形态与 3D 核心定位的差距

最初品牌承诺要求把 **3D 立体树作为主要且重要的展示方式，让其他功能围绕它展开**。当前实现采用扫描、目录结构、快照趋势、差异比较和清理建议等独立工作区；目录结构内部提供列表、空间分布和 3D 树三种视图。快照配置、清理复核、诊断导出和更新检查有自己的操作入口。

因此，当前产品是 **带 3D 可视化的可信磁盘分析与清理工具**。3D 树承担结构探索，不是整个应用的中心交互对象。安全、恢复和发布能力已经形成工程基础，原始的 3D 中心信息架构尚未完整实现。

后续如果恢复 3D 核心方向，应以实际用户验证为前提重新组织交互：

1. 3D 场景作为主要工作区，扫描状态、节点层级和类型标识直接呈现在场景中。
2. 选中节点后可以查看快照历史、比较变化、加入分析计划或设置保护，减少跨页面跳转。
3. 快照差异直接映射到节点的新增、删除、增长和缩减状态。
4. 清理复核保留独立确认步骤，确认前能够回到场景检查目标及其父子关系。
5. 列表和空间分布作为精确检索与辅助比较工具，保留键盘操作和非 3D 替代路径。
6. 先验证 3D 是否提高定位效率，再决定是否扩大视觉和交互投入。

这些是后续设计方向，不属于当前 beta.2 已实现功能。

## 3. 仓库包含的恢复开发条件

| 内容 | 位置 |
| --- | --- |
| Rust 核心与 CLI | `core/`、`apps/cli/`、根目录 `Cargo.toml` 与 `Cargo.lock` |
| Tauri 桌面端 | `apps/desktop/src-tauri/` 及其独立锁文件 |
| React / TypeScript 前端 | `ui/`，包含 `package-lock.json` |
| 自动化检查 | `.github/workflows/checks.yml` |
| 产品与设计记录 | `PRODUCT.md`、`DESIGN.md`、`docs/` |
| 构建与性能脚本 | `scripts/` |
| 用户、安全和恢复说明 | `docs/USER_GUIDE.md`、`docs/SAFETY_AND_RECOVERY.md`、`docs/TROUBLESHOOTING.md` |
| 外部测试材料 | `docs/BETA_TESTING.md`、`.github/ISSUE_TEMPLATE/`、`SECURITY.md` |
| 安装包与免安装包 | GitHub Release；本地构建产物位于被 Git 忽略的 `target/` |
| 发布、签名与第三方声明 | `docs/RELEASE_CHECKLIST.md`、`docs/SIGNING.md`、`THIRD_PARTY_NOTICES.md` |

开发不需要提交 `node_modules`、`target`、测试数据库、合成大目录、安装目录或下载的资产副本。凭据和签名私钥始终留在仓库外。

真实窗口验收的原始脚本包含维护机路径、原生对话框控制及本机样本，不作为跨设备的一键测试工具。仓库中的自动化测试、性能脚本、验收记录和发布检查清单是后续开发的通用基线；重新做真实窗口验收时应按当时设备重建隔离样本和操作脚本。

## 4. 重新克隆并运行

```powershell
git clone https://github.com/nineanswerer/StorageScope.git
cd StorageScope
cd ui
npm ci
npm run build
cd ../apps/desktop/src-tauri
cargo run
```

环境要求与完整测试命令见 `README.md`。开发前同时阅读 `PRODUCT.md`、`DESIGN.md` 和本文，避免把当前实现状态误认为已经完成全部产品设想。

## 5. 重新构建发布资产

先构建前端，再在 `apps/desktop/src-tauri` 中生成 NSIS：

```powershell
node -e "require('../../../ui/node_modules/@tauri-apps/cli/main.js').run(['build','--bundles','nsis'],'tauri').catch(e=>{console.error(e);process.exit(1)})"
```

回到仓库根目录生成免安装 ZIP：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-portable.ps1
```

脚本从 `tauri.conf.json` 读取版本，检查 ZIP 必要文件，并验证解包后的主程序与 release 主程序 SHA-256 一致。输出位于 `apps/desktop/src-tauri/target/release/bundle/portable/`。

上传对应 Release 后重新下载并比较本地与远程资产：

```powershell
python scripts/verify_release_assets.py --tag v0.3.0-beta.2
```

后续版本替换 `--tag`。脚本要求先生成本地 NSIS 和免安装 ZIP，下载文件及报告写入被忽略的 `target/release-verification/`。

## 6. 公开与私有开发

同一个 GitHub 仓库的可见性作用于整个仓库，不能把公开仓库中的某个目录、文件或分支单独设为私有。已经公开的历史代码和 Release 也不会因为新建一个私密分支而失去公开属性。

推荐采用两个仓库：

- `StorageScope`：保留公开源码、稳定文档、Issue 和正式发布的 Beta／正式版资产。
- `StorageScope-dev`：由九术创建的私有仓库，用于未公开原型、3D 重构和其他实验代码。

需要公开成果时，把审查过的提交从私有仓库推送或整理到公开仓库。敏感信息、凭据和私钥不进入任何仓库。

如果不再需要公开下载和社区反馈，也可以把整个现有仓库改为私有；这会同时改变源码、Issue 和 Release 的访问范围。仅想隐藏开发计划时，还可以使用不放入公开仓库的私有项目管理空间，代码可见性不变。

## 7. 后续仍未完成的事项

- 外部测试者尚未提供真实反馈，产品必要性与 3D 主界面的效率仍待验证。
- Authenticode 实际签署受代码签名证书缺失阻塞。
- UAC、其他 Windows 设备和版本、不同文件系统及安全软件组合尚未覆盖。
- Windows 回收站实际还原仍待测试，本轮没有清空回收站。
- LICENSE 尚未由九术最终决定；公开可见不等于已经授予他人复制、修改或再分发许可。

恢复开发时先决定继续强化当前“可信清理”方向，还是回到“3D 树中心”的原始产品方向，再安排对应的外部验证和实现工作。
