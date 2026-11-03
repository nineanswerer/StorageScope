# 第三方组件声明

StorageScope 的桌面程序与界面使用以下直接组件。版本依据当前 `Cargo.lock`、`package-lock.json` 和本地包元数据；传递依赖的精确版本以锁文件为准。各组件由其上游作者按对应许可证提供，本文件不改变任何上游许可证。

本文件也不是 StorageScope 自身的许可证选择。

## 桌面运行时与核心库

| 组件 | 当前版本 | 许可证标识 |
| --- | --- | --- |
| Tauri | 2.12.5 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT |
| reqwest | 0.12.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| rusqlite | 0.32.1 | MIT |
| trash | 5.2.9 | MIT |
| windows / windows-sys | 0.61 系列；传递依赖可含其他版本 | MIT OR Apache-2.0 |
| clap | 4.6.7 | MIT OR Apache-2.0 |
| ctrlc | 3.5.2 | MIT OR Apache-2.0 |

`rusqlite` 的 bundled 构建包含 SQLite。SQLite 由其在公有领域发布，SQLite 本身的声明不覆盖 rusqlite 或其他依赖。

## 用户界面

| 组件 | 当前版本 | 许可证标识 |
| --- | --- | --- |
| React / React DOM | 19.3.1 | MIT |
| Three.js | 0.186.0 | MIT |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.8.4 | MIT OR Apache-2.0 |

## 构建与开发组件

| 组件 | 当前版本 | 许可证标识 |
| --- | --- | --- |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT |
| Vite | 8.3.5 | MIT |
| @vitejs/plugin-react | 6.1.2 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| oxlint | 1.90.0 | MIT |
| @types/node / @types/react / @types/react-dom / @types/three | 见 `package-lock.json` | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |

## 许可证文本与再分发

上游包中的 `LICENSE`、`LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE` 等文件包含相应许可证全文和版权行。发布或再分发时，应保留适用于实际二进制及 bundled 组件的许可证和声明；新增直接依赖时同步更新本文件。

可在签名机器上通过 `cargo metadata --locked` 与 npm 包元数据复核版本和许可证字段。此项声明用于组件透明度，不替代针对完整传递依赖树的法律审核。
