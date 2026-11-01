---
name: StorageScope
description: Operate 模式桌面工具。深色低亮度表面 + 青蓝主色 + 橙色警示，克制留白与明确层级，为"找空间、做清理"的扫描式阅读服务。
---

# StorageScope 设计系统

方法论参照 [impeccable](https://github.com/pbakaus/impeccable)：本应用属 **Operate 模式**（用户来完成任务），表达让位于可扫读性、一致性与精确细节。

## 令牌（`ui/src/App.css` `:root` 唯一事实源）

- **表面**：`--bg #101216` 页面 / `--surface #171a20` 卡片 / `--surface-2 #1e232c` 悬停与次级控件 / `--inset #0d0f13` 输入与可视化底 / 边框 `--border #262b34`、`--border-strong #323a47`。
- **文字**：`--text #eceff3` / `--muted #a8b2c0` / `--faint #7d8798`，对卡片底对比度均 ≥ 4.5:1。
- **品牌**：青蓝 `--accent #7fd4ff`（主按钮、链接、进度），橙色 `--warn #ffb454`（警示与"可清理"高亮，与 3D 视图同色语义）。危险 `--danger #c24034`，成功 `--success #7fd8a4`。
- **形状**：卡片圆角 12，控件圆角 8；卡片只用 1px 边框，不叠阴影。
- **间距**：4px 基准；卡片 padding 20、卡片间隔 20；h3 上 20 下 8（标题上方留白大于下方）。
- **字体**：Segoe UI / Microsoft YaHei；正文字号 13–14，h1 24 / h2 16 / h3 13；等宽字体仅用于路径等数据；表格数字 `tabular-nums`。

## 规则

- 控件必备 hover / focus-visible / disabled 三态；主按钮青蓝底深字，危险按钮实心红。
- 浏览器默认表面纳入设计：选区青蓝 28%、细深色滚动条、焦点环 2px accent。
- 动效只有一种语言：控件颜色 0.12–0.15s 过渡 + 按钮按下 1px 位移，不做分区入场动画。
- 编号小节标题（1. 扫描 / 2. 结构…）保留：编号本身是工作流顺序信息。
- 可视化高亮一律用 `--warn` 橙，与清理建议表语义一致。

## 验证

- impeccable 检测器：源码扫描 0 发现；渲染态扫描仅 1 条脚本错误（dev server 无 Tauri 运行时所致，与桌面端无关）。
